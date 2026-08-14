// Core logic: District API client, session matching, alert state machine, ntfy publisher.
// Everything here is runtime-agnostic and side-effect-free except checkDistrict/notify.

export class CheckError extends Error {}

const UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";

/**
 * District's web client mints this token locally on every request — it is not
 * server-issued, and any value of this shape is accepted.
 */
export function guestToken() {
  let digits = "";
  for (let i = 0; i < 18; i++) digits += Math.floor(Math.random() * 10);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 11; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${Date.now()}_${digits}_${suffix}`;
}

/** API showTime is UTC without a zone suffix ("2026-08-05T03:30"). */
export function toLocalTime(showTime, tzOffsetMinutes) {
  let s = showTime;
  if (/T\d{2}:\d{2}$/.test(s)) s += ":00";
  if (!s.endsWith("Z")) s += "Z";
  const d = new Date(Date.parse(s) + tzOffsetMinutes * 60000);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** YYYY-MM-DD in the configured timezone. */
export function localDate(now, tzOffsetMinutes) {
  return new Date(now.getTime() + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
}

function localMinutes(now, tzOffsetMinutes) {
  const d = new Date(now.getTime() + tzOffsetMinutes * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Single source of truth for "should this tick send today's heartbeat". */
export function heartbeatDue(state, now, cfg) {
  if (cfg.heartbeatHour < 0) return false;
  return localMinutes(now, cfg.tzOffsetMinutes) >= cfg.heartbeatHour * 60 &&
    state.hbDate !== localDate(now, cfg.tzOffsetMinutes);
}

function isMatch(sess, cfg) {
  // Deliberately broad: either the format tag or a substring of the screen format,
  // so "IMAX" also catches "IMAX 3D" and similar variants.
  if (!cfg.formatTag && !cfg.formatMatch) return true;
  return (cfg.formatTag && (sess.tags || []).includes(cfg.formatTag)) ||
    (cfg.formatMatch && String(sess.scrnFmt || "").toUpperCase().includes(cfg.formatMatch.toUpperCase()));
}

function normalize(sess, cinemaName, cfg) {
  return {
    sid: String(sess.sid),
    cinema: cinemaName,
    time: toLocalTime(sess.showTime, cfg.tzOffsetMinutes),
    audi: sess.audi || "",
    avail: sess.avail,
    total: sess.total,
    tiers: (sess.areas || [])
      .map((a) => `${a.label} ${cfg.currency}${Math.round(a.price)} (${a.sAvail}/${a.sTotal})`)
      .join(" · "),
  };
}

/**
 * Split a District response into matching sessions.
 *  matched — at cfg.cinemaId (or every cinema when cinemaId is unset)
 *  other   — matching format at a different cinema (reported as secondary lines)
 */
export function extractSessions(data, cfg) {
  const cinemas = [
    ...(data?.pageData?.nearbyCinemas ?? []),
    ...(data?.pageData?.farCinemas ?? []),
  ];
  const out = {
    matched: [], other: [],
    cinemaCount: cinemas.length, sessionCount: 0,
    showDates: data?.meta?.showDates ?? [],
  };
  for (const c of cinemas) {
    const name = c?.cinemaInfo?.name || `cinema ${c?.id}`;
    for (const s of c?.sessions ?? []) {
      out.sessionCount++;
      if (!isMatch(s, cfg)) continue;
      const wanted = !cfg.cinemaId || String(c.id) === String(cfg.cinemaId);
      (wanted ? out.matched : out.other).push(normalize(s, name, cfg));
    }
  }
  return out;
}

function apiUrl(cfg, date) {
  const p = new URLSearchParams({
    version: "3", site_id: "1", channel: "mweb", child_site_id: "1", platform: "district",
    movieCode: cfg.movieCode, city_key: cfg.cityKey, content_id: cfg.contentId,
    date, latitude: cfg.lat, longitude: cfg.lng, cinemaOrderLogic: "3",
  });
  return `https://www.district.in/gw/consumer/movies/v5/movie?${p}`;
}

/**
 * One API call, classified by HTTP outcome only:
 *   204 -> date not open for booking yet
 *   200 -> open (open-but-empty is decided later, in decide())
 * Anything else throws CheckError, which counts toward the failure streak.
 */
export async function checkDistrict(cfg, date) {
  let res;
  try {
    res = await fetch(apiUrl(cfg, date), {
      headers: {
        accept: "*/*",
        api_source: "district",
        "x-app-type": "ed_mweb",
        "x-guest-token": guestToken(),
        "x-request-id": crypto.randomUUID(),
        "user-agent": UA,
        ...(cfg.bookingUrl ? { referer: cfg.bookingUrl } : {}),
      },
      signal: AbortSignal.timeout(15000),
      // Node-only: routes this call through a SOCKS5 proxy when one is configured.
      ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
    });
  } catch (err) {
    throw new CheckError(`fetch failed: ${err.message}`);
  }
  if (res.status === 204) return { kind: "closed" };
  if (res.status === 200) {
    try {
      return { kind: "open", data: await res.json() };
    } catch (err) {
      throw new CheckError(`unparseable 200 body: ${err.message}`);
    }
  }
  throw new CheckError(`HTTP ${res.status}`);
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

export function defaultState() {
  return {
    dateOpenAlerted: false,
    sidsAlerted: {},
    failures: 0,
    brokenAlerted: false,
    hbDate: "",
    lastGood: null,
    retired: false,
  };
}

/**
 * Pure decision core.
 *   input: { kind: "closed"|"open"|"error", extract?, reason?, now, probeMax? }
 * Returns { baseState, alerts }. Each alert carries its own statePatch, which the
 * caller merges ONLY after that alert's push succeeds, so a failed push retries
 * next tick instead of being silently marked as delivered.
 */
export function decide(state, input, cfg) {
  const base = structuredClone(state);
  const alerts = [];
  const now = input.now;

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

  // Only write when it actually changed, so a repeating probe cannot churn state.
  if (input.probeMax && base.lastGood?.showDatesMax !== input.probeMax) {
    base.lastGood = { ...(base.lastGood ?? {}), showDatesMax: input.probeMax, at: now.toISOString() };
  }

  if (input.kind === "error") {
    base.failures = Math.min((state.failures ?? 0) + 1, cfg.failureThreshold);
    if (base.failures >= cfg.failureThreshold && !state.brokenAlerted) {
      alerts.push({
        title: "Monitor BROKEN - check manually",
        priority: "4",
        tags: "warning",
        click: cfg.bookingUrl,
        body: `${cfg.failureThreshold} consecutive check failures (last: ${input.reason}). The site may be blocking this host, or be down. Until this recovers, silence does NOT mean "not open yet" - check the page yourself.`,
        statePatch: { brokenAlerted: true },
      });
    }
    return { baseState: base, alerts };
  }

  // --- success tick ---
  base.failures = 0;
  if (state.brokenAlerted) {
    alerts.push({
      title: "Monitor recovered",
      priority: "3",
      tags: "white_check_mark",
      click: cfg.bookingUrl,
      body: "Checks are succeeding again. Normal service resumed.",
      statePatch: { brokenAlerted: false },
    });
  }

  const ex = input.kind === "open" ? input.extract : null;
  const effectiveKind = ex && ex.sessionCount > 0 ? "open" : "closed"; // open-but-empty = closed
  if (base.lastGood?.kind !== effectiveKind) {
    base.lastGood = { ...(base.lastGood ?? {}), kind: effectiveKind, at: now.toISOString() };
  }

  if (effectiveKind === "open") {
    const fresh = ex.matched.filter((s) => !state.sidsAlerted?.[s.sid]);
    if (fresh.length > 0) {
      const lines = fresh.map((s) =>
        `${s.time} | ${s.cinema}${s.audi ? ` | ${s.audi}` : ""} | seats ${s.avail}/${s.total}\n${s.tiers}`);
      for (const s of ex.other) lines.push(`Also at ${s.cinema}: ${s.time}`);
      const sidsAlerted = { ...state.sidsAlerted };
      for (const s of fresh) sidsAlerted[s.sid] = true;
      alerts.push({
        title: `${cfg.formatLabel} ${cfg.targetDate} OPEN - BOOK NOW`,
        priority: "5",
        tags: "rotating_light,movie_camera",
        click: cfg.bookingUrl,
        body: lines.join("\n\n"),
        statePatch: { sidsAlerted, dateOpenAlerted: true },
      });
    } else if (!state.dateOpenAlerted && ex.matched.length === 0) {
      alerts.push({
        title: `${cfg.targetDate} bookings are OPEN (no ${cfg.formatLabel} yet)`,
        priority: "4",
        tags: "eyes",
        click: cfg.bookingUrl,
        body: `${ex.cinemaCount} cinemas are listing ${cfg.targetDate}, but nothing matching "${cfg.formatLabel}" so far. You'll get a max-priority push the moment it appears. Open dates: ${ex.showDates.join(", ") || "n/a"}.`,
        statePatch: { dateOpenAlerted: true },
      });
    }
  }

  if (heartbeatDue(state, now, cfg)) {
    alerts.push({
      title: `Still watching ${cfg.targetDate}`,
      priority: "1",
      tags: "hourglass",
      click: cfg.bookingUrl,
      body: `Monitor healthy. Bookings open through: ${base.lastGood?.showDatesMax ?? "unavailable"}. Target date is still ${effectiveKind}.`,
      statePatch: { hbDate: localDate(now, cfg.tzOffsetMinutes) },
    });
  }

  return { baseState: base, alerts };
}
