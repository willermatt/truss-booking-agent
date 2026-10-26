/**
 * Per-test environment: a fresh migrated database, a frozen safety clock, a fake Spectora read API,
 * a mock scheduler driver, and a runner wired the way production wires them (worker connects as truss_app).
 */
import { BookingRunner, type RunnerDeps } from '../../src/booking/runner.js';
import { MockDriver } from '../../src/booking/mockDriver.js';
import { SafetyGate, type JobHandle, type JobMode } from '../../src/safety/gate.js';
import { SpectoraReadApi } from '../../src/spectora/readApi.js';
import { BookingRequestSchema, appointmentInstant } from '../../src/booking/schema.js';
import { fingerprints } from '../../src/booking/normalize.js';
import { FakeSpectora } from './fakeSpectora.js';
import type { PgCluster, TestDb } from './pgCluster.js';

/** Monday 2 Nov 2026, 08:00 Arizona time. */
export const T0 = '2026-11-02T08:00:00-07:00';

export class TestEnv {
  db!: TestDb;
  gate!: SafetyGate;
  driver = new MockDriver();
  spectora = new FakeSpectora();
  api = new SpectoraReadApi({ apiKey: 'test-key', fetch: this.spectora.fetch, sleep: async () => undefined });
  now = new Date(T0);
  private seq = 0;

  static async create(cluster: PgCluster, opts: { enable?: boolean; at?: string } = {}): Promise<TestEnv> {
    const env = new TestEnv();
    env.db = await cluster.freshDb();
    env.gate = new SafetyGate(env.db.pool('truss_app'));
    env.now = new Date(opts.at ?? T0);
    await env.db.freezeClock(env.now);
    if (opts.enable !== false) await env.owner('owner_enable_submissions', ['SPECTORA-TEST-APPROVAL', 'test setup']);
    return env;
  }

  /** Back-compat name used throughout the tests: the mock scheduler driver. */
  get submitter() { return this.driver; }

  runner(overrides: Partial<RunnerDeps> = {}): BookingRunner {
    return new BookingRunner({ gate: this.gate, driver: this.driver, spectora: this.api,
                               workerId: 'test-worker', now: () => this.now, ...overrides });
  }

  async setTime(at: Date | string) {
    this.now = new Date(at);
    await this.db.setClock(this.now);
  }

  async advanceMinutes(min: number) {
    await this.setTime(new Date(this.now.getTime() + min * 60_000));
  }

  /** A valid request with a property and customer unique to `n` (no accidental duplicates). */
  request(overrides: Record<string, unknown> = {}, n = ++this.seq) {
    const appt = new Date(this.now.getTime() + 10 * 86_400_000 - 7 * 3_600_000); // Arizona date, 10 days out
    return {
      property: { street: `${1000 + n} E Testing Ln`, city: 'Phoenix', state: 'AZ', zip: '85050' },
      customer: { firstName: `Client${n}`, lastName: 'Tester', email: `client${n}@example.com`,
                  phone: `602555${String(n).padStart(4, '0')}` },
      appointment: { date: appt.toISOString().slice(0, 10), time: '08:00' },
      services: ['Residential Home Inspection'],
      squareFeet: 1800,
      yearBuilt: 1954,
      ...overrides,
    };
  }

  key(label = 'job') { return `${label}-${++this.seq}-${Math.random().toString(36).slice(2, 10)}`; }

  async owner<T = Record<string, unknown>>(fn: string, params: unknown[] = []): Promise<T> {
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.db.pool('truss_owner').query(`SELECT safety.${fn}(${placeholders}) AS r`, params);
    return rows[0].r as T;
  }

  status() {
    return this.owner<{ jobs_today: number; attempts_today: number; attempts_last_hour: number; breaker_open: boolean;
      consecutive_errors: number; submissions_enabled: boolean; unreconciled_unknown: number;
      in_flight_attempt_id: number | null; active_session: { job_id: string } | null; control_row_present: boolean }>('owner_status');
  }

  async attemptCount(): Promise<number> {
    const { rows } = await this.db.pool('truss_owner').query('SELECT count(*)::int AS n FROM safety.owner_attempts');
    return rows[0].n;
  }

  async jobCount(): Promise<number> {
    const { rows } = await this.db.pool('truss_owner').query('SELECT count(*)::int AS n FROM safety.owner_jobs');
    return rows[0].n;
  }

  /** Admits a job straight through the gate (opens the browser session). Throws if refused. */
  async admit(n?: number, mode: JobMode = 'booking', gate = this.gate): Promise<JobHandle> {
    const req = BookingRequestSchema.parse(this.request({}, n));
    const fp = fingerprints(req);
    const r = await gate.admit({ idempotencyKey: this.key('admit'), mode, request: req, requestHash: fp.requestHash,
      property: fp.propertyColumns, customerKeys: fp.customerKeys,
      appointmentAt: appointmentInstant(req.appointment.date, req.appointment.time)!, workerId: 'test' });
    if (!r.admitted) throw new Error(`admission refused: ${JSON.stringify(r)}`);
    return r.handle;
  }

  /** Admitted, with a clear duplicate check: ready to reserve. */
  async ready(n?: number, gate = this.gate): Promise<JobHandle> {
    const h = await this.admit(n, 'booking', gate);
    await gate.recordDuplicateCheck(h, 'clear', {});
    return h;
  }
}
