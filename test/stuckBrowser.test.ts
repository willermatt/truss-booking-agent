/**
 * A browser that will not close. The worker process can no longer guarantee it is the only one acting,
 * so: the process refuses all further scheduler work (it must exit), and the database keeps the single
 * browser slot held — beyond the 10-minute cap, beyond any lease — until the owner releases it.
 *
 * The refusal is process-wide (module state), so each test loads a fresh copy of the runner module.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import type { RunnerDeps } from '../src/booking/runner.js';
import type { SchedulerDriver, SubmitResult } from '../src/booking/driver.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fresh runner module: a new process, as far as the refusal latch is concerned. */
async function freshProcess(env: TestEnv) {
  vi.resetModules();
  const mod = await import('../src/booking/runner.js');
  const make = (o: Partial<RunnerDeps> = {}) => new mod.BookingRunner({ gate: env.gate, driver: env.driver, spectora: env.api,
                                                                      workerId: 'test-worker', now: () => env.now, ...o });
  return { make, BrowserDidNotStopError: mod.BrowserDidNotStopError, mustExit: mod.workerMustExitReason };
}

/** Wraps the mock driver: submit ignores the abort signal (finishing only when told), close() never ends. */
function stubbornBrowser(env: TestEnv, definite = false) {
  let finish!: (r: SubmitResult) => void;
  const result = new Promise<SubmitResult>((resolve) => { finish = resolve; });
  let started!: () => void;
  const submitting = new Promise<void>((resolve) => { started = resolve; });
  let n = 0;
  const driver: SchedulerDriver = {
    kind: 'mock',
    start: async (job, signal) => {
      const inner = await env.driver.start(job, signal);
      if (++n > 1) return inner;
      return {
        prepare: (s) => inner.prepare(s),
        submit: async (r, s, by) => {
          if (definite) return inner.submit(r, s, by);
          env.driver.submitCalls++; started(); return result;
        },
        close: () => new Promise<void>(() => undefined),
      };
    },
  };
  return { driver, finish, submitting };
}

describe('a browser that will not close', () => {
  it('the process refuses all further work, and the slot stays held past the 10-minute cap until the owner releases it', async () => {
    const env = await TestEnv.create(cluster);
    const p = await freshProcess(env);
    const s = stubbornBrowser(env);
    const runner = p.make({ driver: s.driver, submitDeadlineMs: 100, closeGraceMs: 200, leaseRenewMs: 50 });
    const run = runner.run(env.key(), env.request());
    await s.submitting;
    await expect(run).rejects.toBeInstanceOf(p.BrowserDidNotStopError);
    expect(p.mustExit()).toMatch(/did not stop/);

    // This process does nothing more, with any runner.
    expect(await runner.run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'worker_must_exit' });
    expect(await p.make().dryRun(env.key(), env.request())).toMatchObject({ reason: 'worker_must_exit' });

    // Spectora's real answer arrives late: recorded, but the slot is still held.
    s.finish({ kind: 'requested', inspectionId: 'S-EVENTUALLY' });
    await sleep(200);
    const { rows } = await env.db.pool('truss_owner').query(`SELECT state FROM safety.owner_jobs WHERE spectora_inspection_id = 'S-EVENTUALLY'`);
    expect(rows[0]).toMatchObject({ state: 'REQUESTED' });

    // Past the 10-minute cap and the lease, another process still cannot open a browser.
    await env.advanceMinutes(9); await sleep(150);
    await env.advanceMinutes(2); await sleep(150);
    await env.advanceMinutes(2.5);
    const other = await freshProcess(env);
    expect(await other.make().run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'browser_session_active' });
    expect((await env.gate.expireStaleSessions()).expired).toBe(0);
    expect((await env.status()).active_session).toMatchObject({ browser_unconfirmed_at: expect.any(String) });

    expect(env.driver.maxOpenBrowsers).toBe(1); // nothing else ever opened while it was stuck

    // The owner releases it once that process is gone.
    const jobId = (await env.status()).active_session!.job_id;
    await expect(env.db.pool('truss_app').query(`SELECT safety.owner_release_session($1, 'x')`, [jobId])).rejects.toMatchObject({ code: '42501' });
    expect(await env.owner('owner_release_session', [jobId, 'worker host restarted; browser gone'])).toMatchObject({ ok: true, state: 'REQUESTED' });
    expect((await other.make().run(env.key(), env.request())).state).toBe('REQUESTED');
  });

  it('a definite answer before the browser hung is recorded; the slot is held the same way', async () => {
    const env = await TestEnv.create(cluster);
    const p = await freshProcess(env);
    const s = stubbornBrowser(env, true);
    await expect(p.make({ driver: s.driver, closeGraceMs: 100 }).run(env.key(), env.request())).rejects.toBeInstanceOf(p.BrowserDidNotStopError);
    const { rows } = await env.db.pool('truss_owner').query(`SELECT state FROM safety.owner_jobs`);
    expect(rows[0].state).toBe('REQUESTED');
    await env.advanceMinutes(15);
    expect((await env.gate.expireStaleSessions()).expired).toBe(0);
    expect((await env.status()).active_session).not.toBeNull();
  });

  it('third review: a start that fails and cannot close its browser holds the slot instead of reporting "never started"', async () => {
    const env = await TestEnv.create(cluster);
    const p = await freshProcess(env);
    const { PlaywrightDriver } = await import('../src/booking/playwrightDriver.js');
    let closeCalls = 0;
    const fakeBrowser = {
      newContext: async () => { throw new Error('context creation failed'); },
      close: async () => { closeCalls++; throw new Error('browser.close failed: process still running'); },
    } as unknown as import('playwright').Browser;
    const driver = new PlaywrightDriver({ schedulerUrl: 'http://127.0.0.1:9/home-inspectors/truss-home-inspections/schedule',
                                          testMode: true, launch: async () => fakeBrowser });
    await expect(p.make({ driver }).dryRun(env.key(), env.request())).rejects.toBeInstanceOf(p.BrowserDidNotStopError);
    expect(closeCalls).toBe(1);
    expect(p.mustExit()).toMatch(/did not stop/);
    expect((await env.status()).active_session).toMatchObject({ browser_unconfirmed_at: expect.any(String) });
  });

  it('the owner cannot release a session whose worker is still renewing it', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await env.gate.markBrowserUnconfirmed(h);
    expect(await env.owner('owner_release_session', [h.jobId, 'too early'])).toMatchObject({ ok: false, reason: 'session_in_progress' });
    await env.advanceMinutes(3);
    expect(await env.owner('owner_release_session', [h.jobId, 'browser gone'])).toMatchObject({ ok: true, state: 'FAILED' });
    expect(await env.owner('owner_release_session', [h.jobId, 'again'])).toMatchObject({ ok: false, reason: 'no_active_session' });
  });

  it('the unconfirmed mark cannot be cleared, even by the table owner', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await env.gate.markBrowserUnconfirmed(h);
    await expect(env.db.pool('truss_migrator').query(`UPDATE safety.browser_sessions SET browser_unconfirmed_at = NULL`))
      .rejects.toMatchObject({ code: '42501' });
  });
});
