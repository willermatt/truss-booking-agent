/**
 * Fixed scheduler limits: 15 jobs per Arizona day (counted at admission, before the first Spectora page
 * load, including jobs that fail before submission), 5 submissions per Arizona day, 2 per rolling
 * 60 minutes, 1 browser session globally. Attempts are counted when reserved, whatever the outcome.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

describe('submission limits', () => {
  it('starts disabled: nothing is admitted, no browser opens, nothing is counted', async () => {
    const env = await TestEnv.create(cluster, { enable: false });
    const res = await env.runner().run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'BLOCKED', reason: 'submissions_disabled', jobId: null });
    expect(env.driver.startCalls).toBe(0);
    expect(await env.jobCount()).toBe(0);
    expect(await env.attemptCount()).toBe(0);
  });

  it('blocks a third submission within any rolling 60 minutes (counted over 61 min 30 s, boundary inclusive)', async () => {
    const env = await TestEnv.create(cluster);
    const runner = env.runner();
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');   // 08:00
    await env.advanceMinutes(10);
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');   // 08:10
    await env.advanceMinutes(10);
    expect(await runner.run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'hourly_limit_reached', retryLater: true });
    await env.setTime('2026-11-02T09:00:00-07:00');                                  // exactly 60 min after 08:00
    expect((await runner.run(env.key(), env.request())).reason).toBe('hourly_limit_reached');
    await env.setTime('2026-11-02T09:01:30-07:00');                                  // the 90-second margin
    expect((await runner.run(env.key(), env.request())).reason).toBe('hourly_limit_reached');
    await env.setTime('2026-11-02T09:01:31-07:00');
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    expect((await runner.run(env.key(), env.request())).reason).toBe('hourly_limit_reached');
    expect(env.driver.submitCalls).toBe(3);
    expect(env.driver.startCalls).toBe(3);                                           // refused jobs never open a browser
    expect(await env.attemptCount()).toBe(3);
  });

  it('blocks a sixth submission in one Arizona calendar day', async () => {
    const env = await TestEnv.create(cluster);
    const runner = env.runner();
    for (const t of ['08:00', '09:01', '10:02', '11:03', '12:04']) {
      await env.setTime(`2026-11-02T${t}:00-07:00`);
      expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    }
    await env.setTime('2026-11-02T13:05:00-07:00');
    expect(await runner.run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'daily_limit_reached' });
    await env.setTime('2026-11-02T23:59:00-07:00');
    expect((await runner.run(env.key(), env.request())).reason).toBe('daily_limit_reached');
    expect(env.driver.submitCalls).toBe(5);
    await env.setTime('2026-11-03T08:00:00-07:00');
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
  });

  it('uses the Arizona calendar day, not the UTC day', async () => {
    const env = await TestEnv.create(cluster, { at: '2026-11-02T18:00:00-07:00' });  // 18:00–22:04 AZ = Nov 3 UTC
    const runner = env.runner();
    for (const t of ['18:00', '19:01', '20:02', '21:03', '22:04']) {
      await env.setTime(`2026-11-02T${t}:00-07:00`);
      expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    }
    await env.setTime('2026-11-02T23:59:59-07:00');
    expect((await runner.run(env.key(), env.request())).reason).toBe('daily_limit_reached');
    await env.setTime('2026-11-03T00:00:00-07:00');                                   // AZ midnight, still Nov 3 UTC
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
  });

  it('counts an attempt whatever the outcome (unavailable and rejected still use the limit)', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setSubmit((n) => (n === 1 ? { kind: 'unavailable' } : { kind: 'rejected' }));
    const runner = env.runner();
    expect((await runner.run(env.key(), env.request())).state).toBe('UNAVAILABLE');
    expect((await runner.run(env.key(), env.request())).state).toBe('FAILED');
    expect((await runner.run(env.key(), env.request())).reason).toBe('hourly_limit_reached');
    expect((await env.status()).attempts_last_hour).toBe(2);
  });
});

describe('job limit: 15 per Arizona day, counted before the first page load', () => {
  it('a sixteenth job is refused before any browser opens; failed and blocked jobs all count', async () => {
    const env = await TestEnv.create(cluster);
    const runner = env.runner();
    // 15 jobs that never reach a submission, ending every way a job can end before submitting.
    const faithful = env.driver.summaryFor;
    const endings = [
      () => env.driver.setPrepare({ kind: 'unavailable' }),     // slot not offered      → UNAVAILABLE
      () => env.driver.setPrepare({ kind: 'needs_input' }),     // scheduler refused     → NEEDS_INPUT
      () => {                                                   // Review shows another time → NEEDS_INPUT
        env.driver.setPrepare({ kind: 'ok' });
        env.driver.summaryFor = (job) => ({ ...faithful(job), timeText: '11:30 AM' });
      },
    ];
    for (let i = 0; i < 15; i++) {
      env.driver.summaryFor = faithful;
      endings[i % 3]();
      const res = await runner.run(env.key(), env.request());
      expect(['UNAVAILABLE', 'NEEDS_INPUT']).toContain(res.state);
      expect(res.jobId).not.toBeNull();
    }
    expect(await env.jobCount()).toBe(15);
    expect(env.driver.startCalls).toBe(15);
    expect(env.driver.submitCalls).toBe(0);

    env.driver.setPrepare({ kind: 'ok' });
    env.driver.summaryFor = faithful;
    const sixteenth = await runner.run(env.key(), env.request());
    expect(sixteenth).toMatchObject({ state: 'BLOCKED', reason: 'daily_job_limit_reached', jobId: null });
    expect(env.driver.startCalls).toBe(15);
    expect((await runner.dryRun(env.key(), env.request())).reason).toBe('daily_job_limit_reached'); // dry runs share it

    await env.setTime('2026-11-03T08:00:00-07:00');
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
  });

  it('execution errors, duplicate blocks and dry runs count; refused admissions and invalid requests do not', async () => {
    const env = await TestEnv.create(cluster);
    const runner = env.runner();
    env.driver.setPrepare({ kind: 'execution_error' });
    await runner.run(env.key(), env.request());                                       // 1: FAILED (page broke)
    env.driver.setPrepare({ kind: 'ok' });
    const dupReq = env.request();
    env.spectora.add({ id: 'D', datetime: new Date(`${dupReq.appointment.date}T08:00:00-07:00`).toISOString(),
                       address: dupReq.property.street, zip: dupReq.property.zip });
    expect((await runner.run(env.key(), dupReq)).reason).toBe('potential_duplicate'); // 2: duplicate, no browser
    expect((await runner.dryRun(env.key(), env.request())).state).toBe('DRY_RUN');      // 3: dry run
    expect((await runner.run(env.key(), { ...env.request(), squareFeet: 50 })).state).toBe('NEEDS_INPUT'); // invalid: not counted
    expect((await runner.run(env.key(), env.request({ services: ['sewer'] }))).reason).toBe('service_not_mapped');  // not counted
    expect((await env.status()).jobs_today).toBe(3);
  });

  it('only one browser session at a time: a second job is refused while the first is in its browser', async () => {
    const env = await TestEnv.create(cluster);
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inBrowser = new Promise<void>((r) => { entered = r; });
    const realStart = env.driver.start.bind(env.driver);
    env.driver.start = async (job, signal) => {
      const s = await realStart(job, signal);
      return { ...s, prepare: async (sig) => { entered(); await hold; return s.prepare(sig); } };
    };
    const first = env.runner().run(env.key(), env.request());
    await inBrowser;
    const second = await env.runner().run(env.key(), env.request());
    expect(second).toMatchObject({ state: 'BLOCKED', reason: 'browser_session_active', retryLater: true, jobId: null });
    expect((await env.status()).active_session).not.toBeNull();
    release();
    expect((await first).state).toBe('REQUESTED');
    expect((await env.status()).active_session).toBeNull();
    expect(env.driver.maxOpenBrowsers).toBe(1);
    expect(await env.jobCount()).toBe(1);                                              // the refused one was never counted
  });
});

