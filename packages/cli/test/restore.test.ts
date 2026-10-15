import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  previewSnapshotRestore,
  previewMigrationRestore,
  getPublicTables,
} from '../src/restore.js'
import type { SnapshotManifest, MigrationFile } from '../src/types/config.js'

describe('previewSnapshotRestore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-restore-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns layers with their executable SQL statements', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 2 },
        schema: { captured: true, file: 'schema.sql', itemCount: 1 },
        rls: { captured: true, file: 'rls.sql', itemCount: 1 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), [
      '-- SupaForge Extensions Snapshot',
      '-- 2 extensions',
      '',
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";',
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";',
    ].join('\n'))
    await writeFile(join(tempDir, 'schema.sql'), [
      '-- Schema',
      'CREATE TABLE public.users (id uuid PRIMARY KEY);',
    ].join('\n'))
    await writeFile(join(tempDir, 'rls.sql'), [
      '-- SupaForge RLS Policy Snapshot',
      '-- 1 policies',
      '',
      'CREATE POLICY "users_select"',
      '  ON "public"."users"',
      '  AS PERMISSIVE',
      '  FOR SELECT',
      '  TO public',
      '  USING (true);',
    ].join('\n'))

    const preview = await previewSnapshotRestore(tempDir)

    const extLayer = preview.find(p => p.layer === 'extensions')
    expect(extLayer).toBeDefined()
    expect(extLayer!.statements.length).toBeGreaterThanOrEqual(1)

    const schemaLayer = preview.find(p => p.layer === 'schema')
    expect(schemaLayer).toBeDefined()

    const rlsLayer = preview.find(p => p.layer === 'rls')
    expect(rlsLayer).toBeDefined()
  })

  it('skips uncaptured layers', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 1 },
        cron: { captured: false, file: 'cron.sql', itemCount: 0 },
        webhooks: { captured: false, file: 'webhooks.sql', itemCount: 0 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')

    const preview = await previewSnapshotRestore(tempDir)
    expect(preview.find(p => p.layer === 'cron')).toBeUndefined()
    expect(preview.find(p => p.layer === 'webhooks')).toBeUndefined()
    expect(preview.find(p => p.layer === 'extensions')).toBeDefined()
  })

  it('respects dependency order (extensions before schema before rls)', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 1 },
        schema: { captured: true, file: 'schema.sql', itemCount: 1 },
        rls: { captured: true, file: 'rls.sql', itemCount: 1 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
    await writeFile(join(tempDir, 'schema.sql'), 'CREATE TABLE foo (id int);')
    await writeFile(join(tempDir, 'rls.sql'), 'CREATE POLICY "p" ON foo FOR SELECT TO public USING (true);')

    const preview = await previewSnapshotRestore(tempDir)
    const layerOrder = preview.map(p => p.layer)
    const extIdx = layerOrder.indexOf('extensions')
    const schemaIdx = layerOrder.indexOf('schema')
    const rlsIdx = layerOrder.indexOf('rls')

    expect(extIdx).toBeLessThan(schemaIdx)
    expect(schemaIdx).toBeLessThan(rlsIdx)
  })

  it('handles empty SQL files gracefully', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 0 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), '-- No extensions\n')

    const preview = await previewSnapshotRestore(tempDir)
    // Should not include a layer with 0 executable statements
    expect(preview.find(p => p.layer === 'extensions')).toBeUndefined()
  })
})

describe('previewMigrationRestore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-restore-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns all migrations when no version filter', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250101T120000Z',
      description: 'first',
      parent: null,
      layers: ['schema'],
      up: { sql: ['CREATE TABLE foo (id int);'], api: [] },
      down: { sql: ['DROP TABLE foo;'], api: [] },
    }
    const m2: MigrationFile = {
      version: '20250201T120000Z',
      description: 'second',
      parent: '20250101T120000Z',
      layers: ['rls'],
      up: { sql: ['CREATE POLICY test ON foo FOR SELECT TO public USING (true);'], api: [] },
      down: { sql: ['DROP POLICY test ON foo;'], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m2))

    const result = await previewMigrationRestore(tempDir)
    expect(result).toHaveLength(2)
    expect(result[0].version).toBe('20250101T120000Z')
    expect(result[1].version).toBe('20250201T120000Z')
  })

  it('returns empty when no migrations exist', async () => {
    const result = await previewMigrationRestore(tempDir)
    expect(result).toEqual([])
  })

  it('filters by toVersion', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250101T120000Z',
      description: 'first',
      parent: null,
      layers: ['schema'],
      up: { sql: ['CREATE TABLE foo (id int);'], api: [] },
      down: { sql: ['DROP TABLE foo;'], api: [] },
    }
    const m2: MigrationFile = {
      version: '20250201T120000Z',
      description: 'second',
      parent: '20250101T120000Z',
      layers: ['rls'],
      up: { sql: ['CREATE POLICY test ON foo;'], api: [] },
      down: { sql: ['DROP POLICY test ON foo;'], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m2))

    const result = await previewMigrationRestore(tempDir, '20250101T120000Z')
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('20250101T120000Z')
  })

  it('filters by fromVersion', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250101T120000Z',
      description: 'first',
      parent: null,
      layers: ['schema'],
      up: { sql: ['SELECT 1;'], api: [] },
      down: { sql: [], api: [] },
    }
    const m2: MigrationFile = {
      version: '20250201T120000Z',
      description: 'second',
      parent: '20250101T120000Z',
      layers: ['rls'],
      up: { sql: ['SELECT 2;'], api: [] },
      down: { sql: [], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m2))

    const result = await previewMigrationRestore(tempDir, undefined, '20250201T120000Z')
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('20250201T120000Z')
  })

  it('filters by both fromVersion and toVersion', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const versions = ['20250101T120000Z', '20250201T120000Z', '20250301T120000Z']
    for (const v of versions) {
      const m: MigrationFile = {
        version: v,
        description: `migration-${v}`,
        parent: null,
        layers: ['schema'],
        up: { sql: ['SELECT 1;'], api: [] },
        down: { sql: [], api: [] },
      }
      await writeFile(join(dir, `${v}_migration.json`), JSON.stringify(m))
    }

    const result = await previewMigrationRestore(tempDir, '20250201T120000Z', '20250201T120000Z')
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('20250201T120000Z')
  })
})

describe('getPublicTables', () => {
  it('is exported and callable', () => {
    expect(typeof getPublicTables).toBe('function')
  })
})

/**
 * Replaying a real pg_dump.
 *
 * `restore` used to look for a `schema.sql` that `snapshot` never wrote, so the
 * schema layer was skipped and restoring into an empty database produced no
 * tables (issue #80). Now that the file exists, what it contains has to survive
 * being split into statements — and a pg_dump contains the three things the old
 * splitter got wrong.
 */
describe('previewSnapshotRestore: a pg_dump schema layer', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-restore-dump-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const manifest = (): SnapshotManifest => ({
    version: 1,
    timestamp: '20260929T120000Z',
    environment: 'prod',
    layers: {
      schema: { captured: true, file: 'schema.json', itemCount: 1, sqlFile: 'schema.sql' },
    },
  })

  async function preview(schemaSql: string) {
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest()))
    await writeFile(join(tempDir, 'schema.sql'), schemaSql)
    const layers = await previewSnapshotRestore(tempDir)
    return layers.find(l => l.layer === 'schema')?.statements ?? []
  }

  it('keeps a dollar-quoted routine body in one piece', async () => {
    const statements = await preview(`--
-- Name: touch_seen(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_seen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.seen_at := now();
    RETURN NEW;
END;
$$;
`)

    // Split on ";" this arrived as three fragments: the header plus `AS $$
    // BEGIN NEW.seen_at := now()`, then `RETURN NEW`, then `END; $$`. None
    // parses, and every trigger executing the function failed after it.
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('RETURN NEW;')
    expect(statements[0]).toContain('$$')
  })

  it('drops the psql wrappers pg_dump 16+ emits', async () => {
    const statements = await preview(`\\restrict aBcDeF

CREATE TABLE public.t (id integer);

\\unrestrict aBcDeF;
`)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('CREATE TABLE public.t')
    expect(statements.some(s => s.includes('restrict'))).toBe(false)
  })

  it('makes CREATE SCHEMA conditional', async () => {
    const statements = await preview(`--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;
`)

    // Every database already has `public`, and a dump scoped to it recreates
    // it — so an otherwise clean restore failed on its first statement.
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/CREATE SCHEMA IF NOT EXISTS public/i)
  })

  it('leaves a CREATE SCHEMA that is already conditional alone', async () => {
    const statements = await preview('CREATE SCHEMA IF NOT EXISTS reporting;\n')

    expect(statements[0]).toMatch(/CREATE SCHEMA IF NOT EXISTS reporting/i)
    expect(statements[0]).not.toMatch(/IF NOT EXISTS\s+IF NOT EXISTS/i)
  })

  it('does not rewrite the words appearing inside a body', async () => {
    const statements = await preview(
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN EXECUTE 'CREATE SCHEMA x'; END; $$;\n`,
    )

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("EXECUTE 'CREATE SCHEMA x'")
    expect(statements[0]).not.toContain('IF NOT EXISTS')
  })

  it('discards comment-only blocks', async () => {
    const statements = await preview(`--
-- PostgreSQL database dump
--

--
-- Name: t; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t (id integer);
`)

    expect(statements).toHaveLength(1)
  })
})

describe('summarizeStatement', () => {
  it('names the statement, not the blank line above it', async () => {
    const { summarizeStatement } = await import('../src/restore.js')

    // pg_dump writes `-- header\n-- 2 extensions\n\nCREATE EXTENSION …`.
    // Skipping only comment lines picked the empty line, so restore reported
    // `✓ [sql]` with nothing after it — and an error as `✗ [sql] :` with no
    // indication of which statement failed (issue #80).
    expect(summarizeStatement('-- header\n-- 2 extensions\n\nCREATE EXTENSION x;'))
      .toBe('CREATE EXTENSION x;')
  })

  it('truncates something long', async () => {
    const { summarizeStatement } = await import('../src/restore.js')
    const summary = summarizeStatement(`SELECT ${'a'.repeat(200)}`)

    expect(summary.length).toBe(80)
    expect(summary.endsWith('...')).toBe(true)
  })

  it('falls back to the whole statement when there is nothing else', async () => {
    const { summarizeStatement } = await import('../src/restore.js')
    expect(summarizeStatement('-- only a comment')).toBe('-- only a comment')
  })
})

/**
 * Where restore tracks what it applied (issue #93).
 *
 * It created `public._supaforge_migrations`, unqualified. On Supabase a table
 * in `public` receives the project's default grants to `anon` and
 * `authenticated`, and this one was created with RLS off — so anyone holding
 * the public anon key could read it, insert into it and delete from it through
 * the Data API, and so decide which migrations a later restore believed were
 * already applied. It was also a second, disagreeing record of the same thing
 * that `migrate run` tracks.
 */
describe('restore: the migration tracking table', () => {
  it('lives in a schema the Data API does not expose', async () => {
    const { MIGRATIONS_TABLE, MIGRATIONS_SCHEMA } = await import('../src/constants.js')

    expect(MIGRATIONS_SCHEMA).toBe('supabase_migrations')
    expect(MIGRATIONS_TABLE).toBe('supabase_migrations.schema_migrations')
  })

  it('is not in public, and is not restore\'s own', async () => {
    // Stated as the two properties that were wrong, so a change back to either
    // fails here rather than in a security report.
    const { MIGRATIONS_TABLE } = await import('../src/constants.js')

    expect(MIGRATIONS_TABLE).not.toMatch(/^public\./)
    expect(MIGRATIONS_TABLE).not.toContain('_supaforge_migrations')
  })

  it('is the same table migrate uses', async () => {
    const constants = await import('../src/constants.js')
    const migrate = await import('../src/migrate.js')

    // `migrate run` and `restore --from-migrations` recording into different
    // tables meant each thought the other's work had not happened.
    expect(migrate.BOOTSTRAP_SQL).toContain(constants.MIGRATIONS_TABLE)
    expect(migrate.BOOTSTRAP_SQL).toContain(constants.MIGRATIONS_SCHEMA)
  })
})

/**
 * A migration that applies nothing is not applied (issue #93).
 *
 * `snapshot --migration` writes files whose schema layer is the comment
 * `-- Schema changed. Use @dbdiff/cli to generate migration SQL.`, and the
 * baseline `clone` writes has no statements at all. Recording those as done
 * meant a restore into an empty database built nothing, reported success, and
 * left the tracking table asserting the schema was in place.
 */
describe('restore: recognising a migration with nothing in it', () => {
  it('treats the snapshot marker comment as no SQL', async () => {
    const { isCommentOnly } = await import('../src/utils/sql-split.js')

    expect(isCommentOnly('-- Schema changed. Use @dbdiff/cli to generate migration SQL.')).toBe(true)
  })

  it('treats a multi-line comment block as no SQL', async () => {
    const { isCommentOnly } = await import('../src/utils/sql-split.js')

    expect(isCommentOnly('-- nothing\n--\n-- here either')).toBe(true)
  })

  it('does not mistake real SQL under a comment for nothing', async () => {
    const { isCommentOnly } = await import('../src/utils/sql-split.js')

    expect(isCommentOnly('-- add the column\nALTER TABLE t ADD COLUMN c text;')).toBe(false)
  })
})

describe('restoreError', () => {
  it('explains running out of locks, and the two ways round it', async () => {
    const { restoreError } = await import('../src/restore.js')
    const err = Object.assign(new Error('out of shared memory'), { code: '53200' })
    expect(restoreError(err, true)).toMatch(/more locks than the server allows in one transaction.*max_locks_per_transaction.*--no-transaction/)
    expect(restoreError(err, false)).toBe('out of shared memory')
    expect(restoreError(new Error('syntax error'), true)).toBe('syntax error')
  })
})
