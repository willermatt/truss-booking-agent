/**
 * Checks Spectora's Review step against the request before anything is submitted: the services, the
 * property, the date and the time. Any mismatch stops the job as NEEDS_INPUT; nothing is submitted.
 * The price is not checked: Spectora sets it, and it is recorded with the result (`spectoraShown`).
 */
import type { PreparedJob, ReviewSummary } from './driver.js';
import { compareProperty, parseAddress } from './address.js';

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();


const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const MONTH_PREFIXES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthNo = (name: string) => MONTH_PREFIXES.indexOf(name.slice(0, 3)) + 1;
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Every date the text mentions, as yyyy-mm-dd, or null for a mention without a four-digit year
 * ("November 12", "11/12", "11/12/26").
 */
export function datesIn(text: string): (string | null)[] {
  const t = squash(text);
  const found: { at: number; end: number; date: string | null }[] = [];
  const take = (re: RegExp, f: (m: RegExpExecArray) => string | null) => {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      const end = at + m[0].length;
      if (found.some((x) => at < x.end && end > x.at)) continue;   // already read by an earlier pattern
      found.push({ at, end, date: f(m) });
    }
  };
  const full = (y: string | undefined, m: number, d: number) => (y && y.length === 4 ? iso(Number(y), m, d) : null);
  take(/(?<![0-9-])(\d{4})-(\d{1,2})-(\d{1,2})(?![0-9])/g, (m) => iso(Number(m[1]), Number(m[2]), Number(m[3])));
  take(/(?<![0-9/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![0-9/])/g, (m) => full(m[3], Number(m[1]), Number(m[2])));
  take(new RegExp(`(?<![a-z])${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![0-9])(?:,?\\s+(\\d{4})(?![0-9]))?`, 'g'),
       (m) => full(m[3], monthNo(m[1]), Number(m[2])));
  take(new RegExp(`(?<![0-9])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?![a-z])(?:,?\\s+(\\d{4})(?![0-9]))?`, 'g'),
       (m) => full(m[3], monthNo(m[2]), Number(m[1])));
  return found.sort((a, b) => a.at - b.at).map((x) => x.date);
}

/** The Review must name the date with its year, and every date it names must be that date. */
function dateMatches(text: string, isoDate: string): boolean {
  const dates = datesIn(text);
  return dates.length > 0 && dates.every((d) => d === isoDate);
}

/**
 * Every clock time the text mentions, as minutes after midnight, in order; NaN for one that cannot be read
 * without guessing ("8:00" with no AM/PM, "13:00 PM", "8:00:30 AM").
 */
export function timesIn(text: string): number[] {
  const t = squash(text);
  const out: number[] = [];
  for (const m of t.matchAll(/(?<![0-9:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?(?![a-z]))?(?![0-9:])/g)) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    const sec = m[3] === undefined ? 0 : Number(m[3]);
    const ap = m[4];
    if (min > 59 || sec !== 0) { out.push(NaN); continue; }
    if (ap) out.push(h >= 1 && h <= 12 ? ((h % 12) + (ap === 'p' ? 12 : 0)) * 60 + min : NaN);
    else out.push(h >= 13 && h <= 23 ? h * 60 + min : NaN);    // 24-hour only where it cannot be read as 12-hour
  }
  return out;
}

/** The Review shows exactly one time, the appointment's start, and it is the requested time exactly. */
function timeMatches(text: string, hhmm: string): boolean {
  const [h, m] = hhmm.split(':').map(Number);
  const times = timesIn(text);
  return times.length === 1 && times[0] === h * 60 + m;
}

export function validateReview(job: PreparedJob, s: ReviewSummary): { ok: true } | { ok: false; reason: string; detail: string } {
  const expected = [job.services.service.label, ...job.services.addOns.map((a) => a.label)].map(squash);
  const shown = s.lines.map((l) => squash(l.name));
  const missing = expected.filter((e) => !shown.includes(e));
  const extra = shown.filter((x) => !expected.includes(x));
  if (missing.length || extra.length) {
    return { ok: false, reason: 'review_services_mismatch',
             detail: `missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}` };
  }

  if (!reviewShowsProperty(job, s.addressText)) {
    return { ok: false, reason: 'review_address_mismatch', detail: `Review shows "${s.addressText}"` };
  }
  if (!dateMatches(s.dateText, job.request.appointment.date)) {
    return { ok: false, reason: 'review_date_mismatch', detail: `Review shows "${s.dateText}"` };
  }
  if (!timeMatches(s.timeText, job.request.appointment.time)) {
    return { ok: false, reason: 'review_time_mismatch', detail: `Review shows "${s.timeText}"` };
  }

  return { ok: true };
}

/**
 * The Review's address ("<street> <unit>, <City>, <ST> <ZIP>", as Spectora prints it) must be the same
 * property as the request: directional, street, type, unit and ZIP all agreeing, not just the number.
 */
export function reviewShowsProperty(job: PreparedJob, addressText: string): boolean {
  const r = job.request.property;
  const comma = addressText.indexOf(',');
  if (comma < 0) return false;
  let street = addressText.slice(0, comma).replace(/\s+/g, ' ').trim();
  const locality = squash(addressText.slice(comma + 1));
  let unit = '';
  if (r.unit) {
    const u = r.unit.replace(/\s+/g, ' ').trim();
    if (!squash(street).endsWith(` ${squash(u)}`)) return false;
    street = street.slice(0, street.length - u.length).trim();
    unit = u;
  }
  const zip = locality.match(/\b(\d{5})(-\d{4})?\b/)?.[1] ?? '';
  if (zip !== r.zip.slice(0, 5)) return false;
  const city = squash(r.city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[^a-z0-9])${city}([^a-z0-9]|$)`).test(locality) || !/\b(az|arizona)\b/.test(locality)) return false;
  return compareProperty(parseAddress(street, unit, zip), parseAddress(r.street, r.unit, r.zip)) === 'same';
}

/** What Spectora showed on the Review, recorded with the job for the owner's reference. */
export interface SpectoraShown {
  totalUsd: number | null;
  lines: { name: string; amountUsd: number | null }[];
  squareFeet: string | null;
  yearBuilt: string | null;
}

export function spectoraShown(s: ReviewSummary): SpectoraShown {
  return { totalUsd: s.totalUsd, lines: s.lines,
           squareFeet: s.propertyFacts?.squareFeet || null, yearBuilt: s.propertyFacts?.yearBuilt || null };
}
