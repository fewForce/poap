/**
 * Dates and numbers, the way poap.live writes them.
 *
 * An event's date is a bare ISO day with no timezone. Read it as UTC
 * throughout, or anybody west of Greenwich sees it a day early.
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseDay(iso: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The three pieces of the calendar tile. */
export function dateParts(iso: string | null | undefined): { mon: string; day: string; year: string } | null {
  const d = parseDay(iso);
  if (!d) return null;
  return { mon: MONTHS[d.getUTCMonth()] ?? "", day: String(d.getUTCDate()), year: String(d.getUTCFullYear()) };
}

/** "September 21, 2026". */
export function longDate(iso: string | null | undefined): string {
  const d = parseDay(iso);
  if (!d) return "";
  return `${MONTH_NAMES[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** A timestamp, as a day and a time: "21 Sep 2026 · 14:05". */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const mon = (MONTHS[d.getMonth()] ?? "").charAt(0) + (MONTHS[d.getMonth()] ?? "").slice(1).toLowerCase();
  return `${d.getDate()} ${mon} ${d.getFullYear()} · ${hh}:${mm}`;
}

export function number(n: number): string {
  return n.toLocaleString("en-US");
}

/** Turnout as a whole percentage, capped at 100. */
export function turnout(registered: number, attended: number): number {
  if (registered <= 0) return attended > 0 ? 100 : 0;
  return Math.min(100, Math.round((attended / registered) * 100));
}
