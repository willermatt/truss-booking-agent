/**
 * Drives Spectora's public Online Scheduler with Playwright (Chromium). Implements the SchedulerDriver
 * contract in driver.ts.
 *
 * Safety properties, independent of the runner and the database:
 *   - Booking mode against Spectora requires liveSubmissions, which only createSchedulerDriver sets, and
 *     only when TRUSS_LIVE_SUBMISSIONS=enabled. Without it, start() refuses before a browser launches.
 *     The only other URL accepted is a local test server (localhost), used by the browser tests.
 *   - A network guard sits in front of the page. Every request that is not a GET is blocked, on every
 *     host, except three on the scheduler's own host: the price calculation; the "Schedule In Progress"
 *     notification, only when booking mode leaves Step 3 (a dry run answers it in the browser, so it never
 *     reaches Spectora and no text is sent); and the request that creates the inspection,
 *     exactly once, inside submit(), before the send-by deadline the database set. Allowed requests are
 *     sent once from this process (no retries, no redirects followed). SharedWorker, WebRTC and
 *     WebTransport are removed from the page and service workers and WebSockets are off, so no request
 *     can leave around the guard.
 *   - Dry runs go as far as the Review and read it, but never send the notification or the submit.
 *   - Nothing is retried. submit() returns a definite result only when it can prove what happened (no
 *     create request left the browser, or Spectora answered it); anything else throws ("unknown").
 *   - SMS consent boxes end up ticked only for consent recorded in the request; agent boxes never.
 *   - The address chosen from Spectora's suggestions, and the fields it fills, must be the same property
 *     as the request (E/W, unit and ZIP included), or the job stops as NEEDS_INPUT.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { BrowserNotClosedError, LiveSubmissionDisabledError, type PreparedJob, type PrepareResult, type ReviewSummary,
         type SchedulerDriver, type SchedulerSession, type SendBy, type SubmitResult } from './driver.js';
import { Reservation } from '../safety/gate.js';
import { compareProperty, normalizeUnit, parseAddress, type ParsedAddress } from './address.js';
import { slotLabel, type BookingRequest } from './schema.js';
import { ENDPOINT, OFFICIAL_HOST, OFFICIAL_SCHEDULER_URL, SEL, TEXT } from './spectoraScheduler.js';

export interface PlaywrightDriverOptions {
  schedulerUrl: string;
  /** Allows booking mode against Spectora. Set only by createSchedulerDriver. */
  liveSubmissions?: boolean;
  headless?: boolean;
  /** Longest wait for any one element or page transition. */
  waitMs?: number;
  /** How many calendar pages (two weeks each) to move forward looking for the date. */
  maxCalendarPages?: number;
  /** In submit(): if neither a create request nor a dialog has appeared after this long, stop. */
  submitQuietMs?: number;
  /** Longest wait for Spectora's answer to the create request. */
  createTimeoutMs?: number;
  /** Test hook: how the browser is launched. */
  launch?: () => Promise<Browser>;
  /**
   * Print the create request's field names (never their values) to stderr when it is sent, so the body
   * check can be pinned to the shape Spectora really uses after the designated test booking.
   */
  logCreateFields?: boolean;
  /** Tests only: allows booking mode against a localhost stand-in. Never set by createSchedulerDriver. */
  testMode?: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Longest the create request may take to reach Spectora and answer; see the window in _counts. */
const MAX_CREATE_TIMEOUT_MS = 60_000;
const isLocal = (u: URL) => LOCAL_HOSTS.has(u.hostname);
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** `word` (one or more words) appears in `text` as whole words: "Phoenix" is not in "Phoenixville". */
const wordIn = (text: string, word: string) =>
  new RegExp(`(^|[^a-z0-9])${squash(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(squash(text));

/** Builds the production driver from the environment. */
export function createSchedulerDriver(env: Record<string, string | undefined> = process.env): PlaywrightDriver {
  return new PlaywrightDriver({
    schedulerUrl: env.TRUSS_SCHEDULER_URL || OFFICIAL_SCHEDULER_URL,
    liveSubmissions: env.TRUSS_LIVE_SUBMISSIONS === 'enabled',
    headless: env.TRUSS_HEADFUL !== '1',
    logCreateFields: env.TRUSS_LOG_CREATE_FIELDS === '1',
  });
}

export class PlaywrightDriver implements SchedulerDriver {
  readonly kind = 'playwright' as const;
  private readonly url: URL;

  constructor(private readonly opts: PlaywrightDriverOptions) {
    // The database's hourly window and midnight cutoff assume a create reaches Spectora within 80 s of
    // being counted: 20 s to leave the browser, then at most this long in transit.
    if (opts.createTimeoutMs !== undefined && !(opts.createTimeoutMs > 0 && opts.createTimeoutMs <= MAX_CREATE_TIMEOUT_MS)) {
      throw new Error(`createTimeoutMs must be at most ${MAX_CREATE_TIMEOUT_MS} ms`);
    }
    this.url = new URL(opts.schedulerUrl);
    if (!isLocal(this.url) && this.url.href !== OFFICIAL_SCHEDULER_URL) {
      throw new Error(`scheduler URL must be ${OFFICIAL_SCHEDULER_URL} or a localhost test server`);
    }
  }

  /** Whether booking mode may run at all with this configuration. */
  get canSubmit(): boolean {
    if (isLocal(this.url)) return this.opts.testMode === true;
    return this.opts.liveSubmissions === true && this.url.host === OFFICIAL_HOST;
  }

  async start(job: PreparedJob, signal: AbortSignal): Promise<SchedulerSession> {
    if (job.mode === 'booking' && !this.canSubmit) {
      throw new LiveSubmissionDisabledError('TRUSS_LIVE_SUBMISSIONS is not "enabled"; only dry runs may open Spectora');
    }
    if (signal.aborted) throw new Error('aborted before the browser started');
    // No QUIC: WebTransport (HTTP/3) is still exposed inside workers, where the init script cannot remove it.
    const browser = await (this.opts.launch ?? (() => chromium.launch({ headless: this.opts.headless !== false, args: ['--disable-quic'] })))();
    const session = new PlaywrightSession(browser, job, this.url, this.canSubmit, this.opts);
    try {
      await session.init(signal);
    } catch (e) {
      try {
        await session.close();
      } catch (closeError) {
        // Not "never started": a browser may still be running, so the slot must stay held.
        throw new BrowserNotClosedError(`start failed (${(e as Error).message}); close failed (${(closeError as Error).message})`);
      }
      throw e;
    }
    return session;
  }
}

class NeedsInput extends Error {}
class Unavailable extends Error {}
class StepError extends Error {}

class PlaywrightSession implements SchedulerSession {
  private context!: BrowserContext;
  private page!: Page;
  private stage = 'start';
  private closing: Promise<void> | null = null;
  private readonly waitMs: number;

  // Network guard state.
  private armed = false;
  /** The create request is let through only until these instants (wall clock and monotonic clock). */
  private armedUntilWall = 0;
  private armedUntilMono = 0;
  /** Why the guard refused the create request inside submit(), if it did. */
  private createRefused: string | null = null;
  private createAllowed = false;
  private inProgressAllowed = false;
  private submitted = false;
  /** Set once, when the single create request is sent. Resolves to Spectora's answer or the failure. */
  private create: Promise<CreateAnswer> | null = null;
  readonly blocked: { method: string; path: string; stage: string }[] = [];
  readonly dialogs: string[] = [];
  /** Every field this job typed and the value it must keep showing (checked again before leaving each step and before Schedule). */
  private readonly typed = new Map<string, { want: string; phone: boolean }>();
  /** The property the address fields were confirmed to show at Step 1. */
  private filledAddress: { want: ParsedAddress; city: string } | null = null;
  /** Square feet and year built as entered at Step 1: the request's, or Spectora's lookup values ('' if none). */
  private facts: { squareFeet: string; yearBuilt: string } = { squareFeet: '', yearBuilt: '' };
  /** A dry run answered the "Schedule In Progress" notification in the browser (nothing reached Spectora). */
  notificationAnsweredLocally = false;

  constructor(private readonly browser: Browser, private readonly job: PreparedJob, private readonly url: URL,
              private readonly canSubmit: boolean, private readonly opts: PlaywrightDriverOptions) {
    this.waitMs = opts.waitMs ?? 20_000;
  }

  async init(signal: AbortSignal) {
    signal.addEventListener('abort', () => { this.close().catch(() => undefined); }, { once: true });
    // Service workers are blocked: their requests would not pass through the guard.
    this.context = await this.browser.newContext({ timezoneId: 'America/Phoenix', locale: 'en-US',
                                                   viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    // Requests from a SharedWorker, a WebRTC data channel or WebTransport are not seen by the guard:
    // the page (every frame) gets none of them. A string, so no transpiler helper can leak into the page.
    await this.context.addInitScript(`for (const k of ['SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport']) {
      try { Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
    }`);
    await this.context.route('**/*', (route) => this.guard(route));
    // The scheduler is plain HTTP; nothing it needs travels over a WebSocket, so none are opened.
    await this.context.routeWebSocket(/.*/, (ws) => { void ws.close(); });
    this.page = await this.context.newPage();
    this.page.on('dialog', (d) => {
      this.dialogs.push(d.message());
      // Alerts are only acknowledged. A confirm or prompt is declined: never agree to something unseen.
      (d.type() === 'alert' ? d.accept() : d.dismiss()).catch(() => undefined);
    });
  }

  /** The network guard. Runs in this process for every request before it leaves the browser. */
  private guard(route: Route) {
    const req = route.request();
    const method = req.method();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue();
    const u = new URL(req.url());
    // Default deny: only three requests that are not GETs exist, all on the scheduler's own host.
    if (u.host !== this.url.host) return this.block(route, method, `${u.host}${u.pathname}`);
    if (ENDPOINT.createInspection.test(u.pathname)) {
      const inWindow = Date.now() <= this.armedUntilWall && performance.now() <= this.armedUntilMono;
      if (!(this.armed && this.createAllowed && inWindow)) return this.block(route, method, u.pathname);
      this.createAllowed = false;
      const problem = createBodyProblem(req.postData(), this.job.request, this.facts);
      if (problem) {
        this.createRefused = problem;
        return this.block(route, method, u.pathname);
      }
      if (this.opts.logCreateFields) {
        const names = [...new Set((bodyLeaves(req.postData()) ?? []).map((l) => l.path.join('.')))];
        process.stderr.write(`create request fields (names only): ${names.join(', ')}\n`);
      }
      this.create = this.sendOnce(route);
      return this.create.then(() => undefined);
    }
    if (ENDPOINT.calculateCharge.test(u.pathname)) return this.forward(route);
    if (ENDPOINT.scheduleInProgress.test(u.pathname) && this.inProgressAllowed) {
      this.inProgressAllowed = false;
      if (this.job.mode === 'booking') return this.forward(route);
      // Dry run: the page sends this fire-and-forget when leaving Step 3 and moves on whatever the answer.
      // It is answered here, so nothing reaches Spectora and Truss gets no text.
      this.notificationAnsweredLocally = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return this.block(route, method, u.pathname);
  }

  /** Sends an allowed request once from this process: no retries, and a redirect is not followed. */
  private async forward(route: Route) {
    try {
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: this.waitMs });
      if (response.status() >= 300 && response.status() < 400) {
        await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"redirect not followed"}' });
      } else {
        await route.fulfill({ response });
      }
    } catch {
      await route.abort('failed').catch(() => undefined);
    }
  }

  /**
   * Sends the create request from this process instead of the browser. Chromium re-sends a POST when a
   * connection drops before the response (seen in the browser tests: one click, seven creates), and it
   * does so below anything the page or Playwright can observe. Playwright's own HTTP client with
   * maxRetries 0 and no redirects sends it exactly once. A redirect is never handed back to the page
   * (Chromium would follow it with a second POST, unguarded): the page gets an error, and the outcome is
   * judged from Spectora's actual answer.
   */
  private async sendOnce(route: Route): Promise<CreateAnswer> {
    try {
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: Math.min(this.opts.createTimeoutMs ?? 60_000, MAX_CREATE_TIMEOUT_MS) });
      const status = response.status();
      const body = await response.text().catch(() => '');
      if (status >= 300 && status < 400) {
        await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"redirect not followed"}' }).catch(() => undefined);
      } else {
        await route.fulfill({ response }).catch(() => undefined);
      }
      return { status, body };
    } catch (e) {
      await route.abort('failed').catch(() => undefined);
      return { error: (e as Error).message };
    }
  }

  private block(route: Route, method: string, path: string) {
    this.blocked.push({ method, path, stage: this.stage });
    return route.abort('blockedbyclient');
  }

  async prepare(_signal: AbortSignal): Promise<PrepareResult> {
    try {
      await this.step1();
      await this.step2();
      await this.step3();
      return { ok: true, summary: await this.step4() };
    } catch (e) {
      const detail = (e as Error).message;
      if (e instanceof NeedsInput) return { ok: false, kind: 'needs_input', detail };
      if (e instanceof Unavailable) return { ok: false, kind: 'unavailable', detail };
      return { ok: false, kind: 'execution_error', stage: this.stage, detail };
    }
  }

  // ------------------------------------------------------------------ Step 1: What & Where
  private async step1() {
    const { request: r, services } = this.job;
    await this.enter('step1_load');
    await this.page.goto(this.url.href, { waitUntil: 'domcontentloaded', timeout: this.waitMs });
    await this.visible(SEL.servicesSelect);

    await this.enter('step1_services');
    await this.pick(SEL.servicesSelect, services.service.checkboxId);
    await this.expectChecked(SEL.serviceCheckboxes, [services.service.checkboxId]);
    if (services.addOns.length) {
      await this.enter('step1_add_ons');
      for (const a of services.addOns) await this.pick(SEL.addOnSelect, a.checkboxId);
    }
    await this.expectChecked(SEL.addOnCheckboxes, services.addOns.map((a) => a.checkboxId));

    await this.enter('step1_address');
    const want = parseAddress(r.property.street, r.property.unit, r.property.zip);
    const search = this.page.locator(SEL.addressSearch).first();
    await search.waitFor({ state: 'visible', timeout: this.waitMs });
    await search.fill('');
    await search.pressSequentially(`${r.property.street}, ${r.property.city}, ${r.property.state} ${r.property.zip}`, { delay: 10 });
    await this.chooseSuggestion(want, r.property.city);
    await this.checkFilledAddress(want, r.property.unit ?? '', r.property.city);

    await this.enter('step1_details');
    if (r.squareFeet !== undefined) await this.fillExact(SEL.squareFeet, String(r.squareFeet));
    if (r.yearBuilt !== undefined) await this.fillExact(SEL.yearBuilt, String(r.yearBuilt));
    if (r.foundation) {
      await this.page.locator(SEL.foundation).first().click({ timeout: this.waitMs });
      const label = r.foundation[0].toUpperCase() + r.foundation.slice(1);
      await this.page.getByRole('option', { name: label, exact: true }).first().click({ timeout: this.waitMs });
    }

    // Not given: Spectora's own property lookup fills them when the address is chosen. They are used as
    // Spectora filled them, never invented, and must not change from here on.
    this.facts = { squareFeet: await this.factValue(SEL.squareFeet, r.squareFeet), yearBuilt: await this.factValue(SEL.yearBuilt, r.yearBuilt) };
    await this.requireTypedFields('end of Step 1');
    await this.enter('step1_next');
    try {
      await this.advance(SEL.servicesSelect, SEL.calendar);
    } catch (e) {
      const missing = [!this.facts.squareFeet && 'square footage', !this.facts.yearBuilt && 'year built'].filter(Boolean);
      if (!missing.length) throw e;
      throw new NeedsInput(`Spectora did not accept Step 1 and its property lookup left the ${missing.join(' and ')} empty; ` +
                           `send ${missing.join(' and ')} with the request${e instanceof NeedsInput ? ` (${e.message})` : ''}`);
    }
  }

  /** The request's value, or the one Spectora's lookup filled (waiting briefly for it); '' if there is none. */
  private async factValue(sel: string, given: number | undefined): Promise<string> {
    if (given !== undefined) return String(given);
    const until = Date.now() + Math.min(5_000, this.waitMs);
    let v = (await this.value(sel)).trim();
    while (!v && Date.now() < until) { await sleep(200); v = (await this.value(sel)).trim(); }
    if (v) this.typed.set(sel, { want: v, phone: false });
    return v;
  }

  /** Opens a select menu and ticks one checkbox in it. */
  private async pick(menuSel: string, checkboxId: string) {
    const box = this.page.locator(`[id="${checkboxId}"]`);
    if (!(await box.isVisible())) await this.page.locator(menuSel).first().click({ timeout: this.waitMs });
    try {
      await box.waitFor({ state: 'attached', timeout: this.waitMs });
    } catch {
      throw new StepError(`page changed: #${checkboxId} not found`);
    }
    if (!(await this.isChecked(box))) await box.check({ force: true, timeout: this.waitMs });
    await this.page.keyboard.press('Escape');
  }

  /** Exactly the given checkboxes (by id) among `allSel` are ticked. */
  private async expectChecked(allSel: string, ids: string[]) {
    const state = await this.page.$$eval(allSel, (els) => els.map((e) => ({
      id: e.id, on: (e as HTMLInputElement).checked === true || e.getAttribute('aria-checked') === 'true' })));
    const on = state.filter((s) => s.on).map((s) => s.id).sort();
    const want = [...ids].sort();
    if (JSON.stringify(on) !== JSON.stringify(want)) {
      throw new StepError(`selection did not take: wanted [${want.join(', ')}], page shows [${on.join(', ')}]`);
    }
  }

  private async chooseSuggestion(want: ParsedAddress, city: string) {
    const rows = this.page.locator(SEL.addressSuggestion).filter({ visible: true });
    try {
      await rows.first().waitFor({ state: 'visible', timeout: this.waitMs });
    } catch {
      throw new NeedsInput('Spectora offered no address suggestions for this address; book manually');
    }
    // Suggestions update as the address is typed; read them only once they have stopped changing.
    let texts: string[] = [];
    let last = '';
    let since = Date.now();
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      const now = await this.suggestionTexts();
      const key = now.join('\n');
      if (key !== last) { last = key; since = Date.now(); }
      else if (now.length && Date.now() - since >= 700) { texts = now; break; }
      await sleep(100);
    }
    if (!texts.length) throw new NeedsInput('Spectora\'s address suggestions did not settle; book manually');
    const streetOnly = (p: ParsedAddress) => ({ ...p, unit: '', zip: '' });
    const matches = texts.map((t, i) => ({ t, i })).filter(({ t }) => {
      const [street, ...rest] = t.split(',');
      const tail = squash(rest.join(','));
      return compareProperty(streetOnly(parseAddress(street)), streetOnly(want)) === 'same'
        && wordIn(tail, city) && /\b(az|arizona)\b/.test(tail);
    });
    if (matches.length !== 1) {
      throw new NeedsInput(`${matches.length ? 'more than one' : 'no'} Spectora address suggestion matches exactly ` +
                           `(shown: ${texts.slice(0, 5).join(' | ') || 'none'}); book manually`);
    }
    // Pin the row that was judged, confirm it still reads exactly the same, and click that element.
    const handle = await rows.nth(matches[0].i).elementHandle({ timeout: this.waitMs }).catch(() => null);
    if (!handle) throw new StepError('the address suggestion disappeared before it could be chosen');
    // A function with no inner helpers (a string would be evaluated as an expression and never called).
    const seen = await handle.evaluate((e) => {
      const q = e.querySelector('.pac-item-query');
      if (!q) return e.textContent || '';
      let rest = '';
      for (const c of Array.from(e.children)) if (c !== q && !c.classList.contains('pac-icon')) rest += ' ' + (c.textContent || '');
      return (q.textContent || '') + ',' + rest;
    });
    if (squash(seen) !== squash(texts[matches[0].i])) throw new StepError('the address suggestion changed while it was being chosen');
    await handle.click({ timeout: this.waitMs });
  }

  /**
   * The visible suggestion rows as "<street>, <city>, <ST> <ZIP>, USA". Google's rows put the street and
   * the locality in separate spans with nothing between them ("1700 W Washington StPhoenix, AZ…" as plain
   * text), so the two are joined with a comma here.
   */
  private async suggestionTexts(): Promise<string[]> {
    const texts = await this.page.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(SEL.addressSuggestion)})]
      .filter((e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length))
      .map((e) => {
        const q = e.querySelector('.pac-item-query');
        if (!q) return e.textContent || '';
        let rest = '';
        for (const c of Array.from(e.children)) if (c !== q && !c.classList.contains('pac-icon')) rest += ' ' + (c.textContent || '');
        return (q.textContent || '') + ',' + rest;
      }))()`) as string[];
    return texts.map((t) => t.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim());
  }

  private async checkFilledAddress(want: ParsedAddress, unit: string, city: string) {
    const street = this.page.locator(SEL.street).first();
    await this.page.waitForFunction((sel) => !!(document.querySelector(sel) as HTMLInputElement | null)?.value,
                                    SEL.street, { timeout: this.waitMs })
      .catch(() => { throw new StepError('address fields were not filled from the chosen suggestion'); });
    const shownUnit = await this.value(SEL.unit);
    if (unit) await this.fillExact(SEL.unit, unit);
    else if (shownUnit.trim()) throw new NeedsInput(`Spectora filled unit "${shownUnit}" but the request has none`);
    const got = { street: await street.inputValue(), unit: await this.value(SEL.unit), city: await this.value(SEL.city),
                  state: await this.value(SEL.state), zip: await this.value(SEL.zip) };
    const rel = compareProperty(parseAddress(got.street, got.unit, got.zip), want);
    const stateOk = /^(az|arizona)$/i.test(got.state.trim());
    if (rel !== 'same' || squash(got.city) !== squash(city) || !stateOk) {
      throw new NeedsInput(`Spectora filled "${got.street} ${got.unit}, ${got.city}, ${got.state} ${got.zip}", ` +
                           `which is not the requested property (${rel}); book manually`);
    }
    this.filledAddress = { want, city };
  }

  // ------------------------------------------------------------------ Step 2: When
  private async step2() {
    const { date, time } = this.job.request.appointment;
    await this.enter('step2_calendar');
    const day = this.page.locator(SEL.day(date)).first();
    const max = this.opts.maxCalendarPages ?? 12;
    await this.page.locator('td[data-date]').first().waitFor({ state: 'attached', timeout: this.waitMs })
      .catch(() => { throw new StepError('page changed or did not load: the calendar shows no days'); });
    for (let i = 0; !(await day.count()); i++) {
      if (i >= max) throw new Unavailable(`${date} is beyond the scheduler's calendar`);
      const first = await this.page.locator('td[data-date]').first().getAttribute('data-date');
      await this.page.locator(SEL.calendarNext).first().click({ timeout: this.waitMs });
      await this.page.waitForFunction((f) => document.querySelector('td[data-date]')?.getAttribute('data-date') !== f,
                                      first, { timeout: this.waitMs });
    }
    await this.enter('step2_openings');
    await this.page.waitForFunction(({ sel, slot }) => {
      const cell = document.querySelector(sel);
      return !!cell && (cell.querySelector(slot) !== null || /no times available/i.test(cell.textContent ?? ''));
    }, { sel: SEL.day(date), slot: SEL.slot }, { timeout: this.waitMs });
    const slots = day.locator(SEL.slot);
    const labels = (await slots.allInnerTexts()).map(squash);
    const want = squash(slotLabel(time));
    const hits = labels.map((l, i) => ({ l, i })).filter(({ l }) => l === want || l === want.replace(/^(\d):/, '0$1:'));
    if (hits.length === 0) {
      throw new Unavailable(`${slotLabel(time)} on ${date} is not offered (offered: ${labels.join(', ') || 'none'})`);
    }
    if (hits.length > 1) throw new StepError(`${slotLabel(time)} appears ${hits.length} times on ${date}`);
    await this.enter('step2_select');
    // Pin the exact element that was read, confirm its label and day, and click that element: if the
    // calendar re-renders in between, the click fails rather than landing on another time.
    const handle = await slots.nth(hits[0].i).elementHandle({ timeout: this.waitMs });
    if (!handle) throw new StepError('the time slot disappeared before it could be selected');
    // A function (a string would be evaluated as an expression and never called); nothing in it needs a
    // transpiler helper.
    const seen = await handle.evaluate((a) => {
      const td = a.closest('td[data-date]');
      return { text: a.textContent || '', day: td ? td.getAttribute('data-date') : null };
    });
    if (squash(seen.text) !== hits[0].l || seen.day !== date) {
      throw new StepError(`the slot changed before it was clicked (now "${seen.text.trim()}" on ${seen.day})`);
    }
    await handle.click({ timeout: this.waitMs });
    await this.visible(SEL.clientFirst);
  }

  // ------------------------------------------------------------------ Step 3: Who to contact
  private async step3() {
    const r = this.job.request;
    await this.enter('step3_contact');
    await this.fillExact(SEL.clientFirst, r.customer.firstName);
    await this.fillExact(SEL.clientLast, r.customer.lastName);
    await this.fillExact(SEL.clientEmail, r.customer.email);
    await this.fillPhone(SEL.clientPhone, r.customer.phone);
    if (r.agent) {
      await this.enter('step3_agent');
      if (!(await this.page.locator(SEL.agentFirst).first().isVisible())) {
        await this.page.locator(SEL.agentAddNew).first().click({ timeout: this.waitMs });
      }
      await this.fillExact(SEL.agentFirst, r.agent.firstName);
      await this.fillExact(SEL.agentLast, r.agent.lastName);
      if (r.agent.email) await this.fillExact(SEL.agentEmail, r.agent.email);
      if (r.agent.phone) await this.fillPhone(SEL.agentPhone, r.agent.phone);
      if (r.agent.agency) await this.fillExact(SEL.agentAgency, r.agent.agency);
    }
    await this.enter('step3_consent');
    await this.setChecked(SEL.clientSmsTransactional, r.smsConsent?.transactional === true);
    await this.setChecked(SEL.clientSmsMarketing, r.smsConsent?.marketing === true);
    await this.setChecked(SEL.agentSmsTransactional, false, true);
    await this.setChecked(SEL.agentSmsMarketing, false, true);

    await this.requireTypedFields('end of Step 3');
    // Step 3's NEXT sends the "Schedule In Progress" text: sent once in booking mode, answered locally in a
    // dry run (see the guard).
    await this.enter('step3_next');
    this.inProgressAllowed = true;
    try {
      await this.page.locator(SEL.nextButton).first().click({ timeout: this.waitMs });
      const prompt = this.page.locator(SEL.consentPrompt).first();
      const review = this.page.locator(SEL.review).first();
      const first = await Promise.race([
        review.waitFor({ state: 'visible', timeout: this.waitMs }).then(() => 'review' as const),
        prompt.waitFor({ state: 'visible', timeout: this.waitMs }).then(() => 'prompt' as const),
      ]).catch(() => 'neither' as const);
      if (first === 'prompt') {
        // Its accept button would opt everyone in to texts. Decline, then re-check the boxes.
        await this.page.locator(SEL.consentContinue).first().click({ timeout: this.waitMs });
        await review.waitFor({ state: 'visible', timeout: this.waitMs });
      } else if (first === 'neither') {
        throw await this.stuck('step 3');
      }
    } finally {
      this.inProgressAllowed = false;
    }
    const changed = await this.consentBoxesChanged();
    if (changed) throw new StepError(`the SMS consent boxes changed when leaving Step 3 (${changed})`);
    await this.requireTypedFields('leaving Step 3');
  }

  /** The SMS boxes still in the page that no longer show exactly the recorded consent, or null. */
  private async consentBoxesChanged(): Promise<string | null> {
    const c = this.job.request.smsConsent;
    const want: [string, boolean][] = [[SEL.clientSmsTransactional, c?.transactional === true], [SEL.clientSmsMarketing, c?.marketing === true],
                                      [SEL.agentSmsTransactional, false], [SEL.agentSmsMarketing, false]];
    for (const [sel, on] of want) {
      const l = this.page.locator(sel).first();
      if (!(await l.count())) continue;            // not in the page any more: the request body is checked instead
      if ((await this.isChecked(l)) !== on) return `${sel} is ${on ? 'unticked' : 'ticked'}`;
    }
    return null;
  }

  // ------------------------------------------------------------------ Step 4: Review (read only)
  private async step4(): Promise<ReviewSummary> {
    const r = this.job.request;
    await this.enter('step4_review');
    await this.visible(SEL.scheduleButton);
    if (r.notes) {
      const notes = this.page.locator(SEL.reviewNotes).first();
      if (!(await notes.count())) throw new StepError('page changed: the notes field was not found');
      await notes.fill(r.notes);
      if ((await notes.inputValue()) !== r.notes) throw new StepError('notes did not take');
      this.typed.set(SEL.reviewNotes, { want: r.notes, phone: false });
    }
    // A string, not a function: transpilers can inject helpers into functions that do not exist in the page.
    const raw = await this.page.evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(SEL.review)});
      const t = (e) => (e && (e.innerText ?? e.textContent)) || '';
      const lines = [...root.querySelectorAll('.line-item')].map((li) => {
        const cells = [...li.children];
        const note = t(cells[0] && cells[0].querySelector('.light'));
        return { name: t(cells[0]).replace(note, ''), amount: t(cells[cells.length - 1]) };
      });
      const totals = [...root.querySelectorAll('.total-cell')].map((c) => t(c));
      return { lines, totals, header: t(root).split(/\\bSERVICES\\b/i)[0] || '' };
    })()`) as { lines: { name: string; amount: string }[]; totals: string[]; header: string };
    const money = (s: string) => {
      const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m ? Number(m[0]) : null;
    };
    // The amount labelled "Total" (in its own cell or the next one), and exactly one such amount: a
    // subtotal shown first must not pass for the total.
    const cells = raw.totals.map((t) => t.replace(/\s+/g, ' ').trim());
    const totals: string[] = [];
    cells.forEach((c, i) => {
      if (/^total:?\s*\$?\s*-?[\d,]+(\.\d+)?$/i.test(c)) totals.push(c);
      else if (/^total:?$/i.test(c) && /\d/.test(cells[i + 1] ?? '')) totals.push(cells[i + 1]);
    });
    const totalCell = totals.length === 1 ? totals[0] : '';
    const header = raw.header.replace(/\s+/g, ' ').trim();
    // Spectora prints "<address> <unit>" on the first line and "<City>, <ST> <ZIP>" on the second.
    const headerLines = raw.header.split('\n').map((l) => l.trim()).filter(Boolean);
    return {
      lines: raw.lines.map((l) => ({ name: l.name.replace(/\s+/g, ' ').trim(), amountUsd: money(l.amount) }))
                      .filter((l) => l.name.toUpperCase() !== 'TAX'),
      addressText: headerLines.length >= 2 ? `${headerLines[0]}, ${headerLines[1]}` : header,
      dateText: header,
      timeText: header,
      totalUsd: money(totalCell),
      propertyFacts: { ...this.facts },
    };
  }

  // ------------------------------------------------------------------ The final submit
  async submit(reservation: Reservation, signal: AbortSignal, sendBy: SendBy): Promise<SubmitResult> {
    if (!Reservation.isGenuine(reservation)) throw new Error('submit requires a database reservation');
    if (reservation.jobId !== this.job.jobId) throw new Error('reservation does not belong to this job');
    if (this.job.mode !== 'booking') throw new Error('dry runs cannot submit');
    if (this.submitted) throw new Error('submit already called for this job');
    this.submitted = true;
    if (!this.canSubmit) return { kind: 'rejected', detail: 'not submitted: live submissions are disabled' };
    if (this.closing) throw new Error('browser is closed');
    this.stage = 'submit';

    const notSent = (why: string): SubmitResult => ({ kind: 'rejected', detail: `not submitted: ${why}` });
    const button = this.page.locator(SEL.scheduleButton).first();
    if (!(await button.isVisible().catch(() => false))) return notSent('the Schedule button is not showing');
    const changed = await this.consentBoxesChanged().catch(() => 'unreadable');
    if (changed) return notSent(`the SMS consent boxes changed (${changed})`);
    const edited = await this.typedFieldsChanged().catch(() => 'the entered fields could not be read');
    if (edited) return notSent(`the page changed what was entered (${edited})`);
    // The session must still be live, right now; and the request may leave only before the send-by
    // deadline the database set when it verified the reservation (on both clocks).
    try {
      await this.job.checkpoint?.();
    } catch (e) {
      return notSent(`session check failed (${(e as Error).message})`);
    }
    const quiet = this.opts.submitQuietMs ?? 15_000;
    this.armedUntilWall = Math.min(Date.now() + quiet, sendBy.wallMs);
    this.armedUntilMono = Math.min(performance.now() + quiet, sendBy.monoMs);
    if (signal.aborted || Date.now() >= this.armedUntilWall || performance.now() >= this.armedUntilMono) {
      return notSent('the send-by deadline passed before the click');
    }
    const dialogsBefore = this.dialogs.length;
    this.armed = true;
    this.createAllowed = true;
    try {
      await button.click({ timeout: 5_000 }).catch(() => undefined); // judged below by what was sent
      while (!this.create) {
        if (this.dialogs.length > dialogsBefore || signal.aborted || this.createRefused
            || Date.now() >= this.armedUntilWall || performance.now() >= this.armedUntilMono) break;
        await sleep(50);
      }
      // Close the gate before judging: from here on no create request can leave the browser.
      this.armed = false;
      this.createAllowed = false;

      if (!this.create) {
        if (this.createRefused) return notSent(this.createRefused);
        const message = this.dialogs.slice(dialogsBefore).join(' / ');
        if (TEXT.slotTaken.test(message)) return { kind: 'unavailable', detail: message };
        if (message) return notSent(message);
        if (signal.aborted) return notSent('stopped before the request was sent');
        return notSent('no request was sent before the send-by deadline');
      }

      // The create request was sent. Only Spectora's answer can tell us what happened.
      const answer = await Promise.race([
        this.create,
        new Promise<never>((_, reject) => {
          const stop = () => reject(new Error('stopped while waiting for Spectora'));
          if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
        }),
      ]);
      if ('error' in answer) throw new Error(`create request failed: ${answer.error}`);
      const { status, body } = answer;
      if (status >= 200 && status < 300) {
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* not JSON */ }
        const id = inspectionIdOf(parsed);
        if (!id) throw new Error(`Spectora answered HTTP ${status} without an inspection id`);
        return confirmedOf(parsed) ? { kind: 'requested', inspectionId: id, confirmedOnCreate: true } : { kind: 'requested', inspectionId: id };
      }
      if (status >= 400 && status < 500 && status !== 408) {
        return { kind: 'rejected', detail: `Spectora refused the request (HTTP ${status}) ${body.slice(0, 200)}` };
      }
      throw new Error(`Spectora answered HTTP ${status}; whether the inspection was created is unknown`);
    } finally {
      this.armed = false;
      this.createAllowed = false;
    }
  }

  /** Resolves only once the browser has closed; a failed close rejects (so it is not reported as closed). */
  async close(): Promise<void> {
    this.closing ??= this.browser.close();
    await this.closing;
  }

  // ------------------------------------------------------------------ helpers
  /** Starts a step: the job's session must still be live (see PreparedJob.checkpoint). */
  private async enter(stage: string) {
    this.stage = stage;
    await this.job.checkpoint?.();
  }

  private async visible(sel: string) {
    try {
      await this.page.locator(sel).first().waitFor({ state: 'visible', timeout: this.waitMs });
    } catch {
      throw new StepError(`page changed or did not load: ${sel} not shown`);
    }
  }

  private async value(sel: string) {
    const l = this.page.locator(sel).first();
    return (await l.count()) ? l.inputValue() : '';
  }

  private async fillExact(sel: string, v: string) {
    const l = this.page.locator(sel).first();
    if (!(await l.count())) throw new StepError(`page changed: ${sel} not found`);
    await l.fill(v, { timeout: this.waitMs });
    const got = await l.inputValue();
    if (got.trim() !== v.trim()) throw new StepError(`${sel} shows "${got}" after entering "${v}"`);
    this.typed.set(sel, { want: v, phone: false });
  }

  private async fillPhone(sel: string, phone: string) {
    const l = this.page.locator(sel).first();
    if (!(await l.count())) throw new StepError(`page changed: ${sel} not found`);
    const digits = phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
    await l.fill(digits, { timeout: this.waitMs });
    if ((await l.inputValue()).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') !== digits) {
      throw new StepError(`${sel} did not take the phone number`);
    }
    this.typed.set(sel, { want: digits, phone: true });
  }

  /**
   * A field the page changed after it was typed (a returning-client lookup replacing the name, a property
   * lookup overwriting square feet), or address fields that no longer show the confirmed property.
   * Fields no longer in the page are skipped here; the create request's body is checked instead.
   */
  private async typedFieldsChanged(): Promise<string | null> {
    for (const [sel, { want, phone }] of this.typed) {
      const l = this.page.locator(sel).first();
      if (!(await l.count())) continue;
      const got = await l.inputValue().catch(() => null);
      if (got === null) return `${sel} could not be read`;
      const same = phone ? got.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') === want : got.trim() === want.trim();
      if (!same) return `${sel} now shows "${got.trim()}" instead of "${want}"`;
    }
    if (this.filledAddress && (await this.page.locator(SEL.street).first().count())) {
      const got = { street: await this.value(SEL.street), unit: await this.value(SEL.unit), city: await this.value(SEL.city),
                    state: await this.value(SEL.state), zip: await this.value(SEL.zip) };
      if (compareProperty(parseAddress(got.street, got.unit, got.zip), this.filledAddress.want) !== 'same'
          || squash(got.city) !== squash(this.filledAddress.city) || !/^(az|arizona)$/i.test(got.state.trim())) {
        return `the address fields now show "${got.street} ${got.unit}, ${got.city}, ${got.state} ${got.zip}"`;
      }
    }
    return null;
  }

  private async requireTypedFields(when: string) {
    const changed = await this.typedFieldsChanged();
    if (changed) throw new NeedsInput(`the page changed what was entered (${when}): ${changed}; book manually`);
  }

  private async isChecked(l: ReturnType<Page['locator']>) {
    return l.evaluate((e) => (e as HTMLInputElement).checked === true || e.getAttribute('aria-checked') === 'true');
  }

  private async setChecked(sel: string, want: boolean, optional = false) {
    const l = this.page.locator(sel).first();
    if (!(await l.count())) {
      if (optional && !want) return;              // the agent's boxes exist only once an agent is added
      throw new StepError(`page changed: ${sel} not found`);
    }
    if (!(await l.isVisible())) {
      // A hidden box can still be sent with the form (a page may pre-tick one). Only ever unticked.
      if (want) throw new StepError(`page changed: ${sel} is not showing`);
      if (await this.isChecked(l)) {
        await l.evaluate((e) => {
          const box = e as HTMLInputElement;
          box.checked = false;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    } else if ((await this.isChecked(l)) !== want) {
      await l.setChecked(want, { force: true, timeout: this.waitMs });
    }
    if ((await this.isChecked(l)) !== want) throw new StepError(`${sel} could not be ${want ? 'ticked' : 'unticked'}`);
  }

  /** Clicks NEXT and waits for the next step; a step that will not advance is diagnosed. */
  private async advance(fromSel: string, toSel: string) {
    await this.page.locator(SEL.nextButton).first().click({ timeout: this.waitMs });
    try {
      await this.page.locator(toSel).first().waitFor({ state: 'visible', timeout: this.waitMs });
    } catch {
      throw await this.stuck(fromSel);
    }
  }

  private async stuck(where: string): Promise<Error> {
    const toast = await this.page.locator(SEL.toast).allInnerTexts().catch(() => []);
    const message = toast.map((t) => t.trim()).filter(Boolean).join(' / ');
    return message ? new NeedsInput(`the scheduler did not accept ${where}: ${message}`)
                   : new StepError(`the scheduler did not move past ${where}`);
  }
}

type CreateAnswer = { status: number; body: string } | { error: string };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Checks the create request's own body for SMS opt-ins the customer did not give: any key about texts
 * that is true. Under an agent: never allowed. Marketing: needs recorded marketing consent. Otherwise:
 * needs recorded transactional consent. Returns the problem, or null. A body that is not JSON is passed
 * (the boxes were checked on the page).
 */
type Leaf = { path: string[]; value: unknown };

/** "textOptIn" → "text_opt_in", "SMSConsent" / "SMS-Consent" → "sms_consent": one spelling for matching key names. */
const keyWords = (k: string) => k.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();

/**
 * The create request's body as JSON leaves, or null when it is not JSON (then it cannot be checked).
 * Key names are normalized (keyWords); array elements keep their array's key, so ["Someone"] under
 * "first" is still a first name.
 */
function bodyLeaves(postData: string | null): Leaf[] | null {
  let body: unknown;
  try { body = JSON.parse(postData ?? ''); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const leaves: Leaf[] = [];
  const walk = (v: unknown, path: string[]) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, path); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...path, keyWords(k)]);
      return;
    }
    leaves.push({ path, value: v });
  };
  walk(body, []);
  return leaves;
}

/** Only these mean "not opted in"; any other value under an SMS or text key counts as an opt-in. */
const optedOut = (v: unknown) => v === false || v === 0 || v === null || v === undefined
  || (typeof v === 'string' && /^(false|0|no|n|off|none|)$/i.test(v.trim()));
const SMS_PART = /(^|_)(sms|texts?|texting|txt)($|_)|text_?messag/;
/** A value that names texting as a channel ("sms", "text", "Text message"). */
const SMS_VALUE = /^(sms|texts?|text_?messages?|texting|txt)$/;
/** Paths that hold contact or notification preferences, where a mobile channel switched on means texts. */
const PREFERENCE_PATH = /notif|channel|method|prefer|subscri|opt/;

/**
 * Checks the create request's own body against the recorded consent: no SMS opt-in anywhere in it
 * (any key path naming SMS or texts, in any spelling, with any value but an explicit "no") unless the
 * customer agreed to that kind; agents never. A body that is not JSON cannot be checked and is refused.
 */
export function consentProblem(postData: string | null, consent?: { transactional: boolean; marketing: boolean }): string | null {
  const leaves = bodyLeaves(postData);
  if (!leaves) return 'the create request body is not JSON, so its SMS settings cannot be checked';
  const problems: string[] = [];
  for (const { path, value } of leaves) {
    const key = path.at(-1) ?? '';
    const inKey = path.some((p) => SMS_PART.test(p)) && !optedOut(value);
    // Consent carried in a value: contact_methods: ["email", "sms"], preferred_channel: "text".
    const inValue = typeof value === 'string' && SMS_VALUE.test(keyWords(value.trim()));
    // notifications: { mobile: true }
    const mobileOn = path.some((p) => PREFERENCE_PATH.test(p)) && /(^|_)(mobile|cell|phone)($|_)/.test(key) && !optedOut(value);
    if (!inKey && !inValue && !mobileOn) continue;
    const where = path.join('.');
    if (path.some((p) => /agent|realtor/.test(p))) problems.push(`${where}: agents are never opted in`);
    else if (path.some((p) => /market|promo/.test(p))) { if (consent?.marketing !== true) problems.push(`${where}: no recorded marketing consent`); }
    else if (consent?.transactional !== true) problems.push(`${where}: no recorded consent`);
  }
  return problems.length ? `the request opts in to texts without consent (${problems.join('; ')})` : null;
}

const PERSON_PATH = /client|buyer|customer|contact|person|people|purchaser|participant|part(y|ies)|attendee|recipient|user/;
const FIRST_KEY = /^(first|given|fore|f)(_?name)?$|(^|_)(first|given|fore)_?name$/;
const LAST_KEY = /^(last|family|surname|l)(_?name)?$|(^|_)(last|family|sur)_?name$/;
const NAME_KEY = /(^|_)name(_?\d+)?$/;
const MAIL_KEY = /(^|_)e_?mail(_address)?(_?\d+)?$|^mail(_?\d+)?$/;
const PHONE_KEY = /(^|_)(phone|mobile|cell|tel|telephone)(_number)?(_?\d+)?$/;
const AGENT_PATH = /agent|realtor/;

/**
 * The whole create request against the job: the consent check above; then the customer and the property
 * facts that set the price must be in it; and nothing in it may name another person, refer to an existing
 * client or agent record (any id under a person or agent), or state other property facts. Key names are
 * matched loosely because the live body has not been seen yet; the typed fields are also re-read in the
 * page. A body that cannot be checked is refused (nothing is sent).
 */
export function createBodyProblem(postData: string | null, req: BookingRequest,
                                  facts: { squareFeet?: string; yearBuilt?: string } = {}): string | null {
  const consent = consentProblem(postData, req.smsConsent);
  if (consent) return consent;
  const leaves = bodyLeaves(postData)!;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
  const digits = (x: string) => x.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
  const lower = (x: string) => x.trim().toLowerCase();
  const num = (x: string) => Number(x.replace(/,/g, ''));
  const c = req.customer;
  const unit = req.property.unit ? normalizeUnit(req.property.unit) : '';
  // The request's square feet and year built, or else the values Spectora's lookup filled at Step 1.
  const fact = (given: number | undefined, seen: string | undefined) =>
    given ?? (seen && Number.isFinite(num(seen)) ? num(seen) : undefined);
  const sqft = fact(req.squareFeet, facts.squareFeet);
  const year = fact(req.yearBuilt, facts.yearBuilt);
  const has = (ok: (s: string) => boolean) => leaves.some((l) => { const t = text(l.value); return t !== null && ok(t); });
  const required: [string, (s: string) => boolean][] = [
    ['customer first name', (x) => lower(x) === lower(c.firstName)],
    ['customer last name', (x) => lower(x) === lower(c.lastName)],
    ['customer email', (x) => lower(x) === lower(c.email)],
    ['customer phone', (x) => digits(x).length >= 10 && digits(x) === digits(c.phone)],
    ['ZIP', (x) => x.slice(0, 5) === req.property.zip.slice(0, 5)],
  ];
  if (sqft !== undefined) required.push(['square feet', (x) => num(x) === sqft]);
  if (year !== undefined) required.push(['year built', (x) => num(x) === year]);
  if (unit) required.push(['unit', (x) => normalizeUnit(x) === unit]);
  if (req.agent) {
    required.push(['agent first name', (x) => lower(x) === lower(req.agent!.firstName)],
                  ['agent last name', (x) => lower(x) === lower(req.agent!.lastName)]);
  }
  for (const [what, ok] of required) if (!has(ok)) return `the create request does not carry the requested ${what}`;

  for (const { path, value } of leaves) {
    const t = text(value);
    if (t === null || t === '') continue;
    const key = path.at(-1) ?? '';
    const where = path.join('.');
    const differs = (what: string) => `${where} is "${t}", not the requested ${what}`;
    const isNum = Number.isFinite(num(t));
    // People. A key that names a client or agent at the top level ("client_id", "buyer_name") counts too.
    const party = path.some((p) => AGENT_PATH.test(p)) ? 'agent' : path.some((p) => PERSON_PATH.test(p)) ? 'client' : null;
    if (!party) {
      // Property facts that set the price, under any of their usual names.
      if (sqft !== undefined && /(^|_)(sq|sqft|square|footage|area|living)($|_)/.test(key) && isNum && num(t) !== sqft) return differs(`${sqft} sq ft`);
      if (year !== undefined && /(^|_)(year|built|yr)($|_)/.test(key) && isNum && num(t) !== year) return differs(`year ${year}`);
      if (/(^|_)(zip|postal|postcode)($|_)/.test(key) && t.slice(0, 5) !== req.property.zip.slice(0, 5)) return differs(`ZIP ${req.property.zip}`);
      if (/^(unit|unity|address_2|address2|apt|apartment|suite)$/.test(key) && path.some((p) => /property|address/.test(p))
          && normalizeUnit(t) !== unit) return differs(unit ? `unit ${req.property.unit}` : 'property, which has no unit');
      continue;
    }
    if (/(^|_)(ids?|uuids?|refs?|keys?)$/.test(key)) return `${where} refers to an existing ${party} record ("${t}"); only the details entered may be sent`;
    const who = party === 'client' ? { firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone } : req.agent;
    const first = FIRST_KEY.test(key), last = LAST_KEY.test(key), name = !first && !last && NAME_KEY.test(key);
    const mail = MAIL_KEY.test(key), phone = PHONE_KEY.test(key);
    // A bare number under a person ("client": 98765, "buyer_contact": 98765) is a reference to a record.
    if (/^\d+$/.test(t) && !phone && !/(^|_)(zip|postal|postcode|sms|ext|extension)($|_)/.test(key)) {
      return `${where} refers to an existing ${party} record ("${t}"); only the details entered may be sent`;
    }
    if (!who) {
      if (first || last || name || mail || phone) return `${where} names an agent, but the request has none`;
      continue;
    }
    if (first && lower(t) !== lower(who.firstName)) return differs(`${party} first name`);
    if (last && lower(t) !== lower(who.lastName)) return differs(`${party} last name`);
    if (name && !(lower(t).includes(lower(who.firstName)) && lower(t).includes(lower(who.lastName)))) return differs(`${party} name`);
    if (mail && (!who.email || lower(t) !== lower(who.email))) return differs(`${party} email`);
    if (phone && (!who.phone || digits(t) !== digits(who.phone))) return differs(`${party} phone`);
  }
  return null;
}

function inspectionIdOf(body: Record<string, unknown> | null): string | null {
  const pick = (v: unknown) => (typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : null;
  if (!body) return null;
  const data = body.data as Record<string, unknown> | undefined;
  const inspection = body.inspection as Record<string, unknown> | undefined;
  return pick(data?.id) ?? pick(inspection?.id) ?? pick(body.id);
}

/** True when Spectora's create answer marks the inspection confirmed (data, data.attributes, inspection or top level). */
function confirmedOf(body: Record<string, unknown> | null): boolean {
  if (!body) return false;
  const yes = (v: unknown) => v === true || v === 'true';
  const data = body.data as Record<string, unknown> | undefined;
  const attrs = data?.attributes as Record<string, unknown> | undefined;
  const inspection = body.inspection as Record<string, unknown> | undefined;
  return yes(data?.confirmed) || yes(attrs?.confirmed) || yes(inspection?.confirmed) || yes(body.confirmed);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
