import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideProvider, decideGlobal, defaultProviderState, defaultState, providerState, heartbeatDue,
} from "../src/monitor.js";

const CFG = {
  targetDate: "2026-09-25",
  expiryUtc: "2026-09-25T18:30:00Z",
  bookingUrl: "https://example.com/book",
  failureThreshold: 6,
  tzOffsetMinutes: 330,
  heartbeatHour: 9,
  formatLabel: "IMAX",
  currency: "₹",
};
const P = { key: "district", label: "District", bookingUrl: "https://example.com/d" };
const P2 = { key: "bookmyshow", label: "BookMyShow", bookingUrl: "https://example.com/b" };

const T0 = new Date("2026-09-20T02:00:00Z"); // before the 03:30 UTC (09:00 IST) heartbeat window
const HB = new Date("2026-09-20T03:31:00Z"); // inside it
const openInput = (extract, now = T0) => ({ kind: "open", extract, now });

const EX_MATCH = {
  matched: [{ sid: "111", cinema: "Test Cinema", time: "9:00 AM", audi: "SCREEN 9", format: "IMAX", avail: 100, total: 300, tiers: "CLASSIC ₹260 (66/66)" }],
  other: [], cinemaCount: 3, sessionCount: 7, showDates: [],
};
const EX_NO_MATCH = { matched: [], other: [], cinemaCount: 3, sessionCount: 7, showDates: [] };
const EX_EMPTY = { matched: [], other: [], cinemaCount: 0, sessionCount: 0, showDates: [] };

/** Mirrors the runner: merge each alert's patch only after its push succeeds. */
function apply(pstate, decision) {
  let merged = decision.baseState;
  for (const a of decision.alerts) merged = { ...merged, ...a.statePatch };
  return merged;
}

test("closed steady state produces no alerts and no state change", () => {
  const s1 = apply(defaultProviderState(), decideProvider(defaultProviderState(), { kind: "closed", now: T0 }, CFG, P));
  const d2 = decideProvider(s1, { kind: "closed", now: new Date(T0.getTime() + 60000) }, CFG, P);
  assert.equal(d2.alerts.length, 0);
  assert.equal(JSON.stringify(apply(s1, d2)), JSON.stringify(s1), "no state write when nothing changed");
});

test("a match fires a max-priority alert once, re-firing only for new session ids", () => {
  const d1 = decideProvider(defaultProviderState(), openInput(EX_MATCH), CFG, P);
  assert.equal(d1.alerts.length, 1);
  assert.equal(d1.alerts[0].priority, "5");
  assert.equal(d1.alerts[0].provider, "district", "alerts carry their provider");
  assert.ok(d1.alerts[0].title.includes("District"), "the site is named in the title");
  assert.ok(d1.alerts[0].statePatch.dateOpenAlerted, "first open response sets dateOpenAlerted");
  assert.ok(d1.alerts[0].statePatch.sidsAlerted["111"]);

  const s1 = apply(defaultProviderState(), d1);
  assert.equal(decideProvider(s1, openInput(EX_MATCH), CFG, P).alerts.length, 0, "deduped");

  const withNew = { ...EX_MATCH, matched: [...EX_MATCH.matched, { ...EX_MATCH.matched[0], sid: "222", time: "1:15 PM" }] };
  const d3 = decideProvider(s1, openInput(withNew), CFG, P);
  assert.equal(d3.alerts.length, 1, "new session id re-alerts");
  assert.ok(d3.alerts[0].body.includes("1:15 PM"));
  assert.ok(!d3.alerts[0].body.includes("9:00 AM"), "already-alerted session not repeated");
});

test("sessions without seat counts still render (BookMyShow shape)", () => {
  const bmsLike = {
    matched: [{ sid: "37929", cinema: "PVR: Palladium", time: "08:00 AM", audi: "", format: "IMAX", avail: null, total: null, tiers: "CLASSIC ₹470 (AVAILABLE)" }],
    other: [], cinemaCount: 1, sessionCount: 5, showDates: [],
  };
  const d = decideProvider(defaultProviderState(), openInput(bmsLike), CFG, P2);
  const body = d.alerts[0].body;
  assert.ok(body.includes("08:00 AM | PVR: Palladium | IMAX"), body);
  assert.ok(!body.includes("seats"), "no seat counts when the provider has none");
  assert.ok(d.alerts[0].title.includes("BookMyShow"));
});

test("sessions at other venues ride along as secondary lines, untracked", () => {
  const withOther = {
    ...EX_MATCH,
    other: [{ sid: "999", cinema: "Other Cinema", time: "6:00 PM", audi: "", format: "IMAX", avail: null, total: null, tiers: "" }],
  };
  const d = decideProvider(defaultProviderState(), openInput(withOther), CFG, P);
  assert.equal(d.alerts.length, 1, "no separate push for other venues");
  assert.ok(d.alerts[0].body.includes("Also at Other Cinema: 6:00 PM"));
  assert.ok(!d.alerts[0].statePatch.sidsAlerted["999"], "other-venue ids are not dedupe-tracked");
});

test("date open without a match fires once; a later match still fires", () => {
  const d1 = decideProvider(defaultProviderState(), openInput(EX_NO_MATCH), CFG, P);
  assert.equal(d1.alerts.length, 1);
  assert.equal(d1.alerts[0].priority, "4");
  const s1 = apply(defaultProviderState(), d1);
  assert.equal(decideProvider(s1, openInput(EX_NO_MATCH), CFG, P).alerts.length, 0);
  const d3 = decideProvider(s1, openInput(EX_MATCH), CFG, P);
  assert.equal(d3.alerts.length, 1);
  assert.equal(d3.alerts[0].priority, "5");
});

test("failed match push then sessions vanish -> date-open alert still reachable", () => {
  const d1 = decideProvider(defaultProviderState(), openInput(EX_MATCH), CFG, P);
  const s1 = d1.baseState; // push failed: statePatch not merged
  const d2 = decideProvider(s1, openInput(EX_NO_MATCH), CFG, P);
  assert.equal(d2.alerts.length, 1);
  assert.equal(d2.alerts[0].priority, "4", "user still learns the date opened");
});

test("open-but-empty counts as closed", () => {
  const d = decideProvider(defaultProviderState(), openInput(EX_EMPTY), CFG, P);
  assert.equal(d.alerts.length, 0);
  assert.equal(d.baseState.lastGood.kind, "closed");
});

test("BROKEN fires at the threshold, once, and names the site; RECOVERED on next success", () => {
  let s = defaultProviderState();
  for (let i = 1; i <= 5; i++) {
    const d = decideProvider(s, { kind: "error", reason: "HTTP 403", now: T0 }, CFG, P2);
    assert.equal(d.alerts.length, 0, `no alert at failure ${i}`);
    s = apply(s, d);
    assert.equal(s.failures, i);
  }
  const d6 = decideProvider(s, { kind: "error", reason: "HTTP 403", now: T0 }, CFG, P2);
  assert.equal(d6.alerts.length, 1);
  assert.ok(d6.alerts[0].title.includes("BookMyShow"));
  assert.ok(d6.alerts[0].title.includes("BROKEN"));
  s = apply(s, d6);
  assert.equal(decideProvider(s, { kind: "error", reason: "HTTP 403", now: T0 }, CFG, P2).alerts.length, 0, "not repeated");
  const d8 = decideProvider(s, { kind: "closed", now: T0 }, CFG, P2);
  assert.equal(d8.alerts.length, 1);
  assert.ok(d8.alerts[0].title.includes("recovered"));
  s = apply(s, d8);
  assert.equal(s.failures, 0);
  assert.equal(s.brokenAlerted, false);
});

test("providers keep independent dedupe state", () => {
  const state = defaultState();
  const dA = decideProvider(providerState(state, "district"), openInput(EX_MATCH), CFG, P);
  state.providers.district = apply(providerState(state, "district"), dA);
  // BookMyShow has never alerted, so the same session id must still notify there.
  const dB = decideProvider(providerState(state, "bookmyshow"), openInput(EX_MATCH), CFG, P2);
  assert.equal(dB.alerts.length, 1, "one site alerting must not silence the other");
  assert.ok(dB.alerts[0].title.includes("BookMyShow"));
  assert.equal(decideProvider(providerState(state, "district"), openInput(EX_MATCH), CFG, P).alerts.length, 0);
});

test("providerState defaults unknown providers and preserves stored ones", () => {
  const state = { ...defaultState(), providers: { district: { failures: 3 } } };
  assert.equal(providerState(state, "district").failures, 3);
  assert.equal(providerState(state, "district").brokenAlerted, false, "missing fields are defaulted");
  assert.deepEqual(providerState(state, "bookmyshow"), defaultProviderState());
});

// ---------------------------------------------------------- global alerts

test("heartbeat fires once per local day, summarises every provider, and can be disabled", () => {
  const summaries = [
    { label: "District", kind: "closed", showDatesMax: "2026-09-20" },
    { label: "BookMyShow", kind: "closed" },
  ];
  assert.equal(decideGlobal(defaultState(), CFG, new Date("2026-09-20T03:29:00Z"), summaries).alerts.length, 0, "before the window");

  const d = decideGlobal(defaultState(), CFG, HB, summaries);
  assert.equal(d.alerts.length, 1);
  assert.equal(d.alerts[0].priority, "1");
  assert.ok(d.alerts[0].body.includes("District: closed (open through 2026-09-20)"));
  assert.ok(d.alerts[0].body.includes("BookMyShow: closed"));
  assert.equal(d.alerts[0].statePatch.hbDate, "2026-09-20");

  const after = { ...defaultState(), hbDate: "2026-09-20" };
  assert.equal(decideGlobal(after, CFG, new Date("2026-09-20T09:00:00Z"), summaries).alerts.length, 0, "once per day");
  assert.equal(decideGlobal(defaultState(), { ...CFG, heartbeatHour: -1 }, HB, summaries).alerts.length, 0, "disabled");
});

test("heartbeatDue tracks the local day, so it is not fooled by UTC rollover", () => {
  assert.equal(heartbeatDue({ hbDate: "" }, HB, CFG), true);
  assert.equal(heartbeatDue({ hbDate: "2026-09-20" }, HB, CFG), false);
});

test("retirement: one alert at expiry, then a permanent no-op", () => {
  const past = new Date("2026-09-25T18:31:00Z");
  const d1 = decideGlobal(defaultState(), CFG, past, []);
  assert.equal(d1.alerts.length, 1);
  assert.ok(d1.alerts[0].statePatch.retired);
  const s1 = { ...defaultState(), ...d1.alerts[0].statePatch };
  assert.equal(decideGlobal(s1, CFG, past, []).alerts.length, 0);
});

test("retirement takes precedence over the heartbeat", () => {
  const past = new Date("2026-09-26T03:31:00Z"); // after expiry and inside the heartbeat window
  const d = decideGlobal(defaultState(), CFG, past, []);
  assert.equal(d.alerts.length, 1);
  assert.ok(d.alerts[0].title.includes("retired"));
});
