/**
 * TypeScript and SQL must give the same answer for any pair of cleanly parsed addresses (third review:
 * 4,000 random pairs, no differences). Extended with lettered house numbers, plural street types and unit
 * kinds.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compareProperty, parseAddress } from '../src/booking/address.js';
import { PgCluster, type TestDb } from './helpers/pgCluster.js';

let cluster: PgCluster; let db: TestDb;
beforeAll(async () => { cluster = await PgCluster.create(); db = await cluster.freshDb(); });
afterAll(async () => { await cluster?.destroy(); });

const pick = <T>(a: T[], r: () => number) => a[Math.floor(r() * a.length)];
it('TS and SQL agree on 6,000 random clean address pairs', async () => {
  let seed = 12345; const r = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const nums = ['1700', '1700', '1702', '1700a', '1700b', '01700'];
  const dirs = ['', 'N', 'S', 'E', 'W', 'NE', 'North', 'West', 'N W', 'N.W.'];
  const names = ['Washington', 'Mountain View', 'Desert View', 'Canyon', 'St John', 'Saint John', '7', '7th', 'Eleventh', '11th',
                 'Lake', 'Lake Shore', 'North', 'West', 'Way', 'View', 'E', 'Mount Vernon', 'Mt Vernon', 'Highway 60', 'Twenty First',
                 'Park', 'Parks', 'Saint', 'Street', 'Ft Apache', 'Fort Apache'];
  const sufs = ['', 'St', 'Street', 'Ave', 'Rd', 'View', 'Canyon', 'Way', 'Pkwy', 'Trl', 'Trails', 'Ct', 'Courts', 'Ranch', 'Ranches'];
  const posts = ['', '', '', 'E', 'NW', 'West'];
  const units = ['', '', '4', '4B', '4-B', '1-2', '12', 'Apt 4', '04', '#4b', 'Bldg 4', 'Lot 4', 'Building 4', 'Suite 4'];
  const zips = ['85007', '85007', '85008', ''];
  const gen = () => ({ street: [pick(nums, r), pick(dirs, r), pick(names, r), pick(sufs, r), pick(posts, r)].filter(Boolean).join(' '),
                       unit: pick(units, r), zip: pick(zips, r) });
  const rows: unknown[][] = []; const expected: string[] = []; const labels: string[] = [];
  while (rows.length < 6000) {
    const a = gen();
    // A quarter of the pairs are the same address written again, with an equivalent spelling where one exists.
    const b = r() < 0.25 ? { ...a, street: a.street.replace('Street', 'St').replace('Saint', 'St').replace('Mt ', 'Mount ') } : gen();
    const pa = parseAddress(a.street, a.unit, a.zip), pb = parseAddress(b.street, b.unit, b.zip);
    if (!pa.clean || !pb.clean) continue;   // an unclean parse is ambiguous at most, which SQL never sees
    rows.push([pa.number, pa.name, pa.dir, pa.suffix, pa.unit, pa.zip, pa.tokens, pb.number, pb.name, pb.dir, pb.suffix, pb.unit, pb.zip, pb.tokens]);
    expected.push(compareProperty(pa, pb));
    labels.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  const { rows: out } = await db.pool('superuser').query(
    `SELECT safety._property_relation(x->>0,x->>1,x->>2,x->>3,x->>4,x->>5,x->>6,x->>7,x->>8,x->>9,x->>10,x->>11,x->>12,x->>13) AS r
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(x, n) ORDER BY n`, [JSON.stringify(rows)]);
  const diffs = out.map((o, i) => (o.r !== expected[i] ? `${labels[i]}: ts=${expected[i]} sql=${o.r}` : null)).filter(Boolean);
  expect(diffs.slice(0, 10)).toEqual([]);
  // Inputs admission never stores (no number or no name) still follow the same rule in SQL: ambiguous
  // when the ZIPs agree, otherwise different.
  const rel = async (an: string, bn: string, az: string, bz: string) => (await db.pool('superuser').query(
    `SELECT safety._property_relation($1,'washington','w','st','',$3,'w washington st',$2,'washington','w','st','',$4,'w washington st') AS r`,
    [an, bn, az, bz])).rows[0].r;
  expect(await rel('', '1700', '85007', '85007')).toBe('ambiguous');
  expect(await rel('1700', '', '85007', '85007')).toBe('ambiguous');
  expect(await rel('', '1700', '85007', '85008')).toBe('different');
  expect(await rel('', '1700', '', '')).toBe('different');
  // Every outcome occurs, so the comparison is exercised in all directions.
  expect(new Set(expected)).toEqual(new Set(['same', 'ambiguous', 'different']));
});
