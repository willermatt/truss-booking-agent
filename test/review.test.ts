/** The Review step is checked against the request before anything is reserved or submitted. */
import { describe, expect, it } from 'vitest';
import { spectoraShown, validateReview } from '../src/booking/review.js';
import { faithfulSummary } from '../src/booking/mockDriver.js';
import { preparedJob } from './helpers/prepared.js';
import type { PreparedJob } from '../src/booking/driver.js';

function job(extra: Record<string, unknown> = {}): PreparedJob {
  return preparedJob({
    property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' },
    customer: { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '6025550100' },
    appointment: { date: '2026-11-12', time: '08:00' },
    services: ['home inspection'], addOns: ['termite'], squareFeet: 1800, yearBuilt: 1954, ...extra,
  });
}

describe('Review validation', () => {
  it('accepts a faithful Review in several date and time formats', () => {
    const j = job();
    expect(validateReview(j, faithfulSummary(j))).toEqual({ ok: true });
    for (const dateText of ['Thursday, November 12, 2026', 'Nov 12, 2026', '11/12/2026']) {
      expect(validateReview(j, { ...faithfulSummary(j), dateText, timeText: '08:00 AM' }).ok).toBe(true);
    }
  });

  it('stops on a missing or extra service line', () => {
    const j = job();
    const s = faithfulSummary(j);
    expect(validateReview(j, { ...s, lines: s.lines.slice(0, 1) })).toMatchObject({ ok: false, reason: 'review_services_mismatch' });
    expect(validateReview(j, { ...s, lines: [...s.lines, { name: 'Mold Inspection - $200', amountUsd: 200 }] }))
      .toMatchObject({ ok: false, reason: 'review_services_mismatch' });
  });

  it('stops on a wrong address, date or time', () => {
    const j = job();
    const s = faithfulSummary(j);
    expect(validateReview(j, { ...s, addressText: '1702 W Washington St, Phoenix, AZ 85007' })).toMatchObject({ reason: 'review_address_mismatch' });
    expect(validateReview(j, { ...s, addressText: '1700 W Washington St, Phoenix, AZ 85008' })).toMatchObject({ reason: 'review_address_mismatch' });
    expect(validateReview(j, { ...s, dateText: 'November 13, 2026' })).toMatchObject({ reason: 'review_date_mismatch' });
    expect(validateReview(j, { ...s, timeText: '11:30 AM' })).toMatchObject({ reason: 'review_time_mismatch' });
    expect(validateReview(j, { ...s, timeText: '8:00 PM' })).toMatchObject({ reason: 'review_time_mismatch' });
  });

  it('time: exactly one time, the requested start, exactly; no substring or range match', () => {
    const at = (time: string, header: string) => {
      const j = job({ appointment: { date: '2026-11-12', time } });
      return validateReview(j, { ...faithfulSummary(j), dateText: header, timeText: header });
    };
    const header = (t: string) => `1700 W Washington St Phoenix, AZ 85007 with Matthew Willer 11/12/2026 ${t} 2 hours`;
    // Second-review findings: "12:00 PM" contains "2:00 PM"; a range's end time is not the start.
    expect(at('14:00', header('12:00 PM'))).toMatchObject({ ok: false, reason: 'review_time_mismatch' });
    expect(at('14:30', header('12:30 PM'))).toMatchObject({ ok: false, reason: 'review_time_mismatch' });
    expect(at('12:00', 'Thursday, November 12, 2026 10:00 AM - 12:00 PM')).toMatchObject({ ok: false, reason: 'review_time_mismatch' });
    expect(at('08:00', header('18:00'))).toMatchObject({ ok: false, reason: 'review_time_mismatch' });
    for (const t of ['8:00 AM', '08:00 am', '8:00 a.m.', '8:00:00 AM', '8:00AM']) expect(at('08:00', header(t)), t).toEqual({ ok: true });
    expect(at('12:00', header('12:00 PM'))).toEqual({ ok: true });
    expect(at('14:00', header('2:00 PM'))).toEqual({ ok: true });
    expect(at('14:00', header('14:00'))).toEqual({ ok: true });
    // Times that cannot be read without guessing.
    for (const t of ['8:00', '13:00 PM', '8:00:30 AM', '8:60 AM']) expect(at('08:00', header(t)).ok, t).toBe(false);
    // Digits run into the time are not read as a time ("112:00 PM" is not 12:00 PM).
    expect(at('12:00', header('112:00 PM')).ok).toBe(false);
    expect(at('08:00', '1700 W Washington St Phoenix, AZ 85007 11/12/2026')).toMatchObject({ reason: 'review_time_mismatch' });
    expect(at('08:00', 'Thursday, November 12, 2026 8:00 AM - 11:00 AM')).toMatchObject({ reason: 'review_time_mismatch' });
  });

  it('date: the year is required, and every date shown must be the requested one', () => {
    const on = (dateText: string) => { const j = job(); return validateReview(j, { ...faithfulSummary(j), dateText }); };
    for (const d of ['November 12, 2026', 'Thursday, November 12, 2026', 'Nov. 12, 2026', 'Nov 12th 2026', '12 November 2026',
                     '11/12/2026', '2026-11-12', 'with Matthew Willer 11/12/2026 8:00 AM 2 hours']) {
      expect(on(d), d).toEqual({ ok: true });
    }
    // Second-review finding: "November 12, 2027" matched a 2026 request because the year was ignored.
    for (const d of ['November 12, 2027', 'Thursday, November 12', 'Nov 12', '11/12', '11/12/26', '11/12/2027', '2027-11-12',
                     'November 12, 2026 – December 12, 2026', 'no date here']) {
      expect(on(d), d).toMatchObject({ ok: false, reason: 'review_date_mismatch' });
    }
  });

  it('the Review address must be the same property: directional, street, type, unit and ZIP', () => {
    const j = job();
    const unitJob = job({ property: { street: '1700 W Washington St', unit: 'Apt 4B', city: 'Phoenix', state: 'AZ', zip: '85007' } });
    const ok = (jj: PreparedJob, addressText: string) => validateReview(jj, { ...faithfulSummary(jj), addressText }).ok;
    expect(ok(j, '1700 West Washington Street, Phoenix, AZ 85007')).toBe(true);   // written out in full
    expect(ok(j, '1700 W Washington St , Phoenix, AZ 85007-1234')).toBe(true);    // Spectora's "address unit" with no unit
    for (const shown of ['1700 E Washington St, Phoenix, AZ 85007', '1700 W Washington Ave, Phoenix, AZ 85007',
                         '1700 W Jefferson St, Phoenix, AZ 85007', '1700 Washington St, Phoenix, AZ 85007',
                         '1700 W Washington St 4B, Phoenix, AZ 85007', '1700 W Washington St, Tempe, AZ 85007',
                         '1700 W Washington St, Phoenix, PA 85007', '1700 W Washington St Phoenix AZ 85007',
                         '1700 W Washington St, Phoenixville, AZ 85007']) {
      expect(ok(j, shown), shown).toBe(false);
    }
    expect(ok(unitJob, '1700 W Washington St Apt 4B, Phoenix, AZ 85007')).toBe(true);
    for (const shown of ['1700 W Washington St Apt 9Z, Phoenix, AZ 85007', '1700 W Jefferson St Apt 4B, Phoenix, AZ 85007',
                         '1700 W Washington St, Phoenix, AZ 85007', '1700 E Washington St Apt 4B, Phoenix, AZ 85007']) {
      expect(ok(unitJob, shown), shown).toBe(false);
    }
  });

  it('the price is Spectora\'s: any amount, or none at all, passes, and is reported as shown', () => {
    const j = job({ addOns: ['termite', 'pool', 'mold'] });
    const s = faithfulSummary(j);
    for (const totalUsd of [675, 1234.56, 0, null]) expect(validateReview(j, { ...s, totalUsd }), String(totalUsd)).toEqual({ ok: true });
    const odd = s.lines.map((l) => ({ ...l, amountUsd: l.name.startsWith('Mold') ? null : 999 }));
    expect(validateReview(j, { ...s, lines: odd })).toEqual({ ok: true });
    expect(spectoraShown({ ...s, totalUsd: 1234.56 })).toMatchObject({ totalUsd: 1234.56, squareFeet: '1800', yearBuilt: '1954' });
    // Services are still checked.
    expect(validateReview(j, { ...s, lines: s.lines.slice(1) })).toMatchObject({ ok: false, reason: 'review_services_mismatch' });
  });
});
