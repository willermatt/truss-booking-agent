/**
 * The booking worker, as a command. One job per invocation; the process exits when it is done.
 *
 *   npm run worker -- dry-run request.json            the live scheduler up to the Review; no text to Truss, never submits
 *   npm run worker -- book request.json --key <key>   a real booking (needs TRUSS_LIVE_SUBMISSIONS=enabled)
 *
 * Environment:
 *   APP_DATABASE_URL        truss_app connection string (the only database credential on the worker host)
 *   SPECTORA_API_KEY        read-only Spectora API key; without it every booking is blocked
 *   TRUSS_LIVE_SUBMISSIONS  "enabled" to allow booking mode against Spectora; anything else refuses
 *   TRUSS_SCHEDULER_URL     optional; only the official scheduler URL or a localhost test server
 *   TRUSS_HEADFUL=1         optional; show the browser
 *
 * Exit codes: 0 the job ran to a final state (see the printed state); 2 refused or invalid; 3 the browser
 * would not stop (the process exits so the browser dies with it; the owner releases the slot); 1 error.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { BookingRunner, BrowserDidNotStopError } from '../booking/runner.js';
import { createSchedulerDriver } from '../booking/playwrightDriver.js';
import { SafetyGate } from '../safety/gate.js';
import { SpectoraReadApi } from '../spectora/readApi.js';

const USAGE = 'usage: worker dry-run <request.json> [--key K] | worker book <request.json> --key K';

async function main(argv: string[]): Promise<number> {
  const [command, file, ...rest] = argv;
  const keyAt = rest.indexOf('--key');
  const key = keyAt >= 0 ? rest[keyAt + 1] : undefined;
  if ((command !== 'dry-run' && command !== 'book') || !file) { console.error(USAGE); return 2; }
  if (command === 'book' && !key) { console.error('book needs --key <idempotency key> (reuse it to check on the same job)'); return 2; }
  if (command === 'book' && process.env.TRUSS_LIVE_SUBMISSIONS !== 'enabled') {
    console.error('Live submissions are disabled on this host (TRUSS_LIVE_SUBMISSIONS is not "enabled"). Use dry-run.');
    return 2;
  }
  const url = process.env.APP_DATABASE_URL;
  if (!url) { console.error('APP_DATABASE_URL is not set'); return 2; }

  const request = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  // Bounded: a database that stops answering fails the call instead of hanging it (the runner's
  // watchdog closes the browser meanwhile).
  const pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 35_000, keepAlive: true });
  pool.on('error', () => undefined);
  try {
    const apiKey = process.env.SPECTORA_API_KEY;
    const runner = new BookingRunner({
      gate: new SafetyGate(pool),
      driver: createSchedulerDriver(process.env),
      spectora: apiKey ? new SpectoraReadApi({ apiKey }) : null,
      workerId: `worker-${process.pid}`,
    });
    const jobKey = key ?? `dry-run-${randomBytes(8).toString('hex')}`;
    const result = command === 'book' ? await runner.run(jobKey, request) : await runner.dryRun(jobKey, request);
    console.log(JSON.stringify({ key: jobKey, ...result }, null, 2));
    return result.jobId === null && result.state !== 'NEEDS_INPUT' && !result.replayed ? 2 : 0;
  } catch (e) {
    if (e instanceof BrowserDidNotStopError) {
      console.error(`${e.message} Job ${e.jobId}. The browser slot stays held until you release it: ` +
                    `npm run owner -- release-session ${e.jobId} --note "..."`);
      process.exit(3); // now: the browser is a child of this process and dies with it
    }
    throw e;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
