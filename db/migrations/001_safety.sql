-- 001_safety.sql — mandatory scheduler and submission safety controls for the Truss booking agent.
--
-- Run as truss_migrator on every deploy. Idempotent by design:
--   * tables use CREATE TABLE IF NOT EXISTS; the control row is seeded only on a genuinely fresh install
--     (the migration refuses to re-seed it if booking history exists), so a deploy never rewrites
--     counters, the circuit breaker, or the kill switch;
--   * functions use CREATE OR REPLACE, so a deploy only ever re-installs the reviewed logic.
--
-- Fixed limits — literals in this file only, never read from a table, setting, variable or argument:
--   15 booking jobs per Arizona calendar day (counted at admission, before the first Spectora page load)
--    5 final submission attempts per Arizona calendar day
--    2 final submission attempts per rolling 60 minutes (counted over 61 min 30 s; see _counts)
--    1 active browser session globally (and so at most 1 submission in flight)
--    3 consecutive booking execution errors open the circuit breaker
--    0 unreconciled UNKNOWN outcomes before any further booking
--   10 minutes maximum browser session; 2-minute lease renewed by the live worker
--   10 seconds to verify a counted attempt, 20 seconds to send it; none in the last 90 s of a day
--
-- Not yet applied to any real database. Once it has been, this file is frozen: schema changes go in
-- 002_*.sql and later, never edits here.
--
-- Trust boundary: truss_migrator owns everything here and can therefore change anything (that is what a
-- deploy is). Its credential must exist only in the deploy pipeline — never on the worker, never in an
-- AI client's context. truss_app (worker) and truss_owner (owner) can only call the functions granted
-- at the bottom of this file.

CREATE SCHEMA IF NOT EXISTS safety;
REVOKE ALL ON SCHEMA safety FROM PUBLIC;
-- Functions created by later migrations must not become executable by PUBLIC (and so by truss_app).
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Clock. Every limit is measured on the database's clock, never the worker's.
CREATE OR REPLACE FUNCTION safety.clock() RETURNS timestamptz
LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp() $$;

-- =============================================================================================
-- Tables
-- =============================================================================================

-- Singleton row: circuit breaker. Every writing function locks it first, so it is also the global
-- serialization point.
CREATE TABLE IF NOT EXISTS safety.control (
  singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  consecutive_errors     integer NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  breaker_open           boolean NOT NULL DEFAULT false,
  breaker_opened_at      timestamptz,
  breaker_reason         text,
  last_admitted_at       timestamptz,
  last_reserved_at       timestamptz
);

-- The owner's kill switch, in its own row. Starts DISABLED. Worker functions only read it, never lock
-- it, so the owner's disable can never wait behind a worker's transaction; and each check reads the
-- latest committed value. A missing row reads as disabled.
CREATE TABLE IF NOT EXISTS safety.kill_switch (
  singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  submissions_enabled    boolean NOT NULL DEFAULT false,
  approval_ref           text,
  changed_at             timestamptz,
  changed_by             text,
  change_reason          text,
  -- Incremented only by the owner's acknowledgment of a confirmation report; a report applies to the
  -- generation current when it was written, and enable is refused while one applies.
  generation             bigint NOT NULL DEFAULT 0
);
ALTER TABLE safety.kill_switch ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;

-- Spectora answered a new booking as already confirmed: its "Require Confirmation" setting looks off.
-- Workers record that here (append-only; they never write the kill switch, so nothing they do can hold
-- up the owner's disable). Submissions count as disabled while a report exists for the kill switch's
-- current generation, that is until the owner acknowledges it (enable is refused until then).
CREATE TABLE IF NOT EXISTS safety.confirmation_reports (
  id                     bigserial PRIMARY KEY,
  job_id                 uuid NOT NULL,
  reported_at            timestamptz NOT NULL,
  kill_switch_generation bigint NOT NULL,
  source                 text NOT NULL CHECK (source IN ('create_answer','lookup_after_unknown'))
);

-- One row per ADMITTED job (a job that was allowed to start scheduler activity). Refused admissions
-- create no row. Rows are never deleted, so the daily job count cannot be lowered.
CREATE TABLE IF NOT EXISTS safety.jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key        text NOT NULL UNIQUE,
  mode                   text NOT NULL CHECK (mode IN ('booking','dry_run')),
  request_hash           text NOT NULL,
  request                jsonb NOT NULL,
  prop_number            text NOT NULL,
  prop_name              text NOT NULL,
  prop_dir               text NOT NULL,
  prop_suffix            text NOT NULL,
  prop_unit              text NOT NULL,
  prop_zip               text NOT NULL,
  prop_tokens            text NOT NULL,
  customer_keys          text[] NOT NULL,
  appointment_at         timestamptz NOT NULL,
  admitted_at            timestamptz NOT NULL,
  phoenix_day            date NOT NULL,
  state                  text NOT NULL CHECK (state IN (
                           'RECEIVED','READY','SUBMITTING','REQUESTED','CONFIRMED',
                           'NEEDS_INPUT','UNAVAILABLE','BLOCKED','FAILED','UNKNOWN','DRY_RUN')),
  state_reason           text,
  dup_check_result       text CHECK (dup_check_result IN ('clear','match','ambiguous','error')),
  dup_checked_at         timestamptz,
  dup_check_detail       jsonb,
  spectora_inspection_id text,
  updated_at             timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_day_idx      ON safety.jobs (phoenix_day);
CREATE INDEX IF NOT EXISTS jobs_street_idx   ON safety.jobs (prop_number, prop_name);
CREATE INDEX IF NOT EXISTS jobs_customer_idx ON safety.jobs USING gin (customer_keys);
CREATE INDEX IF NOT EXISTS jobs_appt_idx     ON safety.jobs (appointment_at);

-- One browser session per job, created atomically with the job at admission. Only the worker holding
-- the session token can use it. The live worker renews the 2-minute lease; once a lease has lapsed,
-- anyone may expire the session, which frees the global slot.
CREATE TABLE IF NOT EXISTS safety.browser_sessions (
  id           bigserial PRIMARY KEY,
  job_id       uuid NOT NULL UNIQUE REFERENCES safety.jobs (id),
  started_at   timestamptz NOT NULL,
  worker_id    text,
  token_hash   bytea NOT NULL,
  lease_until  timestamptz NOT NULL,
  ended_at     timestamptz,
  end_reason   text,
  -- Set when the worker could not confirm its browser closed. Such a session is never expired
  -- automatically: the global slot stays held until the owner releases it.
  browser_unconfirmed_at timestamptz
);
-- At most one active browser session across the whole system.
CREATE UNIQUE INDEX IF NOT EXISTS browser_sessions_single_active
  ON safety.browser_sessions ((true)) WHERE ended_at IS NULL;

-- One row per final-submit attempt. Inserted immediately before the submit action and never deleted.
-- job_id is UNIQUE: a job gets at most one submission attempt, ever.
CREATE TABLE IF NOT EXISTS safety.attempts (
  id               bigserial PRIMARY KEY,
  job_id           uuid NOT NULL UNIQUE REFERENCES safety.jobs (id),
  session_id       bigint NOT NULL REFERENCES safety.browser_sessions (id),
  attempted_at     timestamptz NOT NULL,
  phoenix_day      date NOT NULL,
  outcome          text CHECK (outcome IN ('requested','unavailable','failed','unknown')),
  outcome_detail   jsonb,
  completed_at     timestamptz,
  reconciled_at    timestamptz,
  reconciliation   text CHECK (reconciliation IN ('found','not_found')),
  reconciled_by    text
);
CREATE INDEX IF NOT EXISTS attempts_day_idx  ON safety.attempts (phoenix_day);
CREATE INDEX IF NOT EXISTS attempts_time_idx ON safety.attempts (attempted_at);
CREATE UNIQUE INDEX IF NOT EXISTS attempts_single_in_flight ON safety.attempts ((true)) WHERE outcome IS NULL;

-- Append-only audit log.
CREATE TABLE IF NOT EXISTS safety.events (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL,
  actor   text NOT NULL,
  kind    text NOT NULL,
  job_id  uuid,
  detail  jsonb
);
CREATE INDEX IF NOT EXISTS events_at_idx ON safety.events (at);

-- Seed the control row on a fresh install only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM safety.control) THEN
    IF EXISTS (SELECT 1 FROM safety.jobs) OR EXISTS (SELECT 1 FROM safety.attempts) THEN
      RAISE EXCEPTION 'safety.control row is missing but booking history exists; refusing to re-seed it '
                      '(that would reset the kill switch and circuit breaker). Restore it deliberately.';
    END IF;
    INSERT INTO safety.control (singleton) VALUES (true);
  END IF;
END $$;
INSERT INTO safety.kill_switch (singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- =============================================================================================
-- Integrity triggers. They bind every role that does not own the tables.
-- =============================================================================================
CREATE OR REPLACE FUNCTION safety.tg_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'safety.%: % is not allowed (append-only)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE OR REPLACE FUNCTION safety.tg_jobs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety.jobs: DELETE is not allowed (jobs are counted)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.idempotency_key, NEW.mode, NEW.request_hash, NEW.request, NEW.prop_number, NEW.prop_name,
      NEW.prop_dir, NEW.prop_suffix, NEW.prop_unit, NEW.prop_zip, NEW.prop_tokens, NEW.customer_keys, NEW.appointment_at,
      NEW.admitted_at, NEW.phoenix_day)
     IS DISTINCT FROM
     (OLD.id, OLD.idempotency_key, OLD.mode, OLD.request_hash, OLD.request, OLD.prop_number, OLD.prop_name,
      OLD.prop_dir, OLD.prop_suffix, OLD.prop_unit, OLD.prop_zip, OLD.prop_tokens, OLD.customer_keys, OLD.appointment_at,
      OLD.admitted_at, OLD.phoenix_day) THEN
    RAISE EXCEPTION 'safety.jobs: identity, request and admission fields are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION safety.tg_sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety.browser_sessions: DELETE is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.job_id, NEW.started_at, NEW.worker_id, NEW.token_hash)
     IS DISTINCT FROM (OLD.id, OLD.job_id, OLD.started_at, OLD.worker_id, OLD.token_hash) THEN
    RAISE EXCEPTION 'safety.browser_sessions: identity, token and start are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at, NEW.end_reason, NEW.lease_until, NEW.browser_unconfirmed_at)
                                  IS DISTINCT FROM (OLD.ended_at, OLD.end_reason, OLD.lease_until, OLD.browser_unconfirmed_at) THEN
    RAISE EXCEPTION 'safety.browser_sessions: an ended session cannot be reopened or changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.browser_unconfirmed_at IS NOT NULL AND NEW.browser_unconfirmed_at IS DISTINCT FROM OLD.browser_unconfirmed_at THEN
    RAISE EXCEPTION 'safety.browser_sessions: an unconfirmed browser mark cannot be cleared'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION safety.tg_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'safety.attempts: DELETE is not allowed (attempts are permanent)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.job_id, NEW.session_id, NEW.attempted_at, NEW.phoenix_day)
     IS DISTINCT FROM (OLD.id, OLD.job_id, OLD.session_id, OLD.attempted_at, OLD.phoenix_day) THEN
    RAISE EXCEPTION 'safety.attempts: attempt identity and timestamps are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.outcome IS NOT NULL AND (NEW.outcome, NEW.outcome_detail, NEW.completed_at)
                                 IS DISTINCT FROM (OLD.outcome, OLD.outcome_detail, OLD.completed_at) THEN
    RAISE EXCEPTION 'safety.attempts: outcome already recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.reconciled_at IS NOT NULL AND (NEW.reconciled_at, NEW.reconciliation, NEW.reconciled_by)
                                       IS DISTINCT FROM (OLD.reconciled_at, OLD.reconciliation, OLD.reconciled_by) THEN
    RAISE EXCEPTION 'safety.attempts: reconciliation already recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER jobs_guard BEFORE UPDATE OR DELETE ON safety.jobs
  FOR EACH ROW EXECUTE FUNCTION safety.tg_jobs_guard();
CREATE OR REPLACE TRIGGER jobs_no_truncate BEFORE TRUNCATE ON safety.jobs
  FOR EACH STATEMENT EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER sessions_guard BEFORE UPDATE OR DELETE ON safety.browser_sessions
  FOR EACH ROW EXECUTE FUNCTION safety.tg_sessions_guard();
CREATE OR REPLACE TRIGGER sessions_no_truncate BEFORE TRUNCATE ON safety.browser_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER attempts_guard BEFORE UPDATE OR DELETE ON safety.attempts
  FOR EACH ROW EXECUTE FUNCTION safety.tg_attempts_guard();
CREATE OR REPLACE TRIGGER attempts_no_truncate BEFORE TRUNCATE ON safety.attempts
  FOR EACH STATEMENT EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON safety.events
  FOR EACH ROW EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER events_no_truncate BEFORE TRUNCATE ON safety.events
  FOR EACH STATEMENT EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER control_no_delete BEFORE DELETE ON safety.control
  FOR EACH ROW EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER control_no_truncate BEFORE TRUNCATE ON safety.control
  FOR EACH STATEMENT EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER kill_switch_no_delete BEFORE DELETE ON safety.kill_switch
  FOR EACH ROW EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER kill_switch_no_truncate BEFORE TRUNCATE ON safety.kill_switch
  FOR EACH STATEMENT EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER confirmation_reports_append_only BEFORE UPDATE OR DELETE ON safety.confirmation_reports
  FOR EACH ROW EXECUTE FUNCTION safety.tg_append_only();
CREATE OR REPLACE TRIGGER confirmation_reports_no_truncate BEFORE TRUNCATE ON safety.confirmation_reports
  FOR EACH STATEMENT EXECUTE FUNCTION safety.tg_append_only();

-- =============================================================================================
-- Internal helpers (not granted to any role)
-- =============================================================================================

-- Every app_* and owner_* function calls this first. At REPEATABLE READ or SERIALIZABLE a caller could
-- count against an old snapshot and miss recent jobs or attempts. A role can change its own default
-- isolation level, so grants cannot prevent that; this check refuses the call instead.
CREATE OR REPLACE FUNCTION safety._require_read_committed() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'safety functions run only at READ COMMITTED isolation (this transaction is %)',
      current_setting('transaction_isolation') USING ERRCODE = 'invalid_transaction_state';
  END IF;
END $$;

-- Every worker (app_*) function starts here. Besides READ COMMITTED:
--  * the call must not be part of a transaction that has already written. Otherwise a worker could
--    admit a job, renew its session and open the browser inside one transaction and then roll it all
--    back: Spectora loaded, nothing counted. Each worker call must commit on its own.
--  * commits must be durable: with synchronous_commit off (a role can set that on itself) a counted
--    attempt could be lost in a database crash.
CREATE OR REPLACE FUNCTION safety._require_app_call() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM safety._require_read_committed();
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'worker functions must each run in their own transaction (this one has already written)'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  IF current_setting('synchronous_commit') = 'off' THEN
    RAISE EXCEPTION 'worker functions refuse to run with synchronous_commit off'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
END $$;

-- Whether submissions are on: the owner's kill switch, unless a worker has since reported that Spectora
-- confirmed a booking on creation. Read without locking.
CREATE OR REPLACE FUNCTION safety._submissions_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
  SELECT coalesce((SELECT ks.submissions_enabled
                          AND NOT EXISTS (SELECT 1 FROM safety.confirmation_reports r
                                           WHERE r.kill_switch_generation = ks.generation)
                     FROM safety.kill_switch ks WHERE ks.singleton), false);
$$;

-- Records that Spectora showed this job's new inspection as already confirmed.
CREATE OR REPLACE FUNCTION safety._report_confirmed_on_create(p_job uuid, p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
BEGIN
  INSERT INTO safety.confirmation_reports (job_id, reported_at, kill_switch_generation, source)
  VALUES (p_job, safety.clock(), coalesce((SELECT generation FROM safety.kill_switch WHERE singleton), 0), p_source);
  PERFORM safety._log('require_confirmation_off', p_job, jsonb_build_object('source', p_source));
END $$;

-- Locks and returns the control row. Fails closed if it is missing.
-- Lock order, everywhere: control row → browser session → job → attempt. Every app_* and owner_*
-- function that writes takes the control row first, so all writers are serialized and cannot deadlock.
CREATE OR REPLACE FUNCTION safety._lock_control() RETURNS safety.control
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_ctl safety.control%ROWTYPE;
BEGIN
  SELECT * INTO v_ctl FROM safety.control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'safety.control row is missing; refusing to proceed' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_ctl;
END $$;

CREATE OR REPLACE FUNCTION safety._log(p_kind text, p_job uuid, p_detail jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
  INSERT INTO safety.events (at, actor, kind, job_id, detail)
  VALUES (safety.clock(), session_user, p_kind, p_job, p_detail);
$$;

CREATE OR REPLACE FUNCTION safety._token_ok(p_hash bytea, p_token text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT p_hash IS NOT NULL AND p_token IS NOT NULL AND p_hash = sha256(convert_to(p_token, 'UTF8'));
$$;

-- Returns the session for a job after checking the caller's token. Raises 42501 on a bad token.
CREATE OR REPLACE FUNCTION safety._session_for(p_job uuid, p_token text) RETURNS safety.browser_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_s FROM safety.browser_sessions WHERE job_id = p_job FOR UPDATE;
  IF NOT FOUND OR NOT safety._token_ok(v_s.token_hash, p_token) THEN
    RAISE EXCEPTION 'invalid session token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_s;
END $$;

-- Counts one booking execution error. Caller must already hold the control row lock.
-- Opens the breaker at 3 consecutive errors. Never closes it.
CREATE OR REPLACE FUNCTION safety._register_error(p_job uuid, p_kind text, p_detail jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_count integer;
  v_was_open boolean;
BEGIN
  UPDATE safety.control SET consecutive_errors = consecutive_errors + 1
   WHERE singleton RETURNING consecutive_errors, breaker_open INTO v_count, v_was_open;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'safety.control row is missing; refusing to proceed' USING ERRCODE = 'P0002';
  END IF;
  PERFORM safety._log('execution_error', p_job,
    jsonb_build_object('kind', p_kind, 'consecutive_errors', v_count) || coalesce(p_detail, '{}'::jsonb));
  IF v_count >= 3 AND NOT v_was_open THEN
    UPDATE safety.control
       SET breaker_open = true,
           breaker_opened_at = safety.clock(),
           breaker_reason = format('%s consecutive booking execution errors (last: %s)', v_count, p_kind)
     WHERE singleton;
    PERFORM safety._log('breaker_opened', p_job, jsonb_build_object('consecutive_errors', v_count));
  END IF;
END $$;

-- THE limits. The only place these numbers appear. Used by admission, reservation and status.
CREATE OR REPLACE FUNCTION safety._counts(p_now timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
  SELECT jsonb_build_object(
    'phoenix_day',        (p_now AT TIME ZONE 'America/Phoenix')::date,
    'jobs_today',         (SELECT count(*) FROM safety.jobs
                            WHERE phoenix_day = (p_now AT TIME ZONE 'America/Phoenix')::date),
    'attempts_today',     (SELECT count(*) FROM safety.attempts
                            WHERE phoenix_day = (p_now AT TIME ZONE 'America/Phoenix')::date),
    -- 60 minutes plus a 90-second margin. A counted attempt's request leaves the browser within 20 s
    -- (the send-by budget from verification) and then has up to 60 s to reach Spectora (the create
    -- request's timeout): at most 80 s from count to arrival. The margin keeps any 60 minutes of
    -- requests as Spectora receives them at 2 or fewer. Attempts dated in the future (a clock that
    -- moved back) also count.
    'attempts_last_hour', (SELECT count(*) FROM safety.attempts
                            WHERE attempted_at >= p_now - interval '61 minutes 30 seconds'),
    'phoenix_time',       ((p_now AT TIME ZONE 'America/Phoenix')::time)::text,
    'unreconciled_unknown', (SELECT count(*) FROM safety.jobs WHERE mode = 'booking' AND state = 'UNKNOWN'),
    'submissions_enabled', safety._submissions_enabled(),
    'job_limit',          15,
    'day_limit',          5,
    'hour_limit',         2,
    'in_flight_attempt_id', (SELECT id FROM safety.attempts WHERE outcome IS NULL LIMIT 1),
    'active_session_job_id', (SELECT job_id FROM safety.browser_sessions WHERE ended_at IS NULL LIMIT 1));
$$;

-- Admission decision. NULL only when every check explicitly passes; anything missing blocks.
-- Dry runs (non-submitting) do not need the kill switch or a closed breaker, but use the same job limit
-- and the same single browser session.
CREATE OR REPLACE FUNCTION safety._admission_reason(p_ctl safety.control, p_counts jsonb, p_mode text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, safety, pg_temp AS $$
  SELECT CASE
    WHEN p_ctl.singleton IS NULL THEN 'control_row_missing'
    WHEN p_counts IS NULL THEN 'counts_unavailable'
    WHEN p_mode IS NULL OR p_mode NOT IN ('booking','dry_run') THEN 'invalid_mode'
    WHEN p_mode = 'booking' AND (p_counts->>'submissions_enabled')::boolean IS NOT TRUE THEN 'submissions_disabled'
    WHEN p_mode = 'booking' AND p_ctl.breaker_open IS NOT FALSE THEN 'circuit_breaker_open'
    WHEN p_mode = 'booking' AND coalesce((p_counts->>'unreconciled_unknown')::int, 1) > 0 THEN 'unreconciled_unknown_outcome'
    WHEN (p_counts->>'active_session_job_id') IS NOT NULL THEN 'browser_session_active'
    WHEN (p_counts->>'in_flight_attempt_id') IS NOT NULL THEN 'submission_in_flight'
    WHEN coalesce((p_counts->>'jobs_today')::int, 2147483647)
         >= coalesce((p_counts->>'job_limit')::int, 0) THEN 'daily_job_limit_reached'
    WHEN p_mode = 'booking' AND coalesce((p_counts->>'attempts_today')::int, 2147483647)
         >= coalesce((p_counts->>'day_limit')::int, 0) THEN 'daily_limit_reached'
    WHEN p_mode = 'booking' AND coalesce((p_counts->>'attempts_last_hour')::int, 2147483647)
         >= coalesce((p_counts->>'hour_limit')::int, 0) THEN 'hourly_limit_reached'
    ELSE NULL
  END;
$$;

-- Submission decision (re-checked at reservation, under the lock).
CREATE OR REPLACE FUNCTION safety._submit_reason(p_ctl safety.control, p_counts jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, safety, pg_temp AS $$
  SELECT CASE
    WHEN p_ctl.singleton IS NULL THEN 'control_row_missing'
    WHEN p_counts IS NULL THEN 'counts_unavailable'
    WHEN (p_counts->>'submissions_enabled')::boolean IS NOT TRUE THEN 'submissions_disabled'
    WHEN p_ctl.breaker_open IS NOT FALSE THEN 'circuit_breaker_open'
    WHEN coalesce((p_counts->>'unreconciled_unknown')::int, 1) > 0 THEN 'unreconciled_unknown_outcome'
    WHEN (p_counts->>'in_flight_attempt_id') IS NOT NULL THEN 'submission_in_flight'
    -- So the request cannot reach Spectora on the next Arizona day after being counted on this one
    -- (up to 80 s from count to arrival, as above).
    WHEN coalesce(p_counts->>'phoenix_time', '23:59:59')::time >= time '23:58:30' THEN 'too_close_to_midnight'
    WHEN coalesce((p_counts->>'attempts_today')::int, 2147483647)
         >= coalesce((p_counts->>'day_limit')::int, 0) THEN 'daily_limit_reached'
    WHEN coalesce((p_counts->>'attempts_last_hour')::int, 2147483647)
         >= coalesce((p_counts->>'hour_limit')::int, 0) THEN 'hourly_limit_reached'
    ELSE NULL
  END;
$$;

-- Same / ambiguous / different property. Mirrors compareProperty in src/booking/address.ts exactly
-- (test/address.test.ts checks every case against both). Inputs are normalized by the worker and
-- validated at admission. A street part that disagrees is only ambiguous when one side's street words
-- appear whole inside the other's; a unit that differs only in separators ("4-b" / "4b") is ambiguous.
DROP FUNCTION IF EXISTS safety._property_relation(text, text, text, text, text, text, text, text, text, text, text, text);
CREATE OR REPLACE FUNCTION safety._property_relation(
  a_number text, a_name text, a_dir text, a_suffix text, a_unit text, a_zip text, a_tokens text,
  b_number text, b_name text, b_dir text, b_suffix text, b_unit text, b_zip text, b_tokens text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_amb boolean := false;
  v_nested boolean;
BEGIN
  -- No readable house number or street name: ambiguous when the ZIPs agree.
  IF coalesce(a_number, '') = '' OR coalesce(b_number, '') = '' OR coalesce(a_name, '') = '' OR coalesce(b_name, '') = '' THEN
    RETURN CASE WHEN coalesce(a_zip, '') <> '' AND a_zip = b_zip THEN 'ambiguous' ELSE 'different' END;
  END IF;
  IF a_number <> b_number THEN
    -- "12a" / "12": the same number with a letter on one side may be the same building.
    IF regexp_replace(a_number, '[a-z]+$', '') <> regexp_replace(b_number, '[a-z]+$', '') THEN RETURN 'different'; END IF;
    v_amb := true;
  END IF;
  v_nested := (coalesce(b_tokens, '') <> '' AND position(' ' || b_tokens || ' ' IN ' ' || coalesce(a_tokens, '') || ' ') > 0)
           OR (coalesce(a_tokens, '') <> '' AND position(' ' || a_tokens || ' ' IN ' ' || coalesce(b_tokens, '') || ' ') > 0);
  IF a_name <> b_name THEN
    IF starts_with(a_name || ' ', b_name || ' ') OR starts_with(b_name || ' ', a_name || ' ') OR v_nested THEN
      v_amb := true;
    ELSIF a_zip <> '' AND a_zip = b_zip THEN
      v_amb := true;   -- same number, same ZIP, another street name: possibly a spelling not known
    ELSE
      RETURN 'different';
    END IF;
  END IF;
  IF a_dir <> '' AND b_dir <> '' AND a_dir <> b_dir THEN
    IF NOT v_nested THEN RETURN 'different'; END IF;
    v_amb := true;
  END IF;
  IF a_suffix <> '' AND b_suffix <> '' AND a_suffix <> b_suffix THEN
    -- Singular and plural ("trl" / "trls") are ambiguous, never the same.
    IF a_suffix || 's' <> b_suffix AND b_suffix || 's' <> a_suffix AND NOT v_nested THEN RETURN 'different'; END IF;
    v_amb := true;
  END IF;
  IF a_unit <> '' AND b_unit <> '' AND a_unit <> b_unit THEN
    -- Ambiguous when they differ only in separators or in the kind of unit ("bldg-4" / "4").
    IF replace(regexp_replace(a_unit, '^(bldg|lot|spc|rm)-', ''), '-', '')
       <> replace(regexp_replace(b_unit, '^(bldg|lot|spc|rm)-', ''), '-', '') THEN RETURN 'different'; END IF;
    v_amb := true;
  END IF;
  IF a_zip <> '' AND b_zip <> '' AND a_zip <> b_zip THEN RETURN 'different'; END IF;
  IF (a_dir = '') <> (b_dir = '') OR (a_suffix = '') <> (b_suffix = '')
     OR (a_unit = '') <> (b_unit = '') OR (a_zip = '') <> (b_zip = '') THEN
    v_amb := true;
  END IF;
  RETURN CASE WHEN v_amb THEN 'ambiguous' ELSE 'same' END;
END $$;

-- Same email or phone → same customer; same full name only → ambiguous. Mirrors compareCustomer.
CREATE OR REPLACE FUNCTION safety._customer_relation(a text[], b text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM unnest(a) x WHERE x = ANY (b) AND (x LIKE 'email:%' OR x LIKE 'phone:%')) THEN 'same'
    WHEN EXISTS (SELECT 1 FROM unnest(a) x WHERE x = ANY (b) AND x LIKE 'name:%') THEN 'ambiguous'
    ELSE 'different'
  END;
$$;

-- Another booking job within ±14 days that may have reached Spectora and is the same or possibly the
-- same property or customer. Same property → 'duplicate'; anything else → 'ambiguous'.
CREATE OR REPLACE FUNCTION safety._local_conflict(p_job safety.jobs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
  SELECT jsonb_build_object('job_id', j.id,
           'kind', CASE WHEN r.prop = 'same' THEN 'duplicate' ELSE 'ambiguous' END,
           'property', r.prop, 'customer', r.cust)
    FROM safety.jobs j
    CROSS JOIN LATERAL (SELECT
      safety._property_relation(p_job.prop_number, p_job.prop_name, p_job.prop_dir, p_job.prop_suffix,
                                p_job.prop_unit, p_job.prop_zip, p_job.prop_tokens,
                                j.prop_number, j.prop_name, j.prop_dir, j.prop_suffix, j.prop_unit, j.prop_zip,
                                j.prop_tokens) AS prop,
      safety._customer_relation(p_job.customer_keys, j.customer_keys) AS cust) r
   WHERE j.id <> p_job.id
     AND j.mode = 'booking'
     AND j.state IN ('SUBMITTING','REQUESTED','CONFIRMED','UNKNOWN')
     AND j.appointment_at BETWEEN p_job.appointment_at - interval '14 days'
                              AND p_job.appointment_at + interval '14 days'
     -- The same property, or possibly the same property; or another property for the same (or possibly
     -- the same) customer at the very same appointment time. A customer may book several properties.
     AND (r.prop <> 'different' OR (r.cust <> 'different' AND j.appointment_at = p_job.appointment_at))
   ORDER BY (r.prop = 'same') DESC, j.admitted_at
   LIMIT 1;
$$;

-- Ends every active session whose lease has lapsed (worker dead or frozen). Caller holds the control
-- lock. An in-flight attempt becomes 'unknown'; a booking job that had not submitted becomes FAILED.
-- Both count as execution errors. Returns how many sessions were expired.
-- Ends one session whose lease has lapsed. Caller holds the control lock and the session row.
CREATE OR REPLACE FUNCTION safety._end_lapsed_session(p_s safety.browser_sessions, p_now timestamptz, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_job safety.jobs%ROWTYPE;
  v_att safety.attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM safety.jobs WHERE id = p_s.job_id FOR UPDATE;
  SELECT * INTO v_att FROM safety.attempts WHERE job_id = p_s.job_id FOR UPDATE;
  IF v_att.id IS NOT NULL AND v_att.outcome IS NULL THEN
    UPDATE safety.attempts SET outcome = 'unknown', completed_at = p_now,
           outcome_detail = jsonb_build_object('reason', p_reason)
     WHERE id = v_att.id;
    UPDATE safety.jobs SET state = 'UNKNOWN', state_reason = p_reason, updated_at = p_now
     WHERE id = v_job.id;
    PERFORM safety._register_error(v_job.id, p_reason || '_during_submit', NULL);
  ELSIF v_job.state IN ('RECEIVED','READY') THEN
    UPDATE safety.jobs SET state = 'FAILED', state_reason = p_reason, updated_at = p_now
     WHERE id = v_job.id;
    IF v_job.mode = 'booking' THEN
      PERFORM safety._register_error(v_job.id, p_reason, NULL);
    END IF;
  END IF;
  UPDATE safety.browser_sessions SET ended_at = p_now,
         end_reason = CASE p_reason WHEN 'worker_lease_expired' THEN 'lease_expired' ELSE p_reason END
   WHERE id = p_s.id;
  PERFORM safety._log('session_expired', v_job.id, jsonb_build_object('session_id', p_s.id, 'reason', p_reason));
END $$;

-- Ends every active session whose lease has lapsed (worker dead or frozen), except one whose browser
-- was never confirmed closed: that one keeps the slot until the owner releases it. Caller holds the
-- control lock. An in-flight attempt becomes 'unknown'; a booking job that had not submitted becomes
-- FAILED. Both count as execution errors. Returns how many sessions were expired.
CREATE OR REPLACE FUNCTION safety._expire_stale_sessions(p_now timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
  v_n integer := 0;
BEGIN
  FOR v_s IN SELECT * FROM safety.browser_sessions
              WHERE ended_at IS NULL AND lease_until < p_now AND browser_unconfirmed_at IS NULL FOR UPDATE LOOP
    PERFORM safety._end_lapsed_session(v_s, p_now, 'worker_lease_expired');
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- =============================================================================================
-- Worker functions (granted to truss_app)
-- =============================================================================================

-- Admits a job: the ONLY way to start scheduler activity. Atomically, under the global lock:
-- expires lapsed sessions, re-checks the kill switch, breaker, daily job limit, attempt limits and the
-- single browser session, then records the job (counted toward 15/day) and opens its browser session.
-- Called before the first Spectora page load. A refused admission creates nothing.
-- A replayed idempotency key returns the existing job and does nothing else.
CREATE OR REPLACE FUNCTION safety.app_admit_job(
  p_idempotency_key text, p_mode text, p_request jsonb, p_request_hash text,
  p_property jsonb, p_customer_keys text[], p_appointment_at timestamptz, p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_ctl safety.control%ROWTYPE;
  v_job safety.jobs%ROWTYPE;
  v_now timestamptz;
  v_counts jsonb;
  v_reason text;
  v_token text;
  v_session bigint;
  v_k text;
BEGIN
  PERFORM safety._require_app_call();

  -- Input validation: everything the database compares must have the worker's normalized form.
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,200}$' THEN
    RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  IF p_request IS NULL OR p_request_hash IS NULL OR p_appointment_at IS NULL OR p_property IS NULL THEN
    RAISE EXCEPTION 'request, hash, property and appointment are required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_property) <> 'object'
     OR coalesce(p_property->>'number', '') !~ '^[0-9]+[a-z]?$'
     OR coalesce(p_property->>'name', '') !~ '^[a-z0-9]+( [a-z0-9]+)*$'
     OR coalesce(p_property->>'dir', 'x') !~ '^((n|s|e|w|ne|nw|se|sw)( (n|s|e|w|ne|nw|se|sw))?)?$'
     OR coalesce(p_property->>'suffix', 'X') !~ '^[a-z]*$'
     OR coalesce(p_property->>'unit', 'X') !~ '^([a-z0-9]+(-[a-z0-9]+)*)?$'
     OR coalesce(p_property->>'zip', '') !~ '^[0-9]{5}$'
     OR coalesce(p_property->>'tokens', '') !~ '^[a-z0-9]+( [a-z0-9]+)*$'
     OR position(' ' || (p_property->>'name') || ' ' IN ' ' || (p_property->>'tokens') || ' ') = 0 THEN
    RAISE EXCEPTION 'property must be the normalized number/name/dir/suffix/unit/zip/tokens form' USING ERRCODE = '22023';
  END IF;
  -- The request schema requires both an email and a phone; the database requires their keys too.
  IF p_customer_keys IS NULL
     OR NOT EXISTS (SELECT 1 FROM unnest(p_customer_keys) k WHERE k LIKE 'email:%')
     OR NOT EXISTS (SELECT 1 FROM unnest(p_customer_keys) k WHERE k LIKE 'phone:%') THEN
    RAISE EXCEPTION 'customer keys are required (email and phone)' USING ERRCODE = '22023';
  END IF;
  FOREACH v_k IN ARRAY p_customer_keys LOOP
    IF v_k IS NULL OR v_k !~ '^(email|phone|name):[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'invalid customer key' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_ctl := safety._lock_control();
  v_now := safety.clock();

  SELECT * INTO v_job FROM safety.jobs WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_job.request_hash <> p_request_hash OR v_job.mode <> p_mode THEN
      RAISE EXCEPTION 'idempotency key reused with a different request'
        USING ERRCODE = 'P0001', HINT = 'idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('admitted', false, 'replay', true, 'job_id', v_job.id, 'state', v_job.state,
                              'state_reason', v_job.state_reason, 'spectora_inspection_id', v_job.spectora_inspection_id);
  END IF;

  PERFORM safety._expire_stale_sessions(v_now);
  SELECT * INTO v_ctl FROM safety.control WHERE singleton;   -- expiry may have opened the breaker
  v_counts := safety._counts(v_now);
  v_reason := safety._admission_reason(v_ctl, v_counts, p_mode);
  IF v_reason IS NOT NULL THEN
    PERFORM safety._log('admission_refused', NULL,
      jsonb_build_object('reason', v_reason, 'mode', p_mode, 'worker', p_worker) || v_counts);
    RETURN jsonb_build_object('admitted', false, 'replay', false, 'reason', v_reason) || v_counts;
  END IF;

  INSERT INTO safety.jobs (idempotency_key, mode, request_hash, request, prop_number, prop_name, prop_dir,
                           prop_suffix, prop_unit, prop_zip, prop_tokens, customer_keys, appointment_at, admitted_at,
                           phoenix_day, state, updated_at)
  VALUES (p_idempotency_key, p_mode, p_request_hash, p_request, p_property->>'number', p_property->>'name',
          p_property->>'dir', p_property->>'suffix', p_property->>'unit', p_property->>'zip', p_property->>'tokens',
          p_customer_keys,
          p_appointment_at, v_now, (v_counts->>'phoenix_day')::date, 'RECEIVED', v_now)
  RETURNING * INTO v_job;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO safety.browser_sessions (job_id, started_at, worker_id, token_hash, lease_until)
  VALUES (v_job.id, v_now, p_worker, sha256(convert_to(v_token, 'UTF8')), v_now + interval '2 minutes')
  RETURNING id INTO v_session;
  -- Writing the control row makes any concurrent call that started from an older snapshot fail with a
  -- serialization error rather than count stale data.
  UPDATE safety.control SET last_admitted_at = v_now WHERE singleton;
  PERFORM safety._log('job_admitted', v_job.id, jsonb_build_object(
    'mode', p_mode, 'worker', p_worker, 'session_id', v_session,
    'jobs_today', (v_counts->>'jobs_today')::int + 1));
  RETURN jsonb_build_object('admitted', true, 'job_id', v_job.id, 'token', v_token,
                            'phoenix_day', v_counts->>'phoenix_day',
                            'jobs_today', (v_counts->>'jobs_today')::int + 1, 'job_limit', v_counts->'job_limit');
END $$;

-- Keeps the session's lease alive (2 minutes from now). Refused once the session has ended or has run
-- for 10 minutes; the worker must then stop its browser.
CREATE OR REPLACE FUNCTION safety.app_renew_session(p_job uuid, p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_app_call();
  PERFORM safety._lock_control();
  v_s := safety._session_for(p_job, p_token);
  v_now := safety.clock();
  IF v_s.ended_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_ended'); END IF;
  -- A lapsed lease is final even before anyone has expired it: a frozen worker cannot revive it.
  IF v_s.lease_until <= v_now THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_lease_expired'); END IF;
  IF v_s.started_at < v_now - interval '10 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session_max_duration');
  END IF;
  UPDATE safety.browser_sessions SET lease_until = v_now + interval '2 minutes' WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'lease_until', v_now + interval '2 minutes');
END $$;

-- Records the Spectora duplicate check. Only 'clear' makes a job READY; match, ambiguous and error block it.
CREATE OR REPLACE FUNCTION safety.app_record_duplicate_check(p_job uuid, p_token text, p_result text, p_detail jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
  v_job safety.jobs%ROWTYPE;
  v_now timestamptz;
  v_state text;
BEGIN
  PERFORM safety._require_app_call();
  IF p_result IS NULL OR p_result NOT IN ('clear','match','ambiguous','error') THEN
    RAISE EXCEPTION 'invalid duplicate-check result %', p_result USING ERRCODE = '22023';
  END IF;
  PERFORM safety._lock_control();
  v_s := safety._session_for(p_job, p_token);
  v_now := safety.clock();
  IF v_s.ended_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_ended'); END IF;
  IF v_s.lease_until <= v_now THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_lease_expired'); END IF;
  IF v_s.started_at < v_now - interval '10 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session_max_duration');
  END IF;
  SELECT * INTO v_job FROM safety.jobs WHERE id = p_job FOR UPDATE;
  IF v_job.state NOT IN ('RECEIVED','READY') OR EXISTS (SELECT 1 FROM safety.attempts WHERE job_id = p_job) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'job_not_checkable', 'state', v_job.state);
  END IF;
  v_state := CASE p_result WHEN 'clear' THEN 'READY' ELSE 'BLOCKED' END;
  UPDATE safety.jobs SET
    dup_check_result = p_result, dup_checked_at = v_now, dup_check_detail = p_detail, state = v_state,
    state_reason = CASE p_result WHEN 'clear' THEN NULL
                                 WHEN 'match' THEN 'potential_duplicate'
                                 WHEN 'ambiguous' THEN 'ambiguous_match_manual_booking_required'
                                 ELSE 'duplicate_check_unavailable' END,
    updated_at = v_now
  WHERE id = p_job;
  PERFORM safety._log('duplicate_check', p_job, jsonb_build_object('result', p_result));
  RETURN jsonb_build_object('ok', true, 'state', v_state);
END $$;

-- THE submission gate. Called immediately before the final Spectora submit action. Re-checks every
-- control under the global lock, requires the caller's live browser session, and records the attempt
-- BEFORE returning ok. If it returns ok=false, the caller must not submit.
CREATE OR REPLACE FUNCTION safety.app_reserve_submission(p_job uuid, p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_ctl safety.control%ROWTYPE;
  v_s safety.browser_sessions%ROWTYPE;
  v_job safety.jobs%ROWTYPE;
  v_now timestamptz;
  v_counts jsonb;
  v_reason text;
  v_conflict jsonb;
  v_attempt bigint;
BEGIN
  PERFORM safety._require_app_call();
  v_ctl := safety._lock_control();            -- global serialization point
  v_s := safety._session_for(p_job, p_token);
  v_now := safety.clock();                     -- read after the lock is held
  v_counts := safety._counts(v_now);
  SELECT * INTO v_job FROM safety.jobs WHERE id = p_job FOR UPDATE;

  IF v_s.ended_at IS NOT NULL THEN
    v_reason := 'session_ended';
  ELSIF v_s.lease_until <= v_now THEN
    v_reason := 'session_lease_expired';
  ELSIF v_s.started_at < v_now - interval '10 minutes' THEN
    v_reason := 'session_max_duration';
  ELSIF v_job.mode <> 'booking' THEN
    v_reason := 'dry_run_cannot_submit';
  ELSIF safety._submit_reason(v_ctl, v_counts) IS NOT NULL THEN
    v_reason := safety._submit_reason(v_ctl, v_counts);
  ELSIF EXISTS (SELECT 1 FROM safety.attempts WHERE job_id = p_job) THEN
    v_reason := 'job_already_attempted';
  ELSIF v_job.state <> 'READY' THEN
    v_reason := 'job_not_ready';
  ELSIF v_job.dup_check_result IS DISTINCT FROM 'clear' OR v_job.dup_checked_at IS NULL
        OR v_job.dup_checked_at < v_now - interval '15 minutes' THEN
    v_reason := 'duplicate_check_missing_or_stale';
  ELSE
    v_conflict := safety._local_conflict(v_job);
    IF v_conflict IS NOT NULL THEN
      v_reason := CASE v_conflict->>'kind' WHEN 'duplicate' THEN 'local_duplicate' ELSE 'local_ambiguous_match' END;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    PERFORM safety._log('reservation_blocked', p_job,
      jsonb_build_object('reason', v_reason, 'conflict', v_conflict) || v_counts);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'conflict', v_conflict) || v_counts;
  END IF;

  -- Count the attempt now, before the submit action exists, regardless of what happens next.
  INSERT INTO safety.attempts (job_id, session_id, attempted_at, phoenix_day)
  VALUES (p_job, v_s.id, v_now, (v_counts->>'phoenix_day')::date)
  RETURNING id INTO v_attempt;
  UPDATE safety.jobs SET state = 'SUBMITTING', state_reason = NULL, updated_at = v_now WHERE id = p_job;
  UPDATE safety.control SET last_reserved_at = v_now WHERE singleton;
  PERFORM safety._log('attempt_reserved', p_job, jsonb_build_object(
    'attempt_id', v_attempt, 'attempts_today', (v_counts->>'attempts_today')::int + 1,
    'attempts_last_hour', (v_counts->>'attempts_last_hour')::int + 1));
  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt,
                            'attempts_today', (v_counts->>'attempts_today')::int + 1,
                            'attempts_last_hour', (v_counts->>'attempts_last_hour')::int + 1);
END $$;

-- Proves, from a separate connection, that the reservation is committed, still in flight, owned by the
-- token holder, and that its session is live; then extends the lease. The worker calls this immediately
-- before the submit action.
CREATE OR REPLACE FUNCTION safety.app_verify_reservation(p_attempt bigint, p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_ctl safety.control%ROWTYPE;
  v_att safety.attempts%ROWTYPE;
  v_s safety.browser_sessions%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_read_committed();
  -- From inside a transaction that has already written (for example the reservation itself, inside an
  -- open BEGIN), the caller could see its own uncommitted attempt. Refuse.
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'verify_inside_writing_transaction');
  END IF;
  IF current_setting('synchronous_commit') = 'off' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'synchronous_commit_off');
  END IF;
  v_ctl := safety._lock_control();
  v_now := safety.clock();
  SELECT * INTO v_att FROM safety.attempts WHERE id = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'attempt_not_committed'); END IF;
  SELECT * INTO v_s FROM safety.browser_sessions WHERE id = v_att.session_id FOR UPDATE;
  IF NOT safety._token_ok(v_s.token_hash, p_token) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token');
  END IF;
  IF v_att.outcome IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'outcome_already_recorded'); END IF;
  IF v_s.ended_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_ended'); END IF;
  IF v_s.lease_until <= v_now THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_lease_expired'); END IF;
  IF v_s.started_at < v_now - interval '10 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session_max_duration');
  END IF;
  -- The attempt was counted at reservation; the submit must follow at once, not minutes later.
  IF v_att.attempted_at < v_now - interval '10 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reservation_stale');
  END IF;
  -- The clock moved back since the reservation: the elapsed time cannot be known, so nothing is sent.
  IF v_att.attempted_at > v_now THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'clock_moved_back');
  END IF;
  -- The owner may have pressed the kill switch in the moments since the reservation.
  IF NOT safety._submissions_enabled() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submissions_disabled');
  END IF;
  IF v_ctl.breaker_open THEN RETURN jsonb_build_object('ok', false, 'reason', 'circuit_breaker_open'); END IF;
  UPDATE safety.browser_sessions SET lease_until = v_now + interval '2 minutes' WHERE id = v_s.id;
  -- The request must reach Spectora within 20 s of the attempt being counted: the worker gets what is left.
  RETURN jsonb_build_object('ok', true, 'send_within_ms',
    least(20000, greatest(0, 20000 - floor(extract(epoch FROM (v_now - v_att.attempted_at)) * 1000)))::int);
END $$;

-- Records the outcome of a reserved attempt. Only the session token holder can. 'requested' requires
-- the Spectora inspection id, because success is only reported when Spectora's response proves it.
CREATE OR REPLACE FUNCTION safety.app_complete_attempt(
  p_attempt bigint, p_token text, p_outcome text, p_detail jsonb, p_inspection_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_att safety.attempts%ROWTYPE;
  v_s safety.browser_sessions%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_app_call();
  IF p_outcome IS NULL OR p_outcome NOT IN ('requested','unavailable','failed','unknown') THEN
    RAISE EXCEPTION 'invalid outcome %', p_outcome USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'requested' AND coalesce(btrim(p_inspection_id), '') = '' THEN
    RAISE EXCEPTION 'requested outcome requires the Spectora inspection id' USING ERRCODE = '22023';
  END IF;
  PERFORM safety._lock_control();
  v_now := safety.clock();
  SELECT * INTO v_att FROM safety.attempts WHERE id = p_attempt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_s FROM safety.browser_sessions WHERE id = v_att.session_id;
  IF NOT safety._token_ok(v_s.token_hash, p_token) THEN
    RAISE EXCEPTION 'invalid session token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_att.outcome IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'outcome_already_recorded', 'outcome', v_att.outcome);
  END IF;

  UPDATE safety.attempts SET outcome = p_outcome, outcome_detail = p_detail, completed_at = v_now
   WHERE id = p_attempt;
  UPDATE safety.jobs SET
    state = CASE p_outcome WHEN 'requested' THEN 'REQUESTED' WHEN 'unavailable' THEN 'UNAVAILABLE'
                           WHEN 'failed' THEN 'FAILED' ELSE 'UNKNOWN' END,
    state_reason = CASE p_outcome WHEN 'unknown' THEN 'submission_outcome_unknown'
                                  WHEN 'failed' THEN 'submission_failed' ELSE NULL END,
    spectora_inspection_id = coalesce(p_inspection_id, spectora_inspection_id),
    updated_at = v_now
  WHERE id = v_att.job_id;
  IF p_outcome = 'requested' THEN
    UPDATE safety.control SET consecutive_errors = 0 WHERE singleton;
    IF coalesce(p_detail->>'confirmed_on_create', '') = 'true' THEN
      PERFORM safety._report_confirmed_on_create(v_att.job_id, 'create_answer');
    END IF;
  ELSIF p_outcome IN ('failed','unknown') THEN
    PERFORM safety._register_error(v_att.job_id, 'submission_' || p_outcome, p_detail);
  END IF;
  PERFORM safety._log('attempt_completed', v_att.job_id,
    jsonb_build_object('attempt_id', p_attempt, 'outcome', p_outcome));
  RETURN jsonb_build_object('ok', true, 'outcome', p_outcome);
END $$;

-- Ends the job's browser session. The worker calls this only after its browser has actually closed.
-- A job that never submitted must be given its final pre-submit state here (NEEDS_INPUT, UNAVAILABLE,
-- BLOCKED, or DRY_RUN for a dry run). Refused while a submission is in flight.
CREATE OR REPLACE FUNCTION safety.app_end_session(p_job uuid, p_token text, p_state text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
  v_job safety.jobs%ROWTYPE;
  v_att safety.attempts%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_app_call();
  PERFORM safety._lock_control();
  v_s := safety._session_for(p_job, p_token);
  v_now := safety.clock();
  IF v_s.ended_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_ended'); END IF;
  IF v_s.browser_unconfirmed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'browser_unconfirmed'); END IF;
  SELECT * INTO v_job FROM safety.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO v_att FROM safety.attempts WHERE job_id = p_job FOR UPDATE;
  IF v_att.id IS NOT NULL AND v_att.outcome IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_in_flight');
  END IF;
  IF v_att.id IS NULL AND v_job.state IN ('RECEIVED','READY') THEN
    IF p_state IS NULL OR p_state NOT IN ('NEEDS_INPUT','UNAVAILABLE','BLOCKED','DRY_RUN')
       OR (p_state = 'DRY_RUN' AND v_job.mode <> 'dry_run') THEN
      RAISE EXCEPTION 'a job ending without a submission needs a valid final state (got %)', p_state
        USING ERRCODE = '22023';
    END IF;
    UPDATE safety.jobs SET state = p_state, state_reason = p_reason, updated_at = v_now WHERE id = p_job;
  END IF;
  UPDATE safety.browser_sessions SET ended_at = v_now, end_reason = coalesce(p_reason, p_state, 'completed')
   WHERE id = v_s.id;
  PERFORM safety._log('session_ended', p_job, jsonb_build_object('state', p_state, 'reason', p_reason));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Records a booking execution error that happened before any submit (page broke, timeout, crash) and
-- ends the session. Call only after the browser has closed. Dry runs do not count toward the breaker.
CREATE OR REPLACE FUNCTION safety.app_record_execution_error(p_job uuid, p_token text, p_stage text, p_detail jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
  v_job safety.jobs%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_app_call();
  PERFORM safety._lock_control();
  v_s := safety._session_for(p_job, p_token);
  v_now := safety.clock();
  IF v_s.ended_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_ended'); END IF;
  IF v_s.browser_unconfirmed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'browser_unconfirmed'); END IF;
  SELECT * INTO v_job FROM safety.jobs WHERE id = p_job FOR UPDATE;
  IF EXISTS (SELECT 1 FROM safety.attempts WHERE job_id = p_job) THEN
    RAISE EXCEPTION 'job has a submission attempt; record its outcome with app_complete_attempt'
      USING ERRCODE = '22023';
  END IF;
  IF v_job.state NOT IN ('RECEIVED','READY') THEN
    RAISE EXCEPTION 'job is already %', v_job.state USING ERRCODE = '22023';
  END IF;
  UPDATE safety.jobs SET state = 'FAILED', state_reason = 'execution_error:' || coalesce(p_stage, 'unknown'),
                         updated_at = v_now WHERE id = p_job;
  IF v_job.mode = 'booking' THEN
    PERFORM safety._register_error(p_job, 'pre_submit:' || coalesce(p_stage, 'unknown'), p_detail);
  ELSE
    PERFORM safety._log('dry_run_error', p_job, jsonb_build_object('stage', p_stage) || coalesce(p_detail, '{}'::jsonb));
  END IF;
  UPDATE safety.browser_sessions SET ended_at = v_now, end_reason = 'execution_error' WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Upgrades knowledge only: an UNKNOWN job found in Spectora becomes REQUESTED (or CONFIRMED), and a
-- REQUESTED job can become CONFIRMED. Only the job's own token holder. Never marks anything "not found".
CREATE OR REPLACE FUNCTION safety.app_reconcile_found(p_job uuid, p_token text, p_inspection_id text, p_confirmed boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_job safety.jobs%ROWTYPE;
  v_att safety.attempts%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_app_call();
  IF coalesce(btrim(p_inspection_id), '') = '' THEN
    RAISE EXCEPTION 'inspection id required' USING ERRCODE = '22023';
  END IF;
  PERFORM safety._lock_control();
  PERFORM safety._session_for(p_job, p_token);
  v_now := safety.clock();
  SELECT * INTO v_job FROM safety.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO v_att FROM safety.attempts WHERE job_id = p_job FOR UPDATE;
  IF v_att.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_attempt_for_job'); END IF;
  IF v_job.state = 'UNKNOWN' AND v_att.outcome = 'unknown' AND v_att.reconciled_at IS NULL THEN
    UPDATE safety.attempts SET reconciled_at = v_now, reconciliation = 'found', reconciled_by = session_user
     WHERE id = v_att.id;
    -- Found already confirmed, moments after the submit: "Require Confirmation" looks off.
    IF p_confirmed THEN PERFORM safety._report_confirmed_on_create(p_job, 'lookup_after_unknown'); END IF;
  ELSIF NOT (v_job.state = 'REQUESTED' AND p_confirmed) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_reconcilable', 'state', v_job.state);
  ELSIF v_job.spectora_inspection_id IS DISTINCT FROM p_inspection_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inspection_id_mismatch');
  END IF;
  UPDATE safety.jobs SET state = CASE WHEN p_confirmed THEN 'CONFIRMED' ELSE 'REQUESTED' END,
                         state_reason = NULL, spectora_inspection_id = p_inspection_id, updated_at = v_now
   WHERE id = p_job;
  PERFORM safety._log('reconciled_found', p_job,
    jsonb_build_object('inspection_id', p_inspection_id, 'confirmed', p_confirmed));
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN p_confirmed THEN 'CONFIRMED' ELSE 'REQUESTED' END);
END $$;

-- The worker could not confirm its browser closed. Marks the session so that it is never expired
-- automatically: the single browser slot stays held until the owner releases it.
CREATE OR REPLACE FUNCTION safety.app_mark_browser_unconfirmed(p_job uuid, p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
BEGIN
  PERFORM safety._require_app_call();
  PERFORM safety._lock_control();
  v_s := safety._session_for(p_job, p_token);
  IF v_s.ended_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'session_ended'); END IF;
  IF v_s.browser_unconfirmed_at IS NULL THEN
    UPDATE safety.browser_sessions SET browser_unconfirmed_at = safety.clock() WHERE id = v_s.id;
    PERFORM safety._log('browser_unconfirmed', p_job, jsonb_build_object('session_id', v_s.id));
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Expires lapsed sessions (also done automatically at every admission).
CREATE OR REPLACE FUNCTION safety.app_expire_stale_sessions() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM safety._require_app_call();
  PERFORM safety._lock_control();
  v_n := safety._expire_stale_sessions(safety.clock());
  RETURN jsonb_build_object('expired', v_n);
END $$;

CREATE OR REPLACE FUNCTION safety.app_get_job(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
BEGIN
  PERFORM safety._require_read_committed();
  -- No duplicate-check detail: it describes other customers' inspections, and this is what an AI client sees.
  -- spectora_shown: what Spectora's Review showed (price, square feet, year built), kept with the attempt.
  RETURN (SELECT jsonb_build_object('job_id', j.id, 'idempotency_key', j.idempotency_key, 'mode', j.mode, 'state', j.state,
                            'state_reason', j.state_reason, 'spectora_inspection_id', j.spectora_inspection_id,
                            'appointment_at', j.appointment_at, 'admitted_at', j.admitted_at, 'updated_at', j.updated_at,
                            'spectora_shown', (SELECT a.outcome_detail->'spectora_shown' FROM safety.attempts a
                                               WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1))
            FROM safety.jobs j WHERE j.id = p_job);
END $$;

-- The same, looked up by the caller's idempotency key (the API's status endpoint).
CREATE OR REPLACE FUNCTION safety.app_get_job_by_key(p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
BEGIN
  PERFORM safety._require_read_committed();
  -- No duplicate-check detail: it describes other customers' inspections, and this is what an AI client sees.
  -- spectora_shown: what Spectora's Review showed (price, square feet, year built), kept with the attempt.
  RETURN (SELECT jsonb_build_object('job_id', j.id, 'idempotency_key', j.idempotency_key, 'mode', j.mode, 'state', j.state,
                            'state_reason', j.state_reason, 'spectora_inspection_id', j.spectora_inspection_id,
                            'appointment_at', j.appointment_at, 'admitted_at', j.admitted_at, 'updated_at', j.updated_at,
                            'spectora_shown', (SELECT a.outcome_detail->'spectora_shown' FROM safety.attempts a
                                               WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1))
            FROM safety.jobs j WHERE j.idempotency_key = p_key);
END $$;

-- =============================================================================================
-- Owner functions (granted to truss_owner only)
-- =============================================================================================
CREATE OR REPLACE FUNCTION safety.owner_status() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_ctl safety.control%ROWTYPE;
  v_ks safety.kill_switch%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_read_committed();
  v_now := safety.clock();
  SELECT * INTO v_ctl FROM safety.control WHERE singleton;
  SELECT * INTO v_ks FROM safety.kill_switch WHERE singleton;
  RETURN safety._counts(v_now) || jsonb_build_object(
    'control_row_present', v_ctl.singleton IS NOT NULL,
    'submissions_enabled', safety._submissions_enabled(),
    'kill_switch_on', coalesce(v_ks.submissions_enabled, false),
    'stopped_by_confirmation_report', (SELECT jsonb_build_object('job_id', r.job_id, 'reported_at', r.reported_at, 'source', r.source)
                                         FROM safety.confirmation_reports r WHERE r.kill_switch_generation = v_ks.generation
                                        ORDER BY r.id DESC LIMIT 1),
    'approval_ref', v_ks.approval_ref,
    'enabled_changed_at', v_ks.changed_at,
    'enabled_changed_by', v_ks.changed_by,
    'enabled_change_reason', v_ks.change_reason,
    'consecutive_errors', v_ctl.consecutive_errors,
    'breaker_open', v_ctl.breaker_open,
    'breaker_opened_at', v_ctl.breaker_opened_at,
    'breaker_reason', v_ctl.breaker_reason,
    'active_session', (SELECT jsonb_build_object('job_id', job_id, 'started_at', started_at,
                                                 'lease_until', lease_until, 'worker_id', worker_id,
                                                 'browser_unconfirmed_at', browser_unconfirmed_at)
                         FROM safety.browser_sessions WHERE ended_at IS NULL LIMIT 1),
    'unreconciled_unknown', (SELECT count(*) FROM safety.jobs WHERE state = 'UNKNOWN'),
    'db_clock', v_now,
    'real_clock', clock_timestamp());
END $$;

CREATE OR REPLACE FUNCTION safety.owner_disable_submissions(p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
BEGIN
  PERFORM safety._require_read_committed();
  -- Never takes the global lock: a disable cannot be held off by a worker's open transaction.
  INSERT INTO safety.kill_switch (singleton, submissions_enabled, changed_at, changed_by, change_reason)
  VALUES (true, false, safety.clock(), session_user, coalesce(p_reason, 'no reason given'))
  ON CONFLICT (singleton) DO UPDATE SET submissions_enabled = false, changed_at = EXCLUDED.changed_at,
         changed_by = EXCLUDED.changed_by, change_reason = EXCLUDED.change_reason;
  PERFORM safety._log('submissions_disabled', NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('ok', true, 'submissions_enabled', false);
END $$;

CREATE OR REPLACE FUNCTION safety.owner_enable_submissions(p_approval_ref text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
BEGIN
  PERFORM safety._require_read_committed();
  IF coalesce(length(btrim(p_approval_ref)), 0) < 3 THEN
    RAISE EXCEPTION 'a Spectora approval reference is required to enable submissions' USING ERRCODE = '22023';
  END IF;
  IF coalesce(length(btrim(p_reason)), 0) < 3 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023';
  END IF;
  -- In order with the worker functions that record confirmation reports, so a report being written
  -- right now is committed (and seen below) before submissions can be turned on. (Disable never waits.)
  PERFORM safety._lock_control();
  IF EXISTS (SELECT 1 FROM safety.confirmation_reports r JOIN safety.kill_switch ks ON ks.singleton
              WHERE r.kill_switch_generation = ks.generation) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'confirmation_report_unacknowledged',
      'report', (SELECT jsonb_build_object('job_id', r.job_id, 'reported_at', r.reported_at, 'source', r.source)
                   FROM safety.confirmation_reports r ORDER BY r.id DESC LIMIT 1));
  END IF;
  INSERT INTO safety.kill_switch (singleton, submissions_enabled, approval_ref, changed_at, changed_by, change_reason)
  VALUES (true, true, p_approval_ref, safety.clock(), session_user, p_reason)
  ON CONFLICT (singleton) DO UPDATE SET submissions_enabled = true, approval_ref = EXCLUDED.approval_ref,
         changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by, change_reason = EXCLUDED.change_reason;
  PERFORM safety._log('submissions_enabled', NULL,
    jsonb_build_object('approval_ref', p_approval_ref, 'reason', p_reason));
  RETURN jsonb_build_object('ok', true, 'submissions_enabled', true);
END $$;

-- After Spectora confirmed a booking on creation: the owner has checked that "Require Confirmation" is on
-- again. Clears the report's effect (submissions stay as they are; enable them separately).
CREATE OR REPLACE FUNCTION safety.owner_acknowledge_confirmation_report(p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
BEGIN
  PERFORM safety._require_read_committed();
  IF coalesce(length(btrim(p_reason)), 0) < 3 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023';
  END IF;
  PERFORM safety._lock_control();
  UPDATE safety.kill_switch SET generation = generation + 1, changed_at = safety.clock(), changed_by = session_user,
         change_reason = 'confirmation report acknowledged: ' || p_reason
   WHERE singleton;
  PERFORM safety._log('confirmation_report_acknowledged', NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Closes the breaker. Refused while any submission is in flight or any outcome is unreconciled.
CREATE OR REPLACE FUNCTION safety.owner_reset_breaker(p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_ctl safety.control%ROWTYPE;
  v_unknown integer;
BEGIN
  PERFORM safety._require_read_committed();
  IF coalesce(length(btrim(p_reason)), 0) < 3 THEN
    RAISE EXCEPTION 'a reason is required to reset the circuit breaker' USING ERRCODE = '22023';
  END IF;
  v_ctl := safety._lock_control();
  IF EXISTS (SELECT 1 FROM safety.attempts WHERE outcome IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_in_flight');
  END IF;
  SELECT count(*) INTO v_unknown FROM safety.jobs WHERE state = 'UNKNOWN';
  IF v_unknown > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unreconciled_unknown_outcomes', 'count', v_unknown);
  END IF;
  UPDATE safety.control SET consecutive_errors = 0, breaker_open = false,
         breaker_opened_at = NULL, breaker_reason = NULL
   WHERE singleton;
  PERFORM safety._log('breaker_reset', NULL, jsonb_build_object(
    'reason', p_reason, 'was_open', v_ctl.breaker_open, 'consecutive_errors_before', v_ctl.consecutive_errors,
    'opened_at', v_ctl.breaker_opened_at, 'opened_reason', v_ctl.breaker_reason));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Owner's verdict on an uncertain outcome, after checking Spectora.
--   found      -> REQUESTED or CONFIRMED with the inspection id
--   not found  -> FAILED (a new job is needed to try again; this job never gets a second attempt)
-- Refused while the job's browser session is live (its worker may still be submitting). A lapsed
-- session is expired first (its in-flight attempt becomes 'unknown', counted as an error).
CREATE OR REPLACE FUNCTION safety.owner_reconcile(
  p_job uuid, p_found boolean, p_inspection_id text, p_confirmed boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_job safety.jobs%ROWTYPE;
  v_att safety.attempts%ROWTYPE;
  v_s safety.browser_sessions%ROWTYPE;
  v_now timestamptz;
  v_state text;
BEGIN
  PERFORM safety._require_read_committed();
  IF coalesce(length(btrim(p_note)), 0) < 3 THEN
    RAISE EXCEPTION 'a note is required' USING ERRCODE = '22023';
  END IF;
  IF p_found IS NULL OR (p_found AND coalesce(btrim(p_inspection_id), '') = '') THEN
    RAISE EXCEPTION 'say found (with the inspection id) or not found' USING ERRCODE = '22023';
  END IF;
  PERFORM safety._lock_control();
  v_now := safety.clock();
  SELECT * INTO v_s FROM safety.browser_sessions WHERE job_id = p_job FOR UPDATE;
  IF v_s.id IS NOT NULL AND v_s.ended_at IS NULL THEN
    IF v_s.lease_until >= v_now THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'session_in_progress', 'lease_until', v_s.lease_until);
    END IF;
    PERFORM safety._expire_stale_sessions(v_now);
  END IF;
  SELECT * INTO v_job FROM safety.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO v_att FROM safety.attempts WHERE job_id = p_job FOR UPDATE;
  IF v_job.id IS NULL OR v_att.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_attempt_for_job');
  END IF;
  -- The owner confirmed a REQUESTED inspection in Spectora (Require Confirmation stays on in Spectora).
  IF v_job.state = 'REQUESTED' AND p_found AND p_confirmed THEN
    IF v_job.spectora_inspection_id IS DISTINCT FROM p_inspection_id THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'inspection_id_mismatch',
                                'spectora_inspection_id', v_job.spectora_inspection_id);
    END IF;
    UPDATE safety.jobs SET state = 'CONFIRMED', state_reason = NULL, updated_at = v_now WHERE id = p_job;
    PERFORM safety._log('owner_confirmed', p_job, jsonb_build_object('inspection_id', p_inspection_id, 'note', p_note));
    RETURN jsonb_build_object('ok', true, 'state', 'CONFIRMED');
  END IF;
  IF v_job.state <> 'UNKNOWN' OR v_att.outcome IS DISTINCT FROM 'unknown' OR v_att.reconciled_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_reconcilable', 'state', v_job.state);
  END IF;
  UPDATE safety.attempts SET reconciled_at = v_now,
         reconciliation = CASE WHEN p_found THEN 'found' ELSE 'not_found' END, reconciled_by = session_user
   WHERE id = v_att.id;
  v_state := CASE WHEN NOT p_found THEN 'FAILED' WHEN p_confirmed THEN 'CONFIRMED' ELSE 'REQUESTED' END;
  UPDATE safety.jobs SET state = v_state,
         state_reason = CASE WHEN p_found THEN NULL ELSE 'reconciled_not_found' END,
         spectora_inspection_id = CASE WHEN p_found THEN p_inspection_id ELSE spectora_inspection_id END,
         updated_at = v_now
   WHERE id = p_job;
  PERFORM safety._log('owner_reconciled', p_job, jsonb_build_object(
    'found', p_found, 'inspection_id', p_inspection_id, 'confirmed', p_confirmed, 'note', p_note));
  RETURN jsonb_build_object('ok', true, 'state', v_state);
END $$;

-- Releases a session the automatic expiry will not touch (its browser was never confirmed closed), once
-- its worker has stopped renewing. Same effect as expiry: an in-flight attempt becomes UNKNOWN for
-- reconciliation, an unfinished job FAILED. Only after making sure that browser is gone.
CREATE OR REPLACE FUNCTION safety.owner_release_session(p_job uuid, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, safety, pg_temp AS $$
DECLARE
  v_s safety.browser_sessions%ROWTYPE;
  v_now timestamptz;
BEGIN
  PERFORM safety._require_read_committed();
  IF coalesce(length(btrim(p_note)), 0) < 3 THEN
    RAISE EXCEPTION 'a note is required' USING ERRCODE = '22023';
  END IF;
  PERFORM safety._lock_control();
  v_now := safety.clock();
  SELECT * INTO v_s FROM safety.browser_sessions WHERE job_id = p_job AND ended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_active_session'); END IF;
  IF v_s.lease_until >= v_now THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session_in_progress', 'lease_until', v_s.lease_until);
  END IF;
  PERFORM safety._end_lapsed_session(v_s, v_now, 'released_by_owner');
  PERFORM safety._log('session_released', p_job, jsonb_build_object('note', p_note));
  RETURN jsonb_build_object('ok', true, 'state', (SELECT state FROM safety.jobs WHERE id = p_job));
END $$;

-- Owner read views (run with the view owner's rights; the owner role has no table access).
DROP VIEW IF EXISTS safety.owner_jobs, safety.owner_attempts, safety.owner_sessions, safety.owner_events;
CREATE VIEW safety.owner_jobs AS
  SELECT j.id, j.idempotency_key, j.mode, j.state, j.state_reason, j.appointment_at, j.spectora_inspection_id,
         j.request->'property' AS property, j.request->'customer'->>'lastName' AS customer_last_name,
         j.request, j.phoenix_day, j.admitted_at,
         j.dup_check_result, j.dup_check_detail, j.updated_at,
         s.started_at AS session_started_at, s.ended_at AS session_ended_at, s.end_reason AS session_end_reason,
         a.id AS attempt_id, a.attempted_at, a.outcome, a.completed_at, a.reconciliation, a.reconciled_at
    FROM safety.jobs j
    LEFT JOIN safety.browser_sessions s ON s.job_id = j.id
    LEFT JOIN safety.attempts a ON a.job_id = j.id;
CREATE VIEW safety.owner_attempts AS
  SELECT id, job_id, session_id, attempted_at, phoenix_day, outcome, outcome_detail, completed_at,
         reconciled_at, reconciliation, reconciled_by
    FROM safety.attempts;
CREATE VIEW safety.owner_sessions AS
  SELECT id, job_id, started_at, worker_id, lease_until, ended_at, end_reason, browser_unconfirmed_at
    FROM safety.browser_sessions;
CREATE VIEW safety.owner_events AS
  SELECT id, at, actor, kind, job_id, detail FROM safety.events;

-- =============================================================================================
-- Grants. Explicit allow-list; everything else is denied.
-- =============================================================================================
REVOKE ALL ON ALL TABLES    IN SCHEMA safety FROM PUBLIC, truss_app, truss_owner;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA safety FROM PUBLIC, truss_app, truss_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA safety FROM PUBLIC, truss_app, truss_owner;
GRANT USAGE ON SCHEMA safety TO truss_app, truss_owner;

GRANT EXECUTE ON FUNCTION
  safety.app_admit_job(text, text, jsonb, text, jsonb, text[], timestamptz, text),
  safety.app_renew_session(uuid, text),
  safety.app_record_duplicate_check(uuid, text, text, jsonb),
  safety.app_reserve_submission(uuid, text),
  safety.app_verify_reservation(bigint, text),
  safety.app_complete_attempt(bigint, text, text, jsonb, text),
  safety.app_end_session(uuid, text, text, text),
  safety.app_record_execution_error(uuid, text, text, jsonb),
  safety.app_reconcile_found(uuid, text, text, boolean),
  safety.app_mark_browser_unconfirmed(uuid, text),
  safety.app_expire_stale_sessions(),
  safety.app_get_job(uuid),
  safety.app_get_job_by_key(text)
TO truss_app;

GRANT EXECUTE ON FUNCTION
  safety.owner_status(),
  safety.owner_disable_submissions(text),
  safety.owner_enable_submissions(text, text),
  safety.owner_acknowledge_confirmation_report(text),
  safety.owner_reset_breaker(text),
  safety.owner_reconcile(uuid, boolean, text, boolean, text),
  safety.owner_release_session(uuid, text)
TO truss_owner;

GRANT SELECT ON safety.owner_jobs, safety.owner_attempts, safety.owner_sessions, safety.owner_events TO truss_owner;
