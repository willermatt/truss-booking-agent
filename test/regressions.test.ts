/**
 * Regression tests for the third independent review. Each reproduces a confirmed finding and checks
 * that it now fails closed. (The duplicate-matching and Review-address cases are in address.test.ts and
 * review.test.ts; the stuck-browser case is in stuckBrowser.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { SafetyGate, type Reservation } from '../src/safety/gate.js';
import type { BookingResult } from '../src/booking/runner.js';
import { SpectoraReadApi, type FetchLike } from '../src/spectora/readApi.js';
import type { SchedulerDriver } from '../src/booking/driver.js';
import { createAgentInterface } from '../src/agent/interface.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

describe('M3: a worker that lost its session never opens a browser', () => {
  it('frozen during the Spectora check while another job was admitted: no browser, no Steps', async () => {
    const env = await TestEnv.create(cluster);
    let starts = 0;
    let markEntered!: () => void;
    const secondInBrowser = new Promise<void>((r) => { markEntered = r; });
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const driver: SchedulerDriver = {
      kind: 'mock',
      start: async (job, signal) => {
        starts++;
        const inner = await env.driver.start(job, signal);
        return { ...inner, prepare: async (s) => { markEntered(); await hold; return inner.prepare(s); } };
      },
    };
    const runner2 = env.runner({ driver, gate: new SafetyGate(env.db.pool('truss_app')) });
    let second!: Promise<BookingResult>;
    let hooked = false;
    const frozenFetch: FetchLike = async (url, init) => {
      if (!hooked) {
        hooked = true;
        await env.advanceMinutes(3);                      // worker 1's lease lapses while it is frozen
        second = runner2.run(env.key(), env.request());   // worker 2 is admitted and enters its browser
        await secondInBrowser;
      }
      return env.spectora.fetch(url, init);
    };
    const api = new SpectoraReadApi({ apiKey: 'k', fetch: frozenFetch, sleep: async () => undefined });
    const first = await env.runner({ driver, spectora: api }).run(env.key(), env.request());
    expect(first).toMatchObject({ state: 'FAILED', reason: 'worker_lease_expired' });
    expect(starts).toBe(1);                       // only worker 2 ever started a browser
    expect(env.driver.maxOpenBrowsers).toBe(1);
    release();
    expect((await second).state).toBe('REQUESTED');
  });

  it('a session that lapses after the duplicate check is caught before the browser starts', async () => {
    const env = await TestEnv.create(cluster);
    class SlowAfterCheck extends SafetyGate {
      override async recordDuplicateCheck(...a: Parameters<SafetyGate['recordDuplicateCheck']>) {
        const r = await super.recordDuplicateCheck(...a);
        await env.advanceMinutes(3);              // frozen right after recording a clear check
        return r;
      }
    }
    const res = await env.runner({ gate: new SlowAfterCheck(env.db.pool('truss_app')) }).run(env.key(), env.request());
    expect(res.state).toBe('FAILED');
    expect(env.driver.startCalls).toBe(0);
  });

  it('a clear duplicate check the database did not record stops the job before any browser', async () => {
    const env = await TestEnv.create(cluster);
    class NotRecorded extends SafetyGate {
      override async recordDuplicateCheck(..._a: Parameters<SafetyGate['recordDuplicateCheck']>) {
        return { ok: false, reason: 'job_not_checkable' };
      }
    }
    const res = await env.runner({ gate: new NotRecorded(env.db.pool('truss_app')) }).run(env.key(), env.request());
    expect(res.state).toBe('BLOCKED');
    expect(env.driver.startCalls).toBe(0);
  });

  it('a session that lapses between steps stops the driver at the next step', async () => {
    const env = await TestEnv.create(cluster);
    const driver: SchedulerDriver = {
      kind: 'mock',
      start: async (job, signal) => {
        const inner = await env.driver.start(job, signal);
        return { ...inner, prepare: async (s) => { await env.advanceMinutes(3); return inner.prepare(s); } };
      },
    };
    const res = await env.runner({ driver }).run(env.key(), env.request());
    expect(res.state).toBe('FAILED');
    expect(env.driver.prepareCalls).toBe(0);      // the mock's own checkpoint refused before Step 1
    expect(env.driver.submitCalls).toBe(0);
  });
});

describe('M6: the attempt is counted immediately before the submit', () => {
  it('a reservation not verified within 10 seconds is never submitted', async () => {
    const env = await TestEnv.create(cluster);
    class SlowVerify extends SafetyGate {
      override async verifyReservation(r: Reservation) {
        await env.advanceMinutes(0.25);           // 15 s pass between counting and verifying
        await this.renewSession(r.handle);
        return super.verifyReservation(r);
      }
    }
    const res = await env.runner({ gate: new SlowVerify(env.db.pool('truss_app')) }).run(env.key(), env.request());
    expect(res.state).toBe('FAILED');
    expect(env.driver.submitCalls).toBe(0);
  });

  it('the reviewer’s sequence (counted 08:00, then 08:10, then 09:00:01) cannot put 3 submits inside 60 minutes', async () => {
    const env = await TestEnv.create(cluster);
    const submitTimes: number[] = [];
    const driver: SchedulerDriver = {
      kind: 'mock',
      start: async (job, signal) => {
        const inner = await env.driver.start(job, signal);
        return { ...inner, submit: (r, s, by) => { submitTimes.push(env.now.getTime()); return inner.submit(r, s, by); } };
      },
    };
    class SlowConnect extends SafetyGate {
      override async verifyReservation(r: Reservation) {
        for (let i = 0; i < 5; i++) { await env.advanceMinutes(1); await this.renewSession(r.handle); }
        return super.verifyReservation(r);
      }
    }
    await env.setTime('2026-11-02T08:00:00-07:00');
    expect((await env.runner({ driver, gate: new SlowConnect(env.db.pool('truss_app')) }).run(env.key(), env.request())).state).toBe('FAILED');
    await env.setTime('2026-11-02T08:10:00-07:00');
    expect((await env.runner({ driver }).run(env.key(), env.request())).state).toBe('REQUESTED');
    await env.setTime('2026-11-02T09:00:01-07:00');
    expect((await env.runner({ driver }).run(env.key(), env.request())).reason).toBe('hourly_limit_reached');
    expect(submitTimes).toHaveLength(1);
  });

  it('no reservation in the last 90 seconds of an Arizona day', async () => {
    const env = await TestEnv.create(cluster, { at: '2026-11-02T23:58:20-07:00' });
    const h = await env.ready();
    await env.setTime('2026-11-02T23:58:30-07:00');
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'too_close_to_midnight' });
    await env.setTime('2026-11-02T23:59:30-07:00');
    await env.gate.renewSession(h);
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'too_close_to_midnight' });
    await env.setTime('2026-11-03T00:00:00-07:00');
    await env.gate.renewSession(h);
    expect((await env.gate.reserve(h)).ok).toBe(true);
  });
});

describe('N1: the 10-minute cap holds at every step', () => {
  it('no duplicate-check record, reservation or verification after 10 minutes; verify cannot extend a session forever', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.admit();
    for (let i = 0; i < 9; i++) { await env.advanceMinutes(1); expect((await env.gate.renewSession(h)).ok).toBe(true); }
    await env.advanceMinutes(1.5);
    expect(await env.gate.recordDuplicateCheck(h, 'clear', {})).toMatchObject({ ok: false, reason: 'session_max_duration' });

    const g = await (async () => { await env.advanceMinutes(3); await env.gate.expireStaleSessions(); return env.ready(); })();
    for (let i = 0; i < 9; i++) { await env.advanceMinutes(1); await env.gate.renewSession(g); }
    await env.advanceMinutes(1.5);
    expect(await env.gate.reserve(g)).toMatchObject({ ok: false, reason: 'session_max_duration' });

    await env.advanceMinutes(3);
    await env.gate.expireStaleSessions();
    const k = await env.ready();
    const r = await env.gate.reserve(k);
    if (!r.ok) throw new Error('reserve');
    expect((await env.gate.verifyReservation(r.reservation)).ok).toBe(true);
    await env.advanceMinutes(0.25);
    expect(await env.gate.verifyReservation(r.reservation)).toMatchObject({ ok: false, reason: 'reservation_stale' });
  });
});

describe('N2: the worker cannot re-point a REQUESTED job', () => {
  it('confirming with a different inspection id is refused', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const r = await env.gate.reserve(h);
    if (!r.ok) throw new Error('reserve');
    await env.gate.completeAttempt(r.reservation, 'requested', {}, 'S-REAL');
    expect(await env.gate.reconcileFound(h, 'S-SOMETHING-ELSE', true)).toMatchObject({ ok: false, reason: 'inspection_id_mismatch' });
    expect(await env.gate.reconcileFound(h, 'S-REAL', true)).toMatchObject({ ok: true, state: 'CONFIRMED' });
    expect(await env.gate.getJob(h.jobId)).toMatchObject({ state: 'CONFIRMED', spectora_inspection_id: 'S-REAL' });
  });
});

describe('M1 / M5 end to end: duplicates that used to get through', () => {
  const other = { firstName: 'Other', lastName: 'Buyer', email: 'other@example.com', phone: '4805550000' };

  it('Spectora has 1234 E Mountain View Rd; a request for "1234 E Mountain View" is blocked for manual booking', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '1234 E Mountain View', city: 'Phoenix', state: 'AZ', zip: '85020' } });
    env.spectora.add({ id: 'EXISTING', datetime: new Date(`${req.appointment.date}T08:00:00-07:00`).toISOString(),
      address: '1234 E Mountain View Rd', zip: '85020', buyer: other });
    expect(await env.runner().run(env.key(), req)).toMatchObject({ state: 'BLOCKED', reason: 'ambiguous_match_manual_booking_required' });
    expect(env.driver.startCalls).toBe(0);
  });

  it('the database catches Río / Rio among its own jobs', async () => {
    const env = await TestEnv.create(cluster);
    const first = env.request({ property: { street: '1000 E Rio Salado Pkwy', city: 'Tempe', state: 'AZ', zip: '85281' } });
    expect((await env.runner().run(env.key(), first)).state).toBe('REQUESTED');
    await env.advanceMinutes(62);
    const second = env.request({ property: { street: '1000 E Río Salado Pkwy', city: 'Tempe', state: 'AZ', zip: '85281' },
                                 appointment: first.appointment });
    expect(await env.runner().run(env.key(), second)).toMatchObject({ state: 'BLOCKED', reason: 'local_duplicate' });
    expect(env.driver.submitCalls).toBe(1);
  });

  it('a Spectora response without a total record count is not trusted', async () => {
    const env = await TestEnv.create(cluster);
    const noRecords: FetchLike = async (url, init) => {
      const res = await env.spectora.fetch(url, init);
      const body = (await res.json()) as { meta?: { pagination?: Record<string, unknown> } };
      delete body.meta?.pagination?.records;
      return { status: res.status, headers: res.headers, json: async () => body };
    };
    const api = new SpectoraReadApi({ apiKey: 'k', fetch: noRecords, sleep: async () => undefined });
    expect(await env.runner({ spectora: api }).run(env.key(), env.request())).toMatchObject({
      state: 'BLOCKED', reason: 'duplicate_check_unavailable' });
    // More distinct inspections than the total Spectora reports: the results changed while being read.
    const undercount: FetchLike = async (url, init) => {
      const res = await env.spectora.fetch(url, init);
      const body = (await res.json()) as { meta?: { pagination?: Record<string, number> } };
      if (body.meta?.pagination && body.meta.pagination.records > 0) body.meta.pagination.records -= 1;
      return { status: res.status, headers: res.headers, json: async () => body };
    };
    env.spectora.add({ id: 'ANY-1', datetime: new Date(Date.now() + 5 * 86_400_000).toISOString(), address: '1 N Nowhere Rd', zip: '85001' });
    const api3 = new SpectoraReadApi({ apiKey: 'k', fetch: undercount, sleep: async () => undefined });
    expect((await env.runner({ spectora: api3 }).run(env.key(), env.request())).reason).toBe('duplicate_check_unavailable');
    const noData: FetchLike = async () => ({ status: 200, headers: new Headers(), json: async () => ({ meta: { pagination: { last: 1, records: 0 } } }) });
    const api2 = new SpectoraReadApi({ apiKey: 'k', fetch: noData, sleep: async () => undefined });
    expect((await env.runner({ spectora: api2 }).run(env.key(), env.request())).reason).toBe('duplicate_check_unavailable');
  });
});

describe('N5 / N11: what an AI client sees', () => {
  it('possible matches are reported only by kind: no id, time, address or customer relation; status carries no detail', async () => {
    const env = await TestEnv.create(cluster);
    const agent = createAgentInterface(env.runner(), env.gate);
    const req = env.request({ customer: { firstName: 'Dana', lastName: 'Lee', email: 'dana@example.com', phone: '6025550123' } });
    env.spectora.add({ id: 'NAME-ONLY', datetime: new Date(`${req.appointment.date}T08:00:00-07:00`).toISOString(),
      address: '77 W Someone Elses Rd', zip: '85001', buyer: { firstName: 'Dana', lastName: 'Lee', email: 'x@example.com', phone: '4805550000' } });
    const res = await agent.submitBooking(env.key(), req);
    expect(res).toMatchObject({ state: 'BLOCKED', reason: 'ambiguous_match_manual_booking_required' });
    expect(res.duplicates).toEqual([{ kind: 'ambiguous' }]);
    const shown = JSON.stringify(res) + JSON.stringify(await agent.getBookingStatus(res.jobId!));
    for (const secret of ['NAME-ONLY', 'Someone Elses', '85001', 'x@example.com', '4805550000']) expect(shown).not.toContain(secret);
  });
});
