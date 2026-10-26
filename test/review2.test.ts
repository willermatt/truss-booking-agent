/**
 * Regression tests for the second independent review: each reproduces one of its exploits against the
 * database, the runner or the AI interface, and checks that it now fails closed. The browser cases are in
 * browser.test.ts ("second review"), the Review date and time cases in review.test.ts, and the address
 * spellings in address.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { createAgentInterface } from '../src/agent/interface.js';
import { validateBooking } from '../src/booking/runner.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

describe('M5: the kill switch is not behind any lock a worker can hold', () => {
  it('owner disable returns at once while truss_app holds the control row with every timeout lifted', async () => {
    const env = await TestEnv.create(cluster);
    const evil = new pg.Client({ connectionString: env.db.url('truss_app') });
    await evil.connect();
    try {
      await evil.query('SET idle_in_transaction_session_timeout = 0; SET lock_timeout = 0; SET statement_timeout = 0');
      // One statement that takes the control row FOR UPDATE and then holds it (explicit transaction
      // blocks are refused to worker functions, so this is how long a worker can hold it).
      const holding = evil.query('SELECT safety.app_expire_stale_sessions(), pg_sleep(6)');
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      const r = await env.owner<{ ok: boolean }>('owner_disable_submissions', ['stop now']);
      expect(r.ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3_000);
      await holding;
    } finally {
      await evil.end();
    }
    expect((await env.status()).submissions_enabled).toBe(false);
  }, 30_000);

  it('a disable after the reservation is seen by verification: the attempt is not submitted', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const res = await env.gate.reserve(h);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await env.owner('owner_disable_submissions', ['stop now']);
    expect(await env.gate.verifyReservation(res.reservation)).toMatchObject({ ok: false, reason: 'submissions_disabled' });
  });

  it('a disable while a booking is being prepared stops it before the submit', async () => {
    const env = await TestEnv.create(cluster);
    const summary = env.driver.summaryFor;
    env.driver.summaryFor = (job) => { void env.owner('owner_disable_submissions', ['stop now']); return summary(job); };
    // The disable is committed before the reservation or, at the latest, before verification.
    const res = await env.runner().run(env.key(), env.request());
    await new Promise((r) => setTimeout(r, 200));
    expect(env.driver.submitCalls).toBe(0);
    expect(res.state).not.toBe('REQUESTED');
  });
});

describe('M3: the send-by deadline runs from the counted attempt', () => {
  it('verification returns what is left of the 20 s budget, and refuses after 10 s', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const res = await env.gate.reserve(h);
    if (!res.ok) throw new Error(JSON.stringify(res));
    await env.setTime(new Date(env.now.getTime() + 8_000));
    expect(await env.gate.verifyReservation(res.reservation)).toMatchObject({ ok: true, send_within_ms: 12_000 });
    await env.setTime(new Date(env.now.getTime() + 3_000));
    expect((await env.gate.verifyReservation(res.reservation)).ok).toBe(false);
  });

  for (const [label, budget] of [['no budget left', 0], ['no budget given', undefined]] as const) {
    it(`verification with ${label}: the runner never calls submit; the attempt counts and is not UNKNOWN`, async () => {
      const env = await TestEnv.create(cluster);
      const gate = Object.create(env.gate) as typeof env.gate;
      gate.verifyReservation = async (r) => ({ ...(await env.gate.verifyReservation(r)), send_within_ms: budget });
      const res = await env.runner({ gate }).run(env.key(), env.request());
      expect(env.driver.sendBys).toHaveLength(0);
      expect(res.state).toBe('FAILED');
      expect(await env.attemptCount()).toBe(1);
      expect((await env.status()).unreconciled_unknown).toBe(0);
    });
  }

  it('the runner hands the driver a deadline no later than the budget allows', async () => {
    const env = await TestEnv.create(cluster);
    expect((await env.runner().run(env.key(), env.request())).state).toBe('REQUESTED');
    const by = env.driver.sendBys[0]!;
    expect(by.wallMs - by.receivedWallMs).toBeGreaterThan(15_000);
    expect(by.wallMs - by.receivedWallMs).toBeLessThanOrEqual(20_000);
  });
});

describe('N7: a browser that may still be running keeps its slot until the owner releases it', () => {
  it('the worker cannot end the session; no second session; the owner releases it after the lease lapses', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.admit();
    await env.gate.markBrowserUnconfirmed(h);
    expect(await env.gate.endSession(h, 'BLOCKED', 'whatever')).toMatchObject({ ok: false, reason: 'browser_unconfirmed' });
    expect(await env.gate.recordExecutionError(h, 'step1', {})).toMatchObject({ ok: false, reason: 'browser_unconfirmed' });
    await expect(env.admit()).rejects.toThrow(/browser_session_active/);
    expect(await env.owner('owner_release_session', [h.jobId, 'checked the host'])).toMatchObject({ ok: false, reason: 'session_in_progress' });
    await env.advanceMinutes(3);
    expect(await env.owner('owner_release_session', [h.jobId, 'checked the host'])).toMatchObject({ ok: true });
    await env.admit();
  });
});

describe('N10: SMS consent needs a record of how it was given', () => {
  const at = new Date('2026-11-01T17:00:00Z');
  const base = (env: TestEnv) => env.request();
  it('true without evidence is NEEDS_INPUT before anything is counted; with evidence it is accepted', async () => {
    const env = await TestEnv.create(cluster);
    const without = validateBooking('consent-check-1', { ...base(env), smsConsent: { transactional: true, marketing: false } }, at);
    expect(without).toMatchObject({ ok: false });
    expect(JSON.stringify(without)).toMatch(/evidence is required/);
    const res = await env.runner().run(env.key(), { ...base(env), smsConsent: { transactional: false, marketing: true } });
    expect(res.state).toBe('NEEDS_INPUT');
    expect(await env.jobCount()).toBe(0);
    expect(validateBooking('consent-check-2', { ...base(env), smsConsent: { transactional: true, marketing: false,
      evidence: 'Customer agreed to booking texts on the phone call' } }, at)).toMatchObject({ ok: true });
    expect(validateBooking('consent-check-3', { ...base(env), smsConsent: { transactional: false, marketing: false } }, at))
      .toMatchObject({ ok: true });
  });
});

describe('M6: equivalent spellings of the same property are the same property', () => {
  const other = { firstName: 'Someone', lastName: 'Else', email: 'else@example.com', phone: '4805550000' };
  const at = (req: { appointment: { date: string } }) => new Date(`${req.appointment.date}T10:00:00-07:00`).toISOString();
  for (const [inSpectora, requested] of [
    ['1234 W Saint John Rd', '1234 W St John Rd'],
    ['12345 N.W. Grand Ave', '12345 NW Grand Ave'],
    ['1234 E Mount View Rd', '1234 E Mt View Rd'],
  ]) {
    it(`Spectora has "${inSpectora}" (another customer, same day): "${requested}" is a duplicate`, async () => {
      const env = await TestEnv.create(cluster);
      const req = env.request({ property: { street: requested, city: 'Phoenix', state: 'AZ', zip: '85029' } });
      env.spectora.add({ id: 'S-1', datetime: at(req), address: inSpectora, zip: '85029', buyer: other });
      const res = await env.runner().run(env.key(), req);
      expect(res).toMatchObject({ state: 'BLOCKED', reason: 'potential_duplicate' });
      expect(env.driver.submitCalls).toBe(0);
    });
  }

  it('the database check: after "1234 W St John Rd" is REQUESTED, "1234 W Saint John Rd" is refused', async () => {
    const env = await TestEnv.create(cluster);
    const prop = (street: string) => ({ property: { street, city: 'Phoenix', state: 'AZ', zip: '85029' } });
    expect((await env.runner().run(env.key(), env.request(prop('1234 W St John Rd')))).state).toBe('REQUESTED');
    await env.advanceMinutes(62);
    const r2 = await env.runner().run(env.key(), env.request(prop('1234 W Saint John Rd')));
    expect(r2.state).toBe('BLOCKED');
    expect(env.driver.submitCalls).toBe(1);
  });
});

describe('N11: the AI cannot use the duplicate check to look up other people’s bookings', () => {
  it('probing with someone else’s email reveals only that a possible match exists', async () => {
    const env = await TestEnv.create(cluster);
    const probe = env.request({ customer: { firstName: 'Any', lastName: 'Name', email: 'victim@example.com', phone: '6025559999' } });
    env.spectora.add({ id: 'S-77', datetime: new Date(`${probe.appointment.date}T08:00:00-07:00`).toISOString(), confirmed: true,
      address: '999 N Elsewhere Dr', zip: '85254', buyer: { firstName: 'Vic', lastName: 'Tim', email: 'victim@example.com', phone: '4805551111' } });
    const res = await createAgentInterface(env.runner(), env.gate).submitBooking(env.key(), probe);
    expect(res.state).toBe('BLOCKED');
    expect(res.duplicates).toEqual([{ kind: 'ambiguous' }]);
    for (const secret of ['S-77', 'Elsewhere', '85254', 'confirmed', '4805551111']) expect(JSON.stringify(res)).not.toContain(secret);
  });
});
