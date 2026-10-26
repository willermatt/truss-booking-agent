/**
 * Runs one booking job (or one non-submitting dry run) end to end. The order is the safety design:
 *
 *   validate, map services, parse address (no database, no Spectora)
 *   → ADMIT: the database counts the job and opens the single global browser session, atomically
 *   → Spectora read-only duplicate check (booking only)
 *   → browser: start, Steps 1–3, read Review                 (lease renewed throughout)
 *   → validate the Review against the request (services, property, date, time; Spectora sets the price,
 *     which is recorded with the result, never checked)
 *   → RESERVE: the database records the attempt
 *   → verify the reservation is committed → submit exactly once, under a hard deadline
 *   → close the browser, record the outcome, end the session
 *
 * The browser is always confirmed closed before the session is ended, so the global slot is never
 * released while a browser might still act. There is no loop and no retry around submit(). A thrown,
 * aborted or ambiguous submit is recorded UNKNOWN and only ever followed by a read-only lookup.
 */
import { BookingRequestSchema, appointmentInstant, type BookingRequest } from './schema.js';
import { fingerprints, type Fingerprints } from './normalize.js';
import { resolveServices, type ResolvedServices } from './services.js';
import { spectoraShown, validateReview, type SpectoraShown } from './review.js';
import { BrowserNotClosedError, type PreparedJob, type SchedulerDriver, type SchedulerSession, type SubmitResult } from './driver.js';
import { SafetyGate, type JobHandle, type JobMode, type PreSubmitEnd, type Reservation } from '../safety/gate.js';
import { checkSpectoraDuplicates, findSubmittedInspection, type DuplicateMatch } from '../spectora/duplicateCheck.js';
import type { SpectoraReadApi } from '../spectora/readApi.js';
import { errorDetail } from '../log.js';

export type JobState =
  | 'RECEIVED' | 'READY' | 'SUBMITTING'
  | 'CONFIRMED' | 'REQUESTED' | 'NEEDS_INPUT' | 'UNAVAILABLE' | 'BLOCKED' | 'FAILED' | 'UNKNOWN' | 'DRY_RUN';

export interface BookingResult {
  jobId: string | null;
  state: JobState;
  reason: string | null;
  spectoraInspectionId: string | null;
  duplicates?: DuplicateMatch[];
  issues?: string[];
  /** True when the idempotency key matched an existing job and nothing new was done. */
  replayed?: boolean;
  /** True when admission was refused for a reason that may clear (busy, hourly limit). Same key can be resent. */
  retryLater?: boolean;
  /** What Spectora's Review showed (price, square feet, year built), when the job got that far. */
  spectoraShown?: SpectoraShown;
}

export interface RunnerDeps {
  gate: SafetyGate;
  driver: SchedulerDriver;
  /** Read-only Spectora API. Without it, every booking job is blocked (duplicate check cannot run). */
  spectora: SpectoraReadApi | null;
  workerId: string;
  now?: () => Date;
  /** Hard limit on starting the browser plus Steps 1–3 and the Review read. */
  prepareDeadlineMs?: number;
  /** Hard limit on the final submit. */
  submitDeadlineMs?: number;
  /** How often the 2-minute browser-session lease is renewed. */
  leaseRenewMs?: number;
  /** After asking the browser to close, how long to wait for it to be gone. */
  closeGraceMs?: number;
  /**
   * If no session renewal has succeeded for this long (monotonic clock, measured from when the last
   * successful renewal was sent), the job is stopped and its browser closed: the database may be about to
   * let the 2-minute lease lapse and give the slot to another worker. Must be under the lease.
   */
  renewWatchdogMs?: number;
}

/**
 * The browser did not close when told to. The global session is still held (its lease keeps renewing
 * while this process lives) and any late result is still recorded. The host must exit this process; the
 * browser dies with it, the lease lapses two minutes later, and the job is then expired (UNKNOWN if it
 * was submitting) for the owner to reconcile.
 */
export class BrowserDidNotStopError extends Error {
  constructor(readonly jobId: string, reason: string) {
    super(`Browser did not stop (${reason}); exit this worker process.`);
    this.name = 'BrowserDidNotStopError';
  }
}

type Settled<T> = { status: 'value'; value: T } | { status: 'error'; error: unknown };
/** A failed start that may have left a browser running (see BrowserNotClosedError). */
const leftBrowser = (e: unknown) => e instanceof BrowserNotClosedError || (e as Error | null)?.name === 'BrowserNotClosedError';

interface BrowserHolder {
  session: SchedulerSession | null;
  pendingStart: Promise<Settled<SchedulerSession>> | null;
  /** The start failed and its browser could not be confirmed closed. */
  startLeftBrowser: boolean;
}
type PhaseResult<T> = Settled<T> | { status: 'aborted'; error: Error; pending: Promise<Settled<T>> };

type Ending =
  | { kind: 'pre_submit'; state: PreSubmitEnd; reason: string; detail?: string; shown?: SpectoraShown }
  | { kind: 'execution_error'; stage: string; detail: unknown }
  | { kind: 'submitted'; reservation: Reservation; outcome: PhaseResult<SubmitResult>; shown?: SpectoraShown };

interface Abort {
  signal: AbortSignal;
  abort(why: string): void;
  reason(): string | null;
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/**
 * Set when a browser in this process could not be stopped. From then on this process does no more
 * scheduler work of any kind: it must exit (which kills the browser). Module-level, so a new
 * BookingRunner in the same process is refused too.
 */
let workerMustExit: string | null = null;
export function workerMustExitReason(): string | null { return workerMustExit; }
const TRANSIENT = new Set(['browser_session_active', 'submission_in_flight', 'hourly_limit_reached']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** What Spectora showed, stored with the attempt so the status read can return it. */
const withShown = (shown?: SpectoraShown) => (shown ? { spectora_shown: shown } : {});

export type ValidatedBooking =
  | { ok: true; req: BookingRequest; services: ResolvedServices; appointmentAt: Date; fp: Fingerprints }
  | { ok: false; reason: string; issues?: string[] };

/**
 * Everything checked before a job may be admitted: the idempotency key, the strict request schema, the
 * service mapping, the appointment, the address. Pure: no database, no Spectora. Also used by the API to
 * answer 422 synchronously. The price is not checked: Spectora sets it.
 */
export function validateBooking(idempotencyKey: unknown, raw: unknown, now: Date): ValidatedBooking {
  if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) return { ok: false, reason: 'invalid_idempotency_key' };
  const parsed = BookingRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_request',
             issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(request)'}: ${i.message}`) };
  }
  const req = parsed.data;
  const services = resolveServices(req.services, req.addOns ?? []);
  if (!services.ok) return { ok: false, reason: 'service_not_mapped', issues: services.issues };
  const appointmentAt = appointmentInstant(req.appointment.date, req.appointment.time);
  if (!appointmentAt) return { ok: false, reason: 'invalid_appointment_date_or_time' };
  if (appointmentAt.getTime() <= now.getTime()) return { ok: false, reason: 'appointment_in_past' };
  const fp = fingerprints(req);
  if (!fp.property.clean || !fp.property.number || !fp.property.name || !fp.property.zip) {
    return { ok: false, reason: 'address_not_understood',
             issues: ['give the street line only (number, direction, name, type), with unit, city and ZIP in their own fields'] };
  }
  return { ok: true, req, services: services.value, appointmentAt, fp };
}

export class BookingRunner {
  private readonly now: () => Date;
  private readonly prepareDeadlineMs: number;
  private readonly submitDeadlineMs: number;
  private readonly leaseRenewMs: number;
  private readonly closeGraceMs: number;
  private readonly renewWatchdogMs: number;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    // All far inside the database's 10-minute session cap and 2-minute lease.
    this.prepareDeadlineMs = deps.prepareDeadlineMs ?? 240_000;
    this.submitDeadlineMs = deps.submitDeadlineMs ?? 90_000;
    this.leaseRenewMs = deps.leaseRenewMs ?? 20_000;
    this.closeGraceMs = deps.closeGraceMs ?? 30_000;
    this.renewWatchdogMs = deps.renewWatchdogMs ?? 80_000;
    // The lease is 2 minutes from the renewal's own time; stop well before it can lapse.
    if (!(this.renewWatchdogMs <= 90_000 && this.renewWatchdogMs > this.leaseRenewMs)) {
      throw new Error('renewWatchdogMs must be above leaseRenewMs and at most 90 s');
    }
  }

  run(idempotencyKey: string, raw: unknown): Promise<BookingResult> {
    return this.execute(idempotencyKey, raw, 'booking');
  }

  /** Same pipeline up to the Review (the Step 3 notification is not sent), then stops: never reserves or submits. */
  dryRun(idempotencyKey: string, raw: unknown): Promise<BookingResult> {
    return this.execute(idempotencyKey, raw, 'dry_run');
  }

  private async execute(idempotencyKey: string, raw: unknown, mode: JobMode): Promise<BookingResult> {
    const { gate } = this.deps;
    if (workerMustExit) return this.result(null, 'BLOCKED', 'worker_must_exit');

    // 1. Validate, map services, parse the address. Nothing is stored or counted on failure.
    const v = validateBooking(idempotencyKey, raw, this.now());
    if (!v.ok) return { ...this.result(null, 'NEEDS_INPUT', v.reason), ...(v.issues ? { issues: v.issues } : {}) };
    const { req, services, appointmentAt, fp } = v;

    // 2. Admission: counts the job and takes the single browser session — or refuses and creates nothing.
    let admitted;
    const admitSentAt = performance.now();   // the lease runs from no earlier than this
    try {
      admitted = await gate.admit({ idempotencyKey, mode, request: req, requestHash: fp.requestHash,
        property: fp.propertyColumns, customerKeys: fp.customerKeys, appointmentAt, workerId: this.deps.workerId });
    } catch (e) {
      if ((e as { hint?: string }).hint === 'idempotency_conflict') {
        return this.result(null, 'BLOCKED', 'idempotency_key_reused_with_different_request');
      }
      throw e;
    }
    if (!admitted.admitted) {
      if (admitted.replay) {
        return { ...this.result(admitted.jobId, admitted.state as JobState, admitted.stateReason, admitted.spectoraInspectionId), replayed: true };
      }
      return { ...this.result(null, 'BLOCKED', admitted.reason), retryLater: TRANSIENT.has(admitted.reason) };
    }
    const h = admitted.handle;

    // 3. Keep the session lease alive for as long as this job may touch a browser.
    const controller = new AbortController();
    let why: string | null = null;
    const ab: Abort = {
      signal: controller.signal,
      abort: (reason) => { if (!why) why = reason; controller.abort(); },
      reason: () => why,
    };
    // The lease was last extended no earlier than when the last successful renewal was sent.
    let leaseFrom = admitSentAt;
    const renew = async () => {
      const sent = performance.now();
      const r = await gate.renewSession(h);
      if (r.ok) leaseFrom = Math.max(leaseFrom, sent);
      return r;
    };
    // A renewal that never answers (a database that stopped responding) must not leave the browser open
    // past the lease: another worker could then be admitted and open a second one.
    const watchdog: NodeJS.Timeout = setInterval(() => {
      if (performance.now() - leaseFrom > this.renewWatchdogMs) {
        ab.abort(`no session renewal succeeded for ${Math.round(this.renewWatchdogMs / 1000)} s`);
      }
    }, Math.min(1_000, this.renewWatchdogMs / 4));
    watchdog.unref();
    // Called by the driver before every step, and here before the browser starts.
    const checkpoint = async () => {
      if (ab.signal.aborted) throw new Error(`stopped: ${ab.reason()}`);
      const r = await renew();
      if (!r.ok) {
        ab.abort(`session renewal refused: ${r.reason}`);
        throw new Error(`session renewal refused: ${r.reason}`);
      }
      if (ab.signal.aborted) throw new Error(`stopped: ${ab.reason()}`);
    };
    const job: PreparedJob = { jobId: h.jobId, mode, request: req, services, appointmentAt, checkpoint };
    // A refused renewal is final (session ended, lease lapsed, or 10-minute cap): stop renewing and abort.
    const heartbeat: NodeJS.Timeout = setInterval(() => {
      renew().then(
        (r) => { if (!r.ok) { clearInterval(heartbeat); ab.abort(`session renewal refused: ${r.reason}`); } },
        (e) => ab.abort(`session renewal failed: ${errorDetail(e).error}`));
    }, this.leaseRenewMs);
    heartbeat.unref();
    let keepHeartbeat = false;

    try {
      // 4. Duplicate check (booking only) before any browser opens.
      if (mode === 'booking') {
        const blocked = await this.duplicateCheck(h, req, fp, appointmentAt);
        if (blocked) return blocked;
      }
      // 5. Browser work, always followed by a confirmed close.
      return await this.withBrowser(h, job, fp, ab);
    } catch (e) {
      if (e instanceof BrowserDidNotStopError) keepHeartbeat = true;
      throw e; // anything else: the session lapses and is expired as FAILED/UNKNOWN (fail-safe)
    } finally {
      clearInterval(watchdog);
      if (!keepHeartbeat) clearInterval(heartbeat);
    }
  }

  private async duplicateCheck(h: JobHandle, req: BookingRequest, fp: Fingerprints, appointmentAt: Date): Promise<BookingResult | null> {
    const { gate } = this.deps;
    // BLOCKED applies only if the job is still RECEIVED/READY; a job the check already blocked keeps its reason.
    const stop = async (reason: string, extra: Partial<BookingResult> = {}) => {
      await gate.endSession(h, 'BLOCKED', reason).catch(() => undefined);
      return { ...(await this.current(h.jobId)), ...extra };
    };
    if (!this.deps.spectora) {
      await gate.recordDuplicateCheck(h, 'error', { error: 'spectora_api_not_configured' });
      return stop('duplicate_check_unavailable');
    }
    const dup = await checkSpectoraDuplicates(this.deps.spectora, req, fp, appointmentAt);
    if (dup.result === 'clear') {
      // Only a recorded clear check lets the job continue. If the session ended or lapsed meanwhile
      // (this worker was frozen), stop here: no browser.
      const rec = await gate.recordDuplicateCheck(h, 'clear', { checked: dup.checkedCount });
      if (!rec.ok || rec.state !== 'READY') return stop(`duplicate_check_not_recorded: ${rec.reason ?? rec.state}`);
      return null;
    }
    if (dup.result === 'error') {
      await gate.recordDuplicateCheck(h, 'error', { error: dup.error });
      return stop('duplicate_check_unavailable');
    }
    await gate.recordDuplicateCheck(h, dup.result, { matches: dup.matches });
    return stop(dup.result === 'match' ? 'potential_duplicate' : 'ambiguous_match_manual_booking_required',
                { duplicates: dup.matches });
  }

  private async withBrowser(h: JobHandle, job: PreparedJob, fp: Fingerprints, ab: Abort): Promise<BookingResult> {
    const holder: BrowserHolder = { session: null, pendingStart: null, startLeftBrowser: false };
    let ending: Ending;
    try {
      ending = await this.drive(h, job, ab, holder);
    } catch (e) {
      ending = { kind: 'execution_error', stage: 'unexpected', detail: errorDetail(e) };
    }

    // Always confirm the browser is gone before the session can be released.
    ab.abort(ab.reason() ?? 'job finished');
    const closed = !holder.startLeftBrowser && await this.closeBrowser(holder.session, holder.pendingStart);
    if (!closed) {
      workerMustExit = `browser for job ${h.jobId} did not stop (${ab.reason() ?? 'close timed out'})`;
      // Hold the global slot in the database until the owner releases it, whatever this process does next.
      await this.deps.gate.markBrowserUnconfirmed(h).catch(() => undefined);
      // Record what is known about the submit, but do NOT end the session: the browser may still act,
      // so the global slot stays held until this process exits and the lease lapses.
      if (ending.kind === 'submitted') {
        const o = ending.outcome;
        if (o.status === 'value') await this.recordOutcome(h, ending.reservation, o.value, ending.shown);
        else if (o.status === 'error') await this.safeComplete(ending.reservation, 'unknown', { ...errorDetail(o.error), ...withShown(ending.shown) });
        else this.recordLate(h, ending);
      }
      throw new BrowserDidNotStopError(h.jobId, ab.reason() ?? 'close timed out');
    }
    return this.finish(h, job, fp, ending);
  }

  /** Everything between admission and closing the browser. Returns how the job should end. */
  private async drive(h: JobHandle, job: PreparedJob, ab: Abort,
                      holder: BrowserHolder): Promise<Ending> {
    const { gate, driver } = this.deps;

    // Browser start + Steps 1–3 + Review read, under one deadline.
    const prepareDeadline = setTimeout(() => ab.abort(`prepare exceeded ${this.prepareDeadlineMs} ms`), this.prepareDeadlineMs);
    let session: SchedulerSession;
    let prepared: PhaseResult<Awaited<ReturnType<SchedulerSession['prepare']>>>;
    try {
      // No browser unless this worker's session is live right now.
      try {
        await job.checkpoint!();
      } catch (e) {
        return { kind: 'execution_error', stage: 'session_check', detail: errorDetail(e) };
      }
      const started = await this.phase(driver.start(job, ab.signal), ab);
      if (started.status === 'aborted') {
        holder.pendingStart = started.pending;
        return { kind: 'execution_error', stage: 'browser_start', detail: { error: started.error.message } };
      }
      if (started.status === 'error') {
        if (leftBrowser(started.error)) holder.startLeftBrowser = true;
        return { kind: 'execution_error', stage: 'browser_start', detail: errorDetail(started.error) };
      }
      session = started.value;
      holder.session = session;
      prepared = await this.phase(session.prepare(ab.signal), ab);
    } finally {
      clearTimeout(prepareDeadline);
    }
    if (prepared.status === 'aborted') return { kind: 'execution_error', stage: 'prepare_aborted', detail: { error: prepared.error.message } };
    if (prepared.status === 'error') return { kind: 'execution_error', stage: 'prepare', detail: errorDetail(prepared.error) };
    const p = prepared.value;
    if (!p.ok) {
      if (p.kind === 'execution_error') return { kind: 'execution_error', stage: p.stage, detail: { detail: p.detail } };
      return { kind: 'pre_submit', state: p.kind === 'needs_input' ? 'NEEDS_INPUT' : 'UNAVAILABLE', reason: p.kind, detail: p.detail };
    }
    if (!p.summary) return { kind: 'execution_error', stage: 'review', detail: { error: 'no Review summary returned' } };

    const shown = spectoraShown(p.summary);
    const review = validateReview(job, p.summary);
    if (!review.ok) return { kind: 'pre_submit', state: 'NEEDS_INPUT', reason: review.reason, detail: review.detail, shown };
    if (job.mode === 'dry_run') return { kind: 'pre_submit', state: 'DRY_RUN', reason: 'dry_run_complete_stopped_before_schedule', shown };

    // The gate. The database re-checks everything under the global lock and records the attempt.
    const reserved = await gate.reserve(h);
    if (!reserved.ok) return { kind: 'pre_submit', state: 'BLOCKED', reason: reserved.reason };

    // Prove the attempt is committed (separate connection) and extend the lease, then submit once.
    // The send-by budget is measured by the database at verification, which is after this moment, so a
    // deadline anchored here is never later than the database's own (whatever the round trip took).
    const verifySentWall = Date.now();
    const verifySentMono = performance.now();
    const verified: { ok: boolean; reason?: string; send_within_ms?: number } = await Promise.race([
      gate.verifyReservation(reserved.reservation),
      sleep(15_000).then(() => ({ ok: false, reason: 'verification timed out' })),
    ]).catch((e) => ({ ok: false, reason: errorDetail(e).error }));
    const budget = Math.min(20_000, Number(verified.send_within_ms ?? 0));
    const sendBy = { wallMs: verifySentWall + budget, monoMs: verifySentMono + budget };
    if (verified.ok && !(budget > 0 && performance.now() < sendBy.monoMs && Date.now() < sendBy.wallMs)) {
      return { kind: 'submitted', reservation: reserved.reservation, shown,
               outcome: { status: 'value', value: { kind: 'rejected', detail: 'not submitted: no send-by budget left' } } };
    }
    if (!verified.ok) {
      return { kind: 'submitted', reservation: reserved.reservation, shown,
               outcome: { status: 'value', value: { kind: 'rejected', detail: `not submitted: reservation not verified (${verified.reason})` } } };
    }
    if (ab.signal.aborted) {
      return { kind: 'submitted', reservation: reserved.reservation, shown,
               outcome: { status: 'value', value: { kind: 'rejected', detail: `not submitted: ${ab.reason() ?? 'aborted'}` } } };
    }
    const submitDeadline = setTimeout(() => ab.abort(`submit exceeded ${this.submitDeadlineMs} ms`), this.submitDeadlineMs);
    try {
      const outcome = await this.phase(session.submit(reserved.reservation, ab.signal, sendBy), ab);
      return { kind: 'submitted', reservation: reserved.reservation, outcome, shown };
    } finally {
      clearTimeout(submitDeadline);
    }
  }

  /** Waits for `work`, or returns early if the signal aborts (leaving `work` running as `pending`). */
  private async phase<T>(work: Promise<T>, ab: Abort): Promise<PhaseResult<T>> {
    const settled: Promise<Settled<T>> = work.then((value) => ({ status: 'value' as const, value }),
                                                    (error) => ({ status: 'error' as const, error }));
    if (ab.signal.aborted) return { status: 'aborted', error: new Error(ab.reason() ?? 'aborted'), pending: settled };
    const aborted = new Promise<'aborted'>((resolve) => ab.signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
    const first = await Promise.race([settled, aborted]);
    if (first === 'aborted') return { status: 'aborted', error: new Error(ab.reason() ?? 'aborted'), pending: settled };
    return first;
  }

  /** True once the browser is confirmed gone (or never started). */
  private async closeBrowser(session: SchedulerSession | null, pendingStart: Promise<Settled<SchedulerSession>> | null): Promise<boolean> {
    const within = <T>(p: Promise<T>) => Promise.race([p.then((v) => ({ v })), sleep(this.closeGraceMs).then(() => null)]);
    if (!session && pendingStart) {
      const late = await within(pendingStart);
      if (!late) return false;                       // still launching: cannot confirm
      if (late.v.status === 'error') return !leftBrowser(late.v.error);   // never started
      session = late.v.value;
    }
    if (!session) return true;
    const done = await within(session.close().then(() => true, () => false));
    return done !== null && done.v === true;
  }

  /** After the browser is closed: record what happened and release the session. */
  private async finish(h: JobHandle, job: PreparedJob, fp: Fingerprints, ending: Ending): Promise<BookingResult> {
    const { gate } = this.deps;
    switch (ending.kind) {
      case 'pre_submit': {
        await gate.endSession(h, ending.state, ending.detail ? `${ending.reason}: ${ending.detail}` : ending.reason);
        const res = await this.current(h.jobId);
        return { ...res, ...(ending.detail ? { issues: [ending.detail] } : {}), ...(ending.shown ? { spectoraShown: ending.shown } : {}) };
      }
      case 'execution_error':
        await gate.recordExecutionError(h, ending.stage, ending.detail);
        return this.current(h.jobId);
      case 'submitted': {
        const o = ending.outcome;
        if (o.status === 'value') {
          await this.recordOutcome(h, ending.reservation, o.value, ending.shown);
        } else {
          await this.safeComplete(ending.reservation, 'unknown', { ...errorDetail(o.error), ...withShown(ending.shown) });
          if (o.status === 'aborted') this.recordLate(h, ending);
          await this.reconcileUnknown(h, fp, job.appointmentAt);
        }
        await gate.endSession(h, null, 'completed').catch(() => undefined);
        const res = await this.current(h.jobId);
        return ending.shown ? { ...res, spectoraShown: ending.shown } : res;
      }
    }
  }

  private async recordOutcome(h: JobHandle, r: Reservation, outcome: SubmitResult, shown?: SpectoraShown): Promise<void> {
    switch (outcome.kind) {
      case 'requested': {
        // confirmed_on_create: Spectora answered it already confirmed ("Require Confirmation" looks off). The
        // database then counts submissions as disabled until the owner checks and re-enables them.
        const done = await this.safeComplete(r, 'requested', { ...(outcome.confirmedOnCreate ? { confirmed_on_create: true } : {}), ...withShown(shown) },
                                             outcome.inspectionId);
        // Already closed as UNKNOWN (our lease lapsed). We hold Spectora's proof.
        if (done && !done.ok && done.reason === 'outcome_already_recorded') {
          await this.deps.gate.reconcileFound(h, outcome.inspectionId, outcome.confirmedOnCreate === true).catch(() => undefined);
        }
        return;
      }
      case 'unavailable':
        await this.safeComplete(r, 'unavailable', { detail: outcome.detail, ...withShown(shown) });
        return;
      case 'rejected':
        await this.safeComplete(r, 'failed', { detail: outcome.detail, ...withShown(shown) });
        return;
    }
  }

  /** A submit that was abandoned may still deliver its real result; record it if it does. */
  private recordLate(h: JobHandle, ending: Extract<Ending, { kind: 'submitted' }>) {
    if (ending.outcome.status !== 'aborted') return;
    void ending.outcome.pending.then(async (late) => {
      if (late.status === 'value' && late.value.kind === 'requested') {
        const done = await this.safeComplete(ending.reservation, 'requested',
          { late: true, ...(late.value.confirmedOnCreate ? { confirmed_on_create: true } : {}), ...withShown(ending.shown) }, late.value.inspectionId);
        if (done && !done.ok) await this.deps.gate.reconcileFound(h, late.value.inspectionId, late.value.confirmedOnCreate === true);
      }
    }).catch(() => undefined);
  }

  private async safeComplete(r: Reservation, outcome: 'requested' | 'unavailable' | 'failed' | 'unknown',
                             detail: unknown, inspectionId?: string) {
    try {
      return await this.deps.gate.completeAttempt(r, outcome, detail, inspectionId);
    } catch {
      // The attempt stays in flight and the session cannot end; the lease lapses and expiry records
      // UNKNOWN. That is the safe failure.
      return null;
    }
  }

  /** Read-only lookup after an uncertain submit. Can upgrade UNKNOWN to REQUESTED; never retries. */
  private async reconcileUnknown(h: JobHandle, fp: Fingerprints, appointmentAt: Date): Promise<void> {
    if (!this.deps.spectora) return;
    try {
      const found = await findSubmittedInspection(this.deps.spectora, fp, appointmentAt);
      if (found) await this.deps.gate.reconcileFound(h, found.id, found.confirmed === true);
    } catch {
      // Stay UNKNOWN; the owner reconciles.
    }
  }

  private async current(jobId: string): Promise<BookingResult> {
    try {
      const j = await this.deps.gate.getJob(jobId);
      if (j) return this.result(jobId, j.state as JobState, j.state_reason, j.spectora_inspection_id);
    } catch { /* fall through */ }
    return this.result(jobId, 'UNKNOWN', 'status_unreadable');
  }

  private result(jobId: string | null, state: JobState, reason: string | null,
                 spectoraInspectionId: string | null = null): BookingResult {
    return { jobId, state, reason, spectoraInspectionId };
  }
}

export type { BookingRequest };
