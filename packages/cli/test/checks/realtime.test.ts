import { describe, it, expect } from 'vitest'
import { RealtimeCheck, PLATFORM_PUBLICATIONS, PUBLICATION_SQL, diffPublications } from '../../src/checks/realtime.js'
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

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  pubname: 'my_pub',
  schemaname: 'public',
  tablename: 'users',
  ...overrides,
})

describe('RealtimeCheck', () => {
  // Realtime Authorization policies on realtime.messages decide who may join
  // which channel. They are user-written, but the realtime schema is excluded
  // from the main RLS layer (its other tables are product-managed), so nothing
  // compared them — a policy relaxed to `true` reported no drift at all.
  const makePolicy = (overrides: Record<string, unknown> = {}) => ({
    tablename: 'messages',
    policyname: 'authed_read',
    permissive: 'PERMISSIVE',
    roles: ['{authenticated}'],
    cmd: 'SELECT',
    qual: "(topic ~~ 'user:%'::text)",
    with_check: null,
    ...overrides,
  })

  /** Mock answering both the publication and the policy query. */
  const policyQueryFn = (src: unknown[], tgt: unknown[]): QueryFn =>
    async (dbUrl: string, sql: string) => {
      if (!sql.includes('pg_policies')) return [] as never
      return (dbUrl.includes('source') ? src : tgt) as never
    }

  it('detects a channel-authorization policy being relaxed', async () => {
    const issues = await new RealtimeCheck(policyQueryFn(
      [makePolicy()],
      [makePolicy({ qual: 'true' })],
    )).scan(mockContext())

    const changed = issues.find(i => i.id === 'realtime-policy-changed-messages.authed_read')
    expect(changed).toBeDefined()
    expect(changed!.severity).toBe('critical')
    // The fix must restore the source rule, not merely report it.
    expect(changed!.sql?.up).toContain('DROP POLICY')
    expect(changed!.sql?.up).toContain("USING ((topic ~~ 'user:%'::text))")
    expect(changed!.sql?.up).toContain('"realtime"."messages"')
  })

  it('detects a missing channel-authorization policy', async () => {
    const issues = await new RealtimeCheck(policyQueryFn([makePolicy()], [])).scan(mockContext())
    const missing = issues.find(i => i.id === 'realtime-policy-missing-messages.authed_read')
    expect(missing?.severity).toBe('critical')
    expect(missing?.sql?.up).toContain('CREATE POLICY')
  })

  it('treats an extra policy as info, not something to remove blindly', async () => {
    const issues = await new RealtimeCheck(policyQueryFn([], [makePolicy()])).scan(mockContext())
    expect(issues.find(i => i.id === 'realtime-policy-extra-messages.authed_read')?.severity).toBe('info')
  })

  it('reports nothing when the policies match', async () => {
    const issues = await new RealtimeCheck(policyQueryFn([makePolicy()], [makePolicy()])).scan(mockContext())
    expect(issues).toEqual([])
  })

  it('detects missing publication in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_policies')) return [] as never
      if (dbUrl.includes('source')) return [makeRow()]
      return []
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const missing = issues.find(i => i.id === 'realtime-missing-pub-my_pub')
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.sql?.up).toContain('CREATE PUBLICATION')
  })

  it('detects extra publication in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_policies')) return [] as never
      if (dbUrl.includes('target')) return [makeRow({ pubname: 'extra_pub' })]
      return []
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const extra = issues.find(i => i.id === 'realtime-extra-pub-extra_pub')
    expect(extra).toBeDefined()
    expect(extra!.severity).toBe('info')
  })

  it('detects table membership drift in publication', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_policies')) return [] as never
      if (dbUrl.includes('source')) {
        return [
          makeRow({ tablename: 'users' }),
          makeRow({ tablename: 'posts' }),
          makeRow({ tablename: 'comments' }),
        ]
      }
      return [makeRow({ tablename: 'users' })]
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const missingTable = issues.find(i => i.id === 'realtime-missing-table-my_pub-public.posts')
    expect(missingTable).toBeDefined()
    expect(missingTable!.severity).toBe('warning')
    expect(missingTable!.sql?.up).toContain('ALTER PUBLICATION')
  })

  it('detects extra published table in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_policies')) return [] as never
      if (dbUrl.includes('source')) return [makeRow({ tablename: 'users' })]
      return [makeRow({ tablename: 'users' }), makeRow({ tablename: 'orders' })]
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const extra = issues.find(i => i.id === 'realtime-extra-table-my_pub-public.orders')
    expect(extra).toBeDefined()
    expect(extra!.severity).toBe('info')
  })

  it('returns no issues when publications match', async () => {
    const row = makeRow()
    const queryFn: QueryFn = async (_dbUrl, sql) =>
      (sql.includes('pg_policies') ? [] : [row]) as never

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })
})

/**
 * Which publications are compared (issue #90).
 *
 * `supabase_realtime` was excluded, and a second query written for it was
 * never called. That is the publication Supabase Realtime uses: enabling
 * Realtime on a table means adding it to that publication, so excluding it hid
 * the only Realtime drift most projects will ever have.
 */
describe('RealtimeCheck: the publication query', () => {
  async function capturedSql(): Promise<string> {
    const seen: string[] = []
    const queryFn = (async (_url: string, sql: string) => {
      seen.push(sql)
      return []
    }) as unknown as QueryFn

    await new RealtimeCheck(queryFn).scan(mockContext())
    return seen.find(s => s.includes('pg_publication')) ?? ''
  }

  it('does not exclude supabase_realtime', async () => {
    const sql = await capturedSql()

    expect(sql).not.toMatch(/NOT\s+IN\s*\(\s*'supabase_realtime'/i)
    expect(sql).not.toMatch(/pubname\s*(<>|!=)\s*'supabase_realtime'/i)
  })

  it('reads the tables in each publication, not just the names', async () => {
    // Table membership is the drift: the publication itself exists on both
    // sides of every Supabase pair.
    const sql = await capturedSql()

    expect(sql).toContain('pg_publication_tables')
    expect(sql).toContain('tablename')
  })

  // Supabase keeps a second publication of its own over the daily
  // realtime.messages_YYYY_MM_DD partitions. The partition names roll over each
  // day, so comparing them reported drift between any two projects (and
  // between a project and itself a day later), and a snapshot captured them as
  // ALTER PUBLICATION statements naming partitions the target never has.
  it('leaves out the platform-managed messages publication', async () => {
    const sql = await capturedSql()

    expect(PLATFORM_PUBLICATIONS).toContain('supabase_realtime_messages_publication')
    expect(sql).toContain("'supabase_realtime_messages_publication'")
    expect(sql).toMatch(/p\.pubname\s*<>\s*ALL/)
  })

  it('leaves out member tables in schemas excluded everywhere else', async () => {
    // The filter sits in the join, not the WHERE: a user publication whose only
    // members are platform tables must still be reported as existing.
    const sql = await capturedSql()

    expect(sql).toMatch(/LEFT JOIN pg_publication_tables[\s\S]*pt\.schemaname\s*<>\s*ALL[\s\S]*WHERE/)
    expect(sql).toContain("'realtime'")
  })

  it('is the same query the snapshot captures with', async () => {
    expect(await capturedSql()).toBe(PUBLICATION_SQL)
  })
})

// Every Supabase project has supabase_realtime. A plain PostgreSQL source has
// no such publication, which is not drift; the tables it streams are.
describe('diffPublications: Supabase Realtime on a target synced from plain PostgreSQL', () => {
  it('an empty supabase_realtime is not drift', () => {
    expect(diffPublications([], [makeRow({ pubname: 'supabase_realtime', schemaname: null, tablename: null })])).toEqual([])
  })

  it('each table it streams is reported, with the fix that stops it', () => {
    const issues = diffPublications([], [makeRow({ pubname: 'supabase_realtime', tablename: 'messages' })])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', title: 'Extra published table: public.messages in supabase_realtime' })
    expect(issues[0].sql?.up).toBe('ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."messages";')
  })

  it('another publication only the target has is still reported', () => {
    expect(diffPublications([], [makeRow({ pubname: 'analytics' })]).map(i => i.id)).toEqual(['realtime-extra-pub-analytics'])
  })
})
