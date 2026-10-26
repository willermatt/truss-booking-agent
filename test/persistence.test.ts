/**
 * Counters, the kill switch, the circuit breaker and browser sessions live in PostgreSQL. A server
 * restart, new worker processes (new connection pools) and a redeploy (all migrations re-applied) change
 * none of them. A dead or frozen worker's session blocks everything until its lease lapses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { SafetyGate } from '../src/safety/gate.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

async function realClockEnv(enable = true) {
  const env = await TestEnv.create(cluster, { enable });
  await env.db.redeploy(); // restores the production clock
  env.now = new Date();
  return env;
}

/** A fresh worker process after a restart or deploy: brand-new pool and gate. */
function freshRunner(env: TestEnv) {
  env.gate = new SafetyGate(env.db.pool('truss_app'));
  return env.runner({ now: () => new Date() });
}

describe('state survives restarts and deployments', () => {
  it('job and submission counts survive a database restart and a redeploy', async () => {
    const env = await realClockEnv();
    const runner = env.runner({ now: () => new Date() });
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    env.driver.setPrepare({ kind: 'unavailable' });
    for (let i = 0; i < 3; i++) await runner.run(env.key(), env.request()); // blocked by the hour limit at admission
    env.driver.setPrepare({ kind: 'ok' });

    await cluster.restart();
    expect(await env.status()).toMatchObject({ attempts_last_hour: 2, attempts_today: 2, jobs_today: 2 });
    expect((await freshRunner(env).run(env.key(), env.request())).reason).toBe('hourly_limit_reached');

    await env.db.redeploy();
    expect(await env.status()).toMatchObject({ attempts_last_hour: 2, attempts_today: 2, jobs_today: 2 });
    expect((await freshRunner(env).run(env.key(), env.request())).reason).toBe('hourly_limit_reached');
    expect(env.driver.submitCalls).toBe(2);
  });

  it('an open circuit breaker survives a restart and a redeploy; only the owner closes it', async () => {
    const env = await realClockEnv();
    env.driver.setPrepare({ kind: 'execution_error', stage: 'step1' });
    const runner = env.runner({ now: () => new Date() });
    for (let i = 0; i < 3; i++) expect((await runner.run(env.key(), env.request())).state).toBe('FAILED');
    expect((await env.status()).breaker_open).toBe(true);

    await cluster.restart();
    env.driver.setPrepare({ kind: 'ok' });
    expect((await freshRunner(env).run(env.key(), env.request())).reason).toBe('circuit_breaker_open');
    await env.db.redeploy();
    expect((await env.status()).breaker_open).toBe(true);
    expect((await freshRunner(env).run(env.key(), env.request())).reason).toBe('circuit_breaker_open');
    expect(env.driver.submitCalls).toBe(0);

    expect((await env.owner<{ ok: boolean }>('owner_reset_breaker', ['fixed the page selector'])).ok).toBe(true);
    expect((await freshRunner(env).run(env.key(), env.request())).state).toBe('REQUESTED');
  });

  it('the kill switch survives a redeploy; a fresh install starts disabled', async () => {
    expect((await (await realClockEnv(false)).status()).submissions_enabled).toBe(false);
    const env = await realClockEnv(true);
    await env.owner('owner_disable_submissions', ['owner stopped submissions']);
    await cluster.restart();
    await env.db.redeploy();
    expect((await env.status()).submissions_enabled).toBe(false);
    expect((await freshRunner(env).run(env.key(), env.request())).reason).toBe('submissions_disabled');
  });
});

describe('stale workers', () => {
  it('a worker that dies before submitting holds the session until its lease lapses; then the job is FAILED (an error)', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();                                  // admitted, browser session open
    await cluster.restart();                                      // the worker is gone
    const gate = new SafetyGate(env.db.pool('truss_app'));
    env.gate = gate;
    expect((await env.runner().run(env.key(), env.request())).reason).toBe('browser_session_active');
    await env.advanceMinutes(1.5);                                // lease (2 min) still live
    expect((await env.runner().run(env.key(), env.request())).reason).toBe('browser_session_active');
    await env.advanceMinutes(1);                                  // lapsed: the next admission expires it
    expect((await env.runner().run(env.key(), env.request())).state).toBe('REQUESTED');
    expect((await gate.getJob(h.jobId))).toMatchObject({ state: 'FAILED', state_reason: 'worker_lease_expired' });
    expect((await env.status()).consecutive_errors).toBe(0);      // the success after it reset the streak
    expect(await env.jobCount()).toBe(2);
  });

  it('a worker that dies mid-submit: its attempt becomes UNKNOWN and still counts', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    expect((await env.gate.reserve(h)).ok).toBe(true);            // attempt recorded, then the worker dies
    await cluster.restart();
    const gate = new SafetyGate(env.db.pool('truss_app'));
    await env.advanceMinutes(3);
    expect((await gate.expireStaleSessions()).expired).toBe(1);
    expect(await gate.getJob(h.jobId)).toMatchObject({ state: 'UNKNOWN', state_reason: 'worker_lease_expired' });
    expect(await env.status()).toMatchObject({ consecutive_errors: 1, attempts_today: 1, in_flight_attempt_id: null,
                                               active_session: null, unreconciled_unknown: 1 });
  });

  it('a worker that was frozen and comes back after its session was expired can do nothing', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await env.advanceMinutes(3);
    await env.gate.expireStaleSessions();                         // someone else expired the frozen worker
    expect(await env.gate.renewSession(h)).toMatchObject({ ok: false, reason: 'session_ended' });
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'session_ended' });
    expect(await env.gate.recordDuplicateCheck(h, 'clear', {})).toMatchObject({ ok: false, reason: 'session_ended' });
    expect(await env.gate.endSession(h, 'BLOCKED', 'late')).toMatchObject({ ok: false, reason: 'already_ended' });
    expect(await env.attemptCount()).toBe(0);
  });

  it('a session cannot be kept alive past 10 minutes', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    for (let i = 0; i < 9; i++) {
      await env.advanceMinutes(1);
      expect((await env.gate.renewSession(h)).ok).toBe(true);
    }
    await env.advanceMinutes(1.5);
    expect(await env.gate.renewSession(h)).toMatchObject({ ok: false, reason: 'session_max_duration' });
    await env.advanceMinutes(2);
    expect((await env.gate.expireStaleSessions()).expired).toBe(1);
  });
});
