#!/usr/bin/env node
/**
 * Owner controls for the Truss booking agent. Connects with OWNER_DATABASE_URL (the truss_owner role).
 * Keep that credential on your own machine only. The booking worker and any AI client never get it.
 *
 *   npm run owner -- status
 *   npm run owner -- jobs [--limit 20]
 *   npm run owner -- errors [--limit 20]
 *   npm run owner -- disable --reason "text"
 *   npm run owner -- enable --approval-ref "Spectora email 2026-10-24" --reason "text" --yes
 *   npm run owner -- reset-breaker --reason "text" --yes
 *   npm run owner -- lookup <jobId>                       (read-only Spectora search; needs SPECTORA_API_KEY)
 *   npm run owner -- reconcile <jobId> --found <inspectionId> [--confirmed] --note "text"
 *   npm run owner -- reconcile <jobId> --not-found --note "text"
 *   npm run owner -- release-session <jobId> --note "text"
 *
 * There is intentionally no command to change the 5/day or 2/hour limits. They are fixed in the
 * database migration.
 */
import pg from 'pg';
import { BookingRequestSchema, appointmentInstant } from '../booking/schema.js';
import { fingerprints } from '../booking/normalize.js';
import { SpectoraReadApi } from '../spectora/readApi.js';
import { checkSpectoraDuplicates } from '../spectora/duplicateCheck.js';
import { TIMEZONE } from '../config.js';

type Args = { _: string[]; flags: Record<string, string | true> };

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

const fmtTime = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('en-US', { timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short' }) : '—';

function need(flags: Args['flags'], key: string): string {
  const v = flags[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`--${key} "<text>" is required`);
  return v;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const url = process.env.OWNER_DATABASE_URL;
  if (!cmd || cmd === 'help') { console.log(HELP); return 0; }
  if (!url) throw new Error('OWNER_DATABASE_URL is not set');
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0]?.r;
  try {
    switch (cmd) {
      case 'status': {
        const s = await one('SELECT safety.owner_status() AS r');
        const skew = Math.abs(Date.parse(s.db_clock) - Date.parse(s.real_clock));
        if (!s.control_row_present) console.log('WARNING: control row missing — everything is blocked (fail-closed).');
        console.log(`Submissions:      ${s.submissions_enabled ? 'ENABLED' : 'DISABLED'}`
          + (s.approval_ref ? `  (approval: ${s.approval_ref})` : ''));
        console.log(`  last changed:   ${fmtTime(s.enabled_changed_at)} by ${s.enabled_changed_by ?? '—'} — ${s.enabled_change_reason ?? ''}`);
        if (s.stopped_by_confirmation_report) {
          console.log(`WARNING: Spectora confirmed job ${s.stopped_by_confirmation_report.job_id} on creation ` +
                      `(${fmtTime(s.stopped_by_confirmation_report.reported_at)}): "Require Confirmation" looks off, so submissions are stopped. ` +
                      'Check it in Spectora, then ack-confirmation and enable.');
        }
        console.log(`Circuit breaker:  ${s.breaker_open ? `OPEN since ${fmtTime(s.breaker_opened_at)} — ${s.breaker_reason}` : 'closed'}`);
        console.log(`  consecutive errors: ${s.consecutive_errors} of 3`);
        console.log(`Today (${s.phoenix_day}, Arizona): ${s.jobs_today} of ${s.job_limit} jobs, ${s.attempts_today} of ${s.day_limit} submissions`);
        console.log(`Last 60 minutes:  ${s.attempts_last_hour} of ${s.hour_limit} submissions`);
        console.log(`Browser session:  ${s.active_session ? `job ${s.active_session.job_id}, started ${fmtTime(s.active_session.started_at)}, lease until ${fmtTime(s.active_session.lease_until)}` : 'none'}`);
        console.log(`In flight:        ${s.in_flight_attempt_id ?? 'none'}`);
        if (s.active_session?.browser_unconfirmed_at) {
          console.log(`WARNING: that browser was never confirmed closed (${fmtTime(s.active_session.browser_unconfirmed_at)}). ` +
                      'Make sure its worker has exited, then run release-session.');
        }
        console.log(`Unreconciled UNKNOWN jobs: ${s.unreconciled_unknown}${s.unreconciled_unknown > 0 ? '  — no booking runs until these are reconciled' : ''}`);
        if (skew > 5000) console.log(`WARNING: database safety clock differs from real time by ${skew} ms`);
        return 0;
      }
      case 'jobs': {
        const limit = Number(args.flags.limit ?? 20);
        const { rows } = await db.query(
          `SELECT id, mode, state, state_reason, appointment_at, property->>'street' AS street, customer_last_name,
                  spectora_inspection_id, outcome, attempted_at, admitted_at
             FROM safety.owner_jobs ORDER BY admitted_at DESC LIMIT $1`, [limit]);
        for (const r of rows) {
          console.log(`${r.id}  ${(r.mode === 'dry_run' ? 'dry-run ' : '') + r.state.padEnd(11)} ${fmtTime(r.appointment_at).padEnd(22)} ${String(r.street ?? '').padEnd(28)}`
            + ` ${String(r.customer_last_name ?? '').padEnd(14)} ${r.spectora_inspection_id ?? ''}`
            + `${r.state_reason ? `  [${r.state_reason}]` : ''}`);
        }
        if (!rows.length) console.log('No jobs yet.');
        return 0;
      }
      case 'errors': {
        const limit = Number(args.flags.limit ?? 20);
        const uncertain = await db.query(
          `SELECT id, state, state_reason, appointment_at, attempted_at, outcome
             FROM safety.owner_jobs WHERE state IN ('UNKNOWN','SUBMITTING') ORDER BY admitted_at DESC`);
        console.log(uncertain.rows.length ? 'Needs reconciliation:' : 'Nothing needs reconciliation.');
        for (const r of uncertain.rows) {
          console.log(`  ${r.id}  ${r.state}  attempted ${fmtTime(r.attempted_at)}  appt ${fmtTime(r.appointment_at)}  [${r.state_reason ?? ''}]`);
        }
        const ev = await db.query(
          `SELECT at, kind, job_id, detail FROM safety.owner_events
            WHERE kind IN ('execution_error','breaker_opened','breaker_reset','reservation_blocked','admission_refused',
                           'session_expired','dry_run_error','submissions_disabled','submissions_enabled','owner_reconciled',
                           'owner_confirmed','reconciled_found','browser_unconfirmed','session_released')
            ORDER BY id DESC LIMIT $1`, [limit]);
        console.log('\nRecent safety events:');
        for (const e of ev.rows) console.log(`  ${fmtTime(e.at)}  ${e.kind.padEnd(20)} ${e.job_id ?? ''}  ${JSON.stringify(e.detail)}`);
        return 0;
      }
      case 'disable': {
        await one('SELECT safety.owner_disable_submissions($1) AS r', [need(args.flags, 'reason')]);
        console.log('All new submissions are DISABLED.');
        return 0;
      }
      case 'enable': {
        const ref = need(args.flags, 'approval-ref');
        const reason = need(args.flags, 'reason');
        if (args.flags.yes !== true) throw new Error('Enabling live submissions requires --yes');
        const r = await one('SELECT safety.owner_enable_submissions($1, $2) AS r', [ref, reason]);
        if (r && r.ok === false) {
          console.log(`Not enabled: ${r.reason}. Spectora confirmed job ${r.report?.job_id} on creation (${fmtTime(r.report?.reported_at)}): ` +
                      'check that "Require Confirmation" is on in Spectora, then run ack-confirmation, then enable again.');
          return 2;
        }
        console.log('Submissions ENABLED. The 5/day and 2/hour limits and the circuit breaker still apply.');
        return 0;
      }
      case 'ack-confirmation': {
        const reason = need(args.flags, 'reason');
        await one('SELECT safety.owner_acknowledge_confirmation_report($1) AS r', [reason]);
        console.log('Confirmation report acknowledged. Submissions are unchanged; enable them when ready.');
        return 0;
      }
      case 'reset-breaker': {
        const reason = need(args.flags, 'reason');
        if (args.flags.yes !== true) throw new Error('Resetting the circuit breaker requires --yes');
        const r = await one('SELECT safety.owner_reset_breaker($1) AS r', [reason]);
        if (!r.ok) {
          console.log(`Not reset: ${r.reason}${r.count ? ` (${r.count})` : ''}. Reconcile those jobs first (see "errors").`);
          return 2;
        }
        console.log('Circuit breaker reset.');
        return 0;
      }
      case 'lookup': {
        const jobId = args._[1];
        if (!jobId) throw new Error('usage: lookup <jobId>');
        const key = process.env.SPECTORA_API_KEY;
        if (!key) throw new Error('SPECTORA_API_KEY is not set');
        const row = (await db.query('SELECT request FROM safety.owner_jobs WHERE id = $1', [jobId])).rows[0];
        if (!row) throw new Error('job not found');
        const req = BookingRequestSchema.parse(row.request) as Parameters<typeof checkSpectoraDuplicates>[1];
        const appt = appointmentInstant(req.appointment.date, req.appointment.time)!;
        const res = await checkSpectoraDuplicates(new SpectoraReadApi({ apiKey: key }), req, fingerprints(req), appt);
        if (res.result === 'error') { console.log(`Spectora lookup failed: ${res.error}`); return 2; }
        if (!res.matches.length) console.log(`No matching inspection in Spectora (${res.checkedCount} checked).`);
        for (const m of res.matches) {
          console.log(`  ${m.inspectionId}  ${fmtTime(m.datetime)}  ${m.address ?? ''}  confirmed=${m.confirmed}  ${m.kind} (property ${m.property}, customer ${m.customer})`);
        }
        return 0;
      }
      case 'release-session': {
        const jobId = args._[1];
        if (!jobId) throw new Error('usage: release-session <jobId> --note "text"');
        const r = await one('SELECT safety.owner_release_session($1, $2) AS r', [jobId, need(args.flags, 'note')]);
        console.log(r.ok ? `Browser session released. Job is now ${r.state}.`
          : r.reason === 'session_in_progress' ? `Not released: its worker is still renewing it (lease until ${fmtTime(r.lease_until)}). Stop that worker first.`
          : `Not released: ${r.reason}`);
        return r.ok ? 0 : 2;
      }
      case 'reconcile': {
        const jobId = args._[1];
        if (!jobId) throw new Error('usage: reconcile <jobId> --found <inspectionId> | --not-found --note "text"');
        const note = need(args.flags, 'note');
        const found = typeof args.flags.found === 'string';
        if (!found && args.flags['not-found'] !== true) throw new Error('pass --found <inspectionId> or --not-found');
        const r = await one('SELECT safety.owner_reconcile($1, $2, $3, $4, $5) AS r',
          [jobId, found, found ? args.flags.found : null, args.flags.confirmed === true, note]);
        console.log(r.ok ? `Job is now ${r.state}.`
          : r.reason === 'session_in_progress' ? `Not reconciled: that job's worker is still running (lease until ${fmtTime(r.lease_until)}). Stop it or wait.`
          : `Not reconciled: ${r.reason}${r.state ? ` (state ${r.state})` : ''}`);
        return r.ok ? 0 : 2;
      }
      default:
        console.log(HELP);
        return 1;
    }
  } finally {
    await db.end();
  }
}

const HELP = `Truss booking agent — owner controls
  status                                     submission counts, kill switch, breaker
  jobs [--limit N]                           booking history
  errors [--limit N]                         uncertain outcomes and recent safety events
  disable --reason "text"                    stop all new submissions now
  enable --approval-ref "ref" --reason "text" --yes
  ack-confirmation --reason "text"           after Spectora confirmed a booking on creation and you turned Require Confirmation back on
  reset-breaker --reason "text" --yes        refused while any outcome is unreconciled
  lookup <jobId>                             search Spectora (read-only) for a job's inspection
  release-session <jobId> --note "text"      free the browser slot after a worker whose browser would not stop has exited
  reconcile <jobId> --found <id> [--confirmed] --note "text"   an UNKNOWN job you found in Spectora
  reconcile <jobId> --not-found --note "text"                 an UNKNOWN job that is not in Spectora
  reconcile <jobId> --found <id> --confirmed --note "text"    a REQUESTED job you confirmed in Spectora`;

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
