/**
 * Regression tests for the third independent review: each reproduces one of its exploits (database,
 * runner, API, create-body check) and checks that it now fails closed. The browser cases are in
 * browser.test.ts ("third review"), the address cases in address.test.ts and address-parity.test.ts,
 * and the stuck start in stuckBrowser.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { SafetyGate, type JobHandle } from '../src/safety/gate.js';
import { consentProblem, createBodyProblem } from '../src/booking/playwrightDriver.js';
import { createBookingApi, sha256Hex } from '../src/api/server.js';
import { createAgentInterface } from '../src/agent/interface.js';
import { BookingRequestSchema } from '../src/booking/schema.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

describe('M1: an admission must be committed before any browser starts', () => {
  it('jobs run inside a transaction that is rolled back never open a browser', async () => {
    const env = await TestEnv.create(cluster);
    const c = new pg.Client({ connectionString: env.db.url('truss_app') });
    await c.connect();
    // A worker whose database client wraps each job in one transaction and rolls it back.
    const txPool = { query: (sql: string, params?: unknown[]) => c.query(sql, params), options: {} } as unknown as pg.Pool;
    const runner = env.runner({ gate: new SafetyGate(txPool) });
    const states: string[] = [];
    for (let i = 0; i < 5; i++) {
      await c.query('BEGIN');
      const res = await runner.dryRun(env.key('tx'), env.request()).catch(() => ({ state: 'ERROR' }));
      states.push(res.state);
      await c.query('ROLLBACK');
    }
    await c.end();
    expect(states).not.toContain('DRY_RUN');
    expect(env.driver.startCalls).toBe(0);
    expect((await env.status()).jobs_today).toBe(0);
  });

  it('every writing worker function refuses to run after the same transaction has written', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const app = new pg.Client({ connectionString: env.db.url('truss_app') });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query('SELECT safety.app_expire_stale_sessions()');   // takes a transaction id
      await app.query(`SELECT safety.app_renew_session($1, 'x')`, [h.jobId]).then(
        () => { throw new Error('renewal ran inside a writing transaction'); },
        (e: { code?: string; message: string }) => { expect(e.code).toBe('25000'); });
    } finally {
      await app.query('ROLLBACK').catch(() => undefined);
      await app.end();
    }
  });
});

describe('MINOR 7: commits must be durable', () => {
  it('with synchronous_commit off (set by the worker role on itself) nothing is admitted', async () => {
    const env = await TestEnv.create(cluster);
    const admin = new pg.Client({ connectionString: env.db.url('truss_app') });
    await admin.connect();
    await admin.query('ALTER ROLE truss_app SET synchronous_commit = off');
    const pool = new pg.Pool({ connectionString: env.db.url('truss_app'), max: 2 });
    try {
      const res = await env.runner({ gate: new SafetyGate(pool) }).dryRun(env.key(), env.request()).catch(() => ({ state: 'ERROR' }));
      expect(res.state).toBe('ERROR');
      expect(await env.jobCount()).toBe(0);
      expect(env.driver.startCalls).toBe(0);
    } finally {
      await admin.query('ALTER ROLE truss_app RESET synchronous_commit');
      await admin.end();
      await pool.end();
    }
  });
});

describe('M2: an existing inspection whose house number does not read cleanly is not a different property', () => {
  for (const stored of ['1700W Washington St', 'Unit 4, 1700 W Washington St', '1700-4 W Washington St']) {
    it(`Spectora has "${stored}" for the same customer 3 days later: BLOCKED for manual booking`, async () => {
      const env = await TestEnv.create(cluster);
      const req = env.request({ property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' } }) as
        { appointment: { date: string }; customer: { firstName: string; lastName: string; email: string; phone: string } };
      const appt = new Date(`${req.appointment.date}T08:00:00-07:00`);
      env.spectora.add({ id: 'S-EXISTING', datetime: new Date(appt.getTime() + 3 * 86_400_000).toISOString(), address: stored,
                         zip: '85007', buyer: { ...req.customer } });
      const res = await env.runner().run(env.key(), req);
      expect(res).toMatchObject({ state: 'BLOCKED', reason: 'ambiguous_match_manual_booking_required' });
      expect(env.driver.submitCalls).toBe(0);
    });
  }

  it('an unreadable stored address with no ZIP still blocks for the same customer', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' } }) as
      { appointment: { date: string }; customer: { firstName: string; lastName: string; email: string; phone: string } };
    const appt = new Date(`${req.appointment.date}T08:00:00-07:00`);
    env.spectora.add({ id: 'S-NOZIP', datetime: new Date(appt.getTime() + 3 * 86_400_000).toISOString(),
                       address: 'Unit 4, 1700 W Washington St', zip: '', buyer: { ...req.customer } });
    expect(await env.runner().run(env.key(), req)).toMatchObject({ state: 'BLOCKED', reason: 'ambiguous_match_manual_booking_required' });
  });

  it('another customer, another day, a ZIP that does not match: not a match', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' } }) as
      { appointment: { date: string } };
    const appt = new Date(`${req.appointment.date}T08:00:00-07:00`);
    env.spectora.add({ id: 'S-OTHER', datetime: new Date(appt.getTime() + 3 * 86_400_000).toISOString(),
                       address: 'Unit 4, 99 E Elsewhere Rd', zip: '85254',
                       buyer: { firstName: 'Someone', lastName: 'Else', email: 'else@example.com', phone: '4805550000' } });
    expect((await env.runner().run(env.key(), req)).state).toBe('REQUESTED');
  });
});

describe('M4: a worker whose database stops answering closes its browser before its lease can lapse', () => {
  it('renewals that never return: the watchdog stops the job, so a later job never runs alongside it', async () => {
    const env = await TestEnv.create(cluster);
    let hang = false;
    class PartitionedGate extends SafetyGate {
      override renewSession(h: JobHandle) {
        return hang ? new Promise<never>(() => undefined) : super.renewSession(h);
      }
    }
    const stuckGate = new PartitionedGate(env.db.pool('truss_app'));
    env.driver.setPrepare((n) => (n === 1 ? { kind: 'hang' } : { kind: 'ok' }));
    const first = env.runner({ gate: stuckGate, prepareDeadlineMs: 60_000, leaseRenewMs: 50, renewWatchdogMs: 400 })
      .dryRun(env.key('a'), env.request());
    while (env.driver.prepareCalls < 1) await new Promise((r) => setTimeout(r, 10));
    hang = true;
    const res = await first;                          // ends on its own: the watchdog aborted it
    expect(res.state).toBe('FAILED');
    expect(env.driver.openBrowsers).toBe(0);
    await env.advanceMinutes(3);
    expect((await env.runner().dryRun(env.key('b'), env.request())).state).toBe('DRY_RUN');
    expect(env.driver.maxOpenBrowsers).toBe(1);
  });

  it('the watchdog must sit inside the 2-minute lease', async () => {
    const env = await TestEnv.create(cluster);
    expect(() => env.runner({ renewWatchdogMs: 120_000 })).toThrow(/at most 90 s/);
    expect(() => env.runner({ leaseRenewMs: 20_000, renewWatchdogMs: 10_000 })).toThrow(/above leaseRenewMs/);
  });
});

describe('MINOR 3: the send budget cannot grow', () => {
  it('a database clock that steps back between reserve and verify: nothing is sent', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const r = await env.gate.reserve(h);
    if (!r.ok) throw new Error(JSON.stringify(r));
    await env.setTime(new Date(env.now.getTime() - 60_000));
    expect(await env.gate.verifyReservation(r.reservation)).toMatchObject({ ok: false, reason: 'clock_moved_back' });
  });
});

describe('MINOR 8: "Require Confirmation" switched off in Spectora', () => {
  it('a booking Spectora confirms on creation turns submissions off; the next booking is refused', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setSubmit({ kind: 'requested', confirmedOnCreate: true });
    expect((await env.runner().run(env.key(), env.request())).state).toBe('REQUESTED');
    expect((await env.status()).submissions_enabled).toBe(false);
    await env.advanceMinutes(62);
    expect(await env.runner().run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'submissions_disabled' });
    const { rows } = await env.db.pool('truss_owner').query(`SELECT kind FROM safety.owner_events WHERE kind = 'require_confirmation_off'`);
    expect(rows).toHaveLength(1);
  });

  it('the worker cannot change the kill switch at all; a report can only ever stop submissions', async () => {
    const env = await TestEnv.create(cluster);
    const app = env.db.pool('truss_app');
    await expect(app.query(`SELECT safety.owner_enable_submissions('x', 'y')`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`SELECT safety.owner_disable_submissions('x')`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`INSERT INTO safety.confirmation_reports (job_id, reported_at, kill_switch_generation, source)
                            VALUES (gen_random_uuid(), now(), 0, 'create_answer')`)).rejects.toMatchObject({ code: '42501' });
    expect((await env.status()).submissions_enabled).toBe(true);
  });
});

describe('MINOR 6: each API token sees only its own bookings', () => {
  const servers: http.Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

  it('client B cannot read client A\'s booking by its key', async () => {
    const env = await TestEnv.create(cluster);
    const A = 'client-a-token-0123456789-abcdefghij', B = 'client-b-token-0123456789-abcdefghij';
    const server = createBookingApi({ agent: createAgentInterface(env.runner(), env.gate), canSubmit: () => true,
      tokenHashes: [sha256Hex(A), sha256Hex(B)], now: () => env.now, log: () => undefined });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (t: string, method: string, path: string, body?: unknown, key?: string) => {
      const r = await fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
      return { status: r.status, body: await r.json() as Record<string, any> };
    };
    const key = 'booking-0001';
    expect((await call(A, 'POST', '/v1/bookings', env.request(), key)).status).toBe(202);
    let seen;
    for (let i = 0; i < 200; i++) { seen = await call(A, 'GET', `/v1/bookings/${key}`); if (seen.body.status !== 'running') break; await new Promise((r) => setTimeout(r, 25)); }
    expect(seen!.body).toMatchObject({ status: 'recorded', job: { state: 'REQUESTED' } });
    expect(await call(B, 'GET', `/v1/bookings/${key}`)).toMatchObject({ status: 404 });
    expect(await call(B, 'GET', `/v1/bookings/${seen!.body.job.jobId}`)).toMatchObject({ status: 404 });
    // Naming A's stored key ("<A's token id>:<key>") does not reach it either.
    expect(await call(B, 'GET', `/v1/bookings/${sha256Hex(A).slice(0, 12)}:${key}`)).toMatchObject({ status: 404 });
    // B's own booking under the same key is a different job.
    expect((await call(B, 'POST', '/v1/bookings', env.request(), key)).status).toBe(202);
  });
});

describe('MINOR 5 and M3: the create request\'s own body', () => {
  const env0 = { request: () => BookingRequestSchema.parse({
    property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' },
    customer: { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '602-555-0100' },
    appointment: { date: '2026-11-12', time: '08:00' }, services: ['Residential Home Inspection'], squareFeet: 1800, yearBuilt: 1954 }) };
  const good = { services: [13628], datetime: '2026-11-12 8:00 AM',
    client: { first: 'Pat', last: 'Lee', email: 'pat@example.com', phone: '6025550100', sms: false, sms_marketing: false },
    agent: null, property: { address: '1700 W Washington St', unit: '', zip: '85007', square_feet: '1800', year_built: '1954' } };

  it('consent: bodies that are not JSON, nested opt-ins and other key names are refused', () => {
    expect(consentProblem('client[sms_opt_in]=1&client[sms_marketing]=1', undefined)).toMatch(/not JSON/);
    expect(consentProblem(JSON.stringify({ client: { sms: { opt_in: true, marketing: true } } }), undefined)).toMatch(/without consent/);
    expect(consentProblem(JSON.stringify({ client: { consent_to_texts: true } }), undefined)).toMatch(/without consent/);
    expect(consentProblem(JSON.stringify({ client: { sms: 'yes' } }), undefined)).toMatch(/without consent/);
    expect(consentProblem(JSON.stringify({ agent: { sms: true } }), { transactional: true, marketing: true })).toMatch(/agents are never/);
    expect(consentProblem(JSON.stringify({ client: { sms: true, sms_marketing: false } }), { transactional: true, marketing: false })).toBeNull();
  });

  it('the faithful body passes', () => {
    expect(createBodyProblem(JSON.stringify(good), env0.request())).toBeNull();
  });

  it('another person\'s name, email or phone, other property facts, or missing facts are refused', () => {
    const req = env0.request();
    const variant = (patch: (b: any) => void) => { const b = structuredClone(good) as any; patch(b); return createBodyProblem(JSON.stringify(b), req); };
    expect(variant((b) => { b.client.first = 'Someone'; b.client.last = 'Else'; })).toMatch(/first name/);
    // The right name somewhere else in the body does not excuse another name in the client's fields.
    expect(variant((b) => { b.extra = { a: 'Pat', b: 'Lee', c: 'pat@example.com', d: '6025550100' }; b.client.first = 'Someone'; })).toMatch(/client\.first is "Someone"/);
    expect(variant((b) => { b.extra = { a: 'Pat', b: 'Lee', c: 'pat@example.com', d: '6025550100' }; b.client.email = 'else@example.com'; })).toMatch(/client\.email/);
    expect(variant((b) => { b.extra = { a: 'Pat', b: 'Lee', c: 'pat@example.com', d: '6025550100' }; b.client.phone = '4805550000'; })).toMatch(/client\.phone/);
    expect(variant((b) => { b.client.email = 'else@example.com'; })).toMatch(/email/);
    expect(variant((b) => { b.client.phone = '4805550000'; })).toMatch(/phone/);
    expect(variant((b) => { b.property.square_feet = '1950'; })).toMatch(/square/);
    expect(variant((b) => { b.property.square_feet = '1950'; b.property.living_area = '1800'; b.extra = { square_feet: 1950 }; })).toMatch(/1950/);
    expect(variant((b) => { b.property.year_built = '1999'; })).toMatch(/year/);
    expect(variant((b) => { b.property.zip = '85008'; })).toMatch(/ZIP/);
    expect(variant((b) => { b.property.unit = '4B'; })).toMatch(/unit/);
    expect(variant((b) => { b.agent = { first: 'Alex', last: 'Agent' }; })).toMatch(/agent/);
    expect(variant((b) => { delete b.property.square_feet; })).toMatch(/does not carry the requested square feet/);
    expect(variant((b) => { b.client = { client_id: 991 }; })).toMatch(/does not carry the requested customer/);
    expect(createBodyProblem('not json', req)).toMatch(/not JSON/);
  });
});
