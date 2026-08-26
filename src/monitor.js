// Provider-agnostic alert logic: what to notify about, once, and when to stay quiet.
// Providers supply normalized sessions; nothing here knows which site they came from.
import { localDate, localMinutes } from "./lib.js";

export function defaultProviderState() {
  return { dateOpenAlerted: false, sidsAlerted: {}, failures: 0, brokenAlerted: false, lastGood: null };
}

export function defaultState() {
  return { hbDate: "", retired: false, providers: {} };
}

/** Provider sub-state, defaulted, so older state files keep working. */
export function providerState(state, key) {
  return { ...defaultProviderState(), ...((state.providers ?? {})[key] ?? {}) };
}

export function heartbeatDue(state, now, cfg) {
  if (cfg.heartbeatHour < 0) return false;
  return localMinutes(now, cfg.tzOffsetMinutes) >= cfg.heartbeatHour * 60 &&
    state.hbDate !== localDate(now, cfg.tzOffsetMinutes);
}

function sessionLine(s) {
  const head = [s.time, s.cinema, s.audi || s.format, s.avail != null ? `seats ${s.avail}/${s.total}` : null]
    .filter(Boolean).join(" | ");
  return s.tiers ? `${head}\n${s.tiers}` : head;
}

/**
 * Decide what to alert for ONE provider on one tick.
 *   input: { kind: "closed"|"open"|"error", extract?, reason?, now, probeMax? }
 * Returns { baseState, alerts } for that provider's sub-state. Each alert carries its own
 * statePatch, which the caller merges only after that alert's push succeeds, so a failed
 * notification retries next tick instead of being recorded as delivered.
 */
export function decideProvider(pstate, input, cfg, p) {
  const base = structuredClone(pstate);
  const alerts = [];
  const now = input.now;
  const tag = (a) => ({ ...a, provider: p.key });

  if (input.probeMax && base.lastGood?.showDatesMax !== input.probeMax) {
    base.lastGood = { ...(base.lastGood ?? {}), showDatesMax: input.probeMax, at: now.toISOString() };
  }

  if (input.kind === "error") {
    base.failures = Math.min((pstate.failures ?? 0) + 1, cfg.failureThreshold);
    if (base.failures >= cfg.failureThreshold && !pstate.brokenAlerted) {
      alerts.push(tag({
        title: `${p.label} checks BROKEN - check manually`,
        priority: "4",
        tags: "warning",
        click: p.bookingUrl,
        body: `${cfg.failureThreshold} consecutive failures against ${p.label} (last: ${input.reason}). The site may be blocking this host, or be down. Until this recovers, silence does NOT mean "not open yet" - check the page yourself.`,
        statePatch: { brokenAlerted: true },
      }));
    }
    return { baseState: base, alerts };
  }

  base.failures = 0;
  if (pstate.brokenAlerted) {
    alerts.push(tag({
      title: `${p.label} checks recovered`,
      priority: "3",
      tags: "white_check_mark",
      click: p.bookingUrl,
      body: `${p.label} checks are succeeding again. Normal service resumed.`,
      statePatch: { brokenAlerted: false },
    }));
  }

  const ex = input.kind === "open" ? input.extract : null;
  const effectiveKind = ex && ex.sessionCount > 0 ? "open" : "closed"; // open-but-empty = closed
  if (base.lastGood?.kind !== effectiveKind) {
    base.lastGood = { ...(base.lastGood ?? {}), kind: effectiveKind, at: now.toISOString() };
  }

  if (effectiveKind === "open") {
    const fresh = ex.matched.filter((s) => !pstate.sidsAlerted?.[s.sid]);
    if (fresh.length > 0) {
      const lines = fresh.map(sessionLine);
      for (const s of ex.other) lines.push(`Also at ${s.cinema}: ${s.time}`);
      const sidsAlerted = { ...pstate.sidsAlerted };
      for (const s of fresh) sidsAlerted[s.sid] = true;
      alerts.push(tag({
        title: `${cfg.formatLabel} ${cfg.targetDate} OPEN on ${p.label} - BOOK NOW`,
        priority: "5",
        tags: "rotating_light,movie_camera",
        click: p.bookingUrl,
        body: lines.join("\n\n"),
        statePatch: { sidsAlerted, dateOpenAlerted: true },
      }));
    } else if (!pstate.dateOpenAlerted && ex.matched.length === 0) {
      alerts.push(tag({
        title: `${cfg.targetDate} is OPEN on ${p.label} (no ${cfg.formatLabel} yet)`,
        priority: "4",
        tags: "eyes",
        click: p.bookingUrl,
        body: `${p.label} is listing ${cfg.targetDate} at ${ex.cinemaCount} cinemas, but nothing matching "${cfg.formatLabel}" so far. You'll get a max-priority push the moment it appears.${ex.showDates.length ? ` Open dates: ${ex.showDates.join(", ")}.` : ""}`,
        statePatch: { dateOpenAlerted: true },
      }));
    }
  }

  return { baseState: base, alerts };
}

/**
 * Tick-level decisions that are not per-provider: retirement and the daily heartbeat.
 *   summaries: [{ label, kind, showDatesMax }] describing each provider this tick.
 */
export function decideGlobal(state, cfg, now, summaries) {
  const base = structuredClone(state);
  const alerts = [];

  if (base.retired) return { baseState: base, alerts };

  if (now.getTime() >= Date.parse(cfg.expiryUtc)) {
    alerts.push({
      title: "Monitor retired",
      priority: "3",
      tags: "checkered_flag",
      click: cfg.bookingUrl,
      body: `${cfg.targetDate} has passed, so this monitor is now idle. Stop it when convenient.`,
      statePatch: { retired: true },
    });
    return { baseState: base, alerts };
  }

  if (heartbeatDue(state, now, cfg)) {
    const lines = summaries.map((s) =>
      `${s.label}: ${s.kind ?? "unknown"}${s.showDatesMax ? ` (open through ${s.showDatesMax})` : ""}`);
    alerts.push({
      title: `Still watching ${cfg.targetDate}`,
      priority: "1",
      tags: "hourglass",
      click: cfg.bookingUrl,
      body: `Monitor healthy.\n${lines.join("\n")}`,
      statePatch: { hbDate: localDate(now, cfg.tzOffsetMinutes) },
    });
  }

  return { baseState: base, alerts };
}

export async function notify(cfg, alert) {
  if (!cfg.ntfyTopic) throw new Error("NTFY_TOPIC is not set");
  const headers = {
    Title: alert.title,
    Priority: alert.priority,
    Tags: alert.tags,
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (alert.click) headers.Click = alert.click;
  if (cfg.ntfyToken) headers.Authorization = `Bearer ${cfg.ntfyToken}`;
  const res = await fetch(`${cfg.ntfyUrl}/${cfg.ntfyTopic}`, {
    method: "POST",
    headers,
    body: alert.body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}
