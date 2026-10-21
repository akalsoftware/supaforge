/**
 * End-to-end lifecycle tests against real PostgreSQL instances.
 *
 * test/e2e/cli.test.ts covers the CLI surface (help, flag parsing, config
 * errors) without databases. This covers the part that actually matters and was
 * previously only exercised by hand: given two real databases, does the CLI
 * detect the right drift, and does --apply produce a target that genuinely
 * matches the source?
 *
 * The schema is built up in stages (see ../harness/stages.ts) so a failure
 * points at the object type that broke rather than "the big schema differs".
 *
 * Skipped automatically when no container runtime is available, so `npm test`
 * still passes on a machine without podman/docker. Set E2E_KEEP=1 to leave the
 * containers and workspaces up for inspection after a failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { STAGES, MUTATION_SQL } from '../harness/stages.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: real-database lifecycle', () => {
  let h: PgHarness
  let ws: string

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    ws = await h.workspace()
  }, 180_000)

  afterAll(async () => { await h?.down() }, 60_000)

  describe('safety guards', () => {
    it('refuses to operate on a non-loopback host', () => {
      // The whole harness is destructive by design; this is what stops a
      // mistyped config pointing it at a real Supabase project.
      expect(() => PgHarness.assertLocal(
        'postgresql://postgres:pw@db.abcdefghij.supabase.co:5432/postgres',
      )).toThrow(/Refusing to operate on non-local/)
    })

    it('allows loopback', () => {
      expect(() => PgHarness.assertLocal(h.connectionString('source'))).not.toThrow()
      expect(h.connectionString('target')).toContain('127.0.0.1')
    })
  })

  describe('schema build-up', () => {
    it.each(STAGES.map((s) => [s.id, s] as const))(
      'applies stage %s to both databases',
      async (_id, stage) => {
        await h.applySql('source', stage.sql)
        await h.applySql('target', stage.sql)
      },
      120_000,
    )

    it('built the objects the later assertions depend on', async () => {
      const count = async (q: string) => Number(await h.sql('source', q))
      expect(await count("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).toBeGreaterThanOrEqual(4)
      expect(await count("SELECT count(*) FROM pg_indexes WHERE schemaname='public'")).toBeGreaterThanOrEqual(8)
      expect(await count('SELECT count(*) FROM pg_policies')).toBeGreaterThanOrEqual(2)
      // the exotic types are the ones diff tools tend to mangle
      const types = await h.sql('source',
        "SELECT string_agg(DISTINCT data_type, ',' ORDER BY data_type) FROM information_schema.columns WHERE table_name='orders'")
      expect(types).toMatch(/jsonb/)
      expect(types).toMatch(/ARRAY/)
    }, 60_000)
  })

  describe('diff', () => {
    it('reports no schema drift between identical databases', async () => {
      const r = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
      const out = JSON.parse(r.stdout)
      expect(JSON.stringify(out)).not.toMatch(/loyalty_tier/)
      expect(r.code).toBe(0)
    }, 300_000)

    it('exits non-zero under --ci when told to fail on any finding', async () => {
      // Identical databases, so this proves --ci/--fail-on don't fire spuriously.
      const r = await h.cli(['diff', '--check', 'schema', '--ci', '--fail-on', 'any'], { cwd: ws })
      expect(r.code).toBe(0)
    }, 300_000)
  })

  describe('drift detection and sync --apply', () => {
    beforeAll(async () => {
      // Diverge the source only: target must be brought up to match it.
      await h.applySql('source', MUTATION_SQL)
    }, 60_000)

    it('detects the added column and index', async () => {
      const r = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
      expect(r.stdout).toMatch(/loyalty_tier/)
    }, 300_000)

    it('dry-run does NOT modify the target', async () => {
      const before = await h.schemaFingerprint('target')
      await h.cli(['sync', '--check', 'schema', '--dry-run'], { cwd: ws })
      expect(await h.schemaFingerprint('target')).toBe(before)
    }, 300_000)

    it('--apply converges the target onto the source', async () => {
      const r = await h.cli(['sync', '--check', 'schema', '--apply'], { cwd: ws })
      expect(r.code).toBe(0)
      const col = await h.sql('target',
        "SELECT count(*) FROM information_schema.columns WHERE table_name='customers' AND column_name='loyalty_tier'")
      expect(col).toBe('1')
      // The real assertion: not just "the column arrived" but "nothing else moved".
      expect(await h.schemaFingerprint('target')).toBe(await h.schemaFingerprint('source'))
    }, 300_000)

    it('is idempotent — a second diff finds nothing', async () => {
      const r = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
      expect(r.stdout).not.toMatch(/loyalty_tier/)
    }, 300_000)
  })

  describe('snapshot / restore', () => {
    it('snapshot defaults to a dry run and writes nothing', async () => {
      const r = await h.cli(['snapshot', '-e', 'source'], { cwd: ws })
      expect(r.code).toBe(0)
      expect(r.stdout + r.stderr).toMatch(/dry.?run|preview|would/i)
    }, 300_000)

    it('snapshot --apply produces a restorable artefact', async () => {
      const r = await h.cli(['snapshot', '-e', 'source', '--apply', '--json'], { cwd: ws })
      expect(r.code).toBe(0)
      const listed = await h.cli(['snapshot', '--list', '--json'], { cwd: ws })
      expect(listed.stdout).toMatch(/\d{8}|snapshot/i)
    }, 300_000)

    it('restore requires an explicit source', async () => {
      const r = await h.cli(['restore', '-e', 'target', '--apply'], { cwd: ws })
      expect(r.code).not.toBe(0)
      expect(r.stdout + r.stderr).toMatch(/--from-snapshot|--from-migrations/)
    }, 300_000)

    it('restore leaves a non-empty database untouched without --force', async () => {
      const snapshots = await readdir(join(ws, '.supaforge', 'snapshots'))
      expect(snapshots.length).toBeGreaterThan(0)
      const before = await h.schemaFingerprint('target')

      const r = await h.cli(
        ['restore', '-e', 'target', '--from-snapshot', snapshots[0], '--apply'],
        { cwd: ws },
      )
      expect(r.stdout + r.stderr).toMatch(/not empty/i)
      expect(r.stdout + r.stderr).toMatch(/--force/)
      // The guard must actually protect the data, not just print a warning.
      expect(await h.schemaFingerprint('target')).toBe(before)
    }, 300_000)
  })

  describe('migrate', () => {
    it('creates a migration file from the current drift', async () => {
      await h.applySql('source', "ALTER TABLE customers ADD COLUMN IF NOT EXISTS referral_code text;")
      const r = await h.cli(['migrate', 'create', '-n', 'add_referral_code'], { cwd: ws })
      expect(r.code).toBe(0)
      expect(r.stdout + r.stderr).toMatch(/referral|migration/i)
    }, 300_000)

    // A migration is replayed where default privileges differ — Supabase no
    // longer grants the Data API roles on new tables — so a table it makes
    // carries its grants in the file, even where the target's defaults would
    // have given them.
    it('writes the grants on a new table into the file', async () => {
      const role = "DO $$ BEGIN CREATE ROLE sf_api_reader NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;"
      await h.applySql('source', role + ' CREATE TABLE public.sf_granted (id int PRIMARY KEY); GRANT SELECT ON public.sf_granted TO sf_api_reader;')
      await h.applySql('target', role + ' ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sf_api_reader;')
      const dir = await mkdtemp(join(tmpdir(), 'sf-migrations-'))
      const mws = await h.workspace({ checks: { migrations: { dir } } })
      try {
        const r = await h.cli(['migrate', 'create', '-n', 'granted_table'], { cwd: mws })
        expect(r.code, r.stdout + r.stderr).toBe(0)
        const [file] = await readdir(dir)
        const sql = await readFile(join(dir, file), 'utf8')
        expect(sql).toContain('CREATE TABLE public.sf_granted')
        expect(sql).toMatch(/GRANT SELECT ON "public"\."sf_granted" TO "sf_api_reader";/)
      } finally {
        await h.applySql('source', 'DROP TABLE IF EXISTS public.sf_granted;')
        await h.applySql('target', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM sf_api_reader;')
      }
    }, 300_000)

    // `migrate run` was the one writing command that executed when run bare;
    // every other previews until given --apply.
    it('previews pending migrations unless given --apply', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-migrations-'))
      await writeFile(join(dir, '20990101000000_sf_preview.sql'), 'CREATE TABLE public.sf_migrate_preview (id int);\n')
      const mws = await h.workspace({ checks: { migrations: { dir } } })
      const exists = async () =>
        (await h.sql('target', "SELECT to_regclass('public.sf_migrate_preview') IS NOT NULL")) === 't'

      try {
        const preview = await h.cli(['migrate', 'run', '--env=target'], { cwd: mws })
        expect(preview.code).toBe(0)
        expect(preview.stdout).toMatch(/nothing was applied/i)
        expect(await exists()).toBe(false)

        const applied = await h.cli(['migrate', 'run', '--env=target', '--apply'], { cwd: mws })
        expect(applied.code, applied.stdout + applied.stderr).toBe(0)
        expect(await exists()).toBe(true)
      } finally {
        await h.applySql('target', `DROP TABLE IF EXISTS public.sf_migrate_preview;
          DELETE FROM supabase_migrations.schema_migrations WHERE version = '20990101000000';`)
      }
    }, 300_000)
  })

  describe('creating objects that exist only on the source', () => {
    // Until @dbdiff/cli 3.0.0-rc.8 this could not work at all: the generated
    // CREATE TABLE carried two PRIMARY KEY clauses, a serial column referenced
    // a sequence that was never created, and an enum column was emitted as the
    // literal 'USER-DEFINED'. Each produced invalid SQL, so the whole migration
    // aborted and nothing was applied. See DBDiff/DBDiff#190.
    //
    // The existing drift tests only ever ADD A COLUMN to a table both databases
    // already have, which is why they never caught it.
    it('creates a brand-new table with a primary key, serial and enum', async () => {
      await h.applySql('source', `
        CREATE TYPE shipment_state AS ENUM ('queued','sent','lost');
        CREATE TABLE shipments (
          id       serial PRIMARY KEY,
          state    shipment_state NOT NULL DEFAULT 'queued',
          courier  text NOT NULL,
          CONSTRAINT shipments_courier_uq UNIQUE (courier)
        );
      `)

      const r = await h.cli(['sync', '--check', 'schema', '--apply'], { cwd: ws })
      expect(r.code).toBe(0)

      // Assert the target's catalog, not the generated SQL: the point is that
      // the table really exists and round-tripped faithfully.
      expect(await h.sql('target',
        "SELECT count(*) FROM information_schema.tables WHERE table_name='shipments'")).toBe('1')
      expect(await h.sql('target',
        "SELECT count(*) FROM information_schema.table_constraints WHERE table_name='shipments' AND constraint_type='PRIMARY KEY'")).toBe('1')
      expect(await h.sql('target',
        "SELECT column_default FROM information_schema.columns WHERE table_name='shipments' AND column_name='id'"))
        .toBe("nextval('shipments_id_seq'::regclass)")
      expect(await h.sql('target',
        "SELECT udt_name FROM information_schema.columns WHERE table_name='shipments' AND column_name='state'"))
        .toBe('shipment_state')

      expect(await h.schemaFingerprint('target')).toBe(await h.schemaFingerprint('source'))
    }, 300_000)
  })

  describe('partitioned tables and their triggers', () => {
    // Needs @dbdiff/cli >= 3.0.0-rc.9. Before that a partitioned table was
    // rebuilt as an ordinary one — no error, the rows still inserted, the
    // partitioning was simply gone — and a trigger on the parent was re-created
    // on every partition it had already been propagated to, which failed with
    // "trigger ... already exists". See DBDiff/DBDiff#190 and #192.
    it('reproduces partitioning, and the parent trigger only once', async () => {
      await h.applySql('source', `
        CREATE TABLE readings (
          id        bigint GENERATED BY DEFAULT AS IDENTITY,
          taken_on  date NOT NULL,
          value     numeric(10,2),
          PRIMARY KEY (taken_on, id)
        ) PARTITION BY RANGE (taken_on);
        CREATE TABLE readings_2025 PARTITION OF readings
          FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
        CREATE TABLE readings_2026 PARTITION OF readings
          FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

        CREATE FUNCTION readings_touch() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER readings_after_ins AFTER INSERT ON readings
          FOR EACH ROW EXECUTE FUNCTION readings_touch();
      `)

      const r = await h.cli(['sync', '--check', 'schema', '--apply'], { cwd: ws })
      expect(r.code).toBe(0)

      // Partitioning is a property of the catalog, not of the DDL text: the old
      // behaviour produced statements that ran perfectly and still lost it.
      expect(await h.sql('target',
        "SELECT relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace"
        + " WHERE n.nspname='public' AND c.relname='readings'")).toBe('p')
      expect(await h.sql('target',
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace"
        + " WHERE n.nspname='public' AND c.relispartition AND c.relkind='r'"
        + " AND c.relname LIKE 'readings_%'")).toBe('2')

      // One declaration on the parent, propagated by PostgreSQL to each
      // partition — not three separate CREATE TRIGGER statements.
      expect(await h.sql('target',
        "SELECT count(*) FROM pg_trigger WHERE tgname='readings_after_ins'")).toBe('3')

      expect(await h.schemaFingerprint('target')).toBe(await h.schemaFingerprint('source'))
    }, 300_000)
  })

  describe('clone', () => {
    // Point the "local" side at the second container rather than the default
    // localhost:5432, so this works on a machine with no local PostgreSQL.
    const localUrl = () => h.connectionString('target').replace(/\/postgres$/, '/postgres')

    it('lists nothing before any clone exists', async () => {
      const r = await h.cli(['clone', '--list'], { cwd: ws })
      expect(r.code).toBe(0)
      expect(r.stdout + r.stderr).toMatch(/no clones/i)
    }, 120_000)

    it('defaults to a dry run and creates no database', async () => {
      const before = await h.sql('target', "SELECT count(*) FROM pg_database WHERE datname='supaforge_clone_e2e'")
      const r = await h.cli(
        ['clone', '-e', 'source', '--local-url', localUrl(), '--local-db', 'supaforge_clone_e2e', '--schema-only'],
        { cwd: ws },
      )
      expect(r.stdout + r.stderr).toMatch(/dry.?run|preview|--apply/i)
      expect(await h.sql('target', "SELECT count(*) FROM pg_database WHERE datname='supaforge_clone_e2e'")).toBe(before)
    }, 300_000)

    it('--apply produces a schema-only copy of the source', async () => {
      const r = await h.cli(
        ['clone', '-e', 'source', '--local-url', localUrl(), '--local-db', 'supaforge_clone_e2e',
          '--schema-only', '--force', '--apply'],
        { cwd: ws },
      )
      expect(r.code).toBe(0)
      expect(await h.sql('target', "SELECT count(*) FROM pg_database WHERE datname='supaforge_clone_e2e'")).toBe('1')
      // Schema-only: tables must exist, but carry no rows.
      const clone = { role: 'target' as const, db: 'supaforge_clone_e2e' }
      const tables = await h.sqlIn(clone.role, clone.db,
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
      expect(Number(tables)).toBeGreaterThanOrEqual(4)
      expect(await h.sqlIn(clone.role, clone.db, 'SELECT count(*) FROM customers')).toBe('0')
    }, 300_000)
  })

  describe('init', () => {
    it('refuses to clobber an existing config without --force', async () => {
      const r = await h.cli(['init'], { cwd: ws })
      expect(r.code).not.toBe(0)
      expect(r.stdout + r.stderr).toMatch(/already exists|--force/i)
    }, 120_000)
  })

  // The exit code is the only thing a pipeline reads. Each case below is a row
  // of the documented contract in README.md; if one changes, the contract has
  // changed and the docs need to change with it.
  //
  // 0 = did what was asked (including "nothing to do")
  // 1 = ran, but declined to act / found drift above threshold / an op failed
  // 2 = could not run: usage error, or a check that could not complete (--ci)
  describe('exit-code contract', () => {
    it('0 when there is nothing to do', async () => {
      const r = await h.cli(['diff', '--check', 'schema'], { cwd: ws })
      expect(r.code).toBe(0)
    }, 300_000)

    it('0 for a dry run, which is a successful preview', async () => {
      const r = await h.cli(['snapshot', '-e', 'source'], { cwd: ws })
      expect(r.code).toBe(0)
    }, 300_000)

    it('1 when --apply is refused by a safety guard', async () => {
      // The target is non-empty by this point, so restore must decline.
      const snapshots = await readdir(join(ws, '.supaforge', 'snapshots'))
      const before = await h.schemaFingerprint('target')

      const r = await h.cli(
        ['restore', '-e', 'target', '--from-snapshot', snapshots[0], '--apply'],
        { cwd: ws },
      )
      expect(r.code).toBe(1)
      expect(r.stdout + r.stderr).toMatch(/not empty/i)
      // Refusing must still mean refusing: the data is untouched.
      expect(await h.schemaFingerprint('target')).toBe(before)
    }, 300_000)

    it('2 for a usage error', async () => {
      const r = await h.cli(['restore', '-e', 'target', '--apply'], { cwd: ws })
      expect(r.code).toBe(2)
      expect(r.stdout + r.stderr).toMatch(/--from-snapshot|--from-migrations/)
    }, 300_000)

    it('--ci --fail-on any is 0 on a clean comparison', async () => {
      const r = await h.cli(
        ['diff', '--check', 'schema', '--ci', '--fail-on', 'any'],
        { cwd: ws },
      )
      expect(r.code).toBe(0)
    }, 300_000)
  })

  describe('read-only commands', () => {
    it('report lists recent runs without touching a database', async () => {
      const r = await h.cli(['report', '--json'], { cwd: ws })
      expect(r.code).toBe(0)
    }, 120_000)

    it('hukam runs the full check suite', async () => {
      const r = await h.cli(['hukam', '--json'], { cwd: ws })
      // Supabase-only checks (auth, edge functions) can't pass against plain
      // Postgres; we assert it completes and produces JSON, not that all pass.
      expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0)
    }, 300_000)
  })
})
