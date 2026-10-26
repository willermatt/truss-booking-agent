/**
 * In-memory stand-in for Spectora's read-only GET /v2/inspections, shaped like the documented
 * JSON:API responses (developer.spectora.com/api/inspections). Supports the filters the agent uses
 * and can simulate outages, server errors and an exhausted monthly quota.
 */
import type { FetchLike, HttpResponseLike } from '../../src/spectora/readApi.js';

export interface FakeInspection {
  id: string;
  datetime: string; // ISO
  confirmed?: boolean;
  canceledAt?: string | null;
  /** Omitted: the inspection has no address on record. */
  address?: string;
  unit?: string;
  city?: string;
  zip: string; // '' simulates a record with no ZIP
  buyer?: { firstName: string; lastName: string; email?: string; phone?: string };
}

export type FakeMode = 'ok' | 'network_down' | 'server_error' | 'quota_exhausted';

export class FakeSpectora {
  inspections: FakeInspection[] = [];
  mode: FakeMode = 'ok';
  calls: string[] = [];
  /** Server-side page size cap, below the 200 the client asks for (forces pagination). */
  pageSizeCap = 200;
  /** Simulate a response without pagination metadata. */
  omitPagination = false;
  /** Simulate results shifting between page reads: page 2 repeats page 1's last row and skips one. */
  driftOnPage2 = false;

  add(i: FakeInspection) { this.inspections.push(i); }

  readonly fetch: FetchLike = async (url, init) => {
    this.calls.push(url);
    if (init.method !== 'GET') throw new Error('fake Spectora only supports GET');
    if (this.mode === 'network_down') throw new TypeError('fetch failed');
    if (this.mode === 'server_error') return response(500, { errors: [{ status: 500 }] });
    if (this.mode === 'quota_exhausted') {
      return response(429, { errors: [{ status: 429, title: 'Too Many Requests' }] },
        { 'Spectora-Quota-Limit': '500', 'Spectora-Quota-Remaining': '0' });
    }
    const u = new URL(url);
    if (u.pathname !== '/v2/inspections') return response(404, {});
    const q = u.searchParams;
    const gt = q.get('filter[datetime_greater_than]');
    const lt = q.get('filter[datetime_less_than]');
    const addr = q.get('filter[address]');
    const zip = q.get('filter[zip]');
    const rows = this.inspections.filter((i) => {
      if (i.canceledAt) return false; // API default: canceled excluded
      const t = Date.parse(i.datetime);
      if (gt && t < Date.parse(gt)) return false;
      if (lt && t > Date.parse(lt)) return false;
      if (addr && (i.address ?? '').toLowerCase() !== addr.toLowerCase()) return false;
      if (zip && i.zip !== zip) return false;
      return true;
    });
    const size = Math.min(Number(q.get('page[size]') ?? 200), this.pageSizeCap);
    const pageNo = Number(q.get('page[number]') ?? 1);
    const last = Math.max(1, Math.ceil(rows.length / size));
    const pageRows = this.driftOnPage2 && pageNo === 2
      ? [rows[size - 1], ...rows.slice(size + 1, 2 * size)]
      : rows.slice((pageNo - 1) * size, pageNo * size);
    const data = pageRows.map((i) => ({
      id: i.id,
      type: 'inspection',
      attributes: {
        datetime: i.datetime,
        confirmed: i.confirmed ?? false,
        canceled_at: i.canceledAt ?? null,
        full_address: i.address ? `${i.address}${i.unit ? ` ${i.unit}` : ''}, ${i.city ?? 'Phoenix'}, AZ${i.zip ? ` ${i.zip}` : ''}` : null,
        property_address: i.address ?? null,
        property_address_2: i.unit ?? null,
        buyer_name: i.buyer ? `${i.buyer.firstName} ${i.buyer.lastName}` : null,
        buyer_names: i.buyer ? `${i.buyer.firstName} ${i.buyer.lastName}` : null,
      },
      relationships: {
        buyer: { data: i.buyer ? { id: `b-${i.id}`, type: 'buyer' } : null },
        property: { data: { id: `p-${i.id}`, type: 'property' } },
      },
    }));
    const included = pageRows.flatMap((i) => [
      ...(i.buyer ? [{ id: `b-${i.id}`, type: 'buyer', attributes: {
        first_name: i.buyer.firstName, last_name: i.buyer.lastName, email: i.buyer.email ?? null,
        phone: i.buyer.phone ?? null } }] : []),
      { id: `p-${i.id}`, type: 'property', attributes: { address: i.address ?? null, zip: i.zip || null } },
    ]);
    const meta = this.omitPagination ? {} : { pagination: { current: pageNo, first: 1, last, records: rows.length } };
    return response(200, { data, included, meta });
  };
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, json: async () => body };
}
