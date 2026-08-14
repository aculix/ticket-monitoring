# Design notes

Why this is built the way it is, and what broke along the way. Useful if you're forking it,
or writing something similar against a different site.

## The API

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

## Alert state machine

`decide()` in `src/monitor.js` is pure: state in, `{ baseState, alerts }` out. That makes every
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

The guiding rule throughout: **degrade toward duplicate notifications, never toward silence.**
Every failure path — unreadable state, failed push, failed write — errs that way.

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
