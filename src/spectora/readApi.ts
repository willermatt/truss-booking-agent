/**
 * Read-only client for Spectora's public API (https://developer.spectora.com).
 *
 * Only GET is implemented. Booking is never done through this client (the API cannot schedule
 * inspections); it is used to find duplicates before a submission and to reconcile uncertain outcomes.
 *
 * Retries: read requests are retried at most twice on network errors, 5xx, and short-window rate limits.
 * A monthly-quota 429 (identified by Spectora-Quota-* headers) is not retried.
 */
import { SPECTORA_API_BASE } from '../config.js';

export interface HttpResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export class SpectoraApiError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'SpectoraApiError';
  }
}

/** The fields this system reads from an inspection. Parsed defensively: field names come from the docs. */
export interface SpectoraInspection {
  id: string;
  datetime: string | null;
  confirmed: boolean | null;
  canceledAt: string | null;
  fullAddress: string | null;
  propertyAddress: string | null;
  propertyAddress2: string | null;
  zip: string | null;
  buyerNames: string[];
  buyerEmails: string[];
  buyerPhones: string[];
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface ReadApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  maxRetries?: number;
  timeoutMs?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class SpectoraReadApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Count of HTTP requests made; used by tests and to watch the monthly quota. */
  requestCount = 0;

  constructor(private readonly opts: ReadApiOptions) {
    if (!opts.apiKey) throw new Error('SpectoraReadApi requires an API key');
    this.baseUrl = opts.baseUrl ?? SPECTORA_API_BASE;
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.maxRetries = Math.min(opts.maxRetries ?? 2, 2);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxPages = opts.maxPages ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET /v2/inspections with filters, following pagination up to maxPages. */
  async listInspections(filters: Record<string, string>): Promise<SpectoraInspection[]> {
    const out: SpectoraInspection[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const params = new URLSearchParams({ ...filters, include: 'buyer,buyer_2,property',
                                           'page[size]': '200', 'page[number]': String(page) });
      const body = (await this.get(`/v2/inspections?${params.toString()}`)) as Json;
      if (!Array.isArray(body.data)) throw new SpectoraApiError('response has no data array; cannot read results');
      const data = body.data as Json[];
      const included = Array.isArray(body.included) ? (body.included as Json[]) : [];
      for (const item of data) out.push(parseInspection(item, included));
      // Fail closed unless the response proves the result set is complete: a duplicate on an unread
      // page must never be reported as "clear".
      const pagination = (body.meta as Json | undefined)?.pagination as Json | undefined;
      const last = Number(pagination?.last);
      if (!pagination || !Number.isInteger(last) || last < 1) {
        throw new SpectoraApiError('response has no usable pagination metadata; cannot prove the results are complete');
      }
      if (page >= last) {
        // Count distinct inspections: if results shifted between pages, one row can repeat while
        // another is skipped, and a raw row count would still look complete.
        // A total is required: without one, a skipped row cannot be detected.
        const records = typeof pagination.records === 'number' ? pagination.records : Number.NaN;
        if (!Number.isInteger(records) || records < 0) {
          throw new SpectoraApiError('response has no total record count; cannot prove the results are complete');
        }
        const unique = new Set(out.map((i) => i.id)).size;
        if (unique !== records) {
          throw new SpectoraApiError(`read ${unique} distinct inspections but Spectora reports ${records}; results incomplete or changing`);
        }
        return out;
      }
      if (!data.length) throw new SpectoraApiError(`page ${page} of ${last} was empty; results incomplete`);
    }
    throw new SpectoraApiError(`more than ${this.maxPages} pages of results; narrow the query`);
  }

  private async get(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(500 * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.requestCount++;
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (res.status >= 200 && res.status < 300) return await res.json();
        if (res.status === 429 && res.headers.get('Spectora-Quota-Limit') !== null) {
          throw new SpectoraApiError('Spectora monthly API quota exhausted', 429, false);
        }
        const retryable = res.status === 429 || res.status >= 500;
        throw new SpectoraApiError(`Spectora API returned ${res.status}`, res.status, retryable);
      } catch (e) {
        lastError = e;
        const retryable = e instanceof SpectoraApiError ? e.retryable : true; // network error / timeout
        if (!retryable) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof SpectoraApiError
      ? lastError
      : new SpectoraApiError(`Spectora API unreachable: ${(lastError as Error)?.message ?? lastError}`);
  }
}

function parseInspection(item: Json, included: Json[]): SpectoraInspection {
  const a = (item.attributes ?? {}) as Json;
  const rel = (item.relationships ?? {}) as Record<string, { data?: { id?: string; type?: string } | null }>;
  const find = (r?: { id?: string; type?: string } | null) =>
    r ? included.find((x) => String(x.id) === String(r.id) && x.type === r.type) : undefined;

  const buyers = [find(rel.buyer?.data), find(rel.buyer_2?.data)].filter(Boolean) as Json[];
  const buyerAttrs = buyers.map((b) => (b.attributes ?? {}) as Json);
  const property = (find(rel.property?.data)?.attributes ?? {}) as Json;

  const names = new Set<string>();
  for (const n of [str(a.buyer_name), ...(str(a.buyer_names)?.split(/\s*(?:&|,| and )\s*/i) ?? [])]) {
    if (n) names.add(n);
  }
  for (const b of buyerAttrs) {
    const full = str(b.name) ?? [str(b.first_name), str(b.last_name)].filter(Boolean).join(' ');
    if (full) names.add(full);
  }
  const fullAddress = str(a.full_address);
  const zip = str(property.zip) ?? str(property.postal_code) ?? fullAddress?.match(/(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? null;

  return {
    id: String(item.id),
    datetime: str(a.datetime),
    confirmed: typeof a.confirmed === 'boolean' ? a.confirmed : null,
    canceledAt: str(a.canceled_at),
    fullAddress,
    propertyAddress: str(a.property_address) ?? str(property.address),
    propertyAddress2: str(a.property_address_2) ?? str(property.address_2) ?? str(property.unit),
    zip,
    buyerNames: [...names],
    buyerEmails: buyerAttrs.map((b) => str(b.email)).filter((x): x is string => !!x),
    buyerPhones: buyerAttrs
      .flatMap((b) => [str(b.phone), str(b.phone_number), str(b.mobile_phone)])
      .filter((x): x is string => !!x),
  };
}
