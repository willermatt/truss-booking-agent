/**
 * Duplicate matching: directionals, street types, units and ZIPs are preserved; harmless formatting is
 * normalized; anything one-sided is ambiguous (blocks, manual booking). The database's SQL version of
 * the rules must give the same answer as the TypeScript version for every case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareProperty, parseAddress, type PropertyRelation } from '../src/booking/address.js';
import { compareCustomer, fingerprints, normalizePhone } from '../src/booking/normalize.js';
import { BookingRequestSchema } from '../src/booking/schema.js';
import { PgCluster, type TestDb } from './helpers/pgCluster.js';

type Case = [string, string | undefined, string | undefined, string, string | undefined, string | undefined, PropertyRelation, string];

// [streetA, unitA, zipA, streetB, unitB, zipB, expected, why]
const CASES: Case[] = [
  // Harmless differences → same
  ['1700 W Washington St', '', '85007', '1700 West Washington Street', '', '85007', 'same', 'abbreviations'],
  ['1700 W. Washington St.', '', '85007', '1700 w washington st', '', '85007-1234', 'same', 'punctuation, case, ZIP+4'],
  ['1700 W Washington St', 'Apt 4B', '85007', '1700 W Washington St', '#4b', '85007', 'same', 'unit spellings'],
  ['1700 W Washington St Apt 4B', '', '85007', '1700 W Washington St', 'Unit 4B', '85007', 'same', 'unit in street line'],
  ['1700 Washington St W', '', '85007', '1700 W Washington St', '', '85007', 'same', 'pre/post directional'],
  ['12 First Ave', '', '85003', '12 1st Avenue', '', '85003', 'same', 'ordinal'],
  ['100 North St', '', '85004', '100 North Street', '', '85004', 'same', 'street named North'],
  ['100 West Way', '', '85004', '100 W Way', '', '85004', 'same', 'street named W Way'],
  ['1000 E Río Salado Pkwy', '', '85281', '1000 E Rio Salado Pkwy', '', '85281', 'same', 'accent'],
  ['1234 N 7th St', '', '85020', '1234 N 7 St', '', '85020', 'same', 'numbered street without ordinal suffix'],
  ['1234 N Eleventh St', '', '85020', '1234 N 11th St', '', '85020', 'same', 'ordinal word above tenth'],
  ['1234 N Twenty-First St', '', '85020', '1234 N 21st St', '', '85020', 'same', 'hyphenated compound ordinal'],
  ['1234 N Twenty First St', '', '85020', '1234 N 21st St', '', '85020', 'same', 'two-word compound ordinal'],
  ['1234 Highway 60', '', '85020', '1234 Hwy 60', '', '85020', 'same', 'street-type word inside the name'],
  ['1234 W St John Rd', '', '85041', '1234 W Saint John Rd', '', '85041', 'same', 'St / Saint'],
  ['1234 N.W. Grand Ave', '', '85007', '1234 NW Grand Ave', '', '85007', 'same', 'N.W. / NW'],
  ['1234 N W Grand Ave', '', '85007', '1234 Northwest Grand Ave', '', '85007', 'same', 'N W / Northwest'],
  ['1234 E Mt View Rd', '', '85020', '1234 E Mount View Rd', '', '85020', 'same', 'Mt / Mount'],
  ['1234 E Ft Apache Rd', '', '85020', '1234 E Fort Apache Rd', '', '85020', 'same', 'Ft / Fort'],
  ['1234 E Pinnacle Peak Expy', '', '85020', '1234 E Pinnacle Peak Expressway', '', '85020', 'same', 'Expy / Expressway'],
  ['1234 E Harbor Lndg', '', '85020', '1234 E Harbor Landing', '', '85020', 'same', 'Lndg / Landing'],
  ['1234 E Sunset Crst', '', '85020', '1234 E Sunset Crest', '', '85020', 'same', 'Crst / Crest'],
  ['1700 W Washington St', '04', '85007', '1700 W Washington St', '4', '85007', 'same', 'unit 04 / 4'],
  // Third review: house numbers that do not read cleanly are never "different" within the ZIP.
  ['1700W Washington St', '', '85007', '1700 W Washington St', '', '85007', 'ambiguous', 'directional run into the number'],
  ['1700W Washington St', '', '85007', '1700 E Washington St', '', '85007', 'ambiguous', '"1700W" may be a house number, not 1700 W'],
  ['Unit 4, 1700 W Washington St', '', '85007', '1700 W Washington St', '4', '85007', 'ambiguous', 'unit before the street'],
  ['1700-4 W Washington St', '', '85007', '1700 W Washington St', '', '85007', 'ambiguous', 'number with a hyphen'],
  ['Unit 4, 1700 W Washington St', '', '85008', '1700 W Washington St', '4', '85007', 'different', 'unreadable number, other ZIP'],
  ['01700 W Washington St', '', '85007', '1700 W Washington St', '', '85007', 'same', 'leading zero in the number'],
  ['12A W Washington St', '', '85007', '12 W Washington St', '', '85007', 'ambiguous', 'number with a letter / without'],
  ['12A W Washington St', '', '85007', '12B W Washington St', '', '85007', 'ambiguous', 'numbers with different letters'],
  ['12A W Washington St', '', '85007', '13 W Washington St', '', '85007', 'different', 'another number'],
  // Third review: distinct names and unit kinds are not merged into "same".
  ['1234 W Saint Rd', '', '85007', '1234 W Street Rd', '', '85007', 'ambiguous', 'Saint Rd / Street Rd, same ZIP'],
  ['1234 W Saint Rd', '', '85007', '1234 W Street Rd', '', '85008', 'different', 'Saint Rd / Street Rd, other ZIP'],
  ['1234 W Apache Trl', '', '85007', '1234 W Apache Trails', '', '85007', 'ambiguous', 'Trail / Trails'],
  ['1234 W Apache Ranch', '', '85007', '1234 W Apache Ranches', '', '85099', 'different', 'Ranch / Ranches, other ZIP'],
  ['1234 W Apache Ct', '', '85007', '1234 W Apache Courts', '', '85007', 'ambiguous', 'Court / Courts'],
  ['1700 W Washington St', 'Bldg 4', '85007', '1700 W Washington St', 'Apt 4', '85007', 'ambiguous', 'Bldg 4 / Apt 4'],
  ['1700 W Washington St', 'Lot 4', '85007', '1700 W Washington St', '#4', '85007', 'ambiguous', 'Lot 4 / #4'],
  ['1700 W Washington St', 'Bldg 4', '85007', '1700 W Washington St', 'Building 4', '85007', 'same', 'Bldg / Building'],
  ['1700 W Washington St', 'Suite 4', '85007', '1700 W Washington St', 'Apt 4', '85007', 'same', 'Suite / Apt'],
  ['1700 W Washington St', 'Bldg 4', '85007', '1700 W Washington St', 'Bldg 5', '85007', 'different', 'Bldg 4 / Bldg 5'],
  // Meaningful differences → different
  ['1700 E Washington St', '', '85007', '1700 W Washington St', '', '85007', 'different', 'E vs W'],
  ['100 N Central Ave', '', '85004', '100 S Central Ave', '', '85004', 'different', 'N vs S'],
  ['1700 W Washington St', '4B', '85007', '1700 W Washington St', '4C', '85007', 'different', 'unit'],
  ['1700 W Washington St', '', '85007', '1700 W Washington St', '', '85008', 'different', 'ZIP'],
  ['1700 W Washington St', '', '85007', '1700 W Washington Ave', '', '85007', 'different', 'street type'],
  ['1700 W Washington St', '', '85007', '1702 W Washington St', '', '85007', 'different', 'house number'],
  ['1700 W Washington St', '', '85007', '1700 W Jefferson St', '', '85008', 'different', 'street name and ZIP'],
  ['1700 W Washington St', '', '85007', '1700 W Jefferson St', '', '', 'different', 'street name, one ZIP missing'],
  ['1234 E Mountain View Rd', '', '85020', '1234 W Mountain View Rd', '', '85020', 'different', 'E vs W, two-word name'],
  ['1234 E Mountain View', '', '85020', '1234 W Mountain View Rd', '', '85020', 'different', 'E vs W, one side without type'],
  ['1234 W Canyon Rd', '', '85020', '1234 E Canyon Rd', '', '85020', 'different', 'E vs W, name that is a type word'],
  ['1700 W Washington St', '1-2', '85007', '1700 W Washington St', '1-3', '85007', 'different', 'unit 1-2 vs 1-3'],
  // One-sided → ambiguous
  ['1700 W Washington St', '', '85007', '1700 Washington St', '', '85007', 'ambiguous', 'directional missing'],
  ['1700 W Washington St', '', '85007', '1700 W Washington', '', '85007', 'ambiguous', 'street type missing'],
  ['1700 W Washington St', '4B', '85007', '1700 W Washington St', '', '85007', 'ambiguous', 'unit missing'],
  ['1700 W Washington St', '', '85007', '1700 W Washington St', '', '', 'ambiguous', 'ZIP missing'],
  ['100 Main St NW', '', '85004', '100 Main', '', '85004', 'ambiguous', 'directional and type missing'],
  ['100 Lake St', '', '85004', '100 Lake Shore St', '', '85004', 'ambiguous', 'name extends the other'],
  ['1234 E Mountain View Rd', '', '85020', '1234 E Mountain View', '', '85020', 'ambiguous', '"View" read as the street type'],
  ['1234 W Desert View Dr', '', '85020', '1234 W Desert View', '', '85020', 'ambiguous', 'type omitted, name ends in a type word'],
  ['1234 W Canyon Rd', '', '85020', '1234 W Canyon', '', '85020', 'ambiguous', 'type omitted, name is a type word'],
  ['1234 E South Mountain Ave', '', '85020', '1234 South Mountain Ave', '', '85020', 'ambiguous', 'directional omitted before a directional word'],
  ['1700 W Washington St', '1-2', '85007', '1700 W Washington St', '12', '85007', 'ambiguous', 'unit 1-2 vs 12'],
  ['1700 W Washington St', '4-B', '85007', '1700 W Washington St', '4B', '85007', 'ambiguous', 'unit 4-B vs 4B'],
  ['1700 W Washington St', '', '85007', '1700 W Jefferson St', '', '85007', 'ambiguous', 'same number and ZIP, another street name'],
  ['100 W Way', '', '85004', '100 E Way', '', '85004', 'ambiguous', 'street names W Way vs E Way, same ZIP'],
];

describe('address rules (TypeScript)', () => {
  for (const [a, ua, za, b, ub, zb, expected, why] of CASES) {
    it(`${why}: "${a}" vs "${b}" → ${expected}`, () => {
      const pa = parseAddress(a, ua, za);
      const pb = parseAddress(b, ub, zb);
      expect(compareProperty(pa, pb)).toBe(expected);
      expect(compareProperty(pb, pa)).toBe(expected); // symmetric
    });
  }

  it('flags text it cannot place, which makes any match ambiguous rather than same', () => {
    const messy = parseAddress('1700 W Washington Phoenix AZ 85007');
    expect(messy.clean).toBe(false);
    expect(compareProperty(messy, parseAddress('1700 W Washington St', '', '85007'))).toBe('ambiguous');
    expect(parseAddress('Lot 5 Desert Rd').clean).toBe(false);
    expect(parseAddress('1700 W Washington Straße', '', '85007').clean).toBe(false); // ß does not fold to ASCII
    // Every field agrees, but there is text the parser could not place: still only ambiguous.
    for (const extra of ['1700 W Washington St (rear house)', '1700 W Washington St Behind Gate',
                         '1700 W Washington St & 7th Ave', '1700 W Washington and 7th Ave']) {
      const p = parseAddress(extra, '', '85007');
      expect(p.clean, extra).toBe(false);
      expect(compareProperty(p, parseAddress('1700 W Washington St', '', '85007')), extra).not.toBe('same');
    }
    expect(compareProperty(parseAddress('1700 W Washington St (rear house)', '', '85007'),
                           parseAddress('1700 W Washington St', '', '85007'))).toBe('ambiguous');
  });

  it('understands a full address with commas, or with a state and ZIP but no commas', () => {
    expect(parseAddress('1700 W Washington St, Phoenix, AZ 85007-1234')).toMatchObject(
      { number: '1700', name: 'washington', dir: 'w', suffix: 'st', zip: '85007', clean: true });
    expect(parseAddress('1700 W Washington St Phoenix AZ 85007')).toMatchObject({ zip: '85007', clean: true });
  });

  it('customer: same email or phone is the same customer; same name only is ambiguous', () => {
    const a = { email: 'pat@example.com', phone: '6025550100', name: 'pat lee' };
    expect(compareCustomer(a, { emails: ['PAT@example.com'], phones: [], names: [] })).toBe('same');
    expect(compareCustomer(a, { emails: [], phones: ['(602) 555-0100'], names: [] })).toBe('same');
    expect(compareCustomer(a, { emails: [], phones: [], names: ['Pat Lee'] })).toBe('ambiguous');
    expect(compareCustomer(a, { emails: ['x@y.z'], phones: ['4805550000'], names: ['Sam Lee'] })).toBe('different');
    expect(normalizePhone('+1 (602) 456-2756')).toBe('6024562756');
  });
});

describe('address rules (SQL parity)', () => {
  let cluster: PgCluster;
  let db: TestDb;
  beforeAll(async () => { cluster = await PgCluster.create(); db = await cluster.freshDb(); });
  afterAll(async () => { await cluster?.destroy(); });

  it('safety._property_relation agrees with compareProperty on every clean case', async () => {
    const su = db.pool('superuser');
    for (const [a, ua, za, b, ub, zb, expected, why] of CASES) {
      const pa = parseAddress(a, ua, za);
      const pb = parseAddress(b, ub, zb);
      if (!pa.clean || !pb.clean) continue;
      for (const [x, y] of [[pa, pb], [pb, pa]]) {
        const { rows } = await su.query(
          'SELECT safety._property_relation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) AS r',
          [x.number, x.name, x.dir, x.suffix, x.unit, x.zip, x.tokens, y.number, y.name, y.dir, y.suffix, y.unit, y.zip, y.tokens]);
        expect(rows[0].r, why).toBe(expected);
      }
    }
  });

  it('safety._customer_relation agrees with compareCustomer', async () => {
    const base = { property: { street: '1 A St', city: 'Phoenix', state: 'AZ', zip: '85050' },
      appointment: { date: '2026-11-12', time: '08:00' }, services: ['home inspection'], squareFeet: 1000, yearBuilt: 2000 };
    const keys = (first: string, last: string, email: string, phone: string) => fingerprints(BookingRequestSchema.parse(
      { ...base, customer: { firstName: first, lastName: last, email, phone } })).customerKeys;
    const a = keys('Pat', 'Lee', 'pat@example.com', '6025550100');
    const su = db.pool('superuser');
    const rel = async (b: string[]) => (await su.query('SELECT safety._customer_relation($1, $2) AS r', [a, b])).rows[0].r;
    expect(await rel(keys('Sam', 'Ray', 'PAT@example.com', '4805550000'))).toBe('same');
    expect(await rel(keys('Sam', 'Ray', 'sam@example.com', '602-555-0100'))).toBe('same');
    expect(await rel(keys('Pat', 'Lee', 'other@example.com', '4805550000'))).toBe('ambiguous');
    expect(await rel(keys('Sam', 'Ray', 'sam@example.com', '4805550000'))).toBe('different');
  });
});
