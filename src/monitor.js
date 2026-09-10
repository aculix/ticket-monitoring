// Provider-agnostic alert logic: what to notify about, once, and when to stay quiet.
// Providers supply normalized sessions; nothing here knows which site they came from.
import { localDate, localMinutes } from "./lib.js";

/**
 * Consecutive successful checks a previously announced show must be absent before it is
 * forgotten. Counting checks, rather than reacting to one miss, stops a single flaky
 * response from turning into a duplicate max-priority push.
 */
export const REARM_AFTER = 3;

export function defaultProviderState() {
  return {
    dateOpenAlerted: false, sidsAlerted: {}, missing: {}, closedTicks: 0,
    failures: 0, brokenAlerted: false, lastGood: null,
  };
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
  const note = input.note ?? null;
  if (base.lastGood?.kind !== effectiveKind || base.lastGood?.note !== note) {
    base.lastGood = { ...(base.lastGood ?? {}), kind: effectiveKind, note, at: now.toISOString() };
  }

  // Cinemas publish early, pull the shows and re-list them, often under the same session
  // ids. Dedupe must not outlive the listing, or the re-listing is silent. So a show that
  // stays missing for REARM_AFTER checks is forgotten, and its return alerts again. This
  // lives in the base state rather than an alert patch: re-arming must not depend on a
  // notification getting through.
  const present = new Set(effectiveKind === "open" ? ex.matched.map((s) => s.sid) : []);
  const alerted = { ...(pstate.sidsAlerted ?? {}) };
  const missing = { ...(pstate.missing ?? {}) };
  for (const sid of Object.keys(alerted)) {
    if (present.has(sid)) {
      delete missing[sid];
    } else if ((missing[sid] = (missing[sid] ?? 0) + 1) >= REARM_AFTER) {
      delete alerted[sid];
      delete missing[sid];
    }
  }
  for (const sid of Object.keys(missing)) if (!(sid in alerted)) delete missing[sid];
  base.sidsAlerted = alerted;
  base.missing = missing;

  // The whole date going dark after it opened is worth saying out loud: the user may be
  // mid-booking and wondering where the shows went. Counted the same way, then re-armed.
  if (effectiveKind === "closed" && pstate.dateOpenAlerted) {
    base.closedTicks = (pstate.closedTicks ?? 0) + 1;
    if (base.closedTicks >= REARM_AFTER) {
      base.dateOpenAlerted = false;
      base.closedTicks = 0;
      alerts.push(tag({
        title: `${cfg.targetDate} shows withdrawn on ${p.label}`,
        priority: "3",
        tags: "arrows_counterclockwise",
        click: p.bookingUrl,
        body: `${p.label} is no longer listing shows for ${cfg.targetDate}. The monitor has re-armed, so you'll get a max-priority push again the moment they come back.`,
        statePatch: {},
      }));
    }
  } else if (pstate.closedTicks) {
    base.closedTicks = 0;
  }

  if (effectiveKind === "open") {
    const fresh = ex.matched.filter((s) => !alerted[s.sid]);
    if (fresh.length > 0) {
      const lines = fresh.map(sessionLine);
      for (const s of ex.other) lines.push(`Also at ${s.cinema}: ${s.time}`);
      // Built from the post-forget map, so the patch can't resurrect a forgotten id.
      const sidsAlerted = { ...alerted };
      for (const s of fresh) sidsAlerted[s.sid] = true;
      alerts.push(tag({
        title: `${cfg.formatLabel} ${cfg.targetDate} OPEN on ${p.label} - BOOK NOW`,
        priority: "5",
        tags: "rotating_light,movie_camera",
        click: p.bookingUrl,
        body: lines.join("\n\n"),
        statePatch: { sidsAlerted, dateOpenAlerted: true },
      }));
    } else if (!base.dateOpenAlerted && ex.matched.length === 0) {
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
      `${s.label}: ${s.kind ?? "unknown"}${s.note ? `, ${s.note}` : ""}` +
      `${s.showDatesMax ? ` (open through ${s.showDatesMax})` : ""}`);
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
