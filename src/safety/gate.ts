/**
 * Thin client for the database safety functions, connected as truss_app.
 *
 * Every limit is enforced inside PostgreSQL (db/migrations/001_safety.sql). This class adds no policy of
 * its own and exposes no way to change limits, reset the breaker, or enable submissions: the truss_app
 * role has no permission to do any of those things.
 *
 * Every call goes through pool.query — its own autocommit transaction at READ COMMITTED. The database
 * refuses calls made at any other isolation level.
 */
import pg from 'pg';

export type JobMode = 'booking' | 'dry_run';

const ISSUE = Symbol('issue');
const TOKENS = new WeakMap<object, string>();
const ISSUED_RESERVATIONS = new WeakSet<object>();

/**
 * Proof that the database admitted a job and opened its browser session. Holds the session token in a
 * module-private map; genuineness is checked with a private-field brand that prototype tricks cannot fake.
 */
export class JobHandle {
  #brand = true;
  constructor(key: symbol, readonly jobId: string, readonly mode: JobMode, readonly jobsToday: number) {
    if (key !== ISSUE) throw new Error('Job handles can only be issued by SafetyGate');
  }
  static isGenuine(h: unknown): h is JobHandle {
    return typeof h === 'object' && h !== null && #brand in h && TOKENS.has(h);
  }
}

/** Proof that the database recorded a submission attempt for this job's live session. */
export class Reservation {
  #brand = true;
  constructor(key: symbol, readonly attemptId: number, readonly handle: JobHandle,
              readonly attemptsToday: number, readonly attemptsLastHour: number) {
    if (key !== ISSUE) throw new Error('Reservations can only be issued by SafetyGate');
  }
  get jobId() { return this.handle.jobId; }
  static isGenuine(r: unknown): r is Reservation {
    return typeof r === 'object' && r !== null && #brand in r && ISSUED_RESERVATIONS.has(r)
      && JobHandle.isGenuine((r as Reservation).handle);
  }
}

function tokenOf(h: JobHandle): string {
  const t = JobHandle.isGenuine(h) ? TOKENS.get(h) : undefined;
  if (!t) throw new Error('not a database-issued job handle');
  return t;
}

export type AdmitRefusal =
  | 'control_row_missing' | 'counts_unavailable' | 'invalid_mode' | 'submissions_disabled'
  | 'circuit_breaker_open' | 'unreconciled_unknown_outcome' | 'browser_session_active' | 'submission_in_flight'
  | 'daily_job_limit_reached' | 'daily_limit_reached' | 'hourly_limit_reached';

export type ReserveRefusal =
  | 'session_ended' | 'session_lease_expired' | 'session_max_duration' | 'dry_run_cannot_submit' | 'control_row_missing'
  | 'counts_unavailable' | 'submissions_disabled' | 'circuit_breaker_open' | 'unreconciled_unknown_outcome'
  | 'too_close_to_midnight' | 'submission_in_flight'
  | 'daily_limit_reached' | 'hourly_limit_reached' | 'job_already_attempted' | 'job_not_ready'
  | 'duplicate_check_missing_or_stale' | 'local_duplicate' | 'local_ambiguous_match';

export interface JobRecord {
  job_id: string;
  idempotency_key: string;
  mode: JobMode;
  state: string;
  state_reason: string | null;
  spectora_inspection_id: string | null;
  appointment_at: string;
  admitted_at: string;
  updated_at: string;
  /** What Spectora's Review showed (price, square feet, year built), recorded with the submission attempt. */
  spectora_shown?: unknown;
}

export type AdmitResult =
  | { admitted: true; handle: JobHandle }
  | { admitted: false; replay: true; jobId: string; state: string; stateReason: string | null; spectoraInspectionId: string | null }
  | { admitted: false; replay: false; reason: AdmitRefusal; counts: Record<string, unknown> };

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: ReserveRefusal; conflict: unknown; counts: Record<string, unknown> };

export type AttemptOutcome = 'requested' | 'unavailable' | 'failed' | 'unknown';
export type PreSubmitEnd = 'NEEDS_INPUT' | 'UNAVAILABLE' | 'BLOCKED' | 'DRY_RUN';

export class SafetyGate {
  constructor(private readonly pool: pg.Pool) {}

  private async call<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await this.pool.query(sql, params);
    return rows[0]?.r as T;
  }

  async admit(args: {
    idempotencyKey: string; mode: JobMode; request: unknown; requestHash: string;
    property: Record<string, string>; customerKeys: string[]; appointmentAt: Date; workerId: string;
  }): Promise<AdmitResult> {
    const r = await this.call<Record<string, unknown>>(
      'SELECT safety.app_admit_job($1, $2, $3, $4, $5, $6, $7, $8) AS r',
      [args.idempotencyKey, args.mode, JSON.stringify(args.request), args.requestHash,
       JSON.stringify(args.property), args.customerKeys, args.appointmentAt, args.workerId]);
    if (r.admitted === true) {
      const handle = new JobHandle(ISSUE, String(r.job_id), args.mode, Number(r.jobs_today));
      Object.freeze(handle);
      TOKENS.set(handle, String(r.token));
      return { admitted: true, handle };
    }
    if (r.replay === true) {
      return { admitted: false, replay: true, jobId: String(r.job_id), state: String(r.state),
               stateReason: (r.state_reason as string) ?? null, spectoraInspectionId: (r.spectora_inspection_id as string) ?? null };
    }
    const { reason, admitted: _a, replay: _r, ...counts } = r;
    return { admitted: false, replay: false, reason: reason as AdmitRefusal, counts };
  }

  async renewSession(h: JobHandle) {
    return this.call<{ ok: boolean; reason?: string }>('SELECT safety.app_renew_session($1, $2) AS r', [h.jobId, tokenOf(h)]);
  }

  async recordDuplicateCheck(h: JobHandle, result: 'clear' | 'match' | 'ambiguous' | 'error', detail: unknown) {
    return this.call<{ ok: boolean; state?: string; reason?: string }>(
      'SELECT safety.app_record_duplicate_check($1, $2, $3, $4) AS r', [h.jobId, tokenOf(h), result, JSON.stringify(detail)]);
  }

  async reserve(h: JobHandle): Promise<ReserveResult> {
    const r = await this.call<Record<string, unknown>>('SELECT safety.app_reserve_submission($1, $2) AS r', [h.jobId, tokenOf(h)]);
    if (r.ok === true) {
      const reservation = new Reservation(ISSUE, Number(r.attempt_id), h, Number(r.attempts_today), Number(r.attempts_last_hour));
      Object.freeze(reservation);
      ISSUED_RESERVATIONS.add(reservation);
      return { ok: true, reservation };
    }
    const { ok: _ok, reason, conflict, ...counts } = r;
    return { ok: false, reason: reason as ReserveRefusal, conflict: conflict ?? null, counts };
  }

  /**
   * Confirms, on a brand-new connection outside the pool, that the attempt is committed, in flight, owned
   * by this session, and that the session is live; extends the lease. If reserve() ever ran inside a
   * transaction that has not committed, the attempt is invisible here and the submit is refused.
   */
  async verifyReservation(r: Reservation): Promise<{ ok: boolean; reason?: string; send_within_ms?: number }> {
    if (!Reservation.isGenuine(r)) return { ok: false, reason: 'not_a_database_reservation' };
    const base = (this.pool as unknown as { options: pg.ClientConfig }).options;
    // Bounded: a reservation that cannot be verified promptly is not submitted at all.
    const client = new pg.Client({ ...base, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 8_000 });
    client.on('error', () => undefined);
    await client.connect();
    try {
      const { rows } = await client.query('SELECT safety.app_verify_reservation($1, $2) AS r', [r.attemptId, tokenOf(r.handle)]);
      return rows[0].r;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async completeAttempt(r: Reservation, outcome: AttemptOutcome, detail: unknown, inspectionId?: string) {
    if (!Reservation.isGenuine(r)) throw new Error('not a database-issued reservation');
    return this.call<{ ok: boolean; reason?: string; outcome?: string }>(
      'SELECT safety.app_complete_attempt($1, $2, $3, $4, $5) AS r',
      [r.attemptId, tokenOf(r.handle), outcome, JSON.stringify(detail ?? {}), inspectionId ?? null]);
  }

  /** Call only after the browser has actually closed. */
  async endSession(h: JobHandle, state: PreSubmitEnd | null, reason: string | null) {
    return this.call<{ ok: boolean; reason?: string }>('SELECT safety.app_end_session($1, $2, $3, $4) AS r',
      [h.jobId, tokenOf(h), state, reason]);
  }

  /** Call only after the browser has actually closed. Ends the session. */
  async recordExecutionError(h: JobHandle, stage: string, detail: unknown) {
    return this.call<{ ok: boolean; reason?: string }>('SELECT safety.app_record_execution_error($1, $2, $3, $4) AS r',
      [h.jobId, tokenOf(h), stage, JSON.stringify(detail ?? {})]);
  }

  /** The browser could not be confirmed closed: keep the global slot held until the owner releases it. */
  async markBrowserUnconfirmed(h: JobHandle) {
    return this.call<{ ok: boolean; reason?: string }>('SELECT safety.app_mark_browser_unconfirmed($1, $2) AS r', [h.jobId, tokenOf(h)]);
  }

  async reconcileFound(h: JobHandle, inspectionId: string, confirmed: boolean) {
    return this.call<{ ok: boolean; state?: string; reason?: string }>(
      'SELECT safety.app_reconcile_found($1, $2, $3, $4) AS r', [h.jobId, tokenOf(h), inspectionId, confirmed]);
  }

  expireStaleSessions() {
    return this.call<{ expired: number }>('SELECT safety.app_expire_stale_sessions() AS r');
  }

  getJob(jobId: string): Promise<JobRecord | null> {
    return this.call('SELECT safety.app_get_job($1) AS r', [jobId]);
  }

  getJobByKey(idempotencyKey: string): Promise<JobRecord | null> {
    return this.call('SELECT safety.app_get_job_by_key($1) AS r', [idempotencyKey]);
  }
}
