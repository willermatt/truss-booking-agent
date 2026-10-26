/**
 * A small authenticated HTTP API for an AI assistant (or any client) to submit structured booking
 * requests and read their status. It adds no policy of its own: every request goes through the same
 * validation, runner and database safety functions as the worker command.
 *
 *   POST /v1/bookings          start a booking (Idempotency-Key header, JSON body = the booking request)
 *   GET  /v1/bookings/{key}    status of the booking started with that key
 *   GET  /v1/schema            the request's JSON Schema, the bookable services, what each state means
 *   GET  /v1/health            liveness (no authentication, no information)
 *
 * Authentication: `Authorization: Bearer <token>`. The server holds only SHA-256 hashes of valid tokens
 * (TRUSS_API_TOKEN_SHA256) and compares in constant time. There is no endpoint that changes limits,
 * resets the breaker, enables submissions or reconciles; those exist only in the owner CLI, under a
 * different database role.
 *
 * A booking takes minutes (a real browser), so POST answers 202 once the request has passed validation
 * and the run has started; the client polls the status endpoint. Only one booking runs at a time per
 * process (the database allows one browser session globally anyway).
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AgentInterface, AgentBookingResult } from '../agent/interface.js';
import { BookingRequestSchema } from '../booking/schema.js';
import { BrowserDidNotStopError, validateBooking } from '../booking/runner.js';
import { loadCatalog } from '../booking/services.js';

export interface ApiOptions {
  agent: AgentInterface;
  /** False unless this host may submit (TRUSS_LIVE_SUBMISSIONS=enabled, or a local test scheduler). */
  canSubmit: () => boolean;
  /** Hex SHA-256 digests of the accepted bearer tokens. */
  tokenHashes: string[];
  now?: () => Date;
  /** Called when a browser could not be stopped: the process must exit. */
  onFatal?: (e: Error) => void;
  log?: (line: string) => void;
  /** Requests per minute per token (all, and starts of bookings). */
  rateLimit?: { perMinute: number; startsPerMinute: number };
  maxBodyBytes?: number;
}

/** The client's idempotency key. Stored as "<token id>:<key>", so each token sees only its own bookings. */
const KEY = /^[A-Za-z0-9._:-]{8,180}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{24,512})$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const STATE_MEANINGS: Record<string, string> = {
  REQUESTED: 'Submitted; Spectora created the inspection as a request awaiting the owner\'s confirmation.',
  CONFIRMED: 'The owner confirmed it in Spectora.',
  NEEDS_INPUT: 'Not submitted: something in the request must be fixed or checked (see reason and issues).',
  UNAVAILABLE: 'Not submitted: the requested time is not offered. No other time is chosen automatically.',
  BLOCKED: 'Not submitted: a safety control stopped it (limits, duplicates, kill switch, breaker). See reason; retryLater means the same request may succeed later.',
  FAILED: 'Not submitted, or Spectora refused it; nothing was booked.',
  UNKNOWN: 'The submission may or may not have reached Spectora. It is never retried; the owner reconciles it, and no booking runs until then.',
  DRY_RUN: 'A rehearsal that went as far as the Review and stopped; nothing was submitted and no text was sent.',
};

export function sha256Hex(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createBookingApi(opts: ApiOptions): http.Server {
  const hashes = opts.tokenHashes.map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hashes.length || hashes.some((h) => !HEX64.test(h))) {
    throw new Error('the API needs at least one valid SHA-256 token hash (TRUSS_API_TOKEN_SHA256)');
  }
  const accepted = hashes.map((h) => Buffer.from(h, 'hex'));
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((l: string) => console.log(l));
  const limits = opts.rateLimit ?? { perMinute: 60, startsPerMinute: 6 };
  const maxBody = opts.maxBodyBytes ?? 32 * 1024;
  const running = new Map<string, Promise<void>>();
  const finished = new Map<string, AgentBookingResult | { error: string }>();
  const windows = new Map<string, { start: number; all: number; starts: number }>();
  let fatal: Error | null = null;

  const authenticate = (req: http.IncomingMessage): string | null => {
    const m = BEARER.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const digest = createHash('sha256').update(m[1], 'utf8').digest();
    let match = -1;
    accepted.forEach((a, i) => { if (timingSafeEqual(a, digest)) match = i; });
    return match >= 0 ? hashes[match].slice(0, 12) : null;
  };

  const rateLimited = (token: string, isStart: boolean): boolean => {
    const t = Date.now();
    let w = windows.get(token);
    if (!w || t - w.start >= 60_000) { w = { start: t, all: 0, starts: 0 }; windows.set(token, w); }
    w.all++;
    if (isStart) w.starts++;
    return w.all > limits.perMinute || (isStart && w.starts > limits.startsPerMinute);
  };

  const remember = (key: string, v: AgentBookingResult | { error: string }) => {
    finished.set(key, v);
    while (finished.size > 500) finished.delete(finished.keys().next().value as string);
  };

  // Slow or stalled requests are cut off on time (checked every second, not Node's default 30 s).
  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, connectionsCheckingInterval: 1_000 }, (req, res) => {
    const started = Date.now();
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
                              'x-content-type-options': 'nosniff', ...headers });
      res.end(JSON.stringify(body));
      log(`${req.method} ${(req.url ?? '').split('?')[0]} ${status} ${Date.now() - started}ms`);
    };
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://api');
      const path = url.pathname;

      if (path === '/v1/health' && req.method === 'GET') return send(200, { ok: true });

      const token = authenticate(req);
      if (!token) return send(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      const isStart = req.method === 'POST' && path === '/v1/bookings';
      if (rateLimited(token, isStart)) return send(429, { error: 'rate_limited' }, { 'retry-after': '60' });

      if (path === '/v1/schema') {
        if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return send(200, schemaDocument());
      }

      if (path === '/v1/bookings') {
        if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' }, { allow: 'POST' });
        if (fatal) return send(503, { error: 'worker_must_exit' });
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(415, { error: 'content_type_must_be_application_json' });
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!KEY.test(key)) return send(400, { error: 'idempotency_key_header_required', pattern: KEY.source });
        const jobKey = `${token}:${key}`;

        let raw: string;
        try {
          raw = await readBody(req, maxBody);
        } catch {
          return send(413, { error: 'body_too_large', maxBytes: maxBody }, { connection: 'close' });
        }
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid_json' }); }

        // The same checks the runner makes before admission; nothing is stored or counted on failure.
        const v = validateBooking(jobKey, body, now());
        if (!v.ok) return send(422, { idempotencyKey: key, state: 'NEEDS_INPUT', reason: v.reason, issues: v.issues ?? [] });
        if (!opts.canSubmit()) return send(503, { error: 'live_submissions_disabled' });

        if (running.has(jobKey)) return send(202, { idempotencyKey: key, status: 'running', statusUrl: `/v1/bookings/${key}` });
        if (running.size > 0) return send(409, { error: 'busy', retryAfterSeconds: 60 }, { 'retry-after': '60' });

        finished.delete(jobKey);
        const run = opts.agent.submitBooking(jobKey, body).then(
          (result) => remember(jobKey, result),
          (e: unknown) => {
            if (e instanceof BrowserDidNotStopError) {
              fatal = e;
              remember(jobKey, { error: 'the browser did not stop; the owner must check this job' });
              (opts.onFatal ?? (() => undefined))(e);
              return;
            }
            log(`booking ${key} ended with an internal error`);
            remember(jobKey, { error: 'internal error; read the status again, the database holds the outcome' });
          },
        ).finally(() => { running.delete(jobKey); });
        running.set(jobKey, run);
        return send(202, { idempotencyKey: key, status: 'accepted', statusUrl: `/v1/bookings/${key}` });
      }

      const m = /^\/v1\/bookings\/([^/]+)$/.exec(path);
      if (m) {
        if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' }, { allow: 'GET' });
        let key: string;
        try { key = decodeURIComponent(m[1]); } catch { return send(400, { error: 'invalid_idempotency_key' }); }
        if (!KEY.test(key)) return send(400, { error: 'invalid_idempotency_key' });
        // Only this token's own bookings: the stored key carries the token's id.
        const jobKey = `${token}:${key}`;
        if (running.has(jobKey)) return send(200, { idempotencyKey: key, status: 'running' });
        const job = await opts.agent.getBookingStatus(jobKey);
        const local = finished.get(jobKey);
        if (job) {
          return send(200, {
            idempotencyKey: key, status: 'recorded',
            job: { jobId: job.job_id, state: job.state, reason: job.state_reason, spectoraInspectionId: job.spectora_inspection_id,
                   appointmentAt: job.appointment_at, updatedAt: job.updated_at, meaning: STATE_MEANINGS[job.state] ?? null,
                   spectoraShown: job.spectora_shown ?? (local && 'state' in local ? local.spectoraShown : undefined) ?? null },
            ...(local && 'state' in local ? { issues: local.issues, duplicates: local.duplicates } : {}),
          });
        }
        if (local) {
          return 'error' in local
            ? send(200, { idempotencyKey: key, status: 'error', error: local.error })
            : send(200, { idempotencyKey: key, status: 'not_admitted', result: local, meaning: STATE_MEANINGS[local.state] ?? null });
        }
        return send(404, { error: 'not_found' });
      }

      return send(404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) send(500, { error: 'internal_error' });
    });
  });
  server.maxConnections = 64;
  return server;
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;                       // keep draining (bounded by requestTimeout), store nothing
      size += c.length;
      if (size > max) { over = true; chunks.length = 0; reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** What an AI assistant needs to turn a conversation into a valid request. */
export function schemaDocument() {
  const cat = loadCatalog();
  return {
    request: z.toJSONSchema(BookingRequestSchema),
    headers: { 'Idempotency-Key': 'Required. 8–180 characters [A-Za-z0-9._:-]. Reuse it to read the status; never reuse it for a different booking.' },
    services: cat.services.map((s) => ({ name: s.label.trim(), aliases: s.aliases,
      addOns: s.addOns.map((a) => ({ name: a.label, priceUsd: a.priceUsd, aliases: a.aliases })) })),
    notOffered: cat.notOffered,
    states: STATE_MEANINGS,
    rules: [
      'Send only what the customer said. Never invent missing details: leave optional fields out and ask the customer instead.',
      'Exactly one primary service per booking. Times are Arizona time, HH:MM, and must be an offered slot; no other time is chosen automatically.',
      'smsConsent may be true only when the customer explicitly agreed to texts.',
      'A booking is REQUESTED, not confirmed, until the owner confirms it in Spectora.',
      'Spectora sets the price. The agent does not check it; the status shows what Spectora displayed (spectoraShown).',
      'squareFeet and yearBuilt are optional: send them only if the customer gave them. Otherwise Spectora\'s property lookup values are used.',
    ],
  };
}
