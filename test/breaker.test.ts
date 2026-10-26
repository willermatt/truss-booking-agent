/**
 * Circuit breaker: 3 consecutive booking execution errors (failed or uncertain submits, errors before
 * submit, workers whose lease lapsed) disable all further booking jobs until the owner explicitly resets it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

describe('circuit breaker', () => {
  it('three consecutive errors open it; the next job is refused before any browser opens', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setPrepare({ kind: 'execution_error', stage: 'step2_calendar' });
    for (let i = 0; i < 3; i++) expect((await env.runner().run(env.key(), env.request())).state).toBe('FAILED');
    expect(await env.status()).toMatchObject({ breaker_open: true, consecutive_errors: 3 });
    env.driver.setPrepare({ kind: 'ok' });
    expect(await env.runner().run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'circuit_breaker_open' });
    expect(env.driver.startCalls).toBe(3);
    expect(env.driver.submitCalls).toBe(0);
  });

  it('failed submits, uncertain submits, crashes, hung pages and dead workers all count', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setSubmit({ kind: 'rejected' });
    expect((await env.runner().run(env.key(), env.request())).state).toBe('FAILED');
    await env.advanceMinutes(62);
    env.driver.setSubmit({ kind: 'timeout' });
    expect((await env.runner().run(env.key(), env.request())).state).toBe('UNKNOWN');
    expect((await env.owner('owner_reconcile', [ (await env.db.pool('truss_owner').query(
      `SELECT id FROM safety.owner_jobs WHERE state = 'UNKNOWN'`)).rows[0].id, false, null, false, 'not in Spectora'])).ok).toBe(true);
    await env.owner('owner_reset_breaker', ['count again from zero']);

    env.driver.setPrepare({ kind: 'throws', message: 'browser crashed' });
    expect((await env.runner().run(env.key(), env.request())).state).toBe('FAILED');
    env.driver.setPrepare({ kind: 'hang' });
    expect((await env.runner({ prepareDeadlineMs: 50 }).run(env.key(), env.request())).state).toBe('FAILED');
    await env.ready();                                          // a worker that then dies
    await env.advanceMinutes(3);
    await env.gate.expireStaleSessions();
    expect(await env.status()).toMatchObject({ breaker_open: true, consecutive_errors: 3 });
  });

  it('a successful request resets the streak; unavailable, needs-input and duplicates neither count nor reset', async () => {
    const env = await TestEnv.create(cluster);
    const step = async (kind: 'error' | 'ok' | 'unavailable' | 'needs_input') => {
      env.driver.setPrepare(kind === 'error' ? { kind: 'execution_error' } : kind === 'needs_input' ? { kind: 'needs_input' } : { kind: 'ok' });
      env.driver.setSubmit(kind === 'unavailable' ? { kind: 'unavailable' } : { kind: 'requested' });
      await env.runner().run(env.key(), env.request());
      await env.advanceMinutes(62);
    };
    await step('error'); await step('error'); await step('ok');
    await step('error'); await step('error');
    expect(await env.status()).toMatchObject({ consecutive_errors: 2, breaker_open: false });
    await step('unavailable'); await step('needs_input');
    expect(await env.status()).toMatchObject({ consecutive_errors: 2, breaker_open: false });
    await step('error');
    expect((await env.status()).breaker_open).toBe(true);
  });

  it('dry-run errors do not count toward the breaker', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setPrepare({ kind: 'execution_error' });
    for (let i = 0; i < 4; i++) expect((await env.runner().dryRun(env.key(), env.request())).state).toBe('FAILED');
    expect(await env.status()).toMatchObject({ consecutive_errors: 0, breaker_open: false });
  });

  it('only the owner can reset it, and not while an outcome is unreconciled', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setPrepare({ kind: 'execution_error' });
    await env.runner().run(env.key(), env.request());
    await env.runner().run(env.key(), env.request());
    env.driver.setPrepare({ kind: 'ok' });
    env.driver.setSubmit({ kind: 'network_error' });
    const unknown = await env.runner().run(env.key(), env.request());
    expect(unknown.state).toBe('UNKNOWN');
    expect((await env.status()).breaker_open).toBe(true);

    await expect(env.db.pool('truss_app').query(`SELECT safety.owner_reset_breaker('let me through')`))
      .rejects.toMatchObject({ code: '42501' });
    expect(await env.owner('owner_reset_breaker', ['trying early'])).toMatchObject({ ok: false, reason: 'unreconciled_unknown_outcomes' });
    await expect(env.owner('owner_reset_breaker', [''])).rejects.toThrow(/reason is required/);

    await env.owner('owner_reconcile', [unknown.jobId, true, 'S-123', false, 'found it in Spectora']);
    expect(await env.owner('owner_reset_breaker', ['page fixed, verified manually'])).toMatchObject({ ok: true });
    env.driver.setPrepare({ kind: 'ok' });
    env.driver.setSubmit({ kind: 'requested' });
    await env.advanceMinutes(62);
    expect((await env.runner().run(env.key(), env.request())).state).toBe('REQUESTED');
  });

  it('nothing resets it automatically: time, new days, session expiry and deploys leave it open', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setPrepare({ kind: 'execution_error' });
    for (let i = 0; i < 3; i++) await env.runner().run(env.key(), env.request());
    await env.setTime('2026-11-20T08:00:00-07:00');
    await env.gate.expireStaleSessions();
    env.driver.setPrepare({ kind: 'ok' });
    expect((await env.runner().run(env.key(), env.request())).reason).toBe('circuit_breaker_open');
    expect((await env.status()).breaker_open).toBe(true);
  });
});
