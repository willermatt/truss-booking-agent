/**
 * Regression tests for the verification pass of the third review: each reproduces one of its probes and
 * checks that it now fails closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { BookingRequestSchema, appointmentInstant } from '../src/booking/schema.js';
import { fingerprints } from '../src/booking/normalize.js';
import { PlaywrightDriver, consentProblem, createBodyProblem } from '../src/booking/playwrightDriver.js';
import type { SchedulerDriver } from '../src/booking/driver.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

const pending = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then(() => 'settled'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

async function rawAdmit(env: TestEnv, c: pg.Client, mode = 'dry_run') {
  const req = BookingRequestSchema.parse(env.request());
  const fp = fingerprints(req);
  return { req, fp, call: () => c.query('SELECT safety.app_admit_job($1, $2, $3, $4, $5, $6, $7, $8) AS r',
    [env.key(mode), mode, JSON.stringify(req), fp.requestHash, JSON.stringify(fp.propertyColumns), fp.customerKeys,
     appointmentInstant(req.appointment.date, req.appointment.time), 'w']) };
}

describe('R4-1: no worker can hold up the owner\'s disable', () => {
  it('no worker function writes the kill switch; a worker holding the global lock does not delay the disable', async () => {
    const env = await TestEnv.create(cluster);
    const { rows } = await env.db.pool('superuser').query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'safety' AND p.proname LIKE 'app\\_%' AND p.prosrc ~* 'kill_switch\\s*\\(|update\\s+safety\\.kill_switch|insert\\s+into\\s+safety\\.kill_switch'`);
    expect(rows).toEqual([]);
    const a = new pg.Client({ connectionString: env.db.url('truss_app') });
    await a.connect();
    await a.query('SET idle_in_transaction_session_timeout = 0; SET statement_timeout = 0; SET lock_timeout = 0');
    // The global lock held in an idle transaction, and in one long statement.
    await a.query('BEGIN');
    await a.query('SELECT safety.app_expire_stale_sessions()');
    expect(await pending(env.owner('owner_disable_submissions', ['owner pressed stop']), 2_000)).toBe('settled');
    await a.query('ROLLBACK');
    const holding = a.query('SELECT safety.app_expire_stale_sessions(), pg_sleep(4)');
    await new Promise((r) => setTimeout(r, 300));
    expect(await pending(env.owner('owner_disable_submissions', ['again']), 2_000)).toBe('settled');
    await holding;
    await a.end();
    expect((await env.status()).submissions_enabled).toBe(false);
  }, 20_000);

  it('a confirmation report turns submissions off until the owner re-enables; the report itself cannot be removed', async () => {
    const env = await TestEnv.create(cluster);
    env.driver.setSubmit({ kind: 'requested', confirmedOnCreate: true });
    expect((await env.runner().run(env.key(), env.request())).state).toBe('REQUESTED');
    const st = await env.status() as Record<string, unknown>;
    expect(st).toMatchObject({ submissions_enabled: false, kill_switch_on: true,
                               stopped_by_confirmation_report: { source: 'create_answer' } });
    await expect(env.db.pool('truss_migrator').query('DELETE FROM safety.confirmation_reports')).rejects.toMatchObject({ code: '42501' });
    // A disable does not clear it, and enable is refused until the owner acknowledges it.
    await env.owner('owner_disable_submissions', ['checking Spectora']);
    expect(await env.owner('owner_enable_submissions', ['SPECTORA-TEST', 'back on'])).toMatchObject({ ok: false, reason: 'confirmation_report_unacknowledged' });
    await env.owner('owner_acknowledge_confirmation_report', ['Require Confirmation checked']);
    expect(await env.owner('owner_enable_submissions', ['SPECTORA-TEST', 'back on'])).toMatchObject({ ok: true });
    expect((await env.status()).submissions_enabled).toBe(true);
    env.driver.setSubmit({ kind: 'requested' });
    await env.advanceMinutes(62);
    expect((await env.runner().run(env.key(), env.request())).state).toBe('REQUESTED');
  });
});

describe('R4-2: the create body cannot identify someone else', () => {
  const req = BookingRequestSchema.parse({
    property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' },
    customer: { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '602-555-0100' },
    appointment: { date: '2026-11-12', time: '08:00' }, services: ['Residential Home Inspection'], squareFeet: 1800, yearBuilt: 1954 });
  const good = { services: [13628], datetime: '2026-11-12 8:00 AM',
    client: { first: 'Pat', last: 'Lee', email: 'pat@example.com', phone: '6025550100', sms: false, sms_marketing: false },
    agent: null, property: { address: '1700 W Washington St', unit: '', zip: '85007', square_feet: '1800', year_built: '1954' } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const variant = (patch: (b: any) => void) => { const b = structuredClone(good) as any; patch(b); return createBodyProblem(JSON.stringify(b), req); };

  it('record ids, other name, phone and area keys, and array values are all refused', () => {
    expect(variant(() => undefined)).toBeNull();
    const refused: [string, (b: any) => void][] = [
      ['client.id', (b) => { b.client.id = 98765; }],
      ['client_id', (b) => { b.client_id = 98765; }],
      ['clientId', (b) => { b.clientId = 'abc-123'; }],
      ['given/family name', (b) => { b.client.given_name = 'Someone'; b.client.family_name = 'Else'; }],
      ['surname', (b) => { b.client.surname = 'Else'; }],
      ['buyer_name', (b) => { b.buyer_name = 'Someone Else'; }],
      ['display_name', (b) => { b.client.display_name = 'Someone Else'; }],
      ['firstName camelCase', (b) => { b.client.firstName = 'Someone'; }],
      ['tel', (b) => { b.client.tel = '4805550000'; }],
      ['mobile_number', (b) => { b.client.mobile_number = '4805550000'; }],
      ['array value', (b) => { b.client.first = ['Someone']; b.client.first_name = 'Pat'; }],
      ['living_area', (b) => { b.property.living_area = '1950'; }],
      ['sq_feet', (b) => { b.property.sq_feet = '1950'; }],
      ['squareFeet camelCase', (b) => { b.property.squareFeet = 1950; }],
      ['built', (b) => { b.property.built = '1999'; }],
      ['agent without a requested agent', (b) => { b.agent = { first_name: 'Alex', last_name: 'Agent' }; }],
      ['agent_id', (b) => { b.agent_id = 4411; }],
    ];
    for (const [label, patch] of refused) expect(variant(patch), label).not.toBeNull();
  });

  it('camelCase and other spellings of an SMS opt-in, with any value but an explicit no, are refused', () => {
    for (const body of [{ client: { textOptIn: true } }, { client: { allowTexts: true } }, { client: { optInText: true } },
                        { client: { text_updates: 'subscribed' } }, { client: { SMSConsent: 'Y' } }, { clientSmsOptIn: 1 }]) {
      expect(consentProblem(JSON.stringify(body), undefined), JSON.stringify(body)).toMatch(/without consent/);
    }
    for (const body of [{ client: { textOptIn: false } }, { client: { sms: 'no' } }, { client: { sms_opt_in: null } }]) {
      expect(consentProblem(JSON.stringify(body), undefined), JSON.stringify(body)).toBeNull();
    }
    expect(variant((b) => { b.client.textOptIn = true; })).toMatch(/without consent/);
  });
});

describe('R4-3: "confirmed on creation" learned through the read-only lookup also turns submissions off', () => {
  it('a create whose answer is lost, found already confirmed: submissions are off', async () => {
    const env = await TestEnv.create(cluster);
    const req = env.request();
    const appt = appointmentInstant((req.appointment as { date: string }).date, '08:00')!;
    const driver: SchedulerDriver = {
      kind: 'mock',
      start: async (job, signal) => {
        const inner = await env.driver.start(job, signal);
        return { ...inner, submit: async () => {
          env.driver.submitCalls++;
          env.spectora.add({ id: 'S-CONF', datetime: appt.toISOString(), address: (req.property as { street: string }).street,
                             zip: '85050', confirmed: true });
          throw new Error('socket hang up after request was sent');
        } };
      },
    };
    const res = await env.runner({ driver }).run(env.key(), req);
    expect(res).toMatchObject({ state: 'CONFIRMED', spectoraInspectionId: 'S-CONF' });
    expect(await env.status()).toMatchObject({ submissions_enabled: false,
                                               stopped_by_confirmation_report: { source: 'lookup_after_unknown' } });
  });
});

describe('R4-4: durability around worker calls', () => {
  it('synchronous_commit off is refused at the call; a later synchronous commit flushes whatever came before', async () => {
    const env = await TestEnv.create(cluster);
    const a = new pg.Client({ connectionString: env.db.url('truss_app') });
    await a.connect();
    const { call } = await rawAdmit(env, a, 'booking');
    await a.query('SET synchronous_commit = off');
    await expect(call()).rejects.toMatchObject({ code: '25000' });
    await a.query('SET synchronous_commit = on');
    // Residual (accepted): SET LOCAL synchronous_commit = off after a call, in the same transaction,
    // commits that one transaction asynchronously. The next worker call (the renewal before the browser
    // starts, the verification before the submit) runs with it on, and its commit flushes the log past it.
    await a.query('BEGIN');
    const r = (await call()).rows[0].r;
    await a.query('SET LOCAL synchronous_commit = off');
    await a.query('COMMIT');
    expect(r.admitted).toBe(true);
    const renewed = (await a.query('SELECT safety.app_renew_session($1, $2) AS r', [r.job_id, r.token])).rows[0].r;
    expect(renewed.ok).toBe(true);
    await a.end();
  });
});

describe('R4-5: the watchdog firing after the create was sent leaves the attempt UNKNOWN', () => {
  it('renewals hang during a sent submit: UNKNOWN, never FAILED or REQUESTED', async () => {
    const env = await TestEnv.create(cluster);
    const { SafetyGate } = await import('../src/safety/gate.js');
    class HangAfterSend extends SafetyGate {
      override renewSession(h: Parameters<InstanceType<typeof SafetyGate>['renewSession']>[0]) {
        return env.driver.submitCalls > 0 ? new Promise<never>(() => undefined) : super.renewSession(h);
      }
    }
    env.driver.setSubmit({ kind: 'hang' });
    const res = await env.runner({ gate: new HangAfterSend(env.db.pool('truss_app')), leaseRenewMs: 50, renewWatchdogMs: 400,
                                   submitDeadlineMs: 30_000 }).run(env.key(), env.request());
    expect(env.driver.submitCalls).toBe(1);
    expect(res.state).toBe('UNKNOWN');
  });
});

describe('MINOR 5: the create timeout is bounded', () => {
  it('a create timeout above 60 s is refused, since the hourly window assumes it', () => {
    expect(() => new PlaywrightDriver({ schedulerUrl: 'http://127.0.0.1:9/x', testMode: true, createTimeoutMs: 120_000 })).toThrow(/at most 60000/);
    expect(() => new PlaywrightDriver({ schedulerUrl: 'http://127.0.0.1:9/x', testMode: true, createTimeoutMs: 30_000 })).not.toThrow();
  });
});

describe('final verification (R5): the remaining gaps', () => {
  async function reserved(env: TestEnv, c: pg.Client) {
    const req = BookingRequestSchema.parse(env.request());
    const fp = fingerprints(req);
    const a = (await c.query('SELECT safety.app_admit_job($1, $2, $3, $4, $5, $6, $7, $8) AS r',
      [env.key('raw'), 'booking', JSON.stringify(req), fp.requestHash, JSON.stringify(fp.propertyColumns), fp.customerKeys,
       appointmentInstant(req.appointment.date, req.appointment.time), 'w'])).rows[0].r;
    await c.query(`SELECT safety.app_record_duplicate_check($1, $2, 'clear', '{}')`, [a.job_id, a.token]);
    const r = (await c.query('SELECT safety.app_reserve_submission($1, $2) AS r', [a.job_id, a.token])).rows[0].r;
    return { token: a.token as string, attempt: r.attempt_id as number };
  }

  it('R5-1: an owner enable cannot slip past a report being written; it is refused until acknowledged', async () => {
    const env = await TestEnv.create(cluster);
    const c = new pg.Client({ connectionString: env.db.url('truss_app') });
    await c.connect();
    const { token, attempt } = await reserved(env, c);
    await c.query('BEGIN');
    await c.query(`SELECT safety.app_complete_attempt($1, $2, 'requested', '{"confirmed_on_create": true}', 'S-1')`, [attempt, token]);
    expect(await pending(env.owner('owner_disable_submissions', ['stop']), 2_000)).toBe('settled');   // disable never waits
    const enable = env.owner<{ ok: boolean; reason?: string }>('owner_enable_submissions', ['SPECTORA-TEST-APPROVAL', 're-enable']);
    expect(await pending(enable, 1_000)).toBe('pending');                                             // enable waits for the report
    await c.query('COMMIT');
    await c.end();
    expect(await enable).toMatchObject({ ok: false, reason: 'confirmation_report_unacknowledged' });
    expect((await env.status()).submissions_enabled).toBe(false);
    await expect(env.db.pool('truss_app').query(`SELECT safety.owner_acknowledge_confirmation_report('x')`)).rejects.toMatchObject({ code: '42501' });
    await env.owner('owner_acknowledge_confirmation_report', ['Require Confirmation is on again']);
    expect(await env.owner('owner_enable_submissions', ['SPECTORA-TEST-APPROVAL', 're-enable'])).toMatchObject({ ok: true });
    expect((await env.status()).submissions_enabled).toBe(true);
  });

  it('R5-2: bodies that name or point to someone else under other names are refused', () => {
    const req = BookingRequestSchema.parse({
      property: { street: '1700 W Washington St', city: 'Phoenix', state: 'AZ', zip: '85007' },
      customer: { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '602-555-0100' },
      appointment: { date: '2026-11-12', time: '08:00' }, services: ['Residential Home Inspection'], squareFeet: 1800, yearBuilt: 1954 });
    const good = { services: [13628], datetime: '2026-11-12 8:00 AM',
      client: { first: 'Pat', last: 'Lee', email: 'pat@example.com', phone: '6025550100', sms: false, sms_marketing: false },
      agent: null, property: { address: '1700 W Washington St', unit: '4', zip: '85007', square_feet: '1800', year_built: '1954', foundation: 'Slab' },
      notes: 'Gate code 1234' };
    const unitReq = BookingRequestSchema.parse({ ...req, property: { ...req.property, unit: '4' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const variant = (patch: (b: any) => void) => { const b = structuredClone(good) as any; patch(b); return createBodyProblem(JSON.stringify(b), unitReq); };
    expect(variant(() => undefined)).toBeNull();                              // the faithful body still passes
    const refused: [string, (b: any) => void][] = [
      ['people[]', (b) => { b.people = [{ first: 'Someone', last: 'Else', email: 'else@example.com' }]; }],
      ['participants[].id', (b) => { b.participants = [{ id: 98765 }]; }],
      ['fname/lname', (b) => { b.client.fname = 'Someone'; b.client.lname = 'Else'; }],
      ['email2', (b) => { b.client.email2 = 'else@example.com'; }],
      ['phone_2', (b) => { b.client.phone_2 = '4805550000'; }],
      ['client_ids', (b) => { b.client_ids = [98765]; }],
      ['buyer_contact', (b) => { b.buyer_contact = 98765; }],
      ['inspection.client', (b) => { b.inspection = { client: 98765 }; }],
    ];
    for (const [label, patch] of refused) expect(variant(patch), label).not.toBeNull();
  });

  it('R5-3: consent carried in a value is seen', () => {
    for (const body of [{ client: { contact_methods: ['email', 'sms'] } }, { client: { preferred_channel: 'text' } },
                        { client: { notifications: { mobile: true } } }, { client: { channel: 'Text message' } }]) {
      expect(consentProblem(JSON.stringify(body), undefined), JSON.stringify(body)).toMatch(/without consent/);
    }
    expect(consentProblem(JSON.stringify({ client: { contact_methods: ['email'] } }), undefined)).toBeNull();
    expect(consentProblem(JSON.stringify({ client: { notifications: { mobile: false } } }), undefined)).toBeNull();
  });
});
