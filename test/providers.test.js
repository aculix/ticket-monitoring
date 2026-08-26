import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toLocalTime, localDate } from "../src/lib.js";
import * as district from "../src/providers/district.js";
import * as bms from "../src/providers/bookmyshow.js";

const load = (f) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), "utf8"));
const CFG = { tzOffsetMinutes: 330, currency: "₹" };

test("toLocalTime converts API UTC timestamps to local clock time", () => {
  assert.equal(toLocalTime("2026-08-05T03:30", 330), "9:00 AM");  // verified against the site UI
  assert.equal(toLocalTime("2026-08-05T06:30", 330), "12:00 PM"); // noon boundary
  assert.equal(toLocalTime("2026-08-05T12:00", 330), "5:30 PM");
  assert.equal(toLocalTime("2026-08-05T18:45", 330), "12:15 AM"); // past midnight, clock time only
  assert.equal(toLocalTime("2026-08-05T03:30:00", 330), "9:00 AM"); // seconds already present
  assert.equal(toLocalTime("2026-08-05T03:30", 0), "3:30 AM");    // other timezones
});

test("localDate rolls over at local midnight, not UTC midnight", () => {
  assert.equal(localDate(new Date("2026-08-05T19:00:00Z"), 330), "2026-08-06");
  assert.equal(localDate(new Date("2026-08-05T17:00:00Z"), 330), "2026-08-05");
});

// ---------------------------------------------------------------- District

const D_PARAMS = { venueId: "1032362", formatTag: "imax_2d", formatMatch: "IMAX" };

test("district: extracts the target cinema's sessions from a real capture", () => {
  const ex = district.extract(load("response-open-date.json"), CFG, D_PARAMS);
  assert.equal(ex.cinemaCount, 5);
  assert.ok(ex.sessionCount > ex.matched.length);
  assert.equal(ex.matched.length, 4);
  assert.equal(ex.other.length, 0);
  const s = ex.matched[0];
  assert.equal(s.sid, "36874");
  assert.equal(s.cinema, "PVR Palladium Mall, Thaltej, Ahmedabad");
  assert.equal(s.time, "9:00 AM");
  assert.equal(s.audi, "SCREEN 9");
  assert.equal(s.avail, 103); // District reports exact seat counts
  assert.ok(s.tiers.includes("CLASSIC ₹260"));
  assert.ok(s.tiers.includes("RECLINER ₹640"));
  assert.equal(ex.showDates.at(-1), "2026-08-09");
});

test("district: no venue watches every cinema, no format filter matches everything", () => {
  const data = load("response-open-date.json");
  const anyVenue = district.extract(data, CFG, { ...D_PARAMS, venueId: "" });
  assert.equal(anyVenue.matched.length, 4, "still only IMAX");
  assert.equal(anyVenue.other.length, 0);

  const anyFormat = district.extract(data, CFG, { venueId: "", formatTag: "", formatMatch: "" });
  assert.equal(anyFormat.matched.length, anyFormat.sessionCount);

  const elsewhere = district.extract(data, CFG, { ...D_PARAMS, venueId: "125" });
  assert.equal(elsewhere.matched.length, 0);
  assert.equal(elsewhere.other.length, 4, "IMAX at another venue becomes a secondary line");
});

test("district: tolerates empty payloads", () => {
  assert.deepEqual(district.extract({}, CFG, D_PARAMS),
    { matched: [], other: [], cinemaCount: 0, sessionCount: 0, showDates: [] });
});

// ------------------------------------------------------------- BookMyShow

const B_PARAMS = { venueId: "PPAM", formatMatch: "IMAX" };

test("bookmyshow: date codes drop the dashes", () => {
  assert.equal(bms.toDateCode("2026-09-25"), "20260925");
});

test("bookmyshow: extracts venue sessions and per-tier availability from a real capture", () => {
  const ex = bms.extract(load("bms-open-date.json"), CFG, B_PARAMS);
  assert.equal(ex.cinemaCount, 1);
  assert.equal(ex.sessionCount, 5);
  assert.equal(ex.matched.length, 5);
  const s = ex.matched[0];
  assert.equal(s.sid, "37929");
  assert.equal(s.cinema, "PVR: Palladium Mall, Ahmedabad");
  assert.equal(s.time, "08:00 AM"); // already local, so it is passed through untouched
  assert.equal(s.format, "IMAX");
  assert.equal(s.avail, null, "BMS never exposes exact seat counts");
  assert.ok(s.tiers.includes("RECLINER ₹960 (ALMOST FULL)"));
  assert.ok(s.tiers.includes("CLASSIC ₹470 (AVAILABLE)"));
});

test("bookmyshow: a different venue code moves sessions to the secondary bucket", () => {
  const ex = bms.extract(load("bms-open-date.json"), CFG, { ...B_PARAMS, venueId: "XXXX" });
  assert.equal(ex.matched.length, 0);
  assert.equal(ex.other.length, 5);
});

test("bookmyshow: a non-matching format filter yields nothing", () => {
  const ex = bms.extract(load("bms-open-date.json"), CFG, { ...B_PARAMS, formatMatch: "4DX" });
  assert.equal(ex.matched.length, 0);
  assert.equal(ex.sessionCount, 5, "sessions are still counted, just not matched");
});

test("bookmyshow: a not-yet-on-sale response has no widgets and extracts to nothing", () => {
  const closed = load("bms-closed-date.json");
  assert.equal(closed.data.showtimeWidgets, undefined, "this is how 'not open yet' looks");
  assert.deepEqual(bms.extract(closed, CFG, B_PARAMS),
    { matched: [], other: [], cinemaCount: 0, sessionCount: 0, showDates: [] });
});
