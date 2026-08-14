// Configuration is read entirely from environment variables (see .env.example).
// Load a .env file with Node's built-in flag: node --env-file-if-exists=.env src/index.js

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

export function loadConfig() {
  const targetDate = required("TARGET_DATE");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error(`TARGET_DATE must be YYYY-MM-DD, got "${targetDate}"`);
  }
  const tzOffsetMinutes = num("TZ_OFFSET_MINUTES", 330);

  // Retire at local midnight following the target date, unless overridden.
  const expiryUtc = process.env.EXPIRY_UTC ||
    new Date(Date.parse(`${targetDate}T00:00:00Z`) + 86400000 - tzOffsetMinutes * 60000).toISOString();

  return {
    // what to watch
    movieCode: required("MOVIE_CODE"),
    contentId: required("CONTENT_ID"),
    cityKey: required("CITY_KEY"),
    lat: required("LAT"),
    lng: required("LNG"),
    targetDate,
    cinemaId: process.env.CINEMA_ID || "",          // empty = any cinema
    formatTag: process.env.FORMAT_TAG ?? "imax_2d", // empty + empty match = any format
    formatMatch: process.env.FORMAT_MATCH ?? "IMAX",
    formatLabel: process.env.FORMAT_LABEL || "IMAX",
    bookingUrl: process.env.BOOKING_URL || "",

    // notifications
    ntfyUrl: (process.env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, ""),
    ntfyTopic: required("NTFY_TOPIC"),
    ntfyToken: process.env.NTFY_TOKEN || "",

    // behaviour
    intervalMs: num("CHECK_INTERVAL_SECONDS", 60) * 1000,
    failureThreshold: num("FAILURE_THRESHOLD", 6),
    tzOffsetMinutes,
    heartbeatHour: num("HEARTBEAT_HOUR", 9), // -1 disables the daily heartbeat
    currency: process.env.CURRENCY || "₹",
    expiryUtc,

    // runtime
    statePath: process.env.STATE_PATH || "./state.json",
    port: num("PORT", 8080),
    proxyUrl: process.env.PROXY_URL || "",
    dispatcher: null, // set by attachProxy() when PROXY_URL is present
  };
}
