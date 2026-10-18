import { describe, it, expect } from 'vitest'
import { ExtensionsCheck, diffExtensions } from '../../src/checks/extensions.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
    },
  }
}

const makeExt = (overrides: Record<string, unknown> = {}) => ({
  name: 'pgcrypto',
  version: '1.3',
  schema: 'extensions',
  ...overrides,
})

describe('ExtensionsCheck', () => {
  it('detects missing extension in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeExt(), makeExt({ name: 'uuid-ossp', version: '1.1' })]
      return [makeExt()]
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('uuid-ossp')
    expect(issues[0].sql?.up).toContain('CREATE EXTENSION')
    expect(issues[0].sql?.down).toContain('DROP EXTENSION')
  })

  it('detects extra extension in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('target')) return [makeExt(), makeExt({ name: 'postgis', version: '3.4' })]
      return [makeExt()]
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('postgis')
  })

  it('detects version mismatch', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension_update_paths')) return [{ name: makeExt().name, version: '1.4' }]
      if (dbUrl.includes('source')) return [makeExt({ version: '1.4' })]
      return [makeExt({ version: '1.3' })]
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('version mismatch')
    expect(issues[0].sql?.up).toContain("UPDATE TO '1.4'")
    expect(issues[0].sql?.down).toContain("UPDATE TO '1.3'")
  })

  it('returns no issues when extensions match', async () => {
    const ext = makeExt()
    const queryFn: QueryFn = async () => [ext]

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('includes schema in CREATE EXTENSION when not public', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeExt({ name: 'pg_stat_statements', schema: 'extensions' })]
      return []
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].sql?.up).toContain('SCHEMA "extensions"')
  })

  it('omits schema clause for public schema', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeExt({ schema: 'public' })]
      return []
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].sql?.up).not.toContain('SCHEMA')
  })
})

// The target's own server says which versions it can reach. PostgreSQL has
// no way down a version: ALTER EXTENSION pg_cron UPDATE TO '1.6' against a
// target on 1.6.4 failed, and with it the whole apply.
describe('ExtensionsCheck: versions the target cannot reach', () => {
  const scan = (paths: Array<{ name: string; version: string }>) => new ExtensionsCheck(async (dbUrl, sql) => {
    if (sql.includes('pg_extension_update_paths')) return paths as never
    return [makeExt({ version: dbUrl.includes('source') ? '1.6' : '1.6.4' })]
  }).scan(mockContext())

  it('reports the mismatch with no fix, and why', async () => {
    const [issue] = await scan([])
    expect(issue.title).toContain('version mismatch')
    expect(issue.sql).toBeUndefined()
    expect(issue.manualOnly).toContain('cannot go from v1.6.4 to v1.6')
  })

  it('still offers the update when the target can make it', async () => {
    const [issue] = await scan([{ name: makeExt().name, version: '1.6' }])
    expect(issue.sql?.up).toContain("UPDATE TO '1.6'")
    expect(issue.manualOnly).toBeUndefined()
  })
})

describe('diffExtensions: an extension in a schema of its own', () => {
  it('makes the schema first, which plain PostgreSQL may not have', () => {
    const [issue] = diffExtensions([{ name: 'pgjwt', version: '0.2.0', schema: 'extensions' }], [])
    expect(issue.sql?.up).toBe('CREATE SCHEMA IF NOT EXISTS "extensions";\nCREATE EXTENSION IF NOT EXISTS "pgjwt" SCHEMA "extensions";')
  })

  it('makes no system schema, which is always there and cannot be made', () => {
    const [issue] = diffExtensions([{ name: 'pg_cron', version: '1.6', schema: 'pg_catalog' }], [])
    expect(issue.sql?.up).toBe('CREATE EXTENSION IF NOT EXISTS "pg_cron" SCHEMA "pg_catalog";')
  })

  it('needs no schema made in public', () => {
    const [issue] = diffExtensions([{ name: 'pgcrypto', version: '1.3', schema: 'public' }], [])
    expect(issue.sql?.up).toBe('CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
  })
})
