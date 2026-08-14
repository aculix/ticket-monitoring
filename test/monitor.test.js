import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guestToken, toLocalTime, extractSessions, decide, defaultState } from "../src/monitor.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/response-open-date.json", import.meta.url)), "utf8"));

// Matches the sample in .env.example: IMAX at one specific cinema, IST.
const CFG = {
  targetDate: "2026-08-10",
  expiryUtc: "2026-08-10T18:30:00Z",
  bookingUrl: "https://example.com/book",
  failureThreshold: 6,
  tzOffsetMinutes: 330,
  heartbeatHour: 9,
  formatTag: "imax_2d",
  formatMatch: "IMAX",
  formatLabel: "IMAX",
  cinemaId: "1032362",
  currency: "₹",
};

test("guestToken matches District's client-generated shape", () => {
  const t = guestToken();
  assert.match(t, /^\d{13}_\d{18}_[a-z0-9]{11}$/);
  assert.notEqual(guestToken(), t, "fresh token per call");
});

test("toLocalTime converts API UTC showTime to local clock time", () => {
  assert.equal(toLocalTime("2026-08-05T03:30", 330), "9:00 AM");  // verified against the site UI
  assert.equal(toLocalTime("2026-08-05T06:30", 330), "12:00 PM"); // noon boundary
  assert.equal(toLocalTime("2026-08-05T12:00", 330), "5:30 PM");
  assert.equal(toLocalTime("2026-08-05T18:45", 330), "12:15 AM"); // past midnight, clock time only
  assert.equal(toLocalTime("2026-08-05T03:30:00", 330), "9:00 AM"); // seconds already present
  assert.equal(toLocalTime("2026-08-05T03:30", 0), "3:30 AM");    // other timezones
});

test("extractSessions finds the target cinema's sessions in a real capture", () => {
  const ex = extractSessions(fixture, CFG);
  assert.equal(ex.cinemaCount, 5);
  assert.ok(ex.sessionCount > ex.matched.length);
  assert.equal(ex.matched.length, 4);
  assert.equal(ex.other.length, 0);
  const s = ex.matched[0];
  assert.equal(s.sid, "36874");
  assert.equal(s.cinema, "PVR Palladium Mall, Thaltej, Ahmedabad");
  assert.equal(s.time, "9:00 AM");
  assert.equal(s.audi, "SCREEN 9");
  assert.ok(s.tiers.includes("CLASSIC ₹260"));
  assert.ok(s.tiers.includes("RECLINER ₹640"));
  assert.equal(ex.showDates.at(-1), "2026-08-09");
});

test("extractSessions: no cinemaId watches every cinema; no format filter matches all", () => {
  const anyCinema = extractSessions(fixture, { ...CFG, cinemaId: "" });
  assert.equal(anyCinema.matched.length, 4, "still only IMAX sessions");
  assert.equal(anyCinema.other.length, 0, "nothing is 'other' when no cinema is targeted");

  const anyFormat = extractSessions(fixture, { ...CFG, cinemaId: "", formatTag: "", formatMatch: "" });
  assert.equal(anyFormat.matched.length, anyFormat.sessionCount, "every session matches");

  const otherCinema = extractSessions(fixture, { ...CFG, cinemaId: "125" });
  assert.equal(otherCinema.matched.length, 0);
  assert.equal(otherCinema.other.length, 4, "IMAX elsewhere becomes a secondary line");
});

test("extractSessions tolerates empty/malformed payloads", () => {
  assert.deepEqual(extractSessions({}, CFG),
    { matched: [], other: [], cinemaCount: 0, sessionCount: 0, showDates: [] });
});

const T0 = new Date("2026-08-06T02:00:00Z"); // before the 03:30 UTC (09:00 IST) heartbeat window
const openInput = (extract, now = T0) => ({ kind: "open", extract, now });
const EX_MATCH = {
  matched: [{ sid: "111", cinema: "Test Cinema", time: "9:00 AM", audi: "SCREEN 9", avail: 100, total: 300, tiers: "CLASSIC ₹260 (66/66)" }],
  other: [], cinemaCount: 3, sessionCount: 7, showDates: [],
};
const EX_NO_MATCH = { matched: [], other: [], cinemaCount: 3, sessionCount: 7, showDates: [] };
const EX_EMPTY = { matched: [], other: [], cinemaCount: 0, sessionCount: 0, showDates: [] };

/** Mirrors the runner: merge each alert's patch only after its push succeeds. */
function apply(state, decision) {
  let merged = decision.baseState;
  for (const a of decision.alerts) merged = { ...merged, ...a.statePatch };
  return merged;
}

test("closed steady state produces no alerts and no state change", () => {
  const s1 = apply(defaultState(), decide(defaultState(), { kind: "closed", now: T0 }, CFG));
  const d2 = decide(s1, { kind: "closed", now: new Date(T0.getTime() + 60000) }, CFG);
  assert.equal(d2.alerts.length, 0);
  assert.equal(JSON.stringify(apply(s1, d2)), JSON.stringify(s1), "no state write when nothing changed");
});

test("a match fires a max-priority alert once, re-firing only for new session ids", () => {
  const d1 = decide(defaultState(), openInput(EX_MATCH), CFG);
  assert.equal(d1.alerts.length, 1);
  assert.equal(d1.alerts[0].priority, "5");
  assert.ok(d1.alerts[0].statePatch.dateOpenAlerted, "first open response sets dateOpenAlerted");
  assert.ok(d1.alerts[0].statePatch.sidsAlerted["111"]);
  const s1 = apply(defaultState(), d1);
  assert.equal(decide(s1, openInput(EX_MATCH), CFG).alerts.length, 0, "deduped");

  const withNew = { ...EX_MATCH, matched: [...EX_MATCH.matched, { ...EX_MATCH.matched[0], sid: "222", time: "1:15 PM" }] };
  const d3 = decide(s1, openInput(withNew), CFG);
  assert.equal(d3.alerts.length, 1, "new session id re-alerts");
  assert.ok(d3.alerts[0].body.includes("1:15 PM"));
  assert.ok(!d3.alerts[0].body.includes("9:00 AM"), "already-alerted session not repeated");
});

test("sessions at other cinemas ride along as secondary lines, untracked", () => {
  const withOther = {
    ...EX_MATCH,
    other: [{ sid: "999", cinema: "Other Cinema", time: "6:00 PM", audi: "", avail: 50, total: 100, tiers: "CLASSIC ₹300 (50/100)" }],
  };
  const d = decide(defaultState(), openInput(withOther), CFG);
  assert.equal(d.alerts.length, 1, "no separate push for other venues");
  assert.ok(d.alerts[0].body.includes("Also at Other Cinema: 6:00 PM"));
  assert.ok(!d.alerts[0].statePatch.sidsAlerted["999"], "other-venue ids are not dedupe-tracked");
});

test("date open without a match fires DATE_OPEN once; a later match still fires", () => {
  const d1 = decide(defaultState(), openInput(EX_NO_MATCH), CFG);
  assert.equal(d1.alerts.length, 1);
  assert.equal(d1.alerts[0].priority, "4");
  const s1 = apply(defaultState(), d1);
  assert.equal(decide(s1, openInput(EX_NO_MATCH), CFG).alerts.length, 0);
  const d3 = decide(s1, openInput(EX_MATCH), CFG);
  assert.equal(d3.alerts.length, 1);
  assert.equal(d3.alerts[0].priority, "5");
});

test("failed match push then sessions vanish -> DATE_OPEN still reachable", () => {
  const d1 = decide(defaultState(), openInput(EX_MATCH), CFG);
  const s1 = d1.baseState; // push failed: statePatch not merged
  const d2 = decide(s1, openInput(EX_NO_MATCH), CFG);
  assert.equal(d2.alerts.length, 1);
  assert.equal(d2.alerts[0].priority, "4", "user still learns the date opened");
});

test("open-but-empty counts as closed", () => {
  const d = decide(defaultState(), openInput(EX_EMPTY), CFG);
  assert.equal(d.alerts.length, 0);
  assert.equal(d.baseState.lastGood.kind, "closed");
});

test("BROKEN fires at the threshold, once; RECOVERED on the next success", () => {
  let s = defaultState();
  for (let i = 1; i <= 5; i++) {
    const d = decide(s, { kind: "error", reason: "HTTP 403", now: T0 }, CFG);
    assert.equal(d.alerts.length, 0, `no alert at failure ${i}`);
    s = apply(s, d);
    assert.equal(s.failures, i);
  }
  const d6 = decide(s, { kind: "error", reason: "HTTP 403", now: T0 }, CFG);
  assert.equal(d6.alerts.length, 1);
  assert.ok(d6.alerts[0].title.includes("BROKEN"));
  s = apply(s, d6);
  assert.equal(decide(s, { kind: "error", reason: "HTTP 403", now: T0 }, CFG).alerts.length, 0, "not repeated");
  const d8 = decide(s, { kind: "closed", now: T0 }, CFG);
  assert.equal(d8.alerts.length, 1);
  assert.ok(d8.alerts[0].title.includes("recovered"));
  s = apply(s, d8);
  assert.equal(s.failures, 0);
  assert.equal(s.brokenAlerted, false);
});

test("heartbeat fires once per local day, never on error ticks, and can be disabled", () => {
  const hbTime = new Date("2026-08-06T03:31:00Z"); // 09:01 IST
  const early = new Date("2026-08-06T03:29:00Z");
  assert.equal(decide(defaultState(), { kind: "closed", now: early }, CFG).alerts.length, 0);

  const d1 = decide(defaultState(), { kind: "closed", now: hbTime }, CFG);
  assert.equal(d1.alerts.length, 1);
  assert.equal(d1.alerts[0].priority, "1");
  assert.equal(d1.alerts[0].statePatch.hbDate, "2026-08-06");

  const s1 = apply(defaultState(), d1);
  assert.equal(decide(s1, { kind: "closed", now: new Date("2026-08-06T09:00:00Z") }, CFG).alerts.length, 0, "once per day");
  assert.equal(decide(defaultState(), { kind: "error", reason: "x", now: hbTime }, CFG).alerts.length, 0, "not on errors");
  assert.equal(decide(defaultState(), { kind: "closed", now: hbTime }, { ...CFG, heartbeatHour: -1 }).alerts.length, 0, "disabled");
});

test("heartbeat reports the probe-refreshed showDates maximum", () => {
  const hbTime = new Date("2026-08-06T03:31:00Z");
  const d = decide(defaultState(), { kind: "closed", now: hbTime, probeMax: "2026-08-11" }, CFG);
  assert.equal(d.baseState.lastGood.showDatesMax, "2026-08-11", "probe result rides baseState");
  assert.ok(d.alerts[0].body.includes("2026-08-11"));
});

test("recovery, match and heartbeat can co-fire with disjoint patches", () => {
  const hbTime = new Date("2026-08-06T03:31:00Z");
  const s0 = { ...defaultState(), brokenAlerted: true, failures: 6 };
  const d = decide(s0, openInput(EX_MATCH, hbTime), CFG);
  assert.deepEqual(d.alerts.map((a) => a.priority), ["3", "5", "1"]);
  assert.deepEqual(d.alerts.map((a) => Object.keys(a.statePatch)),
    [["brokenAlerted"], ["sidsAlerted", "dateOpenAlerted"], ["hbDate"]]);
  const merged = apply(s0, d);
  assert.equal(merged.brokenAlerted, false);
  assert.equal(merged.failures, 0);
  assert.ok(merged.sidsAlerted["111"]);
  assert.equal(merged.hbDate, "2026-08-06");
});

test("retirement: one alert at expiry, then a permanent no-op", () => {
  const past = new Date("2026-08-10T18:31:00Z");
  const d1 = decide(defaultState(), { kind: "closed", now: past }, CFG);
  assert.equal(d1.alerts.length, 1);
  assert.ok(d1.alerts[0].statePatch.retired);
  const s1 = apply(defaultState(), d1);
  assert.equal(decide(s1, { kind: "closed", now: past }, CFG).alerts.length, 0);
});
