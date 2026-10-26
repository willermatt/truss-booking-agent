/**
 * Concurrent workers cannot exceed any limit. Each worker is a separate OS process with its own database
 * connection, all released at the same instant, running the real database protocol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { BookingRequestSchema, appointmentInstant } from '../src/booking/schema.js';
import { fingerprints } from '../src/booking/normalize.js';

const WORKER = fileURLToPath(new URL('./helpers/protocolWorker.mjs', import.meta.url));

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

type Result = { key: string; admitted: boolean; reserved: boolean | null; reason: string | null };

function spec(env: TestEnv) {
  const req = BookingRequestSchema.parse(env.request());
  const fp = fingerprints(req);
  return JSON.stringify({ key: env.key('race'), hash: fp.requestHash, property: fp.propertyColumns,
    customerKeys: fp.customerKeys, appointmentAt: appointmentInstant(req.appointment.date, req.appointment.time)!.toISOString() });
}

function runWorker(url: string, startAt: number, mode: 'submit' | 'abandon' | 'hold', retry: boolean, specs: string[]): Promise<Result[]> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [WORKER, url, String(startAt), mode, retry ? 'retry' : 'once', ...specs],
      { cwd: fileURLToPath(new URL('../', import.meta.url)), maxBuffer: 4 << 20 },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(JSON.parse(stdout))));
  });
}

async function race(env: TestEnv, workers: number, jobsEach: number, mode: 'submit' | 'abandon' | 'hold', retry: boolean) {
  const batches = Array.from({ length: workers }, () => Array.from({ length: jobsEach }, () => spec(env)));
  const startAt = Date.now() + 1500; // time for every process to start and connect
  return (await Promise.all(batches.map((b) => runWorker(env.db.url('truss_app'), startAt, mode, retry, b)))).flat();
}

/** Replays the audit log in commit-lock order: at most one browser session may ever be open. */
async function maxConcurrentSessions(env: TestEnv): Promise<number> {
  const { rows } = await env.db.pool('truss_owner').query(
    `SELECT kind FROM safety.owner_events WHERE kind IN ('job_admitted','session_ended','session_expired') ORDER BY id`);
  let open = 0, max = 0;
  for (const r of rows) { open += r.kind === 'job_admitted' ? 1 : -1; max = Math.max(max, open); }
  return max;
}

describe('concurrent workers', () => {
  it('12 processes admit at once: exactly one browser session opens', async () => {
    const env = await TestEnv.create(cluster);
    const results = await race(env, 12, 1, 'hold', false);
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(new Set(results.filter((r) => !r.admitted).map((r) => r.reason))).toEqual(new Set(['browser_session_active']));
    expect(await env.jobCount()).toBe(1);
  });

  it('10 processes × 3 jobs that never submit, retrying while busy: exactly 15 jobs are admitted', async () => {
    const env = await TestEnv.create(cluster);
    const results = await race(env, 10, 3, 'abandon', true);
    expect(results.filter((r) => r.admitted)).toHaveLength(15);
    expect(new Set(results.filter((r) => !r.admitted).map((r) => r.reason))).toEqual(new Set(['daily_job_limit_reached']));
    expect(await env.jobCount()).toBe(15);
    expect(await maxConcurrentSessions(env)).toBe(1);
  });

  it('10 processes × 3 submitting jobs, racing every hour: never more than 2 per hour or 5 per day', async () => {
    const env = await TestEnv.create(cluster);
    const perRound: number[] = [];
    for (let round = 0; round < 4; round++) {
      if (round > 0) await env.advanceMinutes(62);
      const results = await race(env, 10, 3, 'submit', true);
      perRound.push(results.filter((r) => r.reserved).length);
      for (const r of results.filter((x) => !x.admitted)) {
        expect(['hourly_limit_reached', 'daily_limit_reached']).toContain(r.reason);
      }
    }
    expect(perRound).toEqual([2, 2, 1, 0]); // 5 of 120 tries succeed
    expect(await env.attemptCount()).toBe(5);
    expect(await maxConcurrentSessions(env)).toBe(1);
    const { rows } = await env.db.pool('truss_owner').query(
      `SELECT max((SELECT count(*) FROM safety.owner_attempts b
                    WHERE b.attempted_at > a.attempted_at - interval '60 minutes' AND b.attempted_at <= a.attempted_at))::int AS m
         FROM safety.owner_attempts a`);
    expect(rows[0].m).toBeLessThanOrEqual(2);
  });
});
