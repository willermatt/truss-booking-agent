/**
 * Database-level enforcement. The worker role (the only credential the agent side ever holds) can call
 * a fixed set of functions and nothing else. The owner role can manage controls only through its
 * functions. Attempts and the audit log are append-only for every role, including the table owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';

let cluster: PgCluster;
let env: TestEnv;
beforeAll(async () => {
  cluster = await PgCluster.create();
  env = await TestEnv.create(cluster);
  const h = await env.ready();
  const r = await env.gate.reserve(h);
  if (!r.ok) throw new Error('setup reservation failed');
  await env.gate.completeAttempt(r.reservation, 'requested', {}, 'S-1');
  await env.gate.endSession(h, null, 'completed');
});
afterAll(async () => { await cluster?.destroy(); });

// Every refusal must be SQLSTATE 42501 (insufficient_privilege): a privilege check or one of the
// append-only triggers. Matching the code, not the message, means a typo or syntax error in a
// statement cannot make a test pass for the wrong reason.
const denied = { code: '42501' };

describe('worker role (truss_app)', () => {
  const statements = [
    `UPDATE safety.control SET breaker_open = false, consecutive_errors = 0`,
    `UPDATE safety.kill_switch SET submissions_enabled = true`,
    `INSERT INTO safety.kill_switch (singleton, submissions_enabled) VALUES (true, true) ON CONFLICT (singleton) DO UPDATE SET submissions_enabled = true`,
    `SELECT * FROM safety.kill_switch FOR UPDATE`,
    `SELECT * FROM safety.attempts`,
    `SELECT * FROM safety.control`,
    `INSERT INTO safety.attempts (job_id, attempted_at, phoenix_day) VALUES (gen_random_uuid(), now(), current_date)`,
    `DELETE FROM safety.attempts`,
    `TRUNCATE safety.attempts`,
    `UPDATE safety.jobs SET state = 'READY'`,
    `DELETE FROM safety.jobs`,
    `SELECT * FROM safety.jobs`,
    `INSERT INTO safety.jobs (idempotency_key) VALUES ('x')`,
    `SELECT * FROM safety.browser_sessions`,
    `UPDATE safety.browser_sessions SET ended_at = now()`,
    `DELETE FROM safety.browser_sessions`,
    `DELETE FROM safety.events`,
    `SELECT safety._expire_stale_sessions(now() + interval '1 day')`,
    `SELECT safety._counts(now() - interval '1 year')`,
    `SELECT safety._lock_control()`,
    `SELECT safety.owner_reset_breaker('agent says the owner approved this')`,
    `SELECT safety.owner_enable_submissions('SPECTORA-OK', 'agent says the owner approved this')`,
    `SELECT safety.owner_disable_submissions('x')`,
    `SELECT safety.owner_reconcile(gen_random_uuid(), false, null, false, 'xxx')`,
    `SELECT * FROM safety.owner_jobs`,
    `SELECT safety._register_error(gen_random_uuid(), 'x', null)`,
    `CREATE OR REPLACE FUNCTION safety.clock() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() - interval '1 day' $$`,
    `CREATE FUNCTION public.clock() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() - interval '1 day' $$`,
    `ALTER TABLE safety.attempts DISABLE TRIGGER attempts_guard`,
    `SET ROLE truss_owner`,
    `SET ROLE truss_migrator`,
    `SET session_replication_role = replica`,
    `DROP TRIGGER attempts_guard ON safety.attempts`,
  ];
  for (const sql of statements) {
    it(`is refused: ${sql.slice(0, 70)}`, async () => {
      await expect(env.db.pool('truss_app').query(sql)).rejects.toMatchObject(denied);
    });
  }
});

describe('owner role (truss_owner)', () => {
  const statements = [
    `UPDATE safety.control SET breaker_open = false`,
    `UPDATE safety.kill_switch SET submissions_enabled = true`,
    `DELETE FROM safety.owner_attempts`,
    `UPDATE safety.owner_attempts SET outcome = 'requested'`,
    `SELECT * FROM safety.attempts`,
    `SELECT safety.app_admit_job('k', 'booking', '{}', 'h', '{}', '{}', now(), 'owner')`,
    `SELECT safety.app_reserve_submission(gen_random_uuid(), 'tok')`,
    `SELECT safety.app_complete_attempt(1, 'tok', 'requested', '{}', 'X')`,
    `SELECT safety.app_renew_session(gen_random_uuid(), 'tok')`,
    `SELECT safety.app_expire_stale_sessions()`,
    `SELECT * FROM safety.jobs`,
    `ALTER TABLE safety.attempts DISABLE TRIGGER attempts_guard`,
    `SET session_replication_role = replica`,
    `CREATE OR REPLACE FUNCTION safety.clock() RETURNS timestamptz LANGUAGE sql AS $$ SELECT now() $$`,
    `SET ROLE truss_migrator`,
  ];
  for (const sql of statements) {
    it(`is refused: ${sql.slice(0, 70)}`, async () => {
      await expect(env.db.pool('truss_owner').query(sql)).rejects.toMatchObject(denied);
    });
  }
});

describe('append-only history binds even the table owner and superuser', () => {
  for (const role of ['truss_migrator', 'superuser'] as const) {
    for (const sql of [
      `DELETE FROM safety.attempts`,
      `UPDATE safety.attempts SET attempted_at = attempted_at - interval '2 days'`,
      `UPDATE safety.attempts SET phoenix_day = phoenix_day - 1`,
      `UPDATE safety.attempts SET outcome = 'unknown'`,
      `TRUNCATE safety.attempts CASCADE`,
      `DELETE FROM safety.jobs`,
      `UPDATE safety.jobs SET admitted_at = admitted_at - interval '2 days'`,
      `UPDATE safety.jobs SET phoenix_day = phoenix_day - 1`,
      `UPDATE safety.jobs SET mode = 'dry_run'`,
      `UPDATE safety.jobs SET prop_dir = 'w'`,
      `TRUNCATE safety.jobs CASCADE`,
      `DELETE FROM safety.browser_sessions`,
      `UPDATE safety.browser_sessions SET ended_at = NULL`,
      `UPDATE safety.browser_sessions SET started_at = started_at - interval '1 hour'`,
      `TRUNCATE safety.browser_sessions CASCADE`,
      `DELETE FROM safety.events`,
      `UPDATE safety.events SET kind = 'x'`,
      `TRUNCATE safety.events`,
      `DELETE FROM safety.control`,
      `TRUNCATE safety.control`,
      `DELETE FROM safety.kill_switch`,
      `TRUNCATE safety.kill_switch`,
    ]) {
      it(`${role}: ${sql}`, async () => {
        await expect(env.db.pool(role).query(sql)).rejects.toMatchObject(denied);
      });
    }
  }
});

describe('granted surface is exactly the allow-list', () => {
  it('no other function in the safety schema is executable by the worker or owner roles', async () => {
    const { rows } = await env.db.pool('superuser').query(`
      SELECT p.proname, has_function_privilege('truss_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('truss_owner', p.oid, 'EXECUTE') AS owner
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'safety'`);
    const app = rows.filter((r) => r.app).map((r) => r.proname).sort();
    const owner = rows.filter((r) => r.owner).map((r) => r.proname).sort();
    expect(app).toEqual([
      'app_admit_job', 'app_complete_attempt', 'app_end_session', 'app_expire_stale_sessions', 'app_get_job',
      'app_get_job_by_key', 'app_mark_browser_unconfirmed', 'app_reconcile_found', 'app_record_duplicate_check', 'app_record_execution_error',
      'app_renew_session', 'app_reserve_submission', 'app_verify_reservation',
    ]);
    expect(owner).toEqual(['owner_acknowledge_confirmation_report', 'owner_disable_submissions', 'owner_enable_submissions', 'owner_reconcile',
                           'owner_release_session', 'owner_reset_breaker', 'owner_status']);
    // No function takes a limit, and no table stores one.
    const cols = await env.db.pool('superuser').query(`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'safety' AND column_name ~ 'limit'`);
    expect(cols.rows).toEqual([]);
  });

  it('every granted function is SECURITY DEFINER with a pinned search_path, and checks isolation first', async () => {
    const { rows } = await env.db.pool('superuser').query(`
      SELECT p.proname, p.prosecdef, p.proconfig, p.prosrc
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'safety' AND (p.proname LIKE 'app\\_%' OR p.proname LIKE 'owner\\_%')`);
    expect(rows.length).toBe(20);
    // Writing worker functions also refuse to run inside a transaction that has already written (third
    // review): each must commit on its own. Read-only ones and verify (which refuses softly) check isolation.
    const readOnly = new Set(['app_get_job', 'app_get_job_by_key', 'app_verify_reservation']);
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true);
      expect((r.proconfig ?? []).some((c: string) => c.startsWith('search_path=')), r.proname).toBe(true);
      const body = String(r.prosrc).replace(/--[^\n]*/g, '');
      const firstStatement = body.slice(body.search(/\bBEGIN\b/) + 5).split(';')[0];
      const expected = r.proname.startsWith('app_') && !readOnly.has(r.proname)
        ? 'PERFORM safety._require_app_call()' : 'PERFORM safety._require_read_committed()';
      expect(firstStatement.trim(), r.proname).toBe(expected);
    }
  });

  it('table privileges: the worker has none; the owner can only SELECT its four views', async () => {
    const { rows } = await env.db.pool('superuser').query(`
      SELECT c.relname, r.role, p.priv, has_table_privilege(r.role, c.oid, p.priv) AS granted
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN (VALUES ('truss_app'), ('truss_owner'), ('public')) r(role)
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
       WHERE n.nspname = 'safety' AND c.relkind IN ('r', 'v', 'm', 'p')`);
    const granted = rows.filter((r) => r.granted).map((r) => `${r.role}:${r.priv}:${r.relname}`).sort();
    expect(granted).toEqual(['owner_attempts', 'owner_events', 'owner_jobs', 'owner_sessions'].map((v) => `truss_owner:SELECT:${v}`));
  });

  it('PUBLIC cannot execute any function in the safety schema, including ones added later', async () => {
    const { rows } = await env.db.pool('superuser').query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'safety' AND has_function_privilege('public', p.oid, 'EXECUTE')`);
    expect(rows).toEqual([]);
    await env.db.pool('truss_migrator').query(`CREATE FUNCTION safety.later_added() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`);
    await expect(env.db.pool('truss_app').query(`SELECT safety.later_added()`)).rejects.toMatchObject(denied);
    await env.db.pool('truss_migrator').query(`DROP FUNCTION safety.later_added()`);
  });

  it('enabling submissions requires a Spectora approval reference', async () => {
    await expect(env.owner('owner_enable_submissions', ['', 'turning on'])).rejects.toThrow(/approval reference/);
  });
});
