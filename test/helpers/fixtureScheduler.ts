/**
 * A local stand-in for Spectora's Online Scheduler, for browser tests. It reproduces what the driver
 * relies on — element IDs, test hooks, the four steps, the calendar markup, the Review layout, the
 * endpoints and the native alerts — as recorded in src/booking/spectoraScheduler.ts. It is plain HTML
 * and JavaScript, not Spectora's code. Submissions go to this server and nowhere else.
 *
 * Scenarios switch on the failure modes the tests need: a price change, an unavailable slot, a slot
 * taken at submit, a renamed element, a page that never loads, network failures, consent pop-ups,
 * pre-ticked boxes, ambiguous address suggestions, and a page that tries to submit on its own.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadCatalog } from '../../src/booking/services.js';

export interface Suggestion {
  text: string;
  fill: { street: string; unit?: string; city: string; state: string; zip: string; squareFeet?: number; yearBuilt?: number };
}

export interface Scenario {
  /** The calendar's first day (YYYY-MM-DD). */
  today: string;
  /** Address suggestions for a query. Default: one suggestion, exactly the queried address. */
  suggestions?: (query: string) => Suggestion[];
  /** Offered slot labels per date. Default: weekdays 8:00 AM and 11:30 AM, none on Sundays. */
  slots?: (date: string) => string[];
  /** Added to every service charge (e.g. a surcharge the request did not expect). */
  priceExtraUsd?: number;
  /** Renames the service checkboxes, as a Spectora redesign might. */
  renameServiceCheckboxes?: boolean;
  /** The schedule page is never served. */
  hangOnLoad?: boolean;
  /** Step 1 shows this validation toast and does not advance. */
  step1Toast?: string;
  /** /can_schedule reports the slot as taken. */
  slotTakenAtSubmit?: boolean;
  /** /can_schedule fails. */
  canScheduleFails?: boolean;
  /** How POST /inspections.json behaves. */
  create?: 'ok' | 'ok_without_id' | 'reject_422' | 'error_500_after_create' | 'drop_after_create' | 'hang_after_create' | 'redirect_307';
  /** The Schedule button waits this long (without blocking the page) before sending the create. */
  delayCreateMs?: number;
  /** the Schedule button sends the create from a SharedWorker. */
  sharedWorkerCreate?: boolean;
  /** [delay, duration] ms: the page's main thread is busy for `duration` starting `delay` after the Review renders. */
  busyAfterReview?: [number, number];
  /** the calendar re-renders its slots (with these labels) on the first pointer move over it. */
  rerenderSlotsOnHover?: string[];
  /** the consent pop-up's "continue anyway" still ticks the client's transactional box. */
  consentContinueTicks?: boolean;
  /** the page fires a create from a SharedWorker on load. */
  rogueSharedWorker?: boolean;
  /** When the email field changes, the page fills in a stored client's name (a returning-client lookup). */
  clientLookupOnEmail?: { first: string; last: string };
  /** The page re-runs its property lookup when year built changes and overwrites square feet. */
  lateSquareFeet?: { value: number };
  /** A fee shown in the totals area only: "Subtotal $X" first, then "Total $X+fee". */
  totalsFeeUsd?: number;
  /** The Review shows no Total. */
  noTotal?: boolean;
  /** The create request's body differs from what the page shows (page state outside the inputs). */
  bodyOverride?: Record<string, unknown>;
  /** When the Review's notes field is typed in, the page changes this field (after every other check but the last). */
  changeOnNotes?: { sel: string; value: string };
  /** On load the page POSTs to this URL on another host (paths that are allowed on the scheduler's host). */
  foreignPostUrls?: string[];
  /** The create answer marks the inspection already confirmed ("Require Confirmation" switched off). */
  confirmOnCreate?: boolean;
  /** Shows the SMS consent pop-up when leaving Step 3. */
  consentPrompt?: boolean;
  /** Every SMS box starts ticked. */
  precheckSms?: boolean;
  /** The page itself fires a create request while on Step 1. */
  rogueCreateOnLoad?: boolean;
  /** The Schedule button fires the create request twice. */
  doubleCreate?: boolean;
  /** The Schedule button does nothing. */
  deadScheduleButton?: boolean;
  /** Shows tax on the Review. */
  taxUsd?: number;
  /** The suggestion list first shows unrelated rows, then (400 ms later) the real ones. */
  suggestionsChangeLate?: boolean;
  /** The page fires a create request with navigator.sendBeacon on load. */
  rogueBeacon?: boolean;
  /** The page asks confirm("…marketing texts?") on load and ticks the marketing box if accepted. */
  confirmMarketing?: boolean;
}

export interface LoggedRequest { method: string; path: string; body: string; at: number }

export class FixtureScheduler {
  scenario: Scenario;
  readonly requests: LoggedRequest[] = [];
  readonly created: { id: string; body: unknown }[] = [];
  private server!: http.Server;
  private readonly hung: http.ServerResponse[] = [];
  url = '';

  constructor(scenario: Partial<Scenario> = {}) {
    this.scenario = { today: '2026-11-02', create: 'ok', ...scenario };
  }

  static async start(scenario: Partial<Scenario> = {}) {
    const f = new FixtureScheduler(scenario);
    f.server = http.createServer((req, res) => { void f.handle(req, res); });
    await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', () => r()));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}/home-inspectors/truss-home-inspections/schedule`;
    return f;
  }

  async stop() {
    for (const r of this.hung) r.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  count(method: string, path: RegExp) {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', 'http://x');
    const body = await new Promise<string>((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
    this.requests.push({ method: req.method ?? '', path: u.pathname, body, at: Date.now() });
    const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const s = this.scenario;

    if (req.method === 'GET' && u.pathname.endsWith('/schedule')) {
      if (s.hangOnLoad) { this.hung.push(res); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(s));
      return;
    }
    if (req.method === 'GET' && (u.pathname.startsWith('/fixture/step/') || u.pathname === '/fixture/confirmed')) return json(200, {});
    if (req.method === 'GET' && u.pathname === '/fixture/places') {
      const q = u.searchParams.get('q') ?? '';
      return json(200, (s.suggestions ?? defaultSuggestions)(q));
    }
    if (req.method === 'GET' && u.pathname === '/fixture/openings') {
      const date = u.searchParams.get('date') ?? '';
      await sleep(30);
      return json(200, (s.slots ?? defaultSlots)(date));
    }
    const charge = u.pathname.match(/^\/api\/v1\/public\/(services|service_add_ons)\/(\d+)\/calculate_charge$/);
    if (req.method === 'POST' && charge) {
      const id = Number(charge[2]);
      const b = JSON.parse(body || '{}') as ChargeBody;
      return json(200, { id, kind: charge[1], amount: priceOf(charge[1], id, b, s).toFixed(2) });
    }
    if (req.method === 'POST' && u.pathname === '/schedule_in_progress') return json(200, { ok: true });
    if (req.method === 'GET' && u.pathname.startsWith('/can_schedule/')) {
      if (s.canScheduleFails) return json(500, { error: 'boom' });
      return json(200, { conflicts: s.slotTakenAtSubmit ? 'Overlaps an inspection.' : '' });
    }
    if (req.method === 'POST' && u.pathname === '/inspections.json') {
      if (mode0(s) === 'redirect_307' && u.searchParams.has('again')) {
        this.created.push({ id: `FX-${this.created.length + 1}`, body: JSON.parse(body || '{}') });
        return json(201, { data: { id: `FX-${this.created.length}`, type: 'inspection' } });
      }
      const mode = s.create ?? 'ok';
      if (mode === 'reject_422') return json(422, { error: 'Client email is invalid' });
      if (mode === 'redirect_307' && !u.searchParams.has('again')) {
        const id0 = `FX-${this.created.length + 1}`;
        this.created.push({ id: id0, body: JSON.parse(body || '{}') });
        res.writeHead(307, { location: '/inspections.json?again=1' }); res.end(); return;
      }
      const id = `FX-${this.created.length + 1}`;
      this.created.push({ id, body: JSON.parse(body || '{}') });
      if (mode === 'ok') return json(201, { data: { id, type: 'inspection', attributes: { confirmed: !!s.confirmOnCreate } } });
      if (mode === 'ok_without_id') return json(201, { data: {} });
      if (mode === 'error_500_after_create') return json(500, { error: 'Internal Server Error' });
      if (mode === 'drop_after_create') { req.socket.destroy(); return; }
      this.hung.push(res); // hang_after_create
      return;
    }
    json(404, { error: 'not found' });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mode0 = (s: Scenario) => s.create ?? 'ok';

function defaultSuggestions(q: string): Suggestion[] {
  // "1700 W Washington St, Phoenix, AZ 85007" → one exact suggestion, with lookup values.
  const [street, city, stateZip] = q.split(',').map((x) => x.trim());
  const [state, zip] = (stateZip ?? '').split(/\s+/);
  if (!street || !city) return [];
  return [{ text: `${street}, ${city}, ${state}, USA`, fill: { street, city, state, zip, squareFeet: 2762, yearBuilt: 1954 } }];
}

function defaultSlots(date: string): string[] {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 ? [] : ['8:00 AM', '11:30 AM'];
}

/** The body Spectora's scheduler sends to calculate_charge (strings, as the real page sends them). */
interface ChargeBody { sqft?: string; year?: string; address?: string; zip?: string; county?: string; foundation?: string }

/**
 * Spectora's price calculation as observed on the real Truss scheduler on 2026-10-25, written out on its
 * own (not read from pricing.json) so the Review check is tested against an independent stand-in:
 * $25 per 500 sq ft started over 500, up to each service's last configured range and nothing above it
 * (New Construction's 6,001-6,500 range is $3); $50 for Residential homes built 1901-1960; Residential
 * mileage $50 / $100 for the sample ZIPs seen in the 60-80 / 80-100 mile ranges; no foundation fee;
 * flat add-ons.
 */
function priceOf(kind: string, id: number, b: ChargeBody, s: Scenario) {
  const cat = loadCatalog();
  if (kind === 'services') {
    const svc = cat.services.find((x) => x.spectoraId === id);
    if (!svc) return 0;
    const sq = Number(b.sqft ?? 0);
    const lastRange = ({ residential: 7000, one_year_warranty: 6500, new_construction: 6500, condo: 3500 } as Record<string, number>)[svc.key] ?? 0;
    let tier = sq > 500 && sq <= lastRange ? Math.ceil((sq - 500) / 500) * 25 : 0;
    if (svc.key === 'new_construction' && sq > 6000 && sq <= 6500) tier = 3;
    const y = Number(b.year ?? 2000);
    const age = svc.key === 'residential' && y > 1900 && y <= 1960 ? 50 : 0;
    const zip = String(b.zip ?? '').slice(0, 5);
    const miles = svc.key !== 'residential' ? 0 : ['85122', '85132'].includes(zip) ? 50 : ['85131', '85337', '85541', '86301'].includes(zip) ? 100 : 0;
    return svc.basePriceUsd + tier + age + miles + (s.priceExtraUsd ?? 0);
  }
  for (const svc of cat.services) {
    const a = svc.addOns.find((x) => x.spectoraId === id);
    if (a) return a.priceUsd;
  }
  return 0;
}

function page(s: Scenario): string {
  const cat = loadCatalog();
  const services = cat.services.map((x) => ({
    id: x.spectoraId, label: x.label, checkboxId: x.checkboxId + (s.renameServiceCheckboxes ? '-v2' : ''),
    addOns: x.addOns.map((a) => ({ id: a.spectoraId, label: a.label, checkboxId: a.checkboxId })),
  }));
  const cfg = { services, today: s.today, step1Toast: s.step1Toast ?? null, consentPrompt: !!s.consentPrompt,
                precheckSms: !!s.precheckSms, rogue: !!s.rogueCreateOnLoad, double: !!s.doubleCreate,
                dead: !!s.deadScheduleButton, tax: s.taxUsd ?? 0, late: !!s.suggestionsChangeLate,
                beacon: !!s.rogueBeacon, confirmMarketing: !!s.confirmMarketing,
                swCreate: !!s.sharedWorkerCreate, delayCreate: s.delayCreateMs ?? 0, lookup: s.clientLookupOnEmail ?? null, onNotes: s.changeOnNotes ?? null, bodyOverride: s.bodyOverride ?? null, foreign: s.foreignPostUrls ?? [], lateSq: s.lateSquareFeet ?? null, totalsFee: s.totalsFeeUsd ?? 0, noTotal: !!s.noTotal, swRogue: !!s.rogueSharedWorker, busy: s.busyAfterReview ?? null, rerender: s.rerenderSlotsOnHover ?? null, contTicks: !!s.consentContinueTicks };
  return `<!doctype html><html><head><meta charset="utf-8"><title>truss-home-inspections | Book an inspection</title>
<style>[hidden]{display:none!important} .menu{border:1px solid #999;padding:4px} .btn{display:inline-block;padding:8px;border:1px solid #333;cursor:pointer}
td{vertical-align:top;min-width:90px;border:1px solid #ddd} a.fc-daygrid-event{display:block;cursor:pointer;color:blue}</style></head>
<body><div id="app">
<div id="step1">
  <div id="scheduler-select-service">
    <div data-testid="os-scheduler-services-select" class="select">Select services</div>
    <div class="menu" id="services-menu" hidden></div>
    <div id="addon-area"></div>
  </div>
  <input id="property-address-search" placeholder="Search address" autocomplete="off">
  <div class="pac-container" id="suggestions"></div>
  <input id="address-address"><input id="address-unity"><input id="address-city"><input id="address-state">
  <input id="address-zip"><input id="address-county"><input id="address-square-feet" type="number"><input id="address-year-built" type="number">
  <div id="property-foundation-dropdown" class="select">Foundation</div>
  <div role="listbox" id="foundation-menu" hidden><div role="option">Basement</div><div role="option">Slab</div><div role="option">Crawlspace</div></div>
</div>
<div id="step2" hidden><div data-testid="scheduler-calendar" id="schedule-calendar">
  <button class="fc-next-button" type="button">next</button><table><tr id="days"></tr></table></div></div>
<div id="step3" hidden><div id="scheduler-contact-info">
  <input id="client-first-name__1"><input id="client-last-name__1"><input id="client-email__1" type="email"><input id="client-phone__1" type="tel">
  <label><input type="checkbox" id="client-sms-opt-in__1"> Text me updates</label>
  <label><input type="checkbox" id="client-sms-marketing-opt-in__1"> Text me offers</label>
  <input id="agent-search-autocomplete__1"><a id="agent-add">Not here? Click to add a new Agent</a>
  <div id="agent-new" hidden><input id="agent-first-name__1"><input id="agent-last-name__1"><input id="agent-email__1"><input id="agent-phone__1"><input id="agent-agency-name__1">
  <label><input type="checkbox" id="agent-sms-opt-in__1"> Agent texts</label><label><input type="checkbox" id="agent-sms-marketing-opt-in__1"> Agent offers</label></div>
</div></div>
<div id="step4" hidden></div>
<div class="button-row"><div class="btn btn-xlarge" id="btn"><div class="inner" id="schedule-next-btn">Next</div></div></div>
<div class="toast" hidden></div>
<div data-testid="consent-prompt" hidden><div data-testid="consent-prompt-message">Opt in to texts?</div>
  <button data-testid="consent-prompt-opt-in" type="button">Yes</button><button data-testid="consent-prompt-continue-anyway" type="button">Continue anyway</button></div>
</div>
<script>
const CFG = ${JSON.stringify(cfg)};
const $ = (s) => document.querySelector(s);
let step = 1, datetime = null, saving = false, saved = false, calStart = CFG.today, charges = [];
const selected = new Set(), selectedAddOns = new Set();
const toast = (m) => { const t = $('.toast'); t.textContent = m; t.hidden = !m; };
const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
if (CFG.rogue) post('/inspections.json', { rogue: true }).catch(() => {});
if (CFG.beacon) navigator.sendBeacon('/inspections.json', JSON.stringify({ beacon: true }));
for (const url of CFG.foreign) fetch(url, { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => {});
const swPost = (b) => { const src = "onconnect = (e) => { const port = e.ports[0]; port.onmessage = (m) => fetch(" + JSON.stringify(location.origin + '/inspections.json') + ", { method: 'POST', headers: { 'content-type': 'application/json' }, body: m.data }).then((r) => r.text()).then((t) => port.postMessage(t), () => port.postMessage('ERR')); };";
  const w = new SharedWorker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); w.port.start(); w.port.postMessage(JSON.stringify(b)); };
if (CFG.swRogue) swPost({ rogue: 'sharedworker' });
if (CFG.rerender) { let done = false; document.addEventListener('pointermove', (e) => {
  if (done || !e.target.closest || !e.target.closest('#schedule-calendar')) return; done = true;
  for (const td of document.querySelectorAll('td[data-date]')) { if (!td.querySelector('a.fc-daygrid-event')) continue; const d = td.dataset.date;
    td.querySelectorAll('a.fc-daygrid-event').forEach((a) => a.remove());
    td.insertAdjacentHTML('beforeend', CFG.rerender.map((x) => '<a class="fc-daygrid-event" data-date="' + d + '">' + x + '</a>').join('')); } }, true); }
if (CFG.confirmMarketing) setTimeout(() => { if (confirm('Would you like marketing texts?')) { $('#client-sms-marketing-opt-in__1').checked = true; fetch('/fixture/confirmed').catch(() => {}); } }, 0);
if (CFG.precheckSms) for (const id of ['client-sms-opt-in__1','client-sms-marketing-opt-in__1','agent-sms-opt-in__1','agent-sms-marketing-opt-in__1']) $('#'+id).checked = true;

function renderServices() {
  $('#services-menu').innerHTML = CFG.services.map((s) =>
    '<label><input type="checkbox" id="' + s.checkboxId + '" data-id="' + s.id + '"' + (selected.has(s.id) ? ' checked' : '') + '> ' + s.label + ' </label><br>').join('');
  $('#addon-area').innerHTML = CFG.services.filter((s) => selected.has(s.id)).map((s) =>
    '<div data-testid="os-scheduler-addon-select" class="select" data-for="' + s.id + '">Add-ons for ' + s.label + '</div>' +
    '<div class="menu addon-menu" data-for="' + s.id + '" hidden>' + s.addOns.map((a) =>
      '<label><input type="checkbox" id="' + a.checkboxId + '" data-addon="' + a.id + '"' + (selectedAddOns.has(a.id) ? ' checked' : '') + '> ' + a.label + '</label><br>').join('') + '</div>').join('');
}
renderServices();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.menu,#foundation-menu').forEach((m) => m.hidden = true); });
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.matches('[data-testid=os-scheduler-services-select]')) { $('#services-menu').hidden = !$('#services-menu').hidden; return; }
  if (t.matches('[data-testid=os-scheduler-addon-select]')) { const m = document.querySelector('.addon-menu[data-for="' + t.dataset.for + '"]'); m.hidden = !m.hidden; return; }
  if (t.matches('#property-foundation-dropdown')) { $('#foundation-menu').hidden = false; return; }
  if (t.matches('#foundation-menu [role=option]')) { $('#property-foundation-dropdown').textContent = t.textContent; $('#foundation-menu').hidden = true; return; }
  if (t.closest('#suggestions .pac-item')) { const f = JSON.parse(t.closest('.pac-item').dataset.fill);
    $('#address-address').value = f.street; $('#address-unity').value = f.unit || ''; $('#address-city').value = f.city;
    $('#address-state').value = f.state; $('#address-zip').value = f.zip || ''; $('#address-square-feet').value = f.squareFeet || '';
    $('#address-year-built').value = f.yearBuilt || ''; $('#suggestions').innerHTML = ''; return; }
  if (t.matches('#agent-add')) { $('#agent-new').hidden = false; return; }
  if (t.matches('a.fc-daygrid-event')) { datetime = t.dataset.date + ' ' + t.textContent; go(3); return; }
  if (t.matches('.fc-next-button')) { calStart = addDays(calStart, 14); renderCalendar(); return; }
  if (t.closest('#btn')) { next(); return; }
  if (t.matches('[data-testid=consent-prompt-opt-in]')) { document.querySelectorAll('[id$=sms-opt-in__1]').forEach((c) => c.checked = true); $('[data-testid=consent-prompt]').hidden = true; leaveStep3(); return; }
  if (t.matches('[data-testid=consent-prompt-continue-anyway]')) { if (CFG.contTicks) $('#client-sms-opt-in__1').checked = true; $('[data-testid=consent-prompt]').hidden = true; leaveStep3(); return; }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (CFG.lookup && t.id === 'client-email__1') { $('#client-first-name__1').value = CFG.lookup.first; $('#client-last-name__1').value = CFG.lookup.last; }
  if (CFG.lateSq && t.id === 'address-year-built') $('#address-square-feet').value = String(CFG.lateSq.value);
  if (CFG.onNotes && t.matches('#schedule-review-inspection textarea')) document.querySelector(CFG.onNotes.sel).value = CFG.onNotes.value;
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.id) { const id = Number(t.dataset.id); t.checked ? selected.add(id) : selected.delete(id); renderServices(); }
  if (t.dataset.addon) { const id = Number(t.dataset.addon); t.checked ? selectedAddOns.add(id) : selectedAddOns.delete(id); }
});
let timer = null, latest = 0;
$('#property-address-search').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const mine = ++latest;
    const list = await fetch('/fixture/places?q=' + encodeURIComponent(e.target.value)).then((r) => r.json());
    if (mine !== latest) return;
    // Google's markup: <div class="pac-item"><span class="pac-icon"></span><span class="pac-item-query">street</span><span>locality</span></div>
    const row = (s) => { const i = s.text.indexOf(','); const q = i < 0 ? s.text : s.text.slice(0, i); const rest = i < 0 ? '' : s.text.slice(i + 1).trim();
      return '<div class="pac-item" data-fill=\\'' + JSON.stringify(s.fill).replace(/'/g, '&#39;') + '\\'><span class="pac-icon pac-icon-marker"></span><span class="pac-item-query">' + q + '</span><span>' + rest + '</span></div>'; };
    const render = (l) => { $('#suggestions').innerHTML = l.map(row).join(''); };
    if (CFG.late) { render([{ text: '9999 N Unrelated Rd, Mesa, AZ, USA', fill: {} }]); setTimeout(() => { if (mine === latest) render(list); }, 400); }
    else render(list);
  }, 60);
});
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function renderCalendar() {
  const days = []; for (let i = 0; i < 14; i++) days.push(addDays(calStart, i));
  $('#days').innerHTML = days.map((d) => '<td data-date="' + d + '">' + d.slice(5) + '</td>').join('');
  for (const d of days) fetch('/fixture/openings?date=' + d).then((r) => r.json()).then((slots) => {
    const td = document.querySelector('td[data-date="' + d + '"]'); if (!td) return;
    td.insertAdjacentHTML('beforeend', slots.length ? slots.map((s) => '<a class="fc-daygrid-event" data-date="' + d + '">' + s + '</a>').join('') : '<div>No times available.</div>');
  });
}
async function calc() {
  const fdn = $('#property-foundation-dropdown').textContent.trim().toLowerCase();
  const b = { sqft: $('#address-square-feet').value, year: $('#address-year-built').value,
              address: $('#address-address').value + ', ' + $('#address-city').value + ', ' + $('#address-state').value,
              zip: $('#address-zip').value, county: $('#address-county').value,
              foundation: ['basement', 'slab', 'crawlspace'].includes(fdn) ? fdn : '', company_id: '7808', discount: '', inspector_id: '', custom_fields: [] };
  const svc = [...selected].map((id) => post('/api/v1/public/services/' + id + '/calculate_charge', b).then((r) => r.json()));
  const add = [...selectedAddOns].map((id) => post('/api/v1/public/service_add_ons/' + id + '/calculate_charge', b).then((r) => r.json()));
  charges = await Promise.all(svc.concat(add));
}
function setButton() {
  const inner = $('#btn .inner');
  if (step === 4 && saving) { inner.id = 'schedule-saving-btn'; inner.textContent = 'Saving'; }
  else if (step === 4) { inner.id = 'schedule-schedule-btn'; inner.textContent = 'Schedule'; }
  else { inner.id = 'schedule-next-btn'; inner.textContent = 'Next'; }
  $('.button-row').hidden = saved;
}
async function go(n) {
  step = n; toast('');
  fetch('/fixture/step/' + n).catch(() => {});
  for (const i of [1, 2, 3, 4]) $('#step' + i).hidden = i !== n;
  if (n === 2) { await calc(); renderCalendar(); }
  if (n === 4) { await calc(); renderReview(); }
  setButton();
}
function money(v) { return Number(v).toFixed(2); }
function renderReview() {
  const all = CFG.services.flatMap((s) => [{ id: s.id, label: s.label, kind: 'services' }, ...s.addOns.map((a) => ({ id: a.id, label: a.label, kind: 'service_add_ons' }))]);
  const line = (name, amt) => '<div class="layout line-item"><div class="flex">' + name + '<div class="light small">notes</div></div><div class="flex">$' + money(amt) + '</div></div>';
  let html = '<div class="flex xs12 section">' + $('#address-address').value + ' ' + $('#address-unity').value + '<br>' +
    $('#address-city').value + ', ' + $('#address-state').value + ' ' + $('#address-zip').value +
    '<div class="inspector-row">with Matthew Willer</div>' + new Date(datetime.split(' ')[0] + 'T12:00:00').toLocaleDateString() + ' ' + datetime.split(' ').slice(1).join(' ') + ' 2 hours</div>';
  html += '<div class="services section">SERVICES';
  let total = 0;
  for (const c of charges) { const def = all.find((x) => x.id === c.id && x.kind === c.kind); html += line(def ? def.label : '?', c.amount); total += Number(c.amount); }
  if (CFG.tax) { html += line('TAX', CFG.tax); total += CFG.tax; }
  if (CFG.totalsFee) html += '</div><div class="layout"><div><div class="flex total-cell">Subtotal</div><div class="flex total-cell">$' + money(total) + '</div></div><div><div class="flex total-cell">Scheduling fee</div><div class="flex total-cell">$' + money(CFG.totalsFee) + '</div></div></div><div class="services section">';
  if (CFG.totalsFee) total += CFG.totalsFee;
  html += CFG.noTotal ? '</div>' : '</div><div class="layout"><div><div class="flex total-cell"><strong>Total</strong></div><div class="flex total-cell"><strong>$' + money(total) + '</strong></div></div></div>';
  html += '<input id="review-inspection-discount-code"><textarea placeholder="Anything else you\\'d like us to know? (e.g. lockbox code, entrance instructions, special considerations, etc.)"></textarea>';
  $('#step4').innerHTML = '<div class="layout" id="schedule-review-inspection">' + html + '</div>';
  if (CFG.busy) { let armed = false; for (const c of document.querySelectorAll('.total-cell')) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
    Object.defineProperty(c, 'innerText', { get() { if (!armed) { armed = true; setTimeout(() => { const end = Date.now() + CFG.busy[1]; while (Date.now() < end) {} }, CFG.busy[0]); } return desc.get.call(this); } }); } }
}
function leaveStep3() { post('/schedule_in_progress', { info: 'in progress' }).catch(() => {}); go(4); }
async function next() {
  if (step === 1) {
    if (CFG.step1Toast) return toast(CFG.step1Toast);
    if (!selected.size || !$('#address-address').value || !$('#address-square-feet').value || !$('#address-year-built').value) return toast('Please complete the required fields');
    return go(2);
  }
  if (step === 3) {
    if (!$('#client-first-name__1').value || !$('#client-email__1').value || !$('#client-phone__1').value) return toast('Please enter contact details');
    if (CFG.consentPrompt) { $('[data-testid=consent-prompt]').hidden = false; return; }
    return leaveStep3();
  }
  if (step === 4) return save();
}
async function save() {
  if (saving || CFG.dead) return;
  saving = true; setButton();
  try {
    const r = await fetch('/can_schedule/1234/' + encodeURIComponent(datetime));
    if (!r.ok) throw new Error('can_schedule failed');
    const j = await r.json();
    if (j.conflicts) { alert("We're sorry, but this time is no longer available. Please select a different time for your inspection."); saving = false; go(2); return; }
  } catch (e) { alert('Something went wrong. Please try again.'); saving = false; setButton(); return; }
  const body = { services: [...selected], add_ons: [...selectedAddOns], datetime,
    client: { first: $('#client-first-name__1').value, last: $('#client-last-name__1').value, email: $('#client-email__1').value,
              phone: $('#client-phone__1').value, sms: $('#client-sms-opt-in__1').checked, sms_marketing: $('#client-sms-marketing-opt-in__1').checked },
    agent: $('#agent-new').hidden ? null : { first: $('#agent-first-name__1').value, last: $('#agent-last-name__1').value,
              sms: $('#agent-sms-opt-in__1').checked, sms_marketing: $('#agent-sms-marketing-opt-in__1').checked },
    property: { address: $('#address-address').value, unit: $('#address-unity').value, zip: $('#address-zip').value,
                square_feet: $('#address-square-feet').value, year_built: $('#address-year-built').value,
                foundation: $('#property-foundation-dropdown').textContent },
    notes: (document.querySelector('#schedule-review-inspection textarea') || {}).value || '' };
  if (CFG.bodyOverride) for (const [k, v] of Object.entries(CFG.bodyOverride)) body[k] = Object.assign({}, body[k], v);
  if (CFG.swCreate) { swPost(body); return; } // fire and forget, like a page that hands the save to a worker
  if (CFG.delayCreate) await new Promise((r) => setTimeout(r, CFG.delayCreate));
  const send = () => post('/inspections.json', body);
  try {
    const attempts = CFG.double ? [send(), send()] : [send()];
    const r = await attempts[0];
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error || 'Error creating inspection'); saving = false; setButton(); return; }
    saved = true; saving = false;
    $('#step4').insertAdjacentHTML('beforeend', '<h3>We\\'ve received your Inspection Request!</h3>');
    setButton();
  } catch (e) { toast('Error creating inspection'); saving = false; setButton(); }
}
</script></body></html>`;
}
