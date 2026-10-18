import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScanResult } from '../src/types/drift.js'

/**
 * A stand-in server. Each fix is `SELECT 'needs:a provides:b'`: it fails with
 * PostgreSQL's "does not exist" unless every name it needs has been provided,
 * or with `code` when it names one. Statements the transaction control issues
 * are recorded, so the test can see what was committed and what rolled back.
 */
const log: string[] = []
let committed = new Set<string>()

vi.mock('pg', () => ({
  default: {
    // `function`, not an arrow: the code under test calls `new pg.Client()`.
    Client: vi.fn(function () {
      let pending = new Set<string>()
      let atSavepoint = new Set<string>()
      return {
        on: vi.fn(),
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async (sql: string) => {
          log.push(sql)
          if (sql === 'BEGIN') pending = new Set(committed)
          else if (sql === 'COMMIT') committed = pending
          else if (sql === 'ROLLBACK') pending = new Set(committed)
          else if (sql.startsWith('SAVEPOINT')) atSavepoint = new Set(pending)
          else if (sql.startsWith('ROLLBACK TO SAVEPOINT')) pending = new Set(atSavepoint)
          else if (sql.startsWith('RELEASE SAVEPOINT')) { /* kept */ }
          // A revoke on `public.<name>` needs <name> to exist.
          else if (/^REVOKE\b/i.test(sql)) {
            const on = /\bON\s+(?:TABLE\s+)?public\.(\w+)/i.exec(sql)?.[1]
            if (on && !pending.has(on)) {
              throw Object.assign(new Error(`relation "public.${on}" does not exist`), { code: '42P01' })
            }
          } else {
            const code = /code:(\w+)/.exec(sql)?.[1]
            if (code) throw Object.assign(new Error(`failed with ${code}`), { code })
            for (const need of /needs:(\w+)/.exec(sql)?.[1].split(',') ?? []) {
              if (!pending.has(need)) {
                throw Object.assign(new Error(`relation "${need}" does not exist`), { code: '42P01' })
              }
            }
            const provides = /provides:(\w+)/.exec(sql)?.[1]
            if (provides) pending.add(provides)
          }
          return { rows: [] }
        }),
      }
    }),
  },
}))

const { promote, unmetDependency, revokesFromAbsent } = await import('../src/promote.js')

function scan(fixes: Array<[id: string, spec: string]>): ScanResult {
  const issues = fixes.map(([id, spec]) => ({
    id,
    check: 'schema' as const,
    severity: 'warning' as const,
    title: id,
    description: 'test',
    sql: { up: `SELECT '${spec}'`, down: '' },
  }))
  return {
    timestamp: '', source: 's', target: 't', score: 0, postureScore: null,
    checks: [{ check: 'schema', status: 'drifted', issues, durationMs: 1 }],
    summary: { total: issues.length, critical: 0, warning: issues.length, info: 0 },
  }
}

describe('promote: one fix the target cannot take', () => {
  beforeEach(() => {
    log.length = 0
    committed = new Set()
  })

  it('leaves out that fix and commits the rest', async () => {
    const result = await promote({
      dbUrl: 'postgres://t',
      scanResult: scan([['a', 'provides:a'], ['vec', 'needs:vector provides:docs'], ['b', 'needs:a provides:b']]),
    })

    expect(result.rolledBack).toBeUndefined()
    expect(result.applied.map(f => f.issueId)).toEqual(['a', 'b'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].issueId).toBe('vec')
    expect(result.errors[0].error).toContain('relation "vector" does not exist')
    expect(result.errors[0].error).toContain('The other fixes were')
    expect(committed).toEqual(new Set(['a', 'b']))
  })

  it('leaves out what depends on a fix that was left out', async () => {
    const result = await promote({
      dbUrl: 'postgres://t',
      scanResult: scan([['vec', 'needs:vector provides:docs'], ['idx', 'needs:docs provides:idx'], ['a', 'provides:a']]),
    })

    expect(result.applied.map(f => f.issueId)).toEqual(['a'])
    expect(result.errors.map(e => e.issueId).sort()).toEqual(['idx', 'vec'])
  })

  // Ordering is meant to make this impossible, but a missing dependency no
  // longer stops the apply, so an ordering miss must not quietly leave a fix
  // out that would have applied a moment later.
  it('retries a fix whose dependency comes later in the batch', async () => {
    const result = await promote({
      dbUrl: 'postgres://t',
      scanResult: scan([['late', 'needs:early provides:late'], ['early', 'provides:early']]),
    })

    expect(result.errors).toHaveLength(0)
    expect(result.applied.map(f => f.issueId)).toEqual(['early', 'late'])
    expect(committed).toEqual(new Set(['early', 'late']))
  })

  it('still rolls everything back on any other failure', async () => {
    const result = await promote({
      dbUrl: 'postgres://t',
      scanResult: scan([['a', 'provides:a'], ['vec', 'needs:vector'], ['dup', 'code:42P07']]),
    })

    expect(result.applied).toHaveLength(0)
    expect(result.rolledBack?.map(f => f.issueId)).toEqual(['a'])
    expect(result.errors.map(e => e.issueId)).toEqual(['dup'])
    expect(log).toContain('ROLLBACK')
    expect(log).not.toContain('COMMIT')
    expect(committed.size).toBe(0)
  })
})

describe('unmetDependency', () => {
  const err = (code: string) => Object.assign(new Error('x'), { code })

  it('accepts an object, schema, type, function or column that does not exist', () => {
    for (const code of ['42P01', '42883', '3F000', '42704', '42703']) {
      expect(unmetDependency('ALTER TABLE t ADD COLUMN e vector(3)', err(code)), code).toBeDefined()
    }
  })

  it('accepts an extension the server does not ship, only for CREATE EXTENSION', () => {
    expect(unmetDependency('CREATE EXTENSION IF NOT EXISTS vector', err('0A000'))).toContain('does not ship')
    expect(unmetDependency('CREATE EXTENSION vector', err('58P01'))).toContain('does not ship')
    // 0A000 is "feature not supported" in general: anywhere else it is a real failure.
    expect(unmetDependency('ALTER TABLE t ALTER COLUMN c TYPE int', err('0A000'))).toBeUndefined()
  })

  it('rejects every other failure', () => {
    expect(unmetDependency('CREATE TABLE t (id int)', err('42P07'))).toBeUndefined()
    expect(unmetDependency('ALTER TABLE t ADD CONSTRAINT u UNIQUE (id)', err('23505'))).toBeUndefined()
    expect(unmetDependency('CREATE TABLE t (id int)', new Error('connection terminated'))).toBeUndefined()
  })
})

// A view the target has and the source lacks is dropped by one fix, and its
// grants revoked by others. Whichever ran first, the revokes are done: the
// object they would take privileges from is gone (issue #147).
describe('promote: revoking on an object the same apply drops', () => {
  beforeEach(() => {
    log.length = 0
    committed = new Set(['old_v'])
  })

  const issue = (id: string, check: 'schema' | 'roles', up: string) =>
    ({ id, check, severity: 'warning' as const, title: id, description: 'test', sql: { up, down: '' } })
  const scanOf = (issues: ReturnType<typeof issue>[]): ScanResult => ({
    timestamp: '', source: 's', target: 't', score: 0, postureScore: null,
    checks: [{ check: 'schema', status: 'drifted', issues, durationMs: 1 }],
    summary: { total: issues.length, critical: 0, warning: issues.length, info: 0 },
  })

  it('counts the revokes as done when the drop ran first', async () => {
    // The stand-in "drops" old_v by forgetting it; the revokes then fail.
    committed = new Set()
    const result = await promote({
      dbUrl: 'postgres://t',
      scanResult: scanOf([
        issue('drop-old_v', 'schema', "SELECT 'drops old_v'"),
        issue('revoke-anon', 'roles', 'REVOKE SELECT ON TABLE public.old_v FROM anon'),
        issue('revoke-authenticated', 'roles', 'REVOKE SELECT ON TABLE public.old_v FROM authenticated'),
      ]),
    })

    expect(result.errors).toEqual([])
    expect(result.applied.map(f => f.issueId)).toEqual(['drop-old_v', 'revoke-anon', 'revoke-authenticated'])
    expect(result.applied.filter(f => f.note).map(f => f.note)).toEqual([
      'nothing to revoke: the object is not on the target',
      'nothing to revoke: the object is not on the target',
    ])
    expect(log).toContain('COMMIT')
  })

  it('still retries a revoke whose object a later fix creates', async () => {
    committed = new Set()
    const result = await promote({
      dbUrl: 'postgres://t',
      scanResult: scanOf([
        issue('revoke-anon', 'roles', 'REVOKE SELECT ON TABLE public.made FROM anon'),
        issue('create-made', 'schema', "SELECT 'provides:made'"),
      ]),
    })

    expect(result.errors).toEqual([])
    expect(result.applied.map(f => [f.issueId, f.note])).toEqual([['create-made', undefined], ['revoke-anon', undefined]])
  })

  it('still leaves out a grant on an object the target lacks', async () => {
    committed = new Set()
    const result = await promote({
      dbUrl: 'postgres://t',
      scanResult: scanOf([issue('grant-anon', 'roles', "SELECT 'needs:absent' /* GRANT */")]),
    })

    expect(result.applied).toEqual([])
    expect(result.errors.map(e => e.issueId)).toEqual(['grant-anon'])
  })
})

describe('revokesFromAbsent', () => {
  it('is a revoke, or revokes, on one object', () => {
    expect(revokesFromAbsent('REVOKE SELECT ON TABLE "public"."v" FROM "anon";')).toBe(true)
    expect(revokesFromAbsent('REVOKE GRANT OPTION FOR SELECT ON public.v FROM anon; REVOKE SELECT ON public.v FROM anon;')).toBe(true)
    expect(revokesFromAbsent('REVOKE EXECUTE ON FUNCTION public.f(int) FROM anon;')).toBe(true)
  })

  it('is not a grant, a drop, several objects or a whole schema', () => {
    expect(revokesFromAbsent('GRANT SELECT ON public.v TO anon;')).toBe(false)
    expect(revokesFromAbsent('DROP VIEW public.v;')).toBe(false)
    expect(revokesFromAbsent('REVOKE SELECT ON public.a, public.b FROM anon;')).toBe(false)
    expect(revokesFromAbsent('REVOKE SELECT ON public.a FROM anon; REVOKE SELECT ON public.b FROM anon;')).toBe(false)
    expect(revokesFromAbsent('REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;')).toBe(false)
    expect(revokesFromAbsent('not sql')).toBe(false)
  })
})
