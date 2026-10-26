/**
 * Mock scheduler driver for tests. Never touches Spectora. Behaviors are scripted per call so tests can
 * prove exactly how many browsers were opened and how many times the final submit ran.
 */
import type { PreparedJob, PrepareResult, ReviewSummary, SchedulerDriver, SchedulerSession, SubmitResult } from './driver.js';
import { Reservation } from '../safety/gate.js';
import { slotLabel } from './schema.js';

export type MockSubmitBehavior =
  | { kind: 'requested'; inspectionId?: string; confirmedOnCreate?: boolean }
  | { kind: 'unavailable' }
  | { kind: 'rejected' }
  | { kind: 'network_error'; message?: string }
  | { kind: 'timeout' }
  /** Never answers; only the abort signal (or close) ends it. */
  | { kind: 'hang' };

export type MockPrepareBehavior =
  | { kind: 'ok' }
  | { kind: 'execution_error'; stage?: string }
  | { kind: 'throws'; message?: string }
  | { kind: 'unavailable' }
  | { kind: 'needs_input' }
  | { kind: 'hang' };

type Pick<B> = B | ((n: number) => B);
const pick = <B>(b: Pick<B>, n: number) => (typeof b === 'function' ? (b as (n: number) => B)(n) : b);

/** The Review summary a faithful scheduler would show for this job (optionally with another total). */
export function faithfulSummary(job: PreparedJob, totalUsd?: number): ReviewSummary {
  const r = job.request;
  const lines = [{ name: job.services.service.label.trim(), amountUsd: job.services.service.basePriceUsd },
                 ...job.services.addOns.map((a) => ({ name: a.label, amountUsd: a.priceUsd }))];
  return {
    lines,
    addressText: `${r.property.street}${r.property.unit ? ` ${r.property.unit}` : ''}, ${r.property.city}, ${r.property.state} ${r.property.zip}`,
    dateText: r.appointment.date,
    timeText: slotLabel(r.appointment.time),
    totalUsd: totalUsd ?? lines.reduce((t, l) => t + l.amountUsd, 0),
    propertyFacts: { squareFeet: r.squareFeet === undefined ? '2762' : String(r.squareFeet),
                     yearBuilt: r.yearBuilt === undefined ? '1954' : String(r.yearBuilt) },
  };
}

export class MockDriver implements SchedulerDriver {
  readonly kind = 'mock' as const;
  startCalls = 0;
  prepareCalls = 0;
  submitCalls = 0;
  closeCalls = 0;
  aborted = 0;
  openBrowsers = 0;
  maxOpenBrowsers = 0;
  readonly submittedJobIds: string[] = [];
  /** The send-by deadline each submit() was given, and when it was called. */
  readonly sendBys: ({ wallMs: number; monoMs: number; receivedWallMs: number } | null)[] = [];
  private seq = 0;
  summaryFor: (job: PreparedJob) => ReviewSummary = (job) => faithfulSummary(job);

  constructor(
    private submitBehavior: Pick<MockSubmitBehavior> = { kind: 'requested' },
    private prepareBehavior: Pick<MockPrepareBehavior> = { kind: 'ok' },
  ) {}

  setSubmit(b: Pick<MockSubmitBehavior>) { this.submitBehavior = b; }
  setPrepare(b: Pick<MockPrepareBehavior>) { this.prepareBehavior = b; }

  async start(job: PreparedJob, _signal: AbortSignal): Promise<SchedulerSession> {
    this.startCalls++;
    this.openBrowsers++;
    this.maxOpenBrowsers = Math.max(this.maxOpenBrowsers, this.openBrowsers);
    let closed = false;
    const waitForAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
      const stop = () => { this.aborted++; reject(new Error('browser stopped')); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });

    return {
      prepare: async (signal): Promise<PrepareResult> => {
        await job.checkpoint?.();
        this.prepareCalls++;
        const b = pick(this.prepareBehavior, this.prepareCalls);
        switch (b.kind) {
          case 'ok': return { ok: true, summary: this.summaryFor(job) };
          case 'execution_error': return { ok: false, kind: 'execution_error', stage: b.stage ?? 'step1', detail: 'mock page error' };
          case 'throws': throw new Error(b.message ?? 'mock browser crashed');
          case 'unavailable': return { ok: false, kind: 'unavailable', detail: 'requested slot not offered' };
          case 'needs_input': return { ok: false, kind: 'needs_input', detail: 'scheduler rejected an input' };
          case 'hang': return waitForAbort(signal);
        }
      },
      submit: async (reservation, signal, sendBy): Promise<SubmitResult> => {
        if (!Reservation.isGenuine(reservation)) throw new Error('submit requires a database reservation');
        this.sendBys.push(sendBy ? { ...sendBy, receivedWallMs: Date.now() } : null);
        if (!sendBy || Date.now() > sendBy.wallMs || performance.now() > sendBy.monoMs) {
          return { kind: 'rejected', detail: 'not submitted: the send-by deadline passed' };
        }
        if (reservation.jobId !== job.jobId) throw new Error('reservation does not belong to this job');
        if (job.mode !== 'booking') throw new Error('dry runs cannot submit');
        if (closed) throw new Error('browser is closed');
        this.submitCalls++;
        this.submittedJobIds.push(job.jobId);
        const b = pick(this.submitBehavior, this.submitCalls);
        switch (b.kind) {
          case 'requested': return { kind: 'requested', inspectionId: b.inspectionId ?? `MOCK-${++this.seq}`,
                                     ...(b.confirmedOnCreate ? { confirmedOnCreate: true } : {}) };
          case 'unavailable': return { kind: 'unavailable', detail: 'slot no longer available' };
          case 'rejected': return { kind: 'rejected', detail: 'validation error' };
          case 'network_error': throw new Error(b.message ?? 'socket hang up after request was sent');
          case 'timeout': throw new Error('Timed out waiting for Spectora response');
          case 'hang': return waitForAbort(signal);
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.closeCalls++;
        this.openBrowsers--;
      },
    };
  }
}
