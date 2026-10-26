/**
 * Throwaway, real PostgreSQL server for the safety tests.
 *
 * One server per test file, in a fresh temp directory (initdb + pg_ctl), deleted afterwards. Roles are
 * created from db/roles.sql and the migrations are applied as truss_migrator, exactly like production,
 * into a template database. Each test gets its own database copied from that template, so attempts
 * (which are append-only and cannot be deleted) never leak between tests. The server can be stopped
 * and started again to prove state survives restarts.
 *
 * Needs PostgreSQL 14+ server binaries. Set PG_BIN to their directory if not found automatically.
 * When run as root (CI containers), the server runs as the `postgres` OS user.
 */
import { execFileSync } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import pg from 'pg';

export const ROLE_PASSWORDS = {
  truss_migrator: 'mig-pw-test', truss_app: 'app-pw-test', truss_owner: 'owner-pw-test',
} as const;
export type RoleName = keyof typeof ROLE_PASSWORDS | 'superuser';
const SUPERUSER_PW = 'postgres-pw-test';
const TEMPLATE_DB = 'truss_template';
const ROOT = new URL('../../', import.meta.url).pathname;

function findPgBin(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const versions = readdirSync(base).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) if (existsSync(join(base, v, 'bin', 'pg_ctl'))) return join(base, v, 'bin');
  }
  return ''; // rely on PATH
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function run(bin: string, args: string[]): string {
  const pgBin = findPgBin();
  const exe = pgBin ? join(pgBin, bin) : bin;
  const [cmd, cmdArgs] = isRoot ? ['runuser', ['-u', 'postgres', '--', exe, ...args]] : [exe, args];
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function applyMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const dir = join(ROOT, 'db', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

export class PgCluster {
  readonly dir: string;
  readonly dataDir: string;
  port = 0;
  private pools = new Map<string, pg.Pool>();
  private dbSeq = 0;

  private constructor(dir: string) {
    this.dir = dir;
    this.dataDir = join(dir, 'data');
  }

  static async create(): Promise<PgCluster> {
    const dir = mkdtempSync(join(tmpdir(), 'truss-pgtest-'));
    if (isRoot) {
      const uid = Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim());
      const gid = Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim());
      chownSync(dir, uid, gid);
    }
    const c = new PgCluster(dir);
    run('initdb', ['-D', c.dataDir, '-U', 'postgres', '--auth-local=trust', '--auth-host=scram-sha-256',
                   '--no-sync', '-E', 'UTF8', '--locale=C']);
    c.port = await freePort();
    await c.start();

    const local = new pg.Client({ host: c.dir, port: c.port, user: 'postgres', database: 'postgres' });
    await local.connect();
    await local.query(`ALTER ROLE postgres PASSWORD '${SUPERUSER_PW}'`);
    await local.query(`CREATE DATABASE truss`); // roles.sql grants on this name
    await local.end();

    const su = new pg.Client({ connectionString: c.url('superuser', 'truss') });
    await su.connect();
    await su.query(readFileSync(join(ROOT, 'db', 'roles.sql'), 'utf8'));
    for (const [role, pw] of Object.entries(ROLE_PASSWORDS)) await su.query(`ALTER ROLE ${role} PASSWORD '${pw}'`);
    await su.query(`CREATE DATABASE ${TEMPLATE_DB}`);
    await su.query(`GRANT CREATE ON DATABASE ${TEMPLATE_DB} TO truss_migrator`);
    await su.end();
    await applyMigrations(c.url('truss_migrator', TEMPLATE_DB));
    return c;
  }

  async start(): Promise<void> {
    run('pg_ctl', ['-D', this.dataDir, '-l', join(this.dir, 'server.log'), '-w', '-t', '60',
                   '-o', `-p ${this.port} -k ${this.dir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`,
                   'start']);
  }

  /** Fast shutdown. Every pool is closed; data on disk is kept. */
  async stop(): Promise<void> {
    await this.endPools();
    run('pg_ctl', ['-D', this.dataDir, '-m', 'fast', '-w', 'stop']);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async destroy(): Promise<void> {
    try { await this.stop(); } catch { /* already stopped */ }
    rmSync(this.dir, { recursive: true, force: true });
  }

  url(role: RoleName, db: string): string {
    const user = role === 'superuser' ? 'postgres' : role;
    const pw = role === 'superuser' ? SUPERUSER_PW : ROLE_PASSWORDS[role];
    return `postgres://${user}:${pw}@127.0.0.1:${this.port}/${db}`;
  }

  pool(role: RoleName, db: string): pg.Pool {
    const key = `${db}:${role}`;
    let p = this.pools.get(key);
    if (!p) {
      p = new pg.Pool({ connectionString: this.url(role, db), max: 10 });
      p.on('error', () => undefined);
      this.pools.set(key, p);
    }
    return p;
  }

  async endPools(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  }

  /** A new, migrated database for one test (copied from the template). */
  async freshDb(): Promise<TestDb> {
    const name = `t_${process.pid}_${++this.dbSeq}`;
    const su = new pg.Client({ connectionString: this.url('superuser', 'postgres') });
    await su.connect();
    await su.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
    await su.query(`GRANT CREATE ON DATABASE ${name} TO truss_migrator`);
    await su.end();
    return new TestDb(this, name);
  }
}

export class TestDb {
  constructor(readonly cluster: PgCluster, readonly name: string) {}

  pool(role: RoleName): pg.Pool { return this.cluster.pool(role, this.name); }
  url(role: RoleName): string { return this.cluster.url(role, this.name); }

  /** Re-runs every migration as truss_migrator, as a deploy would. */
  redeploy(): Promise<void> { return applyMigrations(this.url('truss_migrator')); }

  // ---------------------------------------------------------------------------------------------
  // Test clock. Production's safety.clock() is clock_timestamp(). A test (as superuser) swaps in a
  // version that reads a frozen instant from a test-only table. A redeploy restores the real clock.
  // ---------------------------------------------------------------------------------------------
  async freezeClock(at: Date | string): Promise<void> {
    const su = this.pool('superuser');
    await su.query(`CREATE SCHEMA IF NOT EXISTS safety_test`);
    await su.query(`CREATE TABLE IF NOT EXISTS safety_test.frozen (t timestamptz NOT NULL)`);
    await su.query(`GRANT USAGE ON SCHEMA safety_test TO truss_migrator`);
    await su.query(`GRANT SELECT ON safety_test.frozen TO truss_migrator`);
    await su.query(`DELETE FROM safety_test.frozen`);
    await su.query(`INSERT INTO safety_test.frozen (t) VALUES ($1)`, [new Date(at)]);
    await su.query(`CREATE OR REPLACE FUNCTION safety.clock() RETURNS timestamptz LANGUAGE sql VOLATILE AS
      $$ SELECT coalesce((SELECT t FROM safety_test.frozen LIMIT 1), clock_timestamp()) $$`);
  }

  async setClock(at: Date | string): Promise<void> {
    await this.pool('superuser').query(`UPDATE safety_test.frozen SET t = $1`, [new Date(at)]);
  }
}
