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
        connect: vi.fn(async () => undefined),
        end: vi.fn(async () => undefined),
        query: vi.fn(async (sql: string) => {
          log.push(sql)
          if (sql === 'BEGIN') pending = new Set(committed)
          else if (sql === 'COMMIT') committed = pending
          else if (sql === 'ROLLBACK') pending = new Set(committed)
          else if (sql.startsWith('SAVEPOINT')) atSavepoint = new Set(pending)
          else if (sql.startsWith('ROLLBACK TO SAVEPOINT')) pending = new Set(atSavepoint)
          else if (sql.startsWith('RELEASE SAVEPOINT')) { /* kept */ } else {
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

const { promote, unmetDependency } = await import('../src/promote.js')

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
