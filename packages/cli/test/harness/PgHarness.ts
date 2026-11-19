/**
 * PgHarness — configurable container harness for realistic SupaForge e2e tests.
 *
 * Spins up a pair of throwaway Postgres instances (a "remote"/source and a
 * "local"/target), lets a test build schema up in stages, then exercises the
 * real CLI against them and asserts the diff/sync behaviour.
 *
 * Design notes:
 *  - Podman is preferred over Docker (lighter); the runtime is auto-detected and
 *    can be forced. We use plain `run`/`exec` rather than compose so there is no
 *    podman-compose dependency.
 *  - Containers use --network=host with an explicit PGPORT. Podman 4.9's bridge
 *    networking needs netavark, which is broken on some hosts; host networking
 *    avoids that entirely and is fine for ephemeral test databases.
 *  - Every instance is namespaced by a run id and torn down in `down()`, so
 *    parallel runs and crashed runs don't collide.
 *  - NOTHING here ever touches a non-local database: `assertLocal()` refuses any
 *    connection string that isn't loopback, so a misconfigured test can't point
 *    destructive operations at a real Supabase project.
 */
import { fingerprintSql, stateSql, type SchemaState } from '@akal/pg-conformance';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

export type Runtime = 'podman' | 'docker';
export type Role = 'source' | 'target';

export interface PgHarnessOptions {
  /** Force a runtime; default auto-detect, preferring podman. */
  runtime?: Runtime;
  /** Postgres image. */
  image?: string;
  /**
   * A different image for one side — a Supabase source and a plain target,
   * say, or two major versions. Every other suite runs twins of `image`,
   * which can never show what differs between servers: a role is the whole
   * server's, an extension may exist on one side only.
   */
  images?: Partial<Record<Role, string>>;
  /**
   * Host ports for each role. Omit to have a free port chosen at startup, which
   * is the default: fixed ports collide when suites run in parallel, and there
   * is no reason to pin a listening port to a predictable value.
   */
  ports?: { source: number; target: number };
  /** Leave containers running after down() — useful when debugging a failure. */
  keep?: boolean;
  /** Superuser password. */
  password?: string;
  /** Database name created in each instance. */
  database?: string;
  /** Seconds to wait for readiness. */
  readyTimeoutSec?: number;
  /** Log container lifecycle to stderr. */
  verbose?: boolean;
  /** Override the CLI entrypoint (defaults to the package's bin/run.js). */
  cliEntry?: string;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Working directory the command ran in — inspect .supaforge/ artefacts here. */
  cwd: string;
}

export class PgHarness {
  readonly runtime: Runtime;
  readonly image: string;
  private readonly images: Partial<Record<Role, string>>;
  private resolvedPorts: { source: number; target: number } | null;
  readonly password: string;
  readonly database: string;
  private readonly keep: boolean;
  private readonly readyTimeoutSec: number;
  private readonly verbose: boolean;
  private readonly cliEntryOverride?: string;
  private readonly runId: string;
  private started: Role[] = [];
  private workspaces: string[] = [];

  constructor(opts: PgHarnessOptions = {}) {
    this.runtime = opts.runtime ?? PgHarness.detectRuntime();
    this.image = opts.image ?? 'docker.io/library/postgres:16-alpine';
    this.images = opts.images ?? {};
    // Resolved in up() when not supplied, so each run gets its own free ports.
    this.resolvedPorts = opts.ports ?? null;
    this.password = opts.password ?? 'supaforge-test';
    this.database = opts.database ?? 'postgres';
    this.keep = opts.keep ?? false;
    this.readyTimeoutSec = opts.readyTimeoutSec ?? 60;
    this.verbose = opts.verbose ?? false;
    // SUPAFORGE_E2E_CLI points the e2e suites at an installed package's
    // bin/run.js instead of this checkout's — how scripts/test-release-candidates.sh
    // tests the packed artifact a release would publish.
    this.cliEntryOverride = opts.cliEntry ?? (process.env.SUPAFORGE_E2E_CLI || undefined);
    this.runId = `sf-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  }

  static detectRuntime(): Runtime {
    for (const rt of ['podman', 'docker'] as Runtime[]) {
      try {
        execFileSync(rt, ['--version'], { stdio: 'ignore' });
        return rt;
      } catch { /* try next */ }
    }
    throw new Error('Neither podman nor docker is available');
  }

  private log(msg: string): void {
    if (this.verbose) process.stderr.write(`[PgHarness] ${msg}\n`);
  }

  /** The image a role runs. */
  imageFor(role: Role): string {
    return this.images[role] ?? this.image;
  }

  private name(role: Role): string {
    return `${this.runId}-${role}`;
  }

  port(role: Role): number {
    if (!this.resolvedPorts) {
      throw new Error('Ports are assigned in up(); call it before asking for one.');
    }
    return this.resolvedPorts[role];
  }

  /**
   * Ask the OS for a free port by binding to 0 and reading back what it gave
   * us. There is a small race between closing the socket and the container
   * binding it, which is acceptable for a test harness and far less
   * collision-prone than hardcoding.
   */
  private static freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))));
      });
    });
  }

  /** libpq connection string for a role. Always loopback. */
  connectionString(role: Role): string {
    return `postgresql://postgres:${this.password}@127.0.0.1:${this.port(role)}/${this.database}`;
  }

  /**
   * Guard against a test ever pointing destructive operations at a real
   * database. Only loopback is permitted.
   */
  static assertLocal(conn: string): void {
    const host = /@([^:/]+)/.exec(conn)?.[1] ?? '';
    const ok = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host);
    if (!ok) {
      throw new Error(
        `Refusing to operate on non-local database host "${host}". ` +
        'The harness only ever runs destructive operations against loopback.',
      );
    }
  }

  // ---- lifecycle ----------------------------------------------------------

  async up(roles: Role[] = ['source', 'target']): Promise<void> {
    if (!this.resolvedPorts) {
      this.resolvedPorts = {
        source: await PgHarness.freePort(),
        target: await PgHarness.freePort(),
      };
    }
    for (const role of roles) {
      await this.startOne(role);
      this.started.push(role);
    }
    await Promise.all(roles.map((r) => this.waitReady(r)));
  }

  /**
   * Supabase's image is published to two registries, and either may refuse a
   * pull for a while ("toomanyrequests: Data limit exceeded"). Each is tried
   * in turn, a few times, and the role runs whichever one arrived.
   */
  private async pullSupabaseImage(role: Role): Promise<void> {
    const image = this.imageFor(role);
    if (!isSupabaseImage(image)) return;
    if (await this.rt(['image', 'inspect', image]).then(() => true, () => false)) return;
    const tag = image.slice(image.indexOf('supabase/postgres:'));
    const mirrors = [image, ...['public.ecr.aws', 'docker.io'].map((r) => `${r}/${tag}`).filter((m) => m !== image)];
    let last: unknown;
    for (const mirror of mirrors) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.rt(['pull', '-q', mirror]);
          this.images[role] = mirror;
          return;
        } catch (err) {
          last = err;
          this.log(`pull ${mirror} failed (attempt ${attempt})`);
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
    }
    throw last;
  }

  private async startOne(role: Role): Promise<void> {
    const name = this.name(role);
    await this.pullSupabaseImage(role);
    await this.rt(['rm', '-f', '-v', name]).catch(() => undefined);
    this.log(`starting ${name} on :${this.port(role)} (${this.runtime})`);
    await this.rt([
      'run', '-d', '--name', name,
      // Host networking: avoids podman's bridge/netavark dependency entirely.
      '--network=host',
      '-e', `POSTGRES_PASSWORD=${this.password}`,
      // Supabase's image reads its settings (preloaded libraries) from
      // /etc/postgresql, its init scripts want a JWT secret, and they connect
      // on the default port's socket — so its port is given to the final
      // server only. Initialisation listens on no TCP port at all.
      ...(isSupabaseImage(this.imageFor(role))
        ? ['-e', 'JWT_SECRET=test-only-jwt-secret-at-least-32-characters-long']
        : ['-e', `PGPORT=${this.port(role)}`]),
      this.imageFor(role),
      ...(isSupabaseImage(this.imageFor(role)) ? ['postgres', '-D', '/etc/postgresql', '-c', `port=${this.port(role)}`] : []),
      // Test databases are disposable — trade durability for speed.
      '-c', 'fsync=off', '-c', 'full_page_writes=off',
      // Host networking skips the host firewall's DOCKER-USER rules: loopback only.
      '-c', 'listen_addresses=127.0.0.1',
    ]);
  }

  private async waitReady(role: Role): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutSec * 1000;
    while (Date.now() < deadline) {
      try {
        // Over TCP, not the socket. The image's entrypoint first runs a
        // temporary server for initdb's scripts, listening on the socket only,
        // then stops it and starts the real one. A socket probe could succeed
        // against the temporary server, and the first query then found no
        // socket at all ("No such file or directory").
        await this.rt([
          'exec', this.name(role), 'pg_isready', '-U', 'postgres',
          '-h', '127.0.0.1', '-p', String(this.port(role)),
        ]);
        this.log(`${role} ready`);
        return;
      } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    const logs = await this.rt(['logs', '--tail', '20', this.name(role)]).catch(() => ({ stdout: '', stderr: '' }));
    throw new Error(`${role} not ready after ${this.readyTimeoutSec}s. Logs:\n${logs.stdout}${logs.stderr}`);
  }

  async down(): Promise<void> {
    if (this.keep) { this.log(`keep=true, leaving containers and workspaces (${this.workspaces.join(', ')})`); return; }
    for (const role of this.started) {
      await this.rt(['rm', '-f', '-v', this.name(role)]).catch(() => undefined);
    }
    this.started = [];
    for (const dir of this.workspaces) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.workspaces = [];
  }

  // ---- sql ---------------------------------------------------------------

  /** Run SQL and return stdout (tuples-only, unaligned). */
  async sql(role: Role, statement: string): Promise<string> {
    const { stdout } = await this.rt([
      'exec', '-i', this.name(role),
      'psql', '-U', 'postgres', '-p', String(this.port(role)), '-d', this.database,
      '-v', 'ON_ERROR_STOP=1', '-tAc', statement,
    ]);
    return stdout.trim();
  }

  /** Run SQL against a *different* database on the same instance (e.g. a clone). */
  async sqlIn(role: Role, database: string, statement: string): Promise<string> {
    const { stdout } = await this.rt([
      'exec', '-i', this.name(role),
      'psql', '-U', 'postgres', '-p', String(this.port(role)), '-d', database,
      '-v', 'ON_ERROR_STOP=1', '-tAc', statement,
    ]);
    return stdout.trim();
  }

  /** Apply a multi-statement SQL script (a fixture stage). */
  async applySql(role: Role, script: string): Promise<void> {
    // Fed over stdin so nothing needs mounting into the container.
    await this.rtStdin([
      'exec', '-i', this.name(role),
      'psql', '-U', 'postgres', '-p', String(this.port(role)), '-d', this.database,
      '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ], script);
  }

  /** libpq connection string for another database on a role's server. */
  urlFor(role: Role, database: string): string {
    return this.connectionString(role).replace(/\/[^/]*$/, `/${database}`);
  }

  /** Create an empty database on a role's server, replacing any of that name. */
  async createDatabase(role: Role, database: string): Promise<void> {
    await this.sql(role, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await this.sql(role, `CREATE DATABASE "${database}"`);
  }

  async dropDatabase(role: Role, database: string): Promise<void> {
    await this.sql(role, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }

  /** Apply a multi-statement script to another database on a role's server. */
  async applySqlIn(role: Role, database: string, script: string): Promise<void> {
    await this.rtStdin([
      'exec', '-i', this.name(role),
      'psql', '-U', 'postgres', '-p', String(this.port(role)), '-d', database,
      '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ], script);
  }

  /**
   * A database's schemas as data, from @akal/pg-conformance's state query.
   *
   * The oracle the scenario suites judge convergence by. It is independent of
   * DBDiff: asking DBDiff whether its own migration worked can only ever agree
   * with it.
   */
  async stateIn(role: Role, database: string, schemas = ['public']): Promise<SchemaState> {
    return JSON.parse(await this.sqlIn(role, database, stateSql(schemas).replace(/;\s*$/, ''))) as SchemaState;
  }

  /**
   * What exists across the whole server rather than in one database: roles and
   * databases. A command that claims to change one database — or none, for a
   * dry run or a proof — must leave this as it found it.
   */
  async serverState(role: Role): Promise<{ roles: string[]; databases: string[] }> {
    const list = async (sql: string) => (await this.sql(role, sql)).split('\n').filter(Boolean);
    return {
      roles: await list('SELECT rolname FROM pg_roles ORDER BY 1'),
      databases: await list('SELECT datname FROM pg_database ORDER BY 1'),
    };
  }

  /** Structural fingerprint used to assert two databases match. */
  /**
   * Structural fingerprint of a role's schemas, from @akal/pg-conformance.
   *
   * This used to be a local query that read columns from information_schema and
   * compared functions by signature. It could not see a partitioned table, a
   * partition bound, a view's body, a trigger, a type or a sequence — so an
   * assertion that two schemas matched was much weaker than it appeared.
   */
  async schemaFingerprint(role: Role, schemas = ['public']): Promise<string> {
    return this.sql(role, fingerprintSql(schemas).replace(/;\s*$/, ''));
  }

  // ---- cli ---------------------------------------------------------------

  /**
   * Create a throwaway working directory containing a real supaforge.config.json
   * pointing at the harness databases. Commands write `.supaforge/` (snapshots,
   * migrations) relative to cwd, so each test gets its own directory rather than
   * polluting the repo.
   */
  async workspace(overrides: Record<string, unknown> = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sf-ws-'));
    const config = {
      environments: {
        source: { dbUrl: this.connectionString('source') },
        target: { dbUrl: this.connectionString('target') },
      },
      source: 'source',
      target: 'target',
      ...overrides,
    };
    await writeFile(join(dir, 'supaforge.config.json'), JSON.stringify(config, null, 2) + '\n');
    this.workspaces.push(dir);
    return dir;
  }

  /**
   * Invoke the real CLI the way a user would — the built dist entrypoint, in a
   * workspace with a config file. Non-zero exits are returned rather than
   * thrown, because "does this command fail cleanly?" is itself under test.
   */
  async cli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
    // Use the real oclif launcher (package.json "bin") rather than dist/index.js:
    // the latter resolves no commands and exits 0 on everything, which would make
    // every assertion here vacuously pass.
    // test/harness/ -> packages/cli/
    const cliEntry = this.cliEntryOverride
      ?? join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'bin', 'run.js');
    const cwd = opts.cwd ?? (await this.workspace());
    try {
      const { stdout, stderr } = await exec('node', [cliEntry, ...args], {
        cwd,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', ...opts.env },
        timeout: 300_000,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr, cwd };
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '', cwd };
    }
  }

  // ---- runtime plumbing ---------------------------------------------------

  private rt(args: string[]) {
    return exec(this.runtime, args, { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
  }

  private rtStdin(args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.runtime, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      p.on('close', (code: number) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
      p.on('error', reject);
      p.stdin.write(input);
      p.stdin.end();
    });
  }
}

/** Supabase's Postgres image, which starts differently from the official one. */
function isSupabaseImage(image: string): boolean {
  return /(^|\/)supabase\/postgres:/.test(image)
}
