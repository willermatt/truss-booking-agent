/**
 * Failure-mode hardening: stale snapshots, hung and stubborn browsers, stale leases, a missing control
 * row, incomplete Spectora pages, uncommitted reservations, and stolen or guessed session tokens.
 * Each test reproduces the failure and checks that it fails closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { SafetyGate, type Reservation } from '../src/safety/gate.js';
import { BookingRequestSchema, appointmentInstant } from '../src/booking/schema.js';
import { fingerprints } from '../src/booking/normalize.js';
import type { SchedulerDriver } from '../src/booking/driver.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

async function client(env: TestEnv, role: 'truss_app' | 'truss_owner' | 'superuser' = 'truss_app') {
  const c = new pg.Client({ connectionString: env.db.url(role) });
  await c.connect();
  return c;
}

/** Admits a job with raw SQL so the test holds the session token itself. */
async function rawAdmit(env: TestEnv, q: pg.Pool | pg.Client, ready = true) {
  const req = BookingRequestSchema.parse(env.request());
  const fp = fingerprints(req);
  const a = (await q.query('SELECT safety.app_admit_job($1, $2, $3, $4, $5, $6, $7, $8) AS r',
    [env.key('raw'), 'booking', JSON.stringify(req), fp.requestHash, JSON.stringify(fp.propertyColumns), fp.customerKeys,
     appointmentInstant(req.appointment.date, req.appointment.time), 'raw'])).rows[0].r;
  if (!a.admitted) throw new Error(`refused: ${a.reason}`);
  if (ready) await q.query(`SELECT safety.app_record_duplicate_check($1, $2, 'clear', '{}') AS r`, [a.job_id, a.token]);
  return { job: a.job_id as string, token: a.token as string };
}

async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('condition not reached');
}

describe('1. stale snapshots (REPEATABLE READ / SERIALIZABLE) cannot reach the counters', () => {
  const appCalls = [
    `SELECT safety.app_admit_job('k-k-k-k-k', 'booking', '{}', 'h', '{}', '{}', now(), 'w')`,
    `SELECT safety.app_renew_session(gen_random_uuid(), 't')`,
    `SELECT safety.app_record_duplicate_check(gen_random_uuid(), 't', 'clear', '{}')`,
    `SELECT safety.app_reserve_submission(gen_random_uuid(), 't')`,
    `SELECT safety.app_verify_reservation(1, 't')`,
    `SELECT safety.app_complete_attempt(1, 't', 'unknown', '{}', null)`,
    `SELECT safety.app_end_session(gen_random_uuid(), 't', 'BLOCKED', 'x')`,
    `SELECT safety.app_record_execution_error(gen_random_uuid(), 't', 's', '{}')`,
    `SELECT safety.app_reconcile_found(gen_random_uuid(), 't', 'S-1', false)`,
    `SELECT safety.app_expire_stale_sessions()`,
    `SELECT safety.app_get_job(gen_random_uuid())`,
    `SELECT safety.app_get_job_by_key('some-key-1')`,
    `SELECT safety.app_mark_browser_unconfirmed(gen_random_uuid(), 't')`,
  ];
  const ownerCalls = [
    `SELECT safety.owner_status()`,
    `SELECT safety.owner_disable_submissions('x')`,
    `SELECT safety.owner_enable_submissions('REF', 'x')`,
    `SELECT safety.owner_reset_breaker('x')`,
    `SELECT safety.owner_reconcile(gen_random_uuid(), false, null, false, 'xxxxx')`,
    `SELECT safety.owner_release_session(gen_random_uuid(), 'xxxxx')`,
  ];
  for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
    it(`every worker and owner function refuses to run at ${level}`, async () => {
      const env = await TestEnv.create(cluster);
      for (const [role, calls] of [['truss_app', appCalls], ['truss_owner', ownerCalls]] as const) {
        const c = await client(env, role);
        try {
          for (const sql of calls) {
            await c.query(`BEGIN ISOLATION LEVEL ${level}`);
            await expect(c.query(sql), sql).rejects.toMatchObject({ code: '25000' });
            await c.query('ROLLBACK');
          }
        } finally { await c.end(); }
      }
      expect(await env.jobCount()).toBe(0);
    });
  }

  it('a worker that changes its own default isolation level locks itself out (fails closed)', async () => {
    const env = await TestEnv.create(cluster);
    const c = await client(env);
    await c.query(`SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
    await expect(rawAdmit(env, c)).rejects.toMatchObject({ code: '25000' });
    await c.query(`ALTER ROLE truss_app SET default_transaction_isolation = 'repeatable read'`); // PG allows this
    await c.end();
    const d = await client(env);
    try {
      await expect(rawAdmit(env, d)).rejects.toMatchObject({ code: '25000' });
    } finally {
      await d.query(`ALTER ROLE truss_app RESET default_transaction_isolation`);
      await d.end();
    }
    expect(await env.jobCount()).toBe(0);
  });
});

describe('2. hung, slow and stubborn browsers', () => {
  it('a hung submit is aborted at the deadline, the browser is closed, and the outcome is UNKNOWN', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setSubmit({ kind: 'hang' });
    const res = await env.runner({ submitDeadlineMs: 200 }).run(env.key(), env.request());
    expect(res.state).toBe('UNKNOWN');
    expect(env.driver).toMatchObject({ submitCalls: 1, aborted: 1, openBrowsers: 0 });
    expect(await env.status()).toMatchObject({ in_flight_attempt_id: null, active_session: null, attempts_today: 1 });
  });

  it('a hung page before submit is aborted at the deadline: FAILED, nothing submitted, slot released', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setPrepare({ kind: 'hang' });
    const res = await env.runner({ prepareDeadlineMs: 200 }).run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'FAILED', reason: 'execution_error:prepare_aborted' });
    expect(env.driver).toMatchObject({ submitCalls: 0, openBrowsers: 0 });
    expect(await env.status()).toMatchObject({ attempts_today: 0, jobs_today: 1, active_session: null });
  });

  it('a session whose worker keeps renewing is never expired by anyone else', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const other = new SafetyGate(env.db.pool('truss_app'));
    await env.advanceMinutes(1.5);
    expect((await env.gate.renewSession(h)).ok).toBe(true);
    await env.advanceMinutes(1.5); // 3 minutes since admission, 1.5 since renewal
    expect((await other.expireStaleSessions()).expired).toBe(0);
    await env.advanceMinutes(1);   // lease lapsed
    expect((await other.expireStaleSessions()).expired).toBe(1);
  });

  it('a lapsed lease is final: the frozen worker cannot renew, record or reserve, even before expiry runs', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.admit();
    await env.advanceMinutes(2.5);
    expect(await env.gate.renewSession(h)).toMatchObject({ ok: false, reason: 'session_lease_expired' });
    expect(await env.gate.recordDuplicateCheck(h, 'clear', {})).toMatchObject({ ok: false, reason: 'session_lease_expired' });
    expect(await env.gate.reserve(h)).toMatchObject({ ok: false, reason: 'session_lease_expired' });
    expect(await env.attemptCount()).toBe(0);
  });

  it('a real success that arrives after the lease lapsed is kept, not dropped', async () => {
    const env = await TestEnv.create(cluster);
    const other = new SafetyGate(env.db.pool('truss_app'));
    const driver: SchedulerDriver = {
      kind: 'mock',
      start: async (job, signal) => {
        const inner = await env.driver.start(job, signal);
        return {
          prepare: (x) => inner.prepare(x),
          submit: async (r, x, by) => {
            await env.advanceMinutes(3);        // the worker stalls past its lease...
            await other.expireStaleSessions();  // ...and another worker expires it to UNKNOWN
            return inner.submit(r, x, by);      // then Spectora's real answer arrives
          },
          close: () => inner.close(),
        };
      },
    };
    expect(await env.runner({ driver }).run(env.key(), env.request())).toMatchObject({ state: 'REQUESTED', spectoraInspectionId: 'MOCK-1' });
  });

  it('the owner cannot reconcile a job whose session is still live', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    expect((await env.gate.reserve(h)).ok).toBe(true);
    expect(await env.owner('owner_reconcile', [h.jobId, false, null, false, 'giving up early'])).toMatchObject({
      ok: false, reason: 'session_in_progress' });
    await env.advanceMinutes(3);
    expect(await env.owner('owner_reconcile', [h.jobId, false, null, false, 'worker died; not in Spectora'])).toMatchObject({
      ok: true, state: 'FAILED' });
  });
});

describe('3. a missing control row fails closed and is never silently re-seeded', () => {
  it('blocks admission and reservation, shows in status, and the next deploy refuses to run', async () => {
    const env = await TestEnv.create(cluster);
    const h = await env.ready();
    const su = env.db.pool('superuser');
    await su.query(`ALTER TABLE safety.control DISABLE TRIGGER control_no_delete`);
    await su.query(`DELETE FROM safety.control`);
    await su.query(`ALTER TABLE safety.control ENABLE TRIGGER control_no_delete`);

    await expect(env.runner().run(env.key(), env.request())).rejects.toMatchObject({ code: 'P0002' });
    await expect(env.gate.reserve(h)).rejects.toMatchObject({ code: 'P0002' });
    await expect(env.gate.renewSession(h)).rejects.toMatchObject({ code: 'P0002' });
    expect(await env.status()).toMatchObject({ control_row_present: false });
    await expect(env.db.redeploy()).rejects.toThrow(/refusing to re-seed/);
    expect(await env.attemptCount()).toBe(0);
    expect(await env.jobCount()).toBe(1);
  });
});

describe('4. the duplicate check reads every page or fails', () => {
  const filler = (env: TestEnv, appt: number) => {
    for (let i = 0; i < 100; i++) {
      env.spectora.add({ id: `F-${i}`, datetime: new Date(appt - 86_400_000).toISOString(), address: `${i} Filler Rd`, zip: '85001' });
    }
    env.spectora.pageSizeCap = 100;
  };

  it('finds a duplicate on page 2 when Spectora caps the page size', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '77 N Pagination Dr', city: 'Phoenix', state: 'AZ', zip: '85050' } });
    const appt = new Date(`${req.appointment.date}T08:00:00-07:00`).getTime();
    filler(env, appt);
    env.spectora.add({ id: 'DUP', datetime: new Date(appt).toISOString(), address: '77 N Pagination Dr', zip: '85050' });
    const res = await env.runner().run(env.key(), req);
    expect(res).toMatchObject({ state: 'BLOCKED', reason: 'potential_duplicate' });
    expect(res.duplicates?.map((d) => d.inspectionId)).toEqual(['DUP']);
  });

  it('blocks when results shift between pages (a row repeated, another skipped)', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '88 S Drift Ave', city: 'Phoenix', state: 'AZ', zip: '85050' } });
    const appt = new Date(`${req.appointment.date}T08:00:00-07:00`).getTime();
    filler(env, appt);
    env.spectora.add({ id: 'SKIPPED-DUP', datetime: new Date(appt).toISOString(), address: '88 S Drift Ave', zip: '85050' });
    env.spectora.driftOnPage2 = true;
    expect(await env.runner().run(env.key(), req)).toMatchObject({ state: 'BLOCKED', reason: 'duplicate_check_unavailable' });
  });

  it('blocks when the response cannot prove it is complete', async () => {
    const env = await TestEnv.create(cluster);
    env.spectora.omitPagination = true;
    expect(await env.runner().run(env.key(), env.request())).toMatchObject({ state: 'BLOCKED', reason: 'duplicate_check_unavailable' });
    expect(env.driver.startCalls).toBe(0);
  });

  it('a Spectora record with no ZIP and no street type is a possible match: manual booking', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request({ property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' } });
    env.spectora.add({ id: 'NOZIP', datetime: new Date(`${req.appointment.date}T11:30:00-07:00`).toISOString(),
                       address: '1700 West Washington', zip: '' });
    expect(await env.runner().run(env.key(), req)).toMatchObject({ state: 'BLOCKED', reason: 'ambiguous_match_manual_booking_required' });
  });
});

describe('5. reservations are committed, and only their holder can use them', () => {
  it('an attempt reserved inside an open transaction is invisible to verification; a rollback leaves nothing', async () => {
    const env = await TestEnv.create(cluster);
    const a = await client(env);
    const { job, token } = await rawAdmit(env, a);
    await a.query('BEGIN');
    const r = (await a.query(`SELECT safety.app_reserve_submission($1, $2) AS r`, [job, token])).rows[0].r;
    expect(r.ok).toBe(true);
    const verifyFromElsewhere = env.db.pool('truss_app').query(`SELECT safety.app_verify_reservation($1, $2) AS r`, [r.attempt_id, token]);
    // The other connection waits on the global lock, then sees no committed attempt.
    await new Promise((res) => setTimeout(res, 100));
    await a.query('ROLLBACK');
    expect((await verifyFromElsewhere).rows[0].r).toMatchObject({ ok: false, reason: 'attempt_not_committed' });
    await a.end();
    expect(await env.attemptCount()).toBe(0);
  });

  it('nothing else runs in the transaction that made a reservation', async () => {
    const env = await TestEnv.create(cluster);
    const a = await client(env);
    const { job, token } = await rawAdmit(env, a);
    await a.query('BEGIN');
    const r = (await a.query(`SELECT safety.app_reserve_submission($1, $2) AS r`, [job, token])).rows[0].r;
    expect(r.ok).toBe(true);
    await expect(a.query(`SELECT safety.app_renew_session($1, $2) AS r`, [job, token])).rejects.toMatchObject({ code: '25000' });
    await a.query('ROLLBACK');
    await a.end();
  });

  it('verification refuses to run inside a transaction that has already written', async () => {
    const env = await TestEnv.create(cluster);
    const a = await client(env);
    const { job, token } = await rawAdmit(env, a);
    const r = (await a.query(`SELECT safety.app_reserve_submission($1, $2) AS r`, [job, token])).rows[0].r;
    expect(r.ok).toBe(true);
    await a.query('BEGIN');
    await a.query('SELECT txid_current()');   // assigns this transaction an id, as any write would
    const v = (await a.query(`SELECT safety.app_verify_reservation($1, $2) AS r`, [r.attempt_id, token])).rows[0].r;
    expect(v).toMatchObject({ ok: false, reason: 'verify_inside_writing_transaction' });
    await a.query('ROLLBACK');
    await a.end();
  });

  it('verification re-checks the kill switch: disabling between reserve and submit stops the submit', async () => {
    const env = await TestEnv.create(cluster);
    class DisableAfterReserve extends SafetyGate {
      override async reserve(h: Parameters<SafetyGate['reserve']>[0]) {
        const r = await super.reserve(h);
        await env.owner('owner_disable_submissions', ['owner pressed stop']);
        return r;
      }
    }
    const res = await env.runner({ gate: new DisableAfterReserve(env.db.pool('truss_app')) }).run(env.key(), env.request());
    expect(res.state).toBe('FAILED');
    expect(env.driver.submitCalls).toBe(0);
  });

  it('the runner never submits when verification fails', async () => {
    const env = await TestEnv.create(cluster);
    class NoVerifyGate extends SafetyGate {
      override async verifyReservation(_r: Reservation) { return { ok: false, reason: 'attempt_not_committed' }; }
    }
    const res = await env.runner({ gate: new NoVerifyGate(env.db.pool('truss_app')) }).run(env.key(), env.request());
    expect(res.state).toBe('FAILED');
    expect(env.driver.submitCalls).toBe(0);
    expect(env.driver.sendBys).toHaveLength(0);   // submit() was never even called
  });

  it('without the session token nobody can act on a job or its attempt', async () => {
    const env = await TestEnv.create(cluster);
    const app = env.db.pool('truss_app');
    const { job, token } = await rawAdmit(env, app);
    const r = (await app.query(`SELECT safety.app_reserve_submission($1, $2) AS r`, [job, token])).rows[0].r;
    for (const [sql, params] of [
      [`SELECT safety.app_complete_attempt($1, 'guess', 'requested', '{}', 'X')`, [r.attempt_id]],
      [`SELECT safety.app_complete_attempt($1, 'guess', 'unavailable', '{}', null)`, [r.attempt_id]],
      [`SELECT safety.app_renew_session($1, 'guess')`, [job]],
      [`SELECT safety.app_reserve_submission($1, 'guess')`, [job]],
      [`SELECT safety.app_end_session($1, 'guess', NULL, 'x')`, [job]],
      [`SELECT safety.app_record_execution_error($1, 'guess', 's', '{}')`, [job]],
      [`SELECT safety.app_record_duplicate_check($1, 'guess', 'clear', '{}')`, [job]],
      [`SELECT safety.app_reconcile_found($1, 'guess', 'S-X', true)`, [job]],
    ] as const) {
      await expect(app.query(sql, [...params]), sql).rejects.toMatchObject({ code: '42501' });
    }
    expect((await app.query(`SELECT safety.app_verify_reservation($1, 'guess') AS r`, [r.attempt_id])).rows[0].r)
      .toMatchObject({ ok: false, reason: 'invalid_token' });
    expect((await env.status()).in_flight_attempt_id).toBe(r.attempt_id);
    expect((await app.query(`SELECT safety.app_complete_attempt($1, $2, 'requested', '{}', 'S-9') AS r`, [r.attempt_id, token])).rows[0].r.ok).toBe(true);
  });

  it('the database stores only a hash of the session token', async () => {
    const env = await TestEnv.create(cluster);
    const { token } = await rawAdmit(env, env.db.pool('truss_app'));
    const { rows } = await env.db.pool('superuser').query(
      `SELECT count(*)::int AS n FROM safety.browser_sessions WHERE token_hash = sha256(convert_to($1, 'UTF8'))`, [token]);
    expect(rows[0].n).toBe(1);
    const dump = await env.db.pool('superuser').query(`SELECT row_to_json(e)::text AS t FROM safety.events e`);
    expect(dump.rows.some((r) => r.t.includes(token))).toBe(false);
  });
});

describe('6. an idle worker transaction cannot hold the global lock for long', () => {
  it('the worker role ends idle transactions (so the owner can always disable)', async () => {
    const env = await TestEnv.create(cluster);
    const { rows } = await env.db.pool('superuser').query(
      `SELECT unnest(rolconfig) AS c FROM pg_roles WHERE rolname = 'truss_app'`);
    const cfg = rows.map((r) => r.c);
    expect(cfg).toEqual(expect.arrayContaining(['idle_in_transaction_session_timeout=15s', 'statement_timeout=30s', 'lock_timeout=15s']));
  });
});
