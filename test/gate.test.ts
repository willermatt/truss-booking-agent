/**
 * The database is authoritative at every step. These tests go around the runner (calling the gate or
 * the SQL functions directly, or creating state behind admission's back) and show the database still
 * enforces each control where it matters: admission validates its own inputs, and the reservation
 * re-checks every submission control under the global lock no matter what admission saw.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import type { JobHandle } from '../src/safety/gate.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

/**
 * Creates `n` completed booking attempts directly in the tables (as the superuser), `minutesAgo` before
 * the test clock: state the admission check of an already-admitted job never saw.
 */
async function ghostAttempts(env: TestEnv, like: JobHandle, n: number, minutesAgo: number) {
  const su = env.db.pool('superuser');
  for (let g = 0; g < n; g++) {
    const at = new Date(env.now.getTime() - minutesAgo * 60_000).toISOString();
    const { rows: [job] } = await su.query(`
      INSERT INTO safety.jobs SELECT (jsonb_populate_record(j, jsonb_build_object(
          'id', gen_random_uuid(), 'idempotency_key', 'ghost-' || gen_random_uuid(), 'prop_number', '9' || $2::text,
          'customer_keys', '{}'::text[], 'state', 'REQUESTED', 'admitted_at', $3::timestamptz,
          'phoenix_day', ($3::timestamptz AT TIME ZONE 'America/Phoenix')::date))).*
        FROM safety.jobs j WHERE j.id = $1 RETURNING id`, [like.jobId, g, at]);
    const { rows: [sess] } = await su.query(`
      INSERT INTO safety.browser_sessions (job_id, started_at, worker_id, token_hash, lease_until, ended_at, end_reason)
      VALUES ($1, $2, 'ghost', '\\x00', $2, $2, 'completed') RETURNING id`, [job.id, at]);
    await su.query(`
      INSERT INTO safety.attempts (job_id, session_id, attempted_at, phoenix_day, outcome, completed_at)
      VALUES ($1, $2, $3, ($3::timestamptz AT TIME ZONE 'America/Phoenix')::date, 'requested', $3)`, [job.id, sess.id, at]);
  }
}

describe('admission validates its own inputs (the worker could be buggy or hostile)', () => {
  it('refuses malformed keys, modes, properties and customer keys', async () => {
    const env = await TestEnv.create(cluster);
    const app = env.db.pool('truss_app');
    const good = { key: 'abc-12345', mode: 'booking', req: '{}', hash: 'h',
      prop: JSON.stringify({ number: '1700', name: 'washington', dir: 'w', suffix: 'st', unit: '', zip: '85007', tokens: 'w washington st' }),
      keys: ['email:' + 'a'.repeat(32), 'phone:' + 'b'.repeat(32)] };
    const call = (o: Partial<typeof good>) => {
      const v = { ...good, ...o };
      return app.query('SELECT safety.app_admit_job($1, $2, $3, $4, $5, $6, now() + interval \'5 days\', \'w\') AS r',
        [v.key, v.mode, v.req, v.hash, v.prop, v.keys]);
    };
    for (const bad of [
      { key: 'short' }, { key: 'has spaces in it' }, { key: "x'; DROP TABLE safety.jobs; --" },
      { prop: JSON.stringify({ number: '1700', name: 'Washington St', dir: 'W', suffix: '', unit: '', zip: '85007' }) },
      { prop: JSON.stringify({ number: '', name: 'washington', dir: 'w', suffix: 'st', unit: '', zip: '85007' }) },
      { prop: JSON.stringify({ number: '1700', name: 'washington', dir: 'west', suffix: 'st', unit: '', zip: '8500' }) },
      { prop: JSON.stringify({ number: '1700', name: 'washington', dir: 'w', suffix: 'st', unit: '4 b', zip: '85007', tokens: 'w washington st' }) },
      { prop: JSON.stringify({ number: '1700', name: 'washington', dir: 'w', suffix: 'st', unit: '', zip: '85007' }) },
      { prop: JSON.stringify({ number: '1700', name: 'washington', dir: 'w', suffix: 'st', unit: '', zip: '85007', tokens: 'w jefferson st' }) },
      { keys: [] as string[] }, { keys: ['email:client@example.com'] }, { keys: ['ssn:' + 'a'.repeat(32)] },
      { keys: ['email:' + 'a'.repeat(32)] }, { keys: ['phone:' + 'b'.repeat(32), 'name:' + 'c'.repeat(32)] },
    ]) {
      await expect(call(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '22023' });
    }
    expect((await call({ mode: 'force' })).rows[0].r).toMatchObject({ admitted: false, reason: 'invalid_mode' });
    expect(await env.jobCount()).toBe(0);
    expect((await call({})).rows[0].r).toMatchObject({ admitted: true });
  });
});

describe('the reservation re-checks everything, whatever admission saw', () => {
  it('kill switch pressed after admission', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await env.owner('owner_disable_submissions', ['owner pressed stop']);
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'submissions_disabled' });
    expect(await env.attemptCount()).toBe(0);
  });

  it('circuit breaker opened after admission', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await env.db.pool('superuser').query(`UPDATE safety.control SET breaker_open = true`);
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'circuit_breaker_open' });
  });

  it('hourly limit reached after admission (61 min 30 s window, boundary inclusive)', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await ghostAttempts(env, h, 2, 61.5);       // exactly 61 min 30 s ago: still inside the window
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'hourly_limit_reached', counts: { attempts_last_hour: 2 } });
    await env.setTime(new Date(env.now.getTime() + 1000));
    await env.gate.renewSession(h);
    expect((await env.gate.reserve(h)).ok).toBe(true);
  });

  it('daily limit reached after admission', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await ghostAttempts(env, h, 5, 120);
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'daily_limit_reached', counts: { attempts_today: 5 } });
  });

  it('an attempt dated in the future (a clock that moved backwards) still counts against the hour', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await ghostAttempts(env, h, 2, -30);
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'hourly_limit_reached' });
  });

  it('an UNKNOWN outcome that appeared after admission', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await ghostAttempts(env, h, 1, 90);
    await env.db.pool('superuser').query(`UPDATE safety.jobs SET state = 'UNKNOWN' WHERE idempotency_key LIKE 'ghost-%'`);
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'unreconciled_unknown_outcome' });
  });

  it('a job can be reserved at most once, ever', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const r = await env.gate.reserve(h);
    if (!r.ok) throw new Error('reserve');
    await env.gate.completeAttempt(r.reservation, 'unavailable', {});
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'job_already_attempted' });
    expect(await env.attemptCount()).toBe(1);
  });
});

describe('unique indexes hold even against the table owner', () => {
  it('a second active browser session, or a second in-flight attempt, cannot be inserted', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const r = await env.gate.reserve(h);
    if (!r.ok) throw new Error('reserve');
    const mig = env.db.pool('truss_migrator');
    await expect(mig.query(`
      INSERT INTO safety.browser_sessions (job_id, started_at, worker_id, token_hash, lease_until)
      SELECT gen_random_uuid(), now(), 'x', '\\x00', now() + interval '1 hour'`)).rejects.toMatchObject({ code: '23505' });
    await ghostAttempts(env, h, 1, 1);
    await expect(env.db.pool('superuser').query(`
      INSERT INTO safety.attempts (job_id, session_id, attempted_at, phoenix_day)
      SELECT j.id, s.id, now(), current_date FROM safety.jobs j JOIN safety.browser_sessions s ON s.job_id = j.id
       WHERE j.idempotency_key LIKE 'ghost-%'`)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('dry runs', () => {
  it('run with the kill switch off, count toward the 15 jobs, and can never reserve a submission', async () => {
    const env = await TestEnv.create(cluster, { enable: false });
    const res = await env.runner().dryRun(env.key(), env.request());
    expect(res).toMatchObject({ state: 'DRY_RUN', reason: 'dry_run_complete_stopped_before_schedule' });
    expect(env.driver).toMatchObject({ startCalls: 1, prepareCalls: 1, submitCalls: 0, openBrowsers: 0 });
    expect(await env.status()).toMatchObject({ jobs_today: 1, attempts_today: 0, submissions_enabled: false });

    await env.owner('owner_enable_submissions', ['SPECTORA-TEST', 'for this test']);
    const h = await env.admit(undefined, 'dry_run');
    await env.gate.recordDuplicateCheck(h, 'clear', {});
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'dry_run_cannot_submit' });
    await expect(env.gate.endSession(h, 'REQUESTED' as never, 'x')).rejects.toMatchObject({ code: '22023' });
    expect((await env.gate.endSession(h, 'DRY_RUN', 'done')).ok).toBe(true);
    expect(await env.attemptCount()).toBe(0);
  });

  it('a booking job cannot pretend to be a finished dry run', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    await expect(env.gate.endSession(h, 'DRY_RUN', 'x')).rejects.toMatchObject({ code: '22023' });
  });
});

describe('launch gates', () => {
  it('a fresh install is disabled; enabling needs a Spectora approval reference and a reason, and is audited', async () => {
    const env = await TestEnv.create(cluster, { enable: false });
    expect(await env.status()).toMatchObject({ submissions_enabled: false });
    expect(await env.runner().run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'submissions_disabled' });
    for (const ref of [null, '', '  ', 'x']) {
      await expect(env.owner('owner_enable_submissions', [ref, 'turning on']), String(ref)).rejects.toThrow(/approval reference/);
    }
    await expect(env.owner('owner_enable_submissions', ['SPECTORA-2026-11-01-EMAIL', ''])).rejects.toThrow(/reason/);
    await env.owner('owner_enable_submissions', ['SPECTORA-2026-11-01-EMAIL', 'Spectora approved in writing']);
    expect(await env.status()).toMatchObject({ submissions_enabled: true, approval_ref: 'SPECTORA-2026-11-01-EMAIL' });
    const { rows } = await env.db.pool('truss_owner').query(
      `SELECT actor, detail FROM safety.owner_events WHERE kind = 'submissions_enabled'`);
    expect(rows[0]).toMatchObject({ actor: 'truss_owner' });
    expect(JSON.stringify(rows[0].detail)).toContain('SPECTORA-2026-11-01-EMAIL');
  });

  it('a successful submit is REQUESTED, never CONFIRMED; only Spectora showing it confirmed makes it CONFIRMED', async () => {
    const env = await TestEnv.create(cluster);
    const res = await env.runner().run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'REQUESTED', spectoraInspectionId: 'MOCK-1' });
    expect((await env.gate.getJob(res.jobId!))?.state).toBe('REQUESTED');
    // The owner confirms it in Spectora, then records that here (the id must match what Spectora returned).
    expect(await env.owner('owner_reconcile', [res.jobId, true, 'OTHER-ID', true, 'confirmed in Spectora by Matt']))
      .toMatchObject({ ok: false, reason: 'inspection_id_mismatch' });
    expect(await env.owner('owner_reconcile', [res.jobId, true, 'MOCK-1', false, 'not a confirmation']))
      .toMatchObject({ ok: false, reason: 'not_reconcilable' });
    expect(await env.owner('owner_reconcile', [res.jobId, true, 'MOCK-1', true, 'confirmed in Spectora by Matt']))
      .toMatchObject({ ok: true, state: 'CONFIRMED' });
    expect((await env.gate.getJob(res.jobId!))?.state).toBe('CONFIRMED');
  });

  it('the worker cannot record a "requested" outcome without the inspection id Spectora returned', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const r = await env.gate.reserve(h);
    if (!r.ok) throw new Error('reserve');
    for (const id of [undefined, '', '   ']) {
      await expect(env.gate.completeAttempt(r.reservation, 'requested', {}, id)).rejects.toMatchObject({ code: '22023' });
    }
  });
});
