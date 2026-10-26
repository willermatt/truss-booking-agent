/**
 * Pre-submission duplicate check against Spectora, using only the supported read-only API.
 *
 * For every non-canceled Spectora inspection within ±DUPLICATE_WINDOW_DAYS of the requested appointment:
 *   - same property (address rules in src/booking/address.ts), whoever the customer   → duplicate
 *   - possibly the same property                                                       → ambiguous
 *   - a different property, but the same (or possibly the same) customer at the same
 *     appointment time: most likely the same booking with a different address          → ambiguous
 *   - no address on record, and the same/possibly the same customer or the same time  → ambiguous
 *   - a different property otherwise: the same customer may book several properties  → not a match
 * Any duplicate → 'match'. Otherwise any ambiguous → 'ambiguous'. Both block the job; ambiguous means
 * the owner reviews and books it by hand. Any API failure → 'error', which also blocks.
 */
import { DUPLICATE_WINDOW_DAYS, RECONCILE_WINDOW_MINUTES } from '../config.js';
import { compareProperty, parseAddress, type PropertyRelation } from '../booking/address.js';
import { compareCustomer, type CustomerRelation, type Fingerprints } from '../booking/normalize.js';
import type { BookingRequest } from '../booking/schema.js';
import type { SpectoraInspection, SpectoraReadApi } from './readApi.js';

export interface DuplicateMatch {
  inspectionId: string;
  datetime: string | null;
  address: string | null;
  confirmed: boolean | null;
  kind: 'duplicate' | 'ambiguous';
  property: PropertyRelation;
  customer: CustomerRelation;
}

export type DuplicateCheckResult =
  | { result: 'clear'; matches: []; checkedCount: number }
  | { result: 'match' | 'ambiguous'; matches: DuplicateMatch[]; checkedCount: number }
  | { result: 'error'; matches: []; error: string };

const DAY_MS = 86_400_000;

/** Same start time, to the minute. */
export function sameAppointment(datetime: string | null, appointment: Date): boolean {
  if (!datetime) return false;
  const t = Date.parse(datetime);
  return !Number.isNaN(t) && Math.abs(t - appointment.getTime()) < 60_000;
}

export function classify(insp: SpectoraInspection, fp: Fingerprints, appointment: Date)
  : Omit<DuplicateMatch, 'inspectionId' | 'datetime' | 'address' | 'confirmed'> | null {
  const street = insp.propertyAddress ?? insp.fullAddress;
  const customer = compareCustomer(fp.customer, { emails: insp.buyerEmails, phones: insp.buyerPhones, names: insp.buyerNames });
  const sameTime = sameAppointment(insp.datetime, appointment);
  if (!street) {
    // No address to compare: cannot rule out the same booking when anything else lines up.
    return customer !== 'different' || sameTime ? { kind: 'ambiguous', property: 'ambiguous', customer } : null;
  }
  const stored = parseAddress(street, insp.propertyAddress2, insp.zip);
  const property = compareProperty(fp.property, stored);
  // An address whose house number or street cannot be read is treated like no address at all (and is
  // ambiguous anyway when the ZIP agrees).
  if ((!stored.number || !stored.name) && (customer !== 'different' || sameTime)) {
    return { kind: 'ambiguous', property: 'ambiguous', customer };
  }
  if (property === 'same') return { kind: 'duplicate', property, customer };
  if (property === 'ambiguous') return { kind: 'ambiguous', property, customer };
  if (customer !== 'different' && sameTime) return { kind: 'ambiguous', property, customer };
  return null; // another property: a customer may book several
}

function within(insp: SpectoraInspection, center: Date, windowMs: number): boolean {
  if (!insp.datetime) return true; // no date: treat as relevant rather than silently ignore
  const t = Date.parse(insp.datetime);
  return Number.isNaN(t) || Math.abs(t - center.getTime()) <= windowMs;
}

export async function checkSpectoraDuplicates(
  api: SpectoraReadApi, req: BookingRequest, fp: Fingerprints, appointment: Date,
): Promise<DuplicateCheckResult> {
  try {
    const windowMs = DUPLICATE_WINDOW_DAYS * DAY_MS;
    const byId = new Map<string, SpectoraInspection>();
    // 1) Everything scheduled in the window (catches address-format differences and same-customer).
    for (const i of await api.listInspections({
      'filter[datetime_greater_than]': new Date(appointment.getTime() - windowMs).toISOString(),
      'filter[datetime_less_than]': new Date(appointment.getTime() + windowMs).toISOString(),
    })) byId.set(i.id, i);
    // 2) Spectora's own exact address + ZIP filter, as a second opinion on the property.
    for (const i of await api.listInspections({
      'filter[address]': req.property.street.trim(),
      'filter[zip]': req.property.zip.trim().slice(0, 5),
    })) if (within(i, appointment, windowMs)) byId.set(i.id, i);

    const matches: DuplicateMatch[] = [];
    for (const insp of byId.values()) {
      if (insp.canceledAt) continue;
      const c = classify(insp, fp, appointment);
      if (c) matches.push({ inspectionId: insp.id, datetime: insp.datetime, address: insp.fullAddress, confirmed: insp.confirmed, ...c });
    }
    if (matches.some((m) => m.kind === 'duplicate')) return { result: 'match', matches, checkedCount: byId.size };
    if (matches.length) return { result: 'ambiguous', matches, checkedCount: byId.size };
    return { result: 'clear', matches: [], checkedCount: byId.size };
  } catch (e) {
    return { result: 'error', matches: [], error: (e as Error).message };
  }
}

/**
 * After an uncertain submission: is there now exactly one inspection at this exact property within
 * RECONCILE_WINDOW_MINUTES of the requested time? Returns it, or null if zero or several. (Not by the
 * customer's email alone: the same customer may have another inspection at another property.) Throws if
 * the API fails (the caller then leaves the job UNKNOWN).
 */
export async function findSubmittedInspection(
  api: SpectoraReadApi, fp: Fingerprints, appointment: Date,
): Promise<SpectoraInspection | null> {
  const windowMs = RECONCILE_WINDOW_MINUTES * 60_000;
  const found = await api.listInspections({
    'filter[datetime_greater_than]': new Date(appointment.getTime() - windowMs).toISOString(),
    'filter[datetime_less_than]': new Date(appointment.getTime() + windowMs).toISOString(),
  });
  const hits = found.filter((i) => {
    if (i.canceledAt || !within(i, appointment, windowMs)) return false;
    const street = i.propertyAddress ?? i.fullAddress;
    return !!street && compareProperty(fp.property, parseAddress(street, i.propertyAddress2, i.zip)) === 'same';
  });
  return hits.length === 1 ? hits[0] : null;
}
