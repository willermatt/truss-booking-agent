/**
 * Starts the booking API.
 *
 *   npm run api                 serve (see the environment below)
 *   npm run api -- new-token    print a new random token and the SHA-256 hash to configure
 *   npm run api -- openapi URL  print the OpenAPI document for a ChatGPT custom GPT (Actions)
 *
 * Environment:
 *   APP_DATABASE_URL          truss_app connection string
 *   SPECTORA_API_KEY          read-only Spectora API key (without it every booking is blocked)
 *   TRUSS_API_TOKEN_SHA256    comma-separated SHA-256 hex digests of accepted bearer tokens (required)
 *   TRUSS_API_HOST            default 127.0.0.1; put a TLS proxy in front for anything not local
 *   TRUSS_API_PORT            default 8787
 *   TRUSS_LIVE_SUBMISSIONS    "enabled" to allow bookings to be submitted; otherwise POST answers 503
 *   TRUSS_SCHEDULER_URL       optional; only the official scheduler or a localhost test server
 *   TRUSS_LOG_CREATE_FIELDS   "1" prints the create request's field names (never values) to stderr
 *
 * If a browser cannot be stopped the process exits with code 3 (so the browser dies with it); run it
 * under a supervisor, and release the browser slot with the owner CLI.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createBookingApi, sha256Hex } from './server.js';
import { createAgentInterface } from '../agent/interface.js';
import { BookingRunner } from '../booking/runner.js';
import { createSchedulerDriver } from '../booking/playwrightDriver.js';
import { SafetyGate } from '../safety/gate.js';
import { SpectoraReadApi } from '../spectora/readApi.js';

if (process.argv[2] === 'openapi') {
  const url = process.argv[3];
  if (!url || !/^https:\/\//.test(url)) { console.error('usage: npm run api -- openapi https://your-api-host'); process.exit(2); }
  const { openApiDocument } = await import('./openapi.js');
  console.log(JSON.stringify(openApiDocument(url), null, 2));
  process.exit(0);
}

if (process.argv[2] === 'new-token') {
  const token = randomBytes(32).toString('base64url');
  console.log(`Token (give this to the AI assistant; it is shown once):\n  ${token}\n`);
  console.log(`Hash (put this in TRUSS_API_TOKEN_SHA256 on the server):\n  ${sha256Hex(token)}`);
  process.exit(0);
}

const env = process.env;
if (!env.APP_DATABASE_URL) { console.error('APP_DATABASE_URL is not set'); process.exit(2); }
// Bounded: a database that stops answering fails the call instead of hanging it (the runner's watchdog
// closes the browser meanwhile).
const pool = new pg.Pool({ connectionString: env.APP_DATABASE_URL, max: 4, connectionTimeoutMillis: 10_000, query_timeout: 35_000, keepAlive: true });
pool.on('error', () => undefined);
const gate = new SafetyGate(pool);
const driver = createSchedulerDriver(env);
const runner = new BookingRunner({
  gate, driver, workerId: `api-${process.pid}`,
  spectora: env.SPECTORA_API_KEY ? new SpectoraReadApi({ apiKey: env.SPECTORA_API_KEY }) : null,
});
const server = createBookingApi({
  agent: createAgentInterface(runner, gate),
  canSubmit: () => env.TRUSS_LIVE_SUBMISSIONS === 'enabled' && driver.canSubmit,
  tokenHashes: (env.TRUSS_API_TOKEN_SHA256 ?? '').split(','),
  onFatal: (e) => {
    console.error(`${e.message} Exiting so the browser stops; release the slot with the owner CLI (release-session).`);
    setTimeout(() => process.exit(3), 100);
  },
});
const host = env.TRUSS_API_HOST || '127.0.0.1';
const port = Number(env.TRUSS_API_PORT || 8787);
server.listen(port, host, () => {
  console.log(`Booking API on http://${host}:${port} — live submissions ${env.TRUSS_LIVE_SUBMISSIONS === 'enabled' ? 'ENABLED' : 'disabled'}`);
});
