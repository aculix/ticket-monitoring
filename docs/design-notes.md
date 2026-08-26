# Design notes

Why this is built the way it is, and what broke along the way. Useful if you're forking it,
or writing something similar against a different site.

Two sites are supported. Each lives in `src/providers/` and exposes the same two functions,
`check()` and `extract()`, returning sessions in one normalized shape. Everything above that
layer, including the alert state machine, has no idea which site a session came from.

## District: the API

District's movie pages are server-rendered Next.js, but showtimes load client-side from:

```
GET /gw/consumer/movies/v5/movie
      ?version=3&site_id=1&channel=mweb&child_site_id=1&platform=district
      &movieCode=<frmtid>&city_key=<city>&content_id=<id>
      &date=YYYY-MM-DD&latitude=<lat>&longitude=<lng>&cinemaOrderLogic=3
```

Findings that shaped the design:

- **`x-guest-token` is generated client-side.** It looks like a session token but isn't
  server-issued — the browser builds `<epoch_ms>_<18 digits>_<11 random chars>` per request, and
  any value of that shape is accepted. No login, no cookies.
- **Latitude and longitude are mandatory.** Without them the API returns `400 Mandatory search
  params are missing`, even though results are city-wide.
- **`204` vs `200` is the signal.** A date that isn't open for booking returns `204 No Content`;
  an open date returns the full session list. That status flip is the entire trigger, which keeps
  the check to a single cheap request.
- **`showTime` is UTC** without a zone suffix. Local time is applied via `TZ_OFFSET_MINUTES`.
- **`meta.showDates` only exists in a `200` body.** Because the target date returns an empty
  `204` while closed, the daily heartbeat makes one extra call for *today* purely to report how
  far ahead bookings currently run. That probe is best-effort and never counts as a failure.

## BookMyShow: the API

```
GET /api/movies-data/v5/showtimes-by-event/primary-dynamic
      ?etCodes=<ET code>&dateCode=YYYYMMDD&regionCode=AHD
      &isDesktop=true&xLocationShared=false&memberId=&lsId=&subCode=
      &appCode=WEB&refEventCode=<ET code>[&language=hindi]
```

Sent with `x-region-code`, `x-region-slug`, `x-latitude`, `x-longitude`, `x-app-code: WEB` and
an `x-bms-id` that, like District's guest token, the web client makes up locally.

- **Cloudflare blocks on TLS fingerprint, not IP or headers.** curl and Node's `fetch` both get
  403 with a byte-perfect copy of the browser's headers, and no `cf_clearance` cookie is involved,
  so there is nothing to copy across. A proxy does not help either, since the block happens during
  the TLS handshake. [impit](https://github.com/apify/impit) performs the request with a real
  Chrome fingerprint and returns 200. It ships prebuilt binaries for linux x64 and arm64 in both
  gnu and musl flavours, which is what keeps the Alpine image and the arm64 build working.
- **There is no 204.** A date that is not on sale answers 200 with a short body containing only
  `header`, `additionalData` and `addOnWidgets`. The tell is that `data.showtimeWidgets` is
  absent, so "closed" is a property of the payload rather than the status code.
- **A past or invalid date returns 400**, which counts as a failure rather than "closed". That is
  deliberate: it means something is wrong with the configuration, and you should hear about it.
- **Sessions are buried in generic UI widgets.** Venue cards sit several layers down inside
  `showtimeWidgets`, so the parser walks the tree looking for `type: "venue-card"` instead of
  indexing through fixed positions, which would break the moment BMS reorders its layout.
- **Seat detail lives in a bottom sheet.** Each showtime carries a `customGestureCTA` describing
  the panel shown on double-tap, and that is the only place per-tier prices appear. BMS reports
  availability as words (`AVAILABLE`, `FILLING FAST`, `ALMOST FULL`) and never as exact counts,
  unlike District, so the normalized session leaves `avail` and `total` null and alert lines omit
  the seat figures for this site.
- **Times are already local**, so unlike District's UTC timestamps they are passed through as-is.

## Alert state machine

`decideProvider()` in `src/monitor.js` is pure: state in, `{ baseState, alerts }` out. That makes every
edge case testable without network or clock mocking, and it's where the interesting rules live.

- **Publish before persist.** Each alert carries its own `statePatch`, merged only after that
  alert's push succeeds. A failed notification retries on the next tick instead of being silently
  recorded as delivered.
- **Dedupe by session id, not a boolean.** Shows added after the first alert still notify you.
- **`dateOpenAlerted` rides an alert patch, never the base state.** Otherwise a failed push
  followed by sessions disappearing could swallow the only notification you'd ever get.
- **Open-but-empty counts as closed**, defending against a `200` with no sessions.
- **Failures are capped at the threshold**, so a long outage stops writing state entirely.
- **State is written only when it actually changed.** Originally this ran on Cloudflare KV with a
  1,000 writes/day free limit against 1,440 daily ticks, which forced the discipline; it's still
  the right behaviour on a filesystem.
- **State is namespaced per site.** Each provider gets its own dedupe map, failure counter and
  BROKEN flag under `state.providers.<key>`, so the same session id can alert once per site and a
  site going down never marks the other as broken. Retirement and the daily heartbeat are the only
  tick-level decisions, and they live in `decideGlobal()`.

The guiding rule throughout: **degrade toward duplicate notifications, never toward silence.**
Every failure path, whether it is unreadable state, a failed push or a failed write, errs that way.

## What broke in production

Both failures were about *where the traffic came from*, not the code.

1. **Akamai started returning `403` to the cloud host after ~2 days.** The first version ran as a
   Cloudflare Worker on a 1-minute cron. It worked, alerted correctly in a fire drill, then hard-
   blocked — while the same requests from a home connection kept working. Datacenter IP ranges
   get flagged; residential ones didn't. The monitor's own BROKEN alert is what surfaced this,
   which is the strongest argument for having it.
2. **ntfy.sh returned `429` to that same class of IP.** Push delivery failed from cloud egress
   even with an account token, because rate limits are per visitor IP and shared cloud IPs are
   already spent. Self-hosting ntfy fixed it immediately.

The fix for both: run it from a residential connection, or route only the site checks through a
SOCKS5 proxy (`PROXY_URL`) and use your own ntfy server. Notifications deliberately stay direct
so the alerting path has no dependency on the proxy.

**Cloudflare Workers cannot do this.** `fetch()` there has no proxy option, and the raw-TCP
escape hatch (`connect()` from `cloudflare:sockets`) can't help: `startTls()` validates the
certificate against the host you dialed, with no SNI override, so you can't form a TLS session
for a third-party origin through a proxy. That's why the project ended up as a plain Node
process in Docker rather than a serverless function.
