/**
 * The Playwright driver, end to end through the safety layer, against a local stand-in for Spectora's
 * scheduler (test/helpers/fixtureScheduler.ts). Real Chromium, real PostgreSQL, mocked submissions:
 * nothing here can reach Spectora.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PgCluster } from './helpers/pgCluster.js';
import { TestEnv } from './helpers/env.js';
import { FixtureScheduler, type Scenario } from './helpers/fixtureScheduler.js';
import { PlaywrightDriver, createSchedulerDriver } from '../src/booking/playwrightDriver.js';
import { LiveSubmissionDisabledError } from '../src/booking/driver.js';
import { OFFICIAL_SCHEDULER_URL } from '../src/booking/spectoraScheduler.js';
import type { RunnerDeps } from '../src/booking/runner.js';

let cluster: PgCluster;
beforeAll(async () => { cluster = await PgCluster.create(); });
afterAll(async () => { await cluster?.destroy(); });

const fixtures: FixtureScheduler[] = [];
afterEach(async () => { while (fixtures.length) await fixtures.pop()!.stop(); });


async function setup(scenario: Partial<Scenario> = {}, driverOpts: Partial<ConstructorParameters<typeof PlaywrightDriver>[0]> = {},
                     runnerOpts: Partial<RunnerDeps> = {}) {
  const env = await TestEnv.create(cluster);
  const fx = await FixtureScheduler.start(scenario);
  fixtures.push(fx);
  const driver = new PlaywrightDriver({ schedulerUrl: fx.url, testMode: true, waitMs: 8_000, submitQuietMs: 3_000, ...driverOpts });
  const runner = env.runner({ driver, prepareDeadlineMs: 60_000, submitDeadlineMs: 20_000, closeGraceMs: 10_000,
                              ...runnerOpts });
  return { env, fx, runner };
}

const CREATE = /^\/inspections\.json$/;
const IN_PROGRESS = /^\/schedule_in_progress$/;

describe('dry run (the mode used against the live scheduler before launch)', () => {
  it('goes as far as the Review and reads it: the Step 3 text is never sent, nothing is submitted, no attempt', async () => {
    const { env, fx, runner } = await setup({ precheckSms: true });
    const req = env.request({ addOns: ['termite', 'pool'], property: { street: '1700 W Washington St', unit: '4B', city: 'Phoenix', state: 'AZ', zip: '85007' },
                              agent: { firstName: 'Alex', lastName: 'Agent', email: 'alex@realty.example' }, foundation: 'slab' });
    const res = await runner.dryRun(env.key(), req);
    expect(res).toMatchObject({ state: 'DRY_RUN', reason: 'dry_run_complete_stopped_before_schedule' });
    expect(res.spectoraShown).toMatchObject({ totalUsd: 300 + 75 + 50 + 0 + 50, squareFeet: '1800', yearBuilt: '1954' });
    expect(fx.count('GET', /^\/fixture\/step\/4$/)).toBe(1);   // reached the Review...
    expect(fx.count('POST', IN_PROGRESS)).toBe(0);                // ...without the "Schedule In Progress" text
    expect(fx.count('POST', CREATE)).toBe(0);
    expect(fx.count('GET', /^\/can_schedule\//)).toBe(0);
    expect(await env.status()).toMatchObject({ jobs_today: 1, attempts_today: 0, active_session: null });
  });

  it('square feet and year built left out: Spectora\'s lookup values are used and reported, never invented', async () => {
    const { env, fx, runner } = await setup();
    const { squareFeet: _s, yearBuilt: _y, ...req } = env.request();
    const res = await runner.dryRun(env.key(), req);
    expect(res).toMatchObject({ state: 'DRY_RUN', spectoraShown: { squareFeet: '2762', yearBuilt: '1954' } });
    const booked = await runner.run(env.key(), (({ squareFeet: _a, yearBuilt: _b, ...r }) => r)(env.request()));
    expect(booked.state).toBe('REQUESTED');
    const body = JSON.parse(fx.requests.find((r) => r.method === 'POST' && CREATE.test(r.path))!.body);
    expect(body.property).toMatchObject({ square_feet: '2762', year_built: '1954' });
  });

  it('left out and Spectora\'s lookup has none: Spectora refuses Step 1 and the job says what to send', async () => {
    const suggestions = (q: string) => { const s = q.split(',')[0]; return [{ text: `${s}, Phoenix, AZ, USA`, fill: { street: s, city: 'Phoenix', state: 'AZ', zip: '85050' } }]; };
    const { env, fx, runner } = await setup({ suggestions });
    const { squareFeet: _s, yearBuilt: _y, ...req } = env.request();
    const res = await runner.dryRun(env.key(), req);
    expect(res.state).toBe('NEEDS_INPUT');
    expect(res.issues?.[0]).toMatch(/left the square footage and year built empty; send square footage and year built/);
    expect(fx.count('POST', CREATE)).toBe(0);
  });

  it('works with the kill switch off, and still cannot submit', async () => {
    const env = await TestEnv.create(cluster, { enable: false });
    const fx = await FixtureScheduler.start();
    fixtures.push(fx);
    const runner = env.runner({ driver: new PlaywrightDriver({ schedulerUrl: fx.url, testMode: true, waitMs: 4_000 }) });
    expect((await runner.dryRun(env.key(), env.request())).state).toBe('DRY_RUN');
    expect((await runner.run(env.key(), env.request())).reason).toBe('submissions_disabled');
    expect(fx.count('POST', CREATE)).toBe(0);
  });
});

describe('booking against the stand-in scheduler (mocked submission)', () => {
  it('books once: REQUESTED with the id from the response; fields and consents exactly as requested', async () => {
    const { env, fx, runner } = await setup({ precheckSms: true });
    const req = env.request({ smsConsent: { transactional: true, marketing: false, evidence: 'Customer said yes to booking texts on the call, 10:40' },
                              agent: { firstName: 'Alex', lastName: 'Agent', phone: '480-555-0101' }, notes: 'Lockbox 1234' });
    const res = await runner.run(env.key(), req);
    expect(res).toMatchObject({ state: 'REQUESTED', spectoraInspectionId: 'FX-1' });
    expect(fx.created).toHaveLength(1);
    expect(fx.created[0].body).toMatchObject({
      client: { first: req.customer.firstName, email: req.customer.email, sms: true, sms_marketing: false },
      agent: { first: 'Alex', sms: false, sms_marketing: false },
      property: { address: req.property.street, zip: '85050', square_feet: '1800', year_built: '1954' }, // lookup values (2,762) overwritten
      notes: 'Lockbox 1234',
    });
    expect(fx.count('POST', IN_PROGRESS)).toBe(1);
    expect(await env.status()).toMatchObject({ attempts_today: 1, consecutive_errors: 0, active_session: null });
  });

  it('several add-ons are all selected and checked on the Review', async () => {
    const { env, fx, runner } = await setup();
    const res = await runner.run(env.key(), env.request({ addOns: ['termite', 'pool', 'mold', 'recallchek'] }));
    expect(res.state).toBe('REQUESTED');
    expect((fx.created[0].body as { add_ons: number[] }).add_ons.sort((a, b) => a - b)).toEqual([7451, 7452, 10441, 17336]);
  });

  it('no SMS box is ticked without recorded consent, even when the page pre-ticks them', async () => {
    const { env, fx, runner } = await setup({ precheckSms: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    expect(fx.created[0].body).toMatchObject({ client: { sms: false, sms_marketing: false } });
    expect(JSON.stringify(fx.created[0].body)).not.toMatch(/"sms(_marketing)?":true/);
  });

  it('a consent pop-up is declined (its accept would opt everyone in)', async () => {
    const { env, fx, runner } = await setup({ consentPrompt: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    expect(fx.created[0].body).toMatchObject({ client: { sms: false } });
  });

  it('second review: a box the page ticks on "continue anyway" stops the job; no create is sent', async () => {
    const { env, fx, runner } = await setup({ consentPrompt: true, consentContinueTicks: true });
    const res = await runner.run(env.key(), env.request());   // no consent recorded
    expect(res.state).not.toBe('REQUESTED');
    expect(res.state).not.toBe('UNKNOWN');
    expect(fx.count('POST', CREATE)).toBe(0);
    expect(fx.created).toHaveLength(0);
  });
});

describe('the Review: the price is Spectora\'s; anything else wrong stops before submitting', () => {
  it('Spectora\'s price is accepted as shown (a mileage fee included) and recorded with the job', async () => {
    const { env, fx, runner } = await setup();
    const res = await runner.run(env.key(), env.request({ property: { street: '510 E Florence Blvd', city: 'Casa Grande', state: 'AZ', zip: '85122' } }));
    expect(res).toMatchObject({ state: 'REQUESTED', spectoraShown: { totalUsd: 300 + 75 + 50 + 50 } });
    expect(fx.count('POST', CREATE)).toBe(1);
    const job = await env.gate.getJob(res.jobId!);
    expect(job?.spectora_shown).toMatchObject({ totalUsd: 475, squareFeet: '1800', yearBuilt: '1954' });
  });

  it('a price that cannot be read does not stop the booking: it is recorded as not read', async () => {
    const { env, fx, runner } = await setup({ noTotal: true });
    const res = await runner.run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'REQUESTED', spectoraShown: { totalUsd: null } });
    expect(fx.count('POST', CREATE)).toBe(1);
  });

  it('requested time not offered: UNAVAILABLE before Step 3, no substitute time', async () => {
    const { env, fx, runner } = await setup({ slots: () => ['11:30 AM'] });
    const res = await runner.run(env.key(), env.request());
    expect(res.state).toBe('UNAVAILABLE');
    expect(res.issues?.[0]).toMatch(/8:00 AM .* not offered \(offered: 11:30 am\)/);
    expect(fx.count('POST', IN_PROGRESS)).toBe(0);
    expect(await env.attemptCount()).toBe(0);
  });

  it('Spectora suggests no matching address, or several: NEEDS_INPUT, manual booking', async () => {
    for (const suggestions of [
      () => [],
      (q: string) => [{ text: '1700 W Washington St, Phoenixville, PA, USA', fill: { street: '1700 W Washington St', city: 'Phoenixville', state: 'PA', zip: '19460' } }].filter(() => !!q),
      (q: string) => { const s = q.split(',')[0]; return [s, s].map((x) => ({ text: `${x}, Phoenix, AZ, USA`, fill: { street: x, city: 'Phoenix', state: 'AZ', zip: '85050' } })); },
      (q: string) => { const s = q.split(',')[0].replace(' E ', ' W '); return [{ text: `${s}, Phoenix, AZ, USA`, fill: { street: s, city: 'Phoenix', state: 'AZ', zip: '85050' } }]; },
    ]) {
      const { env, fx, runner } = await setup({ suggestions });
      const res = await runner.run(env.key(), env.request());
      expect(res.state).toBe('NEEDS_INPUT');
      expect(res.issues?.[0]).toMatch(/book manually/);
      expect(fx.count('POST', CREATE)).toBe(0);
    }
  });

  it('the suggestion fills a different ZIP or unit than requested: NEEDS_INPUT', async () => {
    const wrongZip = (q: string) => { const s = q.split(',')[0]; return [{ text: `${s}, Phoenix, AZ, USA`, fill: { street: s, city: 'Phoenix', state: 'AZ', zip: '85051' } }]; };
    const withUnit = (q: string) => { const s = q.split(',')[0]; return [{ text: `${s}, Phoenix, AZ, USA`, fill: { street: s, unit: '7', city: 'Phoenix', state: 'AZ', zip: '85050' } }]; };
    for (const suggestions of [wrongZip, withUnit]) {
      const { env, runner } = await setup({ suggestions });
      const res = await runner.run(env.key(), env.request());
      expect(res.state).toBe('NEEDS_INPUT');
      expect(res.issues?.[0]).toMatch(/not the requested property|has none/);
    }
  });

  it('the scheduler rejects Step 1: NEEDS_INPUT with its message', async () => {
    const { env, runner } = await setup({ step1Toast: 'Please enter the square footage' });
    const res = await runner.run(env.key(), env.request());
    expect(res.state).toBe('NEEDS_INPUT');
    expect(res.issues?.[0]).toMatch(/Please enter the square footage/);
  });
});

describe('page structure changes, timeouts and network failures', () => {
  it('a renamed element is an execution error: FAILED, counted toward the breaker, nothing submitted', async () => {
    const { env, fx, runner } = await setup({ renameServiceCheckboxes: true });
    const res = await runner.run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'FAILED', reason: 'execution_error:step1_services' });
    expect(fx.count('POST', CREATE)).toBe(0);
    expect(await env.status()).toMatchObject({ consecutive_errors: 1, active_session: null });
  });

  it('a page that never loads hits its timeout; the browser is closed and the slot released', async () => {
    const { env, runner } = await setup({ hangOnLoad: true }, { waitMs: 1_500 });
    const res = await runner.run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'FAILED', reason: 'execution_error:step1_load' });
    expect(await env.status()).toMatchObject({ active_session: null, attempts_today: 0 });
  });

  it('the runner deadline stops a slow prepare even if the driver would keep waiting', async () => {
    const { env, fx } = await setup({ hangOnLoad: true }, { waitMs: 60_000 });
    const runner = env.runner({ driver: new PlaywrightDriver({ schedulerUrl: fx.url, testMode: true, waitMs: 60_000 }), prepareDeadlineMs: 1_500 });
    const res = await runner.run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'FAILED', reason: 'execution_error:prepare_aborted' });
    expect((await env.status()).active_session).toBeNull();
  });

  it('slot taken at submit: UNAVAILABLE; the attempt counts; nothing created', async () => {
    const { env, fx, runner } = await setup({ slotTakenAtSubmit: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('UNAVAILABLE');
    expect(fx.created).toHaveLength(0);
    expect(await env.status()).toMatchObject({ attempts_today: 1, consecutive_errors: 0 });
  });

  it('Spectora refuses the request (HTTP 422): FAILED, definite, nothing to reconcile', async () => {
    const { env, fx, runner } = await setup({ create: 'reject_422' });
    expect((await runner.run(env.key(), env.request())).state).toBe('FAILED');
    expect(fx.created).toHaveLength(0);
    expect(await env.status()).toMatchObject({ unreconciled_unknown: 0, consecutive_errors: 1 });
  });

  it('the overlap check fails before sending: FAILED, definite; create never sent', async () => {
    const { env, fx, runner } = await setup({ canScheduleFails: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('FAILED');
    expect(fx.count('POST', CREATE)).toBe(0);
  });

  for (const create of ['error_500_after_create', 'drop_after_create', 'ok_without_id'] as const) {
    it(`create sent but the answer is unusable (${create}): UNKNOWN, never retried`, async () => {
      const { env, fx, runner } = await setup({ create });
      const res = await runner.run(env.key(), env.request());
      expect(res.state).toBe('UNKNOWN');
      expect(fx.count('POST', CREATE)).toBe(1);
      expect(await env.status()).toMatchObject({ unreconciled_unknown: 1, consecutive_errors: 1 });
    });
  }

  it('create sent and Spectora never answers: the submit deadline makes it UNKNOWN', async () => {
    const { env, fx } = await setup({ create: 'hang_after_create' });
    const runner = env.runner({ driver: new PlaywrightDriver({ schedulerUrl: fx.url, testMode: true, waitMs: 4_000 }), submitDeadlineMs: 2_000 });
    expect((await runner.run(env.key(), env.request())).state).toBe('UNKNOWN');
    expect(fx.count('POST', CREATE)).toBe(1);
  });

  it('a Schedule button that does nothing: no request was sent, so FAILED, definite', async () => {
    const { env, fx, runner } = await setup({ deadScheduleButton: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('FAILED');
    expect(fx.count('POST', CREATE)).toBe(0);
    expect((await env.status()).unreconciled_unknown).toBe(0);
  });
});

describe('the network guard', () => {
  it('a create request outside submit() never leaves the browser', async () => {
    const { env, fx, runner } = await setup({ rogueCreateOnLoad: true });
    expect((await runner.dryRun(env.key(), env.request())).state).toBe('DRY_RUN');
    expect(fx.count('POST', CREATE)).toBe(0);
  });

  it('a page that fires the create twice gets exactly one through', async () => {
    const { env, fx, runner } = await setup({ doubleCreate: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    expect(fx.count('POST', CREATE)).toBe(1);
  });
});

describe('guard and page-behaviour edge cases', () => {
  it('a beacon carrying a create request is blocked like any other', async () => {
    const { env, fx, runner } = await setup({ rogueBeacon: true });
    expect((await runner.dryRun(env.key(), env.request())).state).toBe('DRY_RUN');
    expect(fx.count('POST', CREATE)).toBe(0);
  });

  it('a confirm() asking for consent is declined, never accepted', async () => {
    const { env, fx, runner } = await setup({ confirmMarketing: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    expect(fx.created[0].body).toMatchObject({ client: { sms_marketing: false } });
    expect(fx.count('GET', /^\/fixture\/confirmed$/)).toBe(0);
  });

  it('address suggestions are read only after they settle', async () => {
    const { env, runner } = await setup({ suggestionsChangeLate: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
  });

  it('a suggestion in a city whose name merely contains the requested city is not accepted', async () => {
    const suggestions = (q: string) => { const st = q.split(',')[0]; return [{ text: `${st}, Phoenixville, AZ, USA`, fill: { street: st, city: 'Phoenixville', state: 'AZ', zip: '85050' } }]; };
    const { env, fx, runner } = await setup({ suggestions });
    const res = await runner.run(env.key(), env.request());
    expect(res.state).toBe('NEEDS_INPUT');
    expect(res.issues?.[0]).toMatch(/no Spectora address suggestion matches/);
    expect(fx.count('POST', CREATE)).toBe(0);
  });
});

describe('second review: requests the guard did not see, and page tricks', () => {
  const unguarded = (fx: FixtureScheduler) => fx.requests.filter((r) => r.method === 'POST' && CREATE.test(r.path)).length;

  it('dry run: a create fired from a SharedWorker on load never reaches the scheduler', async () => {
    const { env, fx, runner } = await setup({ rogueSharedWorker: true });
    await runner.dryRun(env.key(), env.request());
    expect(unguarded(fx)).toBe(0);
    expect(fx.created).toHaveLength(0);
  });

  it('booking: a Schedule button that hands the create to a SharedWorker sends nothing; the job is not REQUESTED', async () => {
    const { env, fx, runner } = await setup({ sharedWorkerCreate: true });
    const res = await runner.run(env.key(), env.request());
    expect(unguarded(fx)).toBe(0);
    expect(fx.created).toHaveLength(0);
    expect(res.state).toBe('FAILED');                       // definitely not sent: nothing could leave
  });

  it('a 307 answer to the create is not followed: one create reaches Spectora, and the outcome is UNKNOWN', async () => {
    const { env, fx, runner } = await setup({ create: 'redirect_307' });
    const res = await runner.run(env.key(), env.request());
    expect(fx.count('POST', CREATE)).toBe(1);
    expect(fx.created).toHaveLength(1);
    expect(res.state).toBe('UNKNOWN');
    expect((await env.status()).unreconciled_unknown).toBe(1);
  });

  it('a page busy right before the click cannot delay the create past the send-by deadline (real clock)', async () => {
    const env = await TestEnv.create(cluster);
    await env.db.pool('superuser').query('DELETE FROM safety_test.frozen');   // the real database clock
    const fx = await FixtureScheduler.start({ busyAfterReview: [0, 30_000] });
    fixtures.push(fx);
    const driver = new PlaywrightDriver({ schedulerUrl: fx.url, testMode: true, waitMs: 8_000 });
    const runner = env.runner({ driver, prepareDeadlineMs: 60_000, closeGraceMs: 10_000 });   // default submit deadline
    const res = await runner.run(env.key(), env.request());
    expect(fx.count('POST', CREATE)).toBe(0);
    expect(fx.created).toHaveLength(0);
    expect(res.state).not.toBe('REQUESTED');
    expect((await env.status()).unreconciled_unknown).toBe(0);
  }, 120_000);

  it('a create the page sends only after the window has closed is blocked: FAILED, definite, nothing created', async () => {
    const { env, fx, runner } = await setup({ delayCreateMs: 5_000 });   // the window here is 3 s
    const res = await runner.run(env.key(), env.request());
    expect(fx.created).toHaveLength(0);
    expect(fx.count('POST', CREATE)).toBe(0);
    expect(res.state).toBe('FAILED');
    expect((await env.status())).toMatchObject({ unreconciled_unknown: 0, attempts_today: 1 });
  });

  it('slots that re-render under the pointer never book a different time', async () => {
    const { env, fx, runner } = await setup({ slots: (d) => (new Date(`${d}T12:00:00Z`).getUTCDay() === 0 ? [] : ['2:00 PM']),
                                             rerenderSlotsOnHover: ['12:00 PM', '2:00 PM'] });
    const req = env.request();
    req.appointment.time = '14:00';
    const res = await runner.run(env.key(), req);
    const times = fx.created.map((c) => String((c.body as { datetime?: string }).datetime));
    expect(times.filter((t) => /(^|[^0-9])12:00 PM/.test(t))).toEqual([]);
    if (res.state === 'REQUESTED') expect(times).toEqual([expect.stringMatching(/(^|[^0-9])2:00 PM/)]);
    else expect(fx.created).toHaveLength(0);
  });

  it('a localhost scheduler without testMode cannot book', async () => {
    const { env, fx } = await setup();
    const driver = new PlaywrightDriver({ schedulerUrl: fx.url, waitMs: 4_000 });
    expect(driver.canSubmit).toBe(false);
    const res = await env.runner({ driver }).run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'FAILED', reason: 'execution_error:browser_start' });
    expect(fx.requests).toHaveLength(0);
  });
});

describe('third review: what the page changes after the agent typed it, and the totals', () => {
  it('a returning-client lookup that replaces the customer\'s name: NEEDS_INPUT, nothing sent', async () => {
    const { env, fx, runner } = await setup({ clientLookupOnEmail: { first: 'Someone', last: 'Else' } });
    const res = await runner.run(env.key(), env.request());
    expect(res.state).toBe('NEEDS_INPUT');
    expect(res.issues?.[0]).toMatch(/client-first-name__1 now shows "Someone"/);
    expect(fx.count('POST', CREATE)).toBe(0);
    expect(fx.count('POST', IN_PROGRESS)).toBe(0);    // stopped before Step 3's NEXT
    expect(await env.attemptCount()).toBe(0);
  });

  it('a property lookup that overwrites square feet: NEEDS_INPUT at the end of Step 1, nothing sent', async () => {
    const { env, fx, runner } = await setup({ lateSquareFeet: { value: 1950 } });
    const res = await runner.run(env.key(), env.request());
    expect(res.state).toBe('NEEDS_INPUT');
    expect(res.issues?.[0]).toMatch(/address-square-feet now shows "1950"/);
    expect(fx.count('POST', CREATE)).toBe(0);
  });

  it('a field changed on the Review step is caught right before Schedule: nothing is sent', async () => {
    const { env, fx, runner } = await setup({ changeOnNotes: { sel: '#client-first-name__1', value: 'Someone' } });
    const res = await runner.run(env.key(), env.request({ notes: 'Gate code 1234' }));
    expect(res.state).toBe('FAILED');
    expect(fx.count('POST', CREATE)).toBe(0);
    const { rows } = await env.db.pool('truss_owner').query('SELECT outcome, outcome_detail FROM safety.owner_attempts');
    expect(rows[0].outcome).toBe('failed');
    expect(JSON.stringify(rows[0].outcome_detail)).toMatch(/the page changed what was entered/);
    expect((await env.status()).unreconciled_unknown).toBe(0);
  });

  for (const [label, override, why] of [
    ['an SMS opt-in the page adds to the body only', { client: { sms: true } }, /opts in to texts without consent/],
    ['another client\'s name in the body only', { client: { first: 'Someone', last: 'Else' } }, /does not carry the requested customer first name/],
    ['a stored client record in the body', { client: { id: 98765 } }, /refers to an existing client record/],
  ] as const) {
    it(`the create request's own body is checked: ${label} is refused before it leaves (FAILED, nothing sent)`, async () => {
      const { env, fx, runner } = await setup({ bodyOverride: override as Record<string, unknown> });
      const res = await runner.run(env.key(), env.request());
      expect(res.state).toBe('FAILED');
      expect(fx.count('POST', CREATE)).toBe(0);
      const { rows } = await env.db.pool('truss_owner').query('SELECT outcome, outcome_detail FROM safety.owner_attempts');
      expect(rows[0].outcome).toBe('failed');
      expect(JSON.stringify(rows[0].outcome_detail)).toMatch(why);
      expect((await env.status()).unreconciled_unknown).toBe(0);
    });
  }

  it('"Subtotal" shown before "Total": the amount labelled Total is the one recorded', async () => {
    const { env, runner } = await setup({ totalsFeeUsd: 50 });
    const res = await runner.run(env.key(), env.request());
    expect(res).toMatchObject({ state: 'REQUESTED', spectoraShown: { totalUsd: 425 + 50 } });
  });

  it('Spectora confirms the booking on creation: REQUESTED, and submissions are turned off', async () => {
    const { env, runner } = await setup({ confirmOnCreate: true });
    expect((await runner.run(env.key(), env.request())).state).toBe('REQUESTED');
    expect((await env.status()).submissions_enabled).toBe(false);
  });

  it('requests to another host never leave the browser, even on paths allowed on the scheduler\'s host', async () => {
    const http = await import('node:http');
    let hits = 0;
    const foreign = http.createServer((req, res) => { hits++; res.end('{}'); });
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()));
    const port = (foreign.address() as import('node:net').AddressInfo).port;
    try {
      const paths = ['/api/v1/public/services/13628/calculate_charge', '/inspections.json', '/schedule_in_progress'];
      const { env, fx, runner } = await setup({ foreignPostUrls: paths.map((p) => `http://localhost:${port}${p}`) });
      expect((await runner.dryRun(env.key(), env.request())).state).toBe('DRY_RUN');
      expect(hits).toBe(0);
      expect(fx.created).toHaveLength(0);
    } finally {
      await new Promise((r) => foreign.close(r));
    }
  });
});

describe('live-submission gate', () => {
  const launch = () => { throw new Error('a browser was launched'); };

  it('the Spectora URL in booking mode needs TRUSS_LIVE_SUBMISSIONS=enabled; refused before any browser starts', async () => {
    const env = await TestEnv.create(cluster);
    for (const flag of [undefined, '', 'true', '1', 'yes', 'ENABLED']) {
      const driver = createSchedulerDriver({ TRUSS_LIVE_SUBMISSIONS: flag });
      expect(driver.canSubmit, String(flag)).toBe(false);
      const real = new PlaywrightDriver({ schedulerUrl: OFFICIAL_SCHEDULER_URL, liveSubmissions: false, launch });
      const res = await env.runner({ driver: real }).run(env.key(), env.request());
      expect(res).toMatchObject({ state: 'FAILED', reason: 'execution_error:browser_start' });
      await expect(real.start({ mode: 'booking' } as never, new AbortController().signal)).rejects.toBeInstanceOf(LiveSubmissionDisabledError);
      await env.owner('owner_reset_breaker', ['test loop']).catch(() => undefined);
      await env.advanceMinutes(62);
    }
    expect(createSchedulerDriver({ TRUSS_LIVE_SUBMISSIONS: 'enabled' }).canSubmit).toBe(true);
  });

  it('only the official scheduler URL or a localhost test server is accepted', () => {
    for (const url of ['https://app.spectora.com/home-inspectors/someone-else/schedule', 'https://app.spectora.com.evil.example/x',
                       'http://app.spectora.com/home-inspectors/truss-home-inspections/schedule', 'https://example.com/']) {
      expect(() => new PlaywrightDriver({ schedulerUrl: url }), url).toThrow(/scheduler URL must be/);
    }
    expect(() => createSchedulerDriver({ TRUSS_SCHEDULER_URL: 'https://example.com/' })).toThrow(/scheduler URL must be/);
  });
});

describe('worker command', () => {
  it('dry-run against the scheduler URL it is given; book refused without TRUSS_LIVE_SUBMISSIONS', async () => {
    const { execFile } = await import('node:child_process');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const env = await TestEnv.create(cluster);
    await env.db.redeploy(); // the real clock, as the worker process uses
    const fx = await FixtureScheduler.start({ today: new Date().toISOString().slice(0, 10) });
    fixtures.push(fx);
    const dir = mkdtempSync(join(tmpdir(), 'truss-worker-'));
    const file = join(dir, 'request.json');
    const appt = new Date(Date.now() + 9 * 86_400_000 - 7 * 3_600_000).toISOString().slice(0, 10);
    writeFileSync(file, JSON.stringify({ ...env.request(), appointment: { date: appt, time: '08:00' } }));
    const run = (args: string[], extra: Record<string, string>) => new Promise<{ code: number; out: string }>((resolve) => {
      execFile('npx', ['tsx', 'src/worker/cli.ts', ...args], {
        env: { ...process.env, APP_DATABASE_URL: env.db.url('truss_app'), TRUSS_SCHEDULER_URL: fx.url, ...extra },
        timeout: 90_000,
      }, (err, stdout, stderr) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }));
    });
    const dry = await run(['dry-run', file], { TRUSS_LIVE_SUBMISSIONS: '' });
    expect(dry.code, dry.out).toBe(0);
    expect(JSON.parse(dry.out.slice(dry.out.indexOf('{')))).toMatchObject({ state: 'DRY_RUN', spectoraShown: { totalUsd: 425 } });
    expect(fx.count('POST', IN_PROGRESS)).toBe(0);
    const book = await run(['book', file, '--key', 'cli-book-key-1'], { TRUSS_LIVE_SUBMISSIONS: 'true' });
    expect(book.code).toBe(2);
    expect(book.out).toMatch(/Live submissions are disabled/);
    expect(fx.count('POST', CREATE)).toBe(0);
  }, 120_000);
});
