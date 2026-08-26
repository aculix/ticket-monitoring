# ticket-monitoring

[![docker](https://github.com/aculix/ticket-monitoring/actions/workflows/docker.yml/badge.svg)](https://github.com/aculix/ticket-monitoring/actions/workflows/docker.yml)

Watches [District](https://www.district.in) and [BookMyShow](https://in.bookmyshow.com)
showtimes and sends a max-priority push to your phone the second tickets go on sale for the
movie, date, format and cinema you care about.

![Example notification: IMAX shows for a target date, with showtimes, seat counts and prices](docs/alert.png)

I built this because IMAX shows kept selling out before I even knew they'd opened. Refreshing
the page a few times a day wasn't working. Now something else checks every 60 seconds and yells
at me when it matters.

## How it works

Every 60 seconds it calls the same showtime APIs the two sites use themselves, and filters the
result down to your cinema and format. When something matches, it pushes to
[ntfy](https://ntfy.sh), a free open-source notification service with iOS and Android apps.

Both sites can be watched at once, in one process. Each keeps its own dedupe and failure state,
so tickets appearing on one site never suppress the alert for the other, and one site going down
doesn't stop the other from being checked.

The part I care most about: silence always means "not open yet". If checks start failing you get
a *BROKEN* push after six failures in a row, naming the site that's failing, plus an optional
daily heartbeat. A monitor that died at 3am and one that's quietly working should never look the
same from the outside.

Alerts are deduplicated by session id, so you hear about each show once. Shows added later still
get through.

| Notification | Priority | What it means |
|---|---|---|
| `<FORMAT> <DATE> OPEN on <SITE> - BOOK NOW` | max | The one you're waiting for. Tap it to book. |
| `<DATE> is OPEN on <SITE> (no <FORMAT> yet)` | high | Date opened, your format hasn't shown up yet. |
| `<SITE> checks BROKEN - check manually` | high | That site's checks are failing. Don't trust the silence. |
| `<SITE> checks recovered` | default | Back to normal. |
| `Still watching <DATE>` | min | Daily heartbeat, with a line per site. |
| `Monitor retired` | default | Target date passed, so it stopped on its own. |

## Requirements

The [ntfy app](https://ntfy.sh/#subscribe-phone) on your phone, and either Docker or Node.js 22+.

## Quickest start: run the published image

A prebuilt image is published to GitHub Container Registry on every push to `main`, for both
`linux/amd64` and `linux/arm64`. It runs as-is on a normal server, an Apple Silicon Mac or a
Raspberry Pi, with nothing to clone and nothing to build.

Grab [`.env.example`](.env.example), save it as `.env`, fill it in using "Finding your IDs"
below, then:

```bash
docker run -d --name ticket-monitoring \
  --restart unless-stopped \
  --env-file .env \
  -p 4733:4733 \
  -v ticket-monitoring-data:/data \
  ghcr.io/aculix/ticket-monitoring:latest
```

```bash
docker logs -f ticket-monitoring
```

You want to see a line per site once a minute, like `[district] closed | matched: 0 | failures: 0`.

The volume is what stops it re-alerting you about shows it already found, so keep it around
across restarts. Drop the `-p` flag if you don't want the status endpoint reachable. To update,
pull the image again and recreate the container:

```bash
docker pull ghcr.io/aculix/ticket-monitoring:latest
docker rm -f ticket-monitoring   # then re-run the docker run command above
```

Only `:latest` is published, so that's always the current build of `main`.

## Quick start with Docker Compose

Handy if you'd rather keep the config in a file you can edit in place:

```bash
git clone https://github.com/aculix/ticket-monitoring.git
cd ticket-monitoring
cp .env.example .env      # edit it, see "Finding your IDs" below
docker compose up -d      # add --build to build locally instead of pulling
docker compose logs -f
```

## Quick start without Docker

```bash
npm install
cp .env.example .env      # edit it
npm run check             # one check against every configured site
npm start                 # run it for real
```

Run `npm run check` first. It's the fastest way to find out you got an ID wrong, and much less
annoying than discovering it three hours into a run. Needs Node 22+ for the built-in `--env-file`
support.

## Finding your IDs

Configure either site, or both. Skip a site by leaving its main ID unset: no
`DISTRICT_MOVIE_CODE` means District isn't watched, no `BMS_EVENT_CODE` means BookMyShow isn't.

### District

Everything is sitting in the movie's page URL for your city:

```
https://www.district.in/movies/the-odyssey-movie-tickets-in-ahmedabad-MV187151?frmtid=y7EZNLXN5Y&fromdate=2026-09-25
                                                          └── CITY_KEY ──┘ └CONTENT_ID┘        └─MOVIE_CODE─┘
```

- `DISTRICT_CONTENT_ID` is the number after `MV`
- `DISTRICT_MOVIE_CODE` is the `frmtid` parameter, which pins down the movie *and* the language
- `DISTRICT_CITY_KEY` is the city slug in the path
- `DISTRICT_LAT` and `DISTRICT_LNG` can be any coordinates inside that city. The API refuses to
  answer without them, though results are city-wide either way.
- `DISTRICT_BOOKING_URL` is the whole URL with `fromdate` set to your target date

### BookMyShow

From the movie's page URL:

```
https://in.bookmyshow.com/movies/ahmedabad/avengers-endgame-encore/ET00514163
                                  └REGION_SLUG┘                    └EVENT_CODE┘
```

- `BMS_EVENT_CODE` is the `ET...` code
- `BMS_REGION_SLUG` is the city slug, and `BMS_REGION_CODE` is the short code BMS uses internally
  (`AHD` for Ahmedabad). If you don't know yours, open a showtimes page for your city and look at
  the `regionCode` parameter in the network request, or try the obvious abbreviation.
- `BMS_REF_EVENT_CODE` only matters when a URL carries a `refEventCode` that differs from the
  event code, which happens for format-specific listings. Leave it unset otherwise.

### Both

`DISTRICT_CINEMA_ID` and `BMS_VENUE_CODE` restrict alerts to one cinema. The fiddly part is that
neither is in the URL. Easiest approach: leave them empty at first, which watches every cinema in
the city, run `npm run check`, and read the ids out of the output. Or leave them empty for good
and let the alert tell you where the shows are.

Want any format, not only IMAX? Clear `DISTRICT_FORMAT_TAG`, `DISTRICT_FORMAT_MATCH` and
`BMS_FORMAT_MATCH`.

## Configuration

Everything is environment variables. `.env` is only a convenient place to put them. Full list
with comments in [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `TARGET_DATE` | *required* | The date you're waiting for, `YYYY-MM-DD` |
| `NTFY_TOPIC` | *required* | The topic you subscribe to. Treat it like a password. |
| `DISTRICT_MOVIE_CODE` | | Set to watch District. Plus `DISTRICT_CONTENT_ID`, `DISTRICT_CITY_KEY`, `DISTRICT_LAT`, `DISTRICT_LNG` |
| `DISTRICT_CINEMA_ID` | *(any)* | Restrict District to one cinema |
| `DISTRICT_FORMAT_TAG` | `imax_2d` | Session tag that counts as a match |
| `DISTRICT_FORMAT_MATCH` | `IMAX` | Screen-format substring that counts as a match |
| `DISTRICT_BOOKING_URL` | | Opens when you tap a District notification |
| `BMS_EVENT_CODE` | | Set to watch BookMyShow. Plus `BMS_REGION_CODE`, `BMS_REGION_SLUG` |
| `BMS_VENUE_CODE` | *(any)* | Restrict BookMyShow to one cinema |
| `BMS_FORMAT_MATCH` | `IMAX` | Screen-format substring that counts as a match |
| `BMS_LANGUAGE` | *(all)* | Restrict to one language's shows |
| `BMS_BOOKING_URL` | | Opens when you tap a BookMyShow notification |
| `PROVIDERS` | *(all configured)* | Allow-list, e.g. `district` to temporarily watch only one |
| `FORMAT_LABEL` | `IMAX` | What the format is called in the alert text |
| `NTFY_URL` | `https://ntfy.sh` | Your own ntfy server, if you run one |
| `NTFY_TOKEN` | | Only if your server wants auth |
| `CHECK_INTERVAL_SECONDS` | `60` | Poll interval |
| `FAILURE_THRESHOLD` | `6` | Failures in a row before the BROKEN alert |
| `TZ_OFFSET_MINUTES` | `330` | Timezone for showtimes and dates, 330 is IST |
| `HEARTBEAT_HOUR` | `9` | Local hour for the daily heartbeat, `-1` turns it off |
| `CURRENCY` | `₹` | Price prefix |
| `EXPIRY_UTC` | *auto* | When to retire. Defaults to local midnight after `TARGET_DATE`. |
| `STATE_PATH` | `./state.json` | Where dedupe state lives, `/data/state.json` in Docker |
| `PORT` | `4733` | Status endpoint |
| `PROXY_URL` | | SOCKS5 proxy for District checks, see below |

v1 used flat names (`MOVIE_CODE`, `CINEMA_ID` and friends) for District. Those still work, so an
existing `.env` keeps running unchanged.

## Status endpoint

While running continuously it serves JSON on `PORT`, which defaults to 4733:

- `/` gives you state and `lastTick` per site, plus `proxied`
- `/?force=1` adds a live check of every site right now, with no notifications and no state changes
- `/healthz` returns `{"ok":true}`

```bash
curl -s localhost:4733/ | jq
```

Watch `lastTick`. If a site's entry is more than a couple of minutes old, the loop is stuck.

## Troubleshooting

### District returns HTTP 403

District's WAF is blocking your host. This happens reliably on cloud providers. An earlier
version of this ran as a Cloudflare Worker, worked fine for two days, then got blocked
permanently, while a home connection was never touched once. Either run it from a residential
connection, or point `PROXY_URL` at a SOCKS5 proxy. Only the site checks go through the proxy.
Notifications stay direct, so your alerts don't depend on it.

### BookMyShow returns HTTP 403

BookMyShow blocks on the TLS fingerprint of the client, not on your IP, which is why plain
`curl` and Node's `fetch` both get 403 no matter which headers or cookies you send. A proxy
won't help either. This is handled with [impit](https://github.com/apify/impit), which performs
the request with a real Chrome fingerprint. If you see 403s here, the impersonation has probably
stopped matching, so try updating the image or `npm update impit`.

### ntfy returns HTTP 429

Public ntfy.sh rate-limits by IP, and shared cloud egress IPs are usually spent already by other
people. Self-host ntfy and set `NTFY_URL`, or run from home.

### Notifications arrive, but silently

That's your phone, not the monitor. Open the subscription in the ntfy app and let max-priority
messages through Do Not Disturb.

### Alerts repeat, or never arrive again

Dedupe lives in the state file at `STATE_PATH`, or in the `data/` volume under Docker. Delete it
to start fresh. Do this whenever you change `TARGET_DATE`, otherwise it still thinks it has
already told you about those shows.

### Nothing happens at all

Run `npm run check` for a single noisy check. Configuration problems are reported explicitly.

## Development

```bash
npm test        # 24 tests, no network needed
```

The tests run the alert state machine and both site parsers against real captured API responses
in `test/fixtures/`. Layout:

- `src/providers/district.js` and `src/providers/bookmyshow.js` fetch and normalize showtimes.
  Each exports `check()` and `extract()`, and nothing else knows which site a session came from.
- `src/monitor.js` decides what to alert about and when to stay quiet
- `src/index.js` is the runner, state file and status server
- `src/config.js` reads the environment
- `src/lib.js` has the shared time helpers

Adding a third site means writing one file in `src/providers/` and registering it in
`config.js`. [docs/design-notes.md](docs/design-notes.md) covers what I learned about both APIs
and why the alert logic is shaped the way it is.

## Notes

This polls public endpoints once a minute, which is roughly what a person refreshing the page
would do, to buy their own tickets. It doesn't automate purchases, hold seats or skip any queue.
Please keep it that way: don't drop the interval, don't run ten copies, don't use it to scalp.

Not affiliated with District, BookMyShow, PVR or IMAX. Both APIs are undocumented and can change
whenever they feel like it.

## License

MIT, see [LICENSE](LICENSE).
