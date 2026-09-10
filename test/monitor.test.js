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

test("a 'not listed yet' note rides through to lastGood and the heartbeat", () => {
  const d = decideProvider(defaultProviderState(),
    { kind: "closed", now: T0, note: "not listed yet (District: content not found)" }, CFG, P);
  assert.equal(d.alerts.length, 0, "waiting for a listing is not an alert");
  assert.equal(d.baseState.lastGood.kind, "closed");
  assert.match(d.baseState.lastGood.note, /not listed yet/);

  const hb = decideGlobal(defaultState(), CFG, HB, [
    { label: "District", kind: "closed", note: "not listed yet (District: content not found)" },
    { label: "BookMyShow", kind: "closed" },
  ]);
  assert.match(hb.alerts[0].body, /District: closed, not listed yet/,
    "the daily heartbeat must say why District sees nothing, or silence is ambiguous");
  assert.match(hb.alerts[0].body, /BookMyShow: closed$/m);
});

test("clearing the note is itself a state change, so the status endpoint stops lying", () => {
  const withNote = decideProvider(defaultProviderState(), { kind: "closed", now: T0, note: "not listed yet" }, CFG, P).baseState;
  const after = decideProvider(withNote, { kind: "closed", now: T0 }, CFG, P);
  assert.equal(after.baseState.lastGood.note, null, "note is dropped once the listing appears");
});

// ------------------------------------------------ withdrawn and re-listed shows
//
// Cinemas publish early, pull the shows, then re-list them, often under the same
// session ids. If dedupe outlives the listing, the re-listing (the moment bookings
// really open) is silent. These pin down when a vanished session is forgotten.

const closed = (now = T0) => ({ kind: "closed", now });
const tick = (state, input, p = P) => apply(state, decideProvider(state, input, CFG, p));

test("a withdrawn session that comes back after 3 missed checks alerts again", () => {
  let s = tick(defaultProviderState(), openInput(EX_MATCH));
  assert.ok(s.sidsAlerted["111"], "alerted once");
  for (let i = 0; i < 3; i++) s = tick(s, closed());
  assert.equal(s.sidsAlerted["111"], undefined, "forgotten after 3 checks without it");

  const back = decideProvider(s, openInput(EX_MATCH), CFG, P);
  assert.equal(back.alerts.length, 1, "the re-listing must alert");
  assert.equal(back.alerts[0].priority, "5");
});

test("a session missing for fewer than 3 checks is not re-alerted", () => {
  let s = tick(defaultProviderState(), openInput(EX_MATCH));
  s = tick(s, closed());
  s = tick(s, closed());
  const back = decideProvider(s, openInput(EX_MATCH), CFG, P);
  assert.equal(back.alerts.length, 0, "a brief flicker in the response is not a new listing");
  assert.deepEqual(apply(s, back).missing, {}, "and the miss counter resets once it is seen again");
});

test("a fully withdrawn date re-arms after 3 closed checks and says so, once", () => {
  let s = tick(defaultProviderState(), openInput(EX_MATCH));
  assert.equal(s.dateOpenAlerted, true);
  s = tick(s, closed());
  s = tick(s, closed());
  const third = decideProvider(s, closed(), CFG, P);
  const notice = third.alerts.find((a) => /withdrawn/i.test(a.title));
  assert.ok(notice, "the user should hear that the shows were pulled");
  assert.ok(notice.title.includes("District"));
  assert.ok(Number(notice.priority) < 5, "informational, not a booking alert");
  s = apply(s, third);
  assert.equal(s.dateOpenAlerted, false, "re-armed");

  for (let i = 0; i < 5; i++) {
    assert.equal(decideProvider(s, closed(), CFG, P).alerts.length, 0, "the notice is not repeated");
    s = tick(s, closed());
  }
});

test("the re-arm does not depend on the withdrawal notice being delivered", () => {
  let s = tick(defaultProviderState(), openInput(EX_MATCH));
  s = tick(s, closed());
  s = tick(s, closed());
  const third = decideProvider(s, closed(), CFG, P);
  s = third.baseState; // ntfy was down: no alert patches merged
  assert.equal(s.dateOpenAlerted, false, "re-arming is not gated on the push");
  assert.equal(s.sidsAlerted["111"], undefined);
  assert.equal(decideProvider(s, openInput(EX_MATCH), CFG, P).alerts[0].priority, "5",
    "so a re-listing still gets through even if the notice was lost");
});

test("partial withdrawal forgets only the missing session, with no withdrawal notice", () => {
  const two = { ...EX_MATCH, matched: [EX_MATCH.matched[0], { ...EX_MATCH.matched[0], sid: "222", time: "1:15 PM" }] };
  let s = tick(defaultProviderState(), openInput(two));
  for (let i = 0; i < 3; i++) {
    const d = decideProvider(s, openInput(EX_MATCH), CFG, P); // 222 gone, date still open
    assert.equal(d.alerts.filter((a) => /withdrawn/i.test(a.title)).length, 0);
    s = apply(s, d);
  }
  assert.ok(s.sidsAlerted["111"], "the session still listed stays deduped");
  assert.equal(s.sidsAlerted["222"], undefined, "the pulled one is forgotten");

  const back = decideProvider(s, openInput(two), CFG, P);
  assert.equal(back.alerts.length, 1);
  assert.ok(back.alerts[0].body.includes("1:15 PM"), "only the returning session is announced");
  assert.ok(!back.alerts[0].body.includes("9:00 AM"));
});

test("failed checks do not count as a session being missing", () => {
  let s = tick(defaultProviderState(), openInput(EX_MATCH));
  for (let i = 0; i < 5; i++) s = tick(s, { kind: "error", reason: "HTTP 403", now: T0 });
  assert.ok(s.sidsAlerted["111"], "an outage says nothing about whether the show still exists");
  assert.equal(decideProvider(s, openInput(EX_MATCH), CFG, P).alerts.filter((a) => a.priority === "5").length, 0);
});

test("waiting on a date that never opened writes no state", () => {
  let s = tick(defaultProviderState(), closed());
  const next = decideProvider(s, closed(), CFG, P);
  assert.equal(JSON.stringify(apply(s, next)), JSON.stringify(s), "no counters ticking while nothing was ever alerted");
});
