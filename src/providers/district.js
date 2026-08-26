// District (district.in) provider.
// The showtimes endpoint answers 204 while a date is not on sale yet, and 200 with the
// full session list once it opens. Plain fetch works, so this provider needs no special
// HTTP client, and it honours a SOCKS5 dispatcher when one is configured.
import { CheckError, toLocalTime } from "../lib.js";

export const key = "district";
export const label = "District";

const UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";

/** Generated client-side by District's own web app, not issued by the server. */
function guestToken() {
  let digits = "";
  for (let i = 0; i < 18; i++) digits += Math.floor(Math.random() * 10);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 11; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${Date.now()}_${digits}_${suffix}`;
}

function apiUrl(p, date) {
  const q = new URLSearchParams({
    version: "3", site_id: "1", channel: "mweb", child_site_id: "1", platform: "district",
    movieCode: p.movieCode, city_key: p.cityKey, content_id: p.contentId,
    date, latitude: p.lat, longitude: p.lng, cinemaOrderLogic: "3",
  });
  return `https://www.district.in/gw/consumer/movies/v5/movie?${q}`;
}

/** @returns {{kind:"closed"}|{kind:"open",data:object}} */
export async function check(cfg, p, date) {
  let res;
  try {
    res = await fetch(apiUrl(p, date), {
      headers: {
        accept: "*/*",
        api_source: "district",
        "x-app-type": "ed_mweb",
        "x-guest-token": guestToken(),
        "x-request-id": crypto.randomUUID(),
        "user-agent": UA,
        ...(p.bookingUrl ? { referer: p.bookingUrl } : {}),
      },
      signal: AbortSignal.timeout(15000),
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

function isMatch(sess, p) {
  if (!p.formatTag && !p.formatMatch) return true;
  return (p.formatTag && (sess.tags || []).includes(p.formatTag)) ||
    (p.formatMatch && String(sess.scrnFmt || "").toUpperCase().includes(p.formatMatch.toUpperCase()));
}

export function extract(data, cfg, p) {
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
      if (!isMatch(s, p)) continue;
      const session = {
        sid: String(s.sid),
        cinema: name,
        time: toLocalTime(s.showTime, cfg.tzOffsetMinutes),
        audi: s.audi || "",
        format: s.scrnFmt || "",
        avail: s.avail,
        total: s.total,
        tiers: (s.areas || [])
          .map((a) => `${a.label} ${cfg.currency}${Math.round(a.price)} (${a.sAvail}/${a.sTotal})`)
          .join(" · "),
      };
      const wanted = !p.venueId || String(c.id) === String(p.venueId);
      (wanted ? out.matched : out.other).push(session);
    }
  }
  return out;
}

/**
 * Optional capability: how far ahead bookings currently run. `meta.showDates` only
 * appears in a 200 body, and the target date returns an empty 204 while closed, so this
 * asks about today instead. Best effort; the caller ignores failures.
 */
export async function probeShowDates(cfg, p, todayIso) {
  const res = await check(cfg, p, todayIso);
  if (res.kind !== "open") return null;
  const dates = res.data?.meta?.showDates ?? [];
  return dates.length ? dates.slice().sort().at(-1) : null;
}
