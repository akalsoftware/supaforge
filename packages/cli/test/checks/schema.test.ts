import { describe, it, expect } from 'vitest'
import { CheckSkipped } from '../../src/checks/base.js'
import { SchemaCheck } from '../../src/checks/schema.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { RunDbDiffFn } from '../../src/checks/schema.js'
import type { DbDiffOptions } from '../../src/dbdiff.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
      ignoreSchemas: ['auth', 'storage'],
    },
  }
}

/** A queryFn that returns no tables (simulates empty ignored schemas). */
const noTablesQuery: QueryFn = async () => []

describe('SchemaCheck', () => {
  it('has name "schema"', () => {
    const check = new SchemaCheck(async () => ({ up: '', down: '' }))
    expect(check.name).toBe('schema')
  })

  it('returns empty issues when no diff found', async () => {
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('returns issues from @dbdiff/cli output', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";',
    })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].check).toBe('schema')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].sql?.up).toContain('ADD COLUMN')
    expect(issues[0].sql?.down).toContain('DROP COLUMN')
  })

  it('classifies DROP TABLE as critical', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'DROP TABLE "legacy_data";',
      down: 'CREATE TABLE "legacy_data" (id int);',
    })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('passes options to @dbdiff/cli', async () => {
    let capturedOptions: unknown
    const runFn: RunDbDiffFn = async (opts) => {
      capturedOptions = opts
      return { up: '', down: '' }
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await check.scan(mockContext())

    expect(capturedOptions).toMatchObject({
      type: 'schema',
      sourceUrl: 'postgres://source',
      targetUrl: 'postgres://target',
      ignoreSchemas: ['auth', 'storage'],
    })
  })

  it('skips with a reason when @dbdiff/cli is not installed', async () => {
    // Was: returned [], reporting the most important layer in the tool as
    // clean when it had not run at all (issue #42).
    const runFn: RunDbDiffFn = async () => {
      throw new Error('@dbdiff/cli is not installed. Install it with: npm install -g @dbdiff/cli')
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await expect(check.scan(mockContext())).rejects.toThrow(CheckSkipped)
    await expect(check.scan(mockContext())).rejects.toThrow('@dbdiff/cli is not installed')
  })

  it('rethrows non-installation errors', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('Connection refused')
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await expect(check.scan(mockContext())).rejects.toThrow('Connection refused')
  })

  it('reports error cleanly when dbdiff cannot connect (no output file)', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('dbdiff failed with no error output')
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await expect(check.scan(mockContext())).rejects.toThrow('dbdiff failed')
    await expect(check.scan(mockContext())).rejects.not.toThrow('Command failed:')
  })

  it('uses DEFAULT_IGNORE_SCHEMAS when config has no ignoreSchemas', async () => {
    let capturedOptions: unknown
    const runFn: RunDbDiffFn = async (opts) => {
      capturedOptions = opts
      return { up: '', down: '' }
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    const ctx = mockContext()
    delete ctx.config.ignoreSchemas
    await check.scan(ctx)

    const opts = capturedOptions as { ignoreSchemas?: string[] }
    expect(opts.ignoreSchemas).toBeDefined()
    expect(opts.ignoreSchemas!.length).toBeGreaterThan(0)
    expect(opts.ignoreSchemas).toContain('auth')
    expect(opts.ignoreSchemas).toContain('storage')
  })

  it('handles multiple statements', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;\nCREATE INDEX idx_bio ON users(bio);',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";\nDROP INDEX idx_bio;',
    })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(2)
    expect(issues[0].title).toContain('users')
    expect(issues[1].title).toContain('Index')
  })

  // ── Unqualified FK filtering via ignoredSchemaTables ─────────────────────

  it('filters unqualified FK when queryFn reports the referenced table is in an ignored schema', async () => {
    // This is the real-world case: auth was excluded from pg_dump, so local has no
    // projects_user_id_fkey. dbdiff outputs REFERENCES "users" (no schema prefix).
    // The queryFn simulates the target DB returning auth.users when queried.
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    })
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_tables')) return [{ tablename: 'users' }, { tablename: 'refresh_tokens' }]
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('keeps unqualified FK when the referenced table does not live in an ignored schema', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts" ("id");',
      down: 'ALTER TABLE "comments" DROP CONSTRAINT "comments_post_id_fkey";',
    })
    // queryFn returns auth tables — "posts" is not among them
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_tables')) return [{ tablename: 'users' }]
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].sql?.up).toContain('ADD CONSTRAINT')
  })

  it('queries the TARGET database for ignored-schema tables (not source)', async () => {
    const queriedUrls: string[] = []
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_tables')) queriedUrls.push(dbUrl)
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    await check.scan(mockContext())

    expect(queriedUrls).toHaveLength(1)
    expect(queriedUrls[0]).toBe('postgres://target')
  })

  it('passes ignoreSchemas as parameters to the pg_tables query', async () => {
    const calls: { sql: string; params?: unknown[] }[] = []
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const queryFn: QueryFn = async (_dbUrl, sql, params) => {
      calls.push({ sql, params })
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    await check.scan(mockContext())

    const tablesCall = calls.find(c => c.sql.includes('pg_tables'))
    expect(tablesCall).toBeDefined()
    expect(tablesCall!.params).toEqual(['auth', 'storage'])
  })

  it('continues gracefully when queryFn throws (non-fatal)', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";',
    })
    const queryFn: QueryFn = async () => { throw new Error('DB not reachable') }
    const check = new SchemaCheck(runFn, queryFn)
    const issues = await check.scan(mockContext())

    // The main diff result is still returned despite queryFn failure
    expect(issues).toHaveLength(1)
  })
})

// ─── issue #43: scoping the comparison to specific tables ───────────────────

describe('SchemaCheck honours the table filter (issue #43)', () => {
  function capture(): { calls: DbDiffOptions[]; runFn: RunDbDiffFn } {
    const calls: DbDiffOptions[] = []
    const runFn: RunDbDiffFn = async (opts) => {
      calls.push(opts)
      return { up: '', down: '' }
    }
    return { calls, runFn }
  }

  it('forwards the include list to dbdiff rather than filtering afterwards', async () => {
    // DbDiffOptions.tables was already forwarded to --tables; nothing populated
    // it, so the capability was unreachable from outside.
    const { calls, runFn } = capture()
    await new SchemaCheck(runFn, noTablesQuery).scan({
      ...mockContext(),
      tableFilter: { tables: ['orders', 'order_items'] },
    })
    expect(calls[0].tables).toEqual(['orders', 'order_items'])
  })

  it('forwards the exclude list as ignoreTables', async () => {
    const { calls, runFn } = capture()
    await new SchemaCheck(runFn, noTablesQuery).scan({
      ...mockContext(),
      tableFilter: { excludeTables: ['*_audit'] },
    })
    expect(calls[0].ignoreTables).toEqual(['*_audit'])
  })

  it('passes both together', async () => {
    const { calls, runFn } = capture()
    await new SchemaCheck(runFn, noTablesQuery).scan({
      ...mockContext(),
      tableFilter: { tables: ['billing_*'], excludeTables: ['*_audit'] },
    })
    expect(calls[0].tables).toEqual(['billing_*'])
    expect(calls[0].ignoreTables).toEqual(['*_audit'])
  })

  it('omits both when unfiltered, so the default still compares everything', async () => {
    const { calls, runFn } = capture()
    await new SchemaCheck(runFn, noTablesQuery).scan(mockContext())
    expect(calls[0].tables).toBeUndefined()
    expect(calls[0].ignoreTables).toBeUndefined()
  })

  it('leaves ignoreSchemas alone — schema and table filtering are separate', async () => {
    const { calls, runFn } = capture()
    await new SchemaCheck(runFn, noTablesQuery).scan({
      ...mockContext(),
      tableFilter: { excludeTables: ['*_audit'] },
    })
    expect(calls[0].ignoreSchemas).toBeDefined()
    expect(calls[0].ignoreSchemas).not.toContain('*_audit')
  })
})

describe('SchemaCheck: a platform extension left where Supabase installs it', () => {
  const unit = (kind: string, name: string, sql: string) => `-- dbdiff:unit ${kind} ${name}\n${sql}\n-- dbdiff:end\n`
  const runFn: RunDbDiffFn = async () => ({
    up: unit('AlterExtensionSchema', 'uuid-ossp', 'ALTER EXTENSION "uuid-ossp" SET SCHEMA "public";')
      + unit('CreateTable', 'public.t', 'CREATE TABLE "public"."t" ("id" uuid DEFAULT public.uuid_generate_v1() NOT NULL);'),
    down: unit('AlterExtensionSchema', 'uuid-ossp', 'ALTER EXTENSION "uuid-ossp" SET SCHEMA "extensions";')
      + unit('CreateTable', 'public.t', 'DROP TABLE "public"."t";'),
  })

  it('creates tables calling its functions through the schema the target keeps it in', async () => {
    const asked: unknown[][] = []
    const queryFn: QueryFn = async (_url, sql, params) => {
      if (!/pg_depend/.test(sql)) return []
      asked.push(params ?? [])
      return [{ extname: 'uuid-ossp', proname: 'uuid_generate_v1' }]
    }
    const issues = await new SchemaCheck(runFn, queryFn).scan(mockContext())
    expect(asked).toEqual([[['uuid-ossp']]])
    const create = issues.find(i => i.sql?.up.includes('CREATE TABLE'))!
    expect(create.sql!.up).toContain('DEFAULT extensions.uuid_generate_v1() NOT NULL')
    expect(create.description).toContain('public.uuid_generate_v1() → extensions.uuid_generate_v1()')
    expect(issues.find(i => i.title === 'Extension in another schema: uuid-ossp')?.sql).toBeUndefined()
  })

  it('leaves the calls as written when the target cannot be read', async () => {
    const queryFn: QueryFn = async (_url, sql) => {
      if (/pg_depend/.test(sql)) throw new Error('permission denied')
      return []
    }
    const issues = await new SchemaCheck(runFn, queryFn).scan(mockContext())
    expect(issues.find(i => i.sql?.up.includes('CREATE TABLE'))!.sql!.up).toContain('DEFAULT public.uuid_generate_v1()')
  })
})
