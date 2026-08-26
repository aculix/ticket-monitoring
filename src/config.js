// Configuration comes entirely from environment variables (see .env.example).
// Load a .env file with Node's built-in flag:
//   node --env-file-if-exists=.env src/index.js
import * as district from "./providers/district.js";
import * as bookmyshow from "./providers/bookmyshow.js";

const MODULES = { district, bookmyshow };

const env = (name, fallback = "") => process.env[name] ?? fallback;

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required — copy .env.example to .env and fill it in`);
  return v;
}

const num = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};

/** Old single-provider variable names, still honoured so v1 .env files keep working. */
function legacyDistrict() {
  if (!process.env.MOVIE_CODE || process.env.DISTRICT_MOVIE_CODE) return null;
  return {
    movieCode: env("MOVIE_CODE"),
    contentId: env("CONTENT_ID"),
    cityKey: env("CITY_KEY"),
    lat: env("LAT"),
    lng: env("LNG"),
    venueId: env("CINEMA_ID"),
    formatTag: process.env.FORMAT_TAG ?? "imax_2d",
    formatMatch: process.env.FORMAT_MATCH ?? "IMAX",
    bookingUrl: env("BOOKING_URL"),
  };
}

function districtConfig() {
  const legacy = legacyDistrict();
  if (legacy) return legacy;
  if (!process.env.DISTRICT_MOVIE_CODE) return null;
  return {
    movieCode: required("DISTRICT_MOVIE_CODE"),
    contentId: required("DISTRICT_CONTENT_ID"),
    cityKey: required("DISTRICT_CITY_KEY"),
    lat: required("DISTRICT_LAT"),
    lng: required("DISTRICT_LNG"),
    venueId: env("DISTRICT_CINEMA_ID"),
    formatTag: process.env.DISTRICT_FORMAT_TAG ?? "imax_2d",
    formatMatch: process.env.DISTRICT_FORMAT_MATCH ?? "IMAX",
    bookingUrl: env("DISTRICT_BOOKING_URL"),
  };
}

function bookmyshowConfig() {
  if (!process.env.BMS_EVENT_CODE) return null;
  return {
    eventCode: required("BMS_EVENT_CODE"),
    refEventCode: env("BMS_REF_EVENT_CODE"),
    regionCode: required("BMS_REGION_CODE"),
    regionSlug: env("BMS_REGION_SLUG", "").toLowerCase(),
    lat: env("BMS_LAT", "0"),
    lng: env("BMS_LNG", "0"),
    venueId: env("BMS_VENUE_CODE"),
    language: env("BMS_LANGUAGE"),
    formatMatch: process.env.BMS_FORMAT_MATCH ?? "IMAX",
    bookingUrl: env("BMS_BOOKING_URL"),
  };
}

export function loadConfig() {
  const targetDate = required("TARGET_DATE");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error(`TARGET_DATE must be YYYY-MM-DD, got "${targetDate}"`);
  }
  const tzOffsetMinutes = num("TZ_OFFSET_MINUTES", 330);

  // Retire at local midnight following the target date, unless overridden.
  const expiryUtc = process.env.EXPIRY_UTC ||
    new Date(Date.parse(`${targetDate}T00:00:00Z`) + 86400000 - tzOffsetMinutes * 60000).toISOString();

  const built = { district: districtConfig(), bookmyshow: bookmyshowConfig() };
  // PROVIDERS is an explicit allow-list; without it, every configured provider runs.
  const wanted = env("PROVIDERS").split(",").map((s) => s.trim()).filter(Boolean);
  for (const w of wanted) {
    if (!MODULES[w]) throw new Error(`Unknown provider "${w}" in PROVIDERS. Valid: ${Object.keys(MODULES).join(", ")}`);
  }
  const keys = (wanted.length ? wanted : Object.keys(built)).filter((k) => built[k]);
  if (!keys.length) {
    throw new Error("No provider configured. Set DISTRICT_MOVIE_CODE and/or BMS_EVENT_CODE (see .env.example)");
  }
  for (const w of wanted) {
    if (!built[w]) throw new Error(`PROVIDERS lists "${w}" but its settings are missing (see .env.example)`);
  }

  const providers = keys.map((k) => ({
    key: k,
    label: MODULES[k].label,
    module: MODULES[k],
    ...built[k],
  }));

  return {
    targetDate,
    providers,
    formatLabel: env("FORMAT_LABEL", "IMAX"),
    // Used by alerts that are not tied to one provider (heartbeat, retirement).
    bookingUrl: providers[0].bookingUrl || "",

    ntfyUrl: env("NTFY_URL", "https://ntfy.sh").replace(/\/+$/, ""),
    ntfyTopic: required("NTFY_TOPIC"),
    ntfyToken: env("NTFY_TOKEN"),

    intervalMs: num("CHECK_INTERVAL_SECONDS", 60) * 1000,
    failureThreshold: num("FAILURE_THRESHOLD", 6),
    tzOffsetMinutes,
    heartbeatHour: num("HEARTBEAT_HOUR", 9), // -1 disables the daily heartbeat
    currency: env("CURRENCY", "₹"),
    expiryUtc,

    statePath: env("STATE_PATH", "./state.json"),
    port: num("PORT", 4733),
    proxyUrl: env("PROXY_URL"),
    dispatcher: null, // set by attachProxy() when PROXY_URL is present
  };
}
