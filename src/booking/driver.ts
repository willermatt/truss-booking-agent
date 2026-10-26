/**
 * The browser side of a booking. One SchedulerSession = one browser = one job's database session.
 *
 *   start()    launches the browser. Nothing is loaded yet. Called only after the database admitted the
 *              job (which is when the job is counted and the single browser session is taken).
 *   prepare()  Steps 1–3 and reading the Review summary. Never clicks the final submit. In dry-run mode
 *              the "Schedule In Progress" notification sent when leaving Step 3 is answered in the browser
 *              and never reaches Spectora (no text to Truss); the Review is read the same way.
 *   submit()   The single final-submit action. Requires a genuine Reservation, and must not let the
 *              request leave after the send-by deadline.
 *   close()    Kills the browser. Must resolve only once the browser process is gone.
 *
 * Contract for every implementation:
 *   - submit() checks Reservation.isGenuine() and that it belongs to this job, and refuses otherwise;
 *   - submit() either returns a definite result or throws; throwing means "outcome unknown";
 *   - when the AbortSignal fires, all browser activity stops at once (close the browser);
 *   - nothing is retried inside the driver.
 */
import type { BookingRequest } from './schema.js';
import type { ResolvedServices } from './services.js';
import type { JobMode, Reservation } from '../safety/gate.js';

export interface PreparedJob {
  jobId: string;
  mode: JobMode;
  request: BookingRequest;
  services: ResolvedServices;
  appointmentAt: Date;
  /**
   * Renews this job's browser session now and throws if the database refuses (session ended, lease
   * lapsed, 10-minute cap). Drivers call it before each step, so a worker that was frozen and lost its
   * session does at most one more page action.
   */
  checkpoint?: () => Promise<void>;
}

export interface ReviewSummary {
  /** Service and add-on rows as shown on the Review step. */
  lines: { name: string; amountUsd: number | null }[];
  addressText: string;
  dateText: string;
  timeText: string;
  /** The amount labelled "Total", as Spectora shows it (recorded, never checked: Spectora sets the price). */
  totalUsd: number | null;
  /** Square feet and year built as entered on Step 1: the request's, or Spectora's lookup values ('' if none). */
  propertyFacts?: { squareFeet: string; yearBuilt: string };
}

export type PrepareResult =
  | { ok: true; summary: ReviewSummary | null }
  | { ok: false; kind: 'needs_input' | 'unavailable'; detail: string }
  | { ok: false; kind: 'execution_error'; stage: string; detail: string };

export type SubmitResult =
  /** Spectora's response contained the created inspection (an unconfirmed request). */
  | { kind: 'requested'; inspectionId: string;
      /** Spectora's answer already showed it confirmed: its "Require Confirmation" setting looks off. */
      confirmedOnCreate?: boolean }
  /** Spectora explicitly reported the slot was taken; nothing was created. */
  | { kind: 'unavailable'; detail: string }
  /** Spectora explicitly refused the request, or no request was sent; nothing was created. */
  | { kind: 'rejected'; detail: string };

/**
 * The request must reach Spectora before these instants: the database sets the budget when it verifies
 * the reservation (20 s from the moment the attempt was counted). Both clocks are checked: the wall clock
 * jumps with suspends and adjustments, the monotonic one does not.
 */
export interface SendBy { wallMs: number; monoMs: number }

export interface SchedulerSession {
  prepare(signal: AbortSignal): Promise<PrepareResult>;
  submit(reservation: Reservation, signal: AbortSignal, sendBy: SendBy): Promise<SubmitResult>;
  close(): Promise<void>;
}

export interface SchedulerDriver {
  readonly kind: 'mock' | 'playwright';
  start(job: PreparedJob, signal: AbortSignal): Promise<SchedulerSession>;
}

/** Starting failed and the browser it had launched could not be confirmed closed. */
export class BrowserNotClosedError extends Error {
  constructor(detail: string) {
    super(`The browser could not be confirmed closed: ${detail}`);
    this.name = 'BrowserNotClosedError';
  }
}

export class LiveSubmissionDisabledError extends Error {
  constructor(detail: string) {
    super(`Live Spectora submission is disabled: ${detail}`);
    this.name = 'LiveSubmissionDisabledError';
  }
}
