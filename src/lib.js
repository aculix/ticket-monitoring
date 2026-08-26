// Small shared helpers used by providers and the alert logic.

export class CheckError extends Error {}

/**
 * Providers report showtimes in local wall-clock terms. District returns UTC
 * timestamps, so they get shifted; BookMyShow already returns local strings.
 */
export function toLocalTime(showTime, tzOffsetMinutes) {
  let s = showTime;
  if (/T\d{2}:\d{2}$/.test(s)) s += ":00";
  if (!s.endsWith("Z")) s += "Z";
  const d = new Date(Date.parse(s) + tzOffsetMinutes * 60000);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** YYYY-MM-DD in the configured timezone. */
export function localDate(now, tzOffsetMinutes) {
  return new Date(now.getTime() + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
}

export function localMinutes(now, tzOffsetMinutes) {
  const d = new Date(now.getTime() + tzOffsetMinutes * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
