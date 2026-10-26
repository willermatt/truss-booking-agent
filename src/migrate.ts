/**
 * Applies db/migrations/*.sql in order as truss_migrator (MIGRATOR_DATABASE_URL). Run on every deploy.
 * Every migration is idempotent and never rewrites safety state, so deploying cannot reset counters,
 * the circuit breaker, or the kill switch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const dir = new URL('../db/migrations/', import.meta.url).pathname;

async function main() {
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
