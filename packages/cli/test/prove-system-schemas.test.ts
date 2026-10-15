import { describe, it, expect } from 'vitest'
import { prepareClone, residualHeldBack, supportingSchemas, tolerateExistingSchemas } from '../src/prove.js'
import type { QueryFn } from '../src/db.js'

/**
 * Preparing a proof clone on a target with a system-schema extension (#94).
 *
 * `--prove` aborted on any target with `pg_cron` — every Supabase project with
 * Cron enabled — because Supabase installs it into `pg_catalog`. The extension
 * query filtered `plpgsql` by *name*, so `pg_cron` came through and the clone
 * preparation ran `CREATE SCHEMA IF NOT EXISTS "pg_catalog"`. PostgreSQL
 * rejects a name beginning with `pg_` before it evaluates `IF NOT EXISTS`:
 *
 *     error: unacceptable schema name "pg_catalog"  (42939)
 */
describe('prepareClone: extensions in system schemas', () => {
  /**
   * A query function that answers the extension query from `installed`,
   * records every statement it is asked to run, and fails on a reserved schema
   * the way PostgreSQL does.
   */
  function harness(installed: Array<{ name: string; schema: string }>) {
    const ran: string[] = []

    const queryFn = (async (_url: string, sql: string) => {
      ran.push(sql)

      if (sql.includes('pg_extension')) {
        // Apply the query's own filter, so the test exercises the predicate
        // rather than trusting it.
        return installed.filter(e =>
          !['pg_catalog', 'information_schema'].includes(e.schema)
          && !e.schema.startsWith('pg_'))
      }

      const reserved = /CREATE SCHEMA IF NOT EXISTS "(pg_[^"]*|information_schema)"/.exec(sql)
      if (reserved) {
        throw new Error(`unacceptable schema name "${reserved[1]}"`)
      }
      return []
    }) as unknown as QueryFn

    return { ran, queryFn }
  }

  const SUPABASE_WITH_CRON = [
    { name: 'plpgsql', schema: 'pg_catalog' },
    { name: 'pg_cron', schema: 'pg_catalog' },
    { name: 'pg_net', schema: 'extensions' },
    { name: 'pgsodium', schema: 'pgsodium' },
    { name: 'pg_graphql', schema: 'graphql' },
  ]

  it('does not try to create a system schema', async () => {
    const { ran, queryFn } = harness(SUPABASE_WITH_CRON)

    await prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn)

    const created = ran.filter(sql => sql.startsWith('CREATE SCHEMA'))
    expect(created.some(sql => sql.includes('pg_catalog'))).toBe(false)
    expect(created.some(sql => sql.includes('information_schema'))).toBe(false)
  })

  it('completes on a target with pg_cron', async () => {
    // The whole of #94: this threw before.
    const { queryFn } = harness(SUPABASE_WITH_CRON)

    await expect(
      prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn),
    ).resolves.toBeUndefined()
  })

  it('still creates the schemas that extensions genuinely need', async () => {
    // `extensions` and `pgsodium` are ordinary schemas a Supabase project has,
    // and a column default calling `extensions.uuid_generate_v4()` cannot be
    // created without them. Skipping by a loose `pg%` match would have taken
    // `pgsodium` with it.
    const { ran, queryFn } = harness(SUPABASE_WITH_CRON)

    await prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn)

    const created = ran.filter(sql => sql.startsWith('CREATE SCHEMA')).join('\n')
    expect(created).toContain('"extensions"')
    expect(created).toContain('"pgsodium"')
    expect(created).toContain('"graphql"')
  })

  // pg_dump --schema=public does not dump an extension installed in public,
  // so the clone has it installed after the schema is dropped; the dump's own
  // CREATE SCHEMA is made tolerant of finding the schema there.
  it('recreates a proved schema to install its extension, after dropping it', async () => {
    const { ran, queryFn } = harness([{ name: 'ext_in_public', schema: 'public' }])

    await prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn)

    const at = (sql: string) => ran.indexOf(sql)
    expect(at('DROP SCHEMA IF EXISTS "public" CASCADE')).toBeGreaterThanOrEqual(0)
    expect(at('CREATE SCHEMA IF NOT EXISTS "public"')).toBeGreaterThan(at('DROP SCHEMA IF EXISTS "public" CASCADE'))
    expect(at('CREATE EXTENSION IF NOT EXISTS "ext_in_public" WITH SCHEMA "public"'))
      .toBeGreaterThan(at('CREATE SCHEMA IF NOT EXISTS "public"'))
  })

  it('survives a schema the clone will not accept', async () => {
    // Given the same tolerance as the CREATE EXTENSION below it: the replay
    // fails next with a better error than this one.
    const ran: string[] = []
    const queryFn = (async (_url: string, sql: string) => {
      ran.push(sql)
      if (sql.includes('pg_extension')) return [{ name: 'weird', schema: 'weird' }]
      if (sql.startsWith('CREATE SCHEMA')) throw new Error('permission denied for database')
      return []
    }) as unknown as QueryFn

    await expect(
      prepareClone('postgres://clone', 'postgres://target', ['public'], queryFn),
    ).resolves.toBeUndefined()
  })
})

describe('the schemas a proof copies besides its own', () => {
  it('follows what the proved schemas lean on, transitively, once each', async () => {
    const asked: string[][] = []
    const queryFn: QueryFn = async (_url, sql) => {
      const from = [...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).filter(s => !['pg_class', 'pg_proc', 'pg_type', 'pg_constraint', 'pg_attrdef', 'pg_policy', 'pg_trigger', 'pg_rewrite', 'pg_catalog', 'information_schema', 'n', 'a', 'e'].includes(s))
      asked.push(from)
      const leans: Record<string, string[]> = { public: ['auth', 'extensions'], auth: ['extensions'], extensions: [] }
      return from.flatMap(s => leans[s] ?? []).map(schema => ({ schema })) as never
    }

    expect(await supportingSchemas('postgres://x', ['public'], queryFn)).toEqual(['auth', 'extensions'])
    expect(asked).toEqual([['public'], ['auth', 'extensions']])
  })

  it('lets a CREATE SCHEMA find its schema already there', () => {
    expect(tolerateExistingSchemas('CREATE SCHEMA auth;\nCREATE SCHEMA IF NOT EXISTS x;\nSELECT 1;'))
      .toBe('CREATE SCHEMA IF NOT EXISTS auth;\nCREATE SCHEMA IF NOT EXISTS x;\nSELECT 1;')
  })
})

describe('residual the held-back fixes account for', () => {
  const held = ['DROP TABLE IF EXISTS "legacy";', 'DROP TYPE IF EXISTS "legacy_kind";', 'ALTER TABLE "t" DROP COLUMN "old";']

  it('is the objects those fixes would have dropped, left on the target', () => {
    const r = residualHeldBack([
      'table public.legacy: unexpected',
      'type public.legacy_kind: unexpected',
      'column public.t.old: unexpected',
    ], held)
    expect(r.unexplained).toEqual([])
    expect(r.heldBack).toHaveLength(3)
  })

  it('leaves anything else to block the apply, even on the same objects', () => {
    const r = residualHeldBack([
      'table public.legacy: unexpected',
      'column public.t.total: type numeric → integer',
      'table public.other: unexpected',
      'column public.t.old: not null yes → no',
    ], held)
    expect(r.unexplained).toEqual([
      'column public.t.total: type numeric → integer',
      'table public.other: unexpected',
      'column public.t.old: not null yes → no',
    ])
  })

  // A serial or identity column's sequence goes with its table, or with the
  // column: a held-back drop of either leaves the sequence too.
  it('counts the sequence a held-back table or column owns', () => {
    const r = residualHeldBack([
      'sequence public.legacy_id_seq: unexpected (owned by legacy.id)',
      'sequence public.t_old_seq: unexpected (owned by t.old)',
      'sequence public."Odd_n_seq": unexpected (owned by "Odd"."n")',
      'sequence public.free_seq: unexpected',
      'sequence public.kept_id_seq: unexpected (owned by kept.id)',
    ], [...held, 'DROP TABLE IF EXISTS "Odd";'])
    expect(r.heldBack).toHaveLength(3)
    expect(r.unexplained).toEqual([
      'sequence public.free_seq: unexpected',
      'sequence public.kept_id_seq: unexpected (owned by kept.id)',
    ])
  })

  it('accounts for nothing when nothing is held back', () => {
    expect(residualHeldBack(['table public.legacy: unexpected'], []).unexplained).toHaveLength(1)
  })
})
