import { describe, it, expect, vi } from 'vitest'
import { getTableFingerprint, tablesMatch, filterChangedTables } from '../src/checksum.js'
import type { QueryFn } from '../src/db.js'

function makeQueryFn(rowCount: number, content: string): QueryFn {
  return vi.fn(async () => [{ row_count: rowCount, content }])
}

describe('getTableFingerprint', () => {
  it('returns the row count and content digest from the query result', async () => {
    const queryFn = makeQueryFn(42, 'd41d8cd98f00b204e9800998ecf8427e')
    const fp = await getTableFingerprint('postgres://source', 'public.users', queryFn)
    expect(fp).toEqual({
      table: 'public.users',
      rowCount: 42,
      content: 'd41d8cd98f00b204e9800998ecf8427e',
    })
  })

  it('passes the table name in SQL', async () => {
    const queryFn = vi.fn(async (_url: string, _sql: string) => [{ row_count: 0, content: '' }])
    await getTableFingerprint('postgres://x', 'my_schema.my_table', queryFn)
    expect(queryFn).toHaveBeenCalledOnce()
    const sql = queryFn.mock.calls[0][1]
    expect(sql).toContain('"my_schema"."my_table"')
  })
})

describe('tablesMatch', () => {
  it('returns true when fingerprints match', async () => {
    const queryFn = makeQueryFn(100, 'abc123')
    const result = await tablesMatch('postgres://src', 'postgres://tgt', 'users', queryFn)
    expect(result).toBe(true)
  })

  it('returns false when row counts differ', async () => {
    let calls = 0
    const queryFn: QueryFn = vi.fn(async () => {
      calls++
      return [{ row_count: calls === 1 ? 100 : 99, content: 'abc123' }]
    })
    const result = await tablesMatch('postgres://src', 'postgres://tgt', 'users', queryFn)
    expect(result).toBe(false)
  })

  it('returns false when the contents differ at the same row count', async () => {
    // The case the old fingerprint could not see: an update, or an insert and
    // a delete together, leaves the row count and the relation size alone
    // (issue #90).
    let calls = 0
    const queryFn: QueryFn = vi.fn(async () => {
      calls++
      return [{ row_count: 100, content: calls === 1 ? 'aaa' : 'bbb' }]
    })
    const result = await tablesMatch('postgres://src', 'postgres://tgt', 'users', queryFn)
    expect(result).toBe(false)
  })
})

describe('filterChangedTables', () => {
  it('separates changed from unchanged tables', async () => {
    let callIdx = 0
    const data = [
      // users: same on both
      { row_count: 10, content: 'u1' },
      { row_count: 10, content: 'u1' },
      // orders: different
      { row_count: 50, content: 'o1' },
      { row_count: 55, content: 'o2' },
      // flags: same
      { row_count: 3, content: 'f1' },
      { row_count: 3, content: 'f1' },
    ]
    const queryFn: QueryFn = vi.fn(async () => {
      return [data[callIdx++]]
    })

    const result = await filterChangedTables(
      'postgres://src', 'postgres://tgt',
      ['users', 'orders', 'flags'],
      queryFn,
    )

    expect(result.changed).toEqual(['orders'])
    expect(result.skipped).toContain('users')
    expect(result.skipped).toContain('flags')
  })

  it('includes tables in changed when fingerprint query fails', async () => {
    const queryFn: QueryFn = vi.fn(async () => {
      throw new Error('relation does not exist')
    })
    const result = await filterChangedTables(
      'postgres://src', 'postgres://tgt',
      ['nonexistent'],
      queryFn,
    )
    expect(result.changed).toEqual(['nonexistent'])
    expect(result.skipped).toEqual([])
  })

  it('returns all empty when no tables given', async () => {
    const queryFn = makeQueryFn(0, '')
    const result = await filterChangedTables('postgres://src', 'postgres://tgt', [], queryFn)
    expect(result.changed).toEqual([])
    expect(result.skipped).toEqual([])
  })
})

/**
 * The changes the old fingerprint could not see (issue #90).
 *
 * Row count plus `pg_total_relation_size` are both catalog reads. They agree
 * across an update, across an insert paired with a delete, and across any
 * same-length value change — so three real data differences were reported as
 * clean and the drift score stayed at 100 after a sync that changed nothing.
 */
describe('filterChangedTables: a change that keeps the row count', () => {
  it('sees a value-only change', async () => {
    const data = [
      { row_count: 3, content: 'before' },
      { row_count: 3, content: 'after' },
    ]
    let i = 0
    const queryFn: QueryFn = vi.fn(async () => [data[i++]])

    const result = await filterChangedTables(
      'postgres://src', 'postgres://tgt', ['ref_codes'], queryFn,
    )

    expect(result.changed).toEqual(['ref_codes'])
    expect(result.skipped).toEqual([])
  })

  it('sees an update, an insert and a delete that cancel out', async () => {
    // The report's exact shape: plans goes 3 rows → 3 rows either side.
    const data = [
      { row_count: 3, content: 'src-digest' },
      { row_count: 3, content: 'tgt-digest' },
    ]
    let i = 0
    const queryFn: QueryFn = vi.fn(async () => [data[i++]])

    const result = await filterChangedTables(
      'postgres://src', 'postgres://tgt', ['plans'], queryFn,
    )

    expect(result.changed).toEqual(['plans'])
  })

  it('still skips a table that genuinely matches', async () => {
    // The skip is the point of the fingerprint; it has to survive the fix.
    const queryFn: QueryFn = vi.fn(async () => [{ row_count: 3, content: 'same' }])

    const result = await filterChangedTables(
      'postgres://src', 'postgres://tgt', ['plans'], queryFn,
    )

    expect(result.skipped).toEqual(['plans'])
    expect(result.changed).toEqual([])
  })
})

describe('getTableFingerprint: the query it runs', () => {
  it('digests the rows rather than reading the catalog', async () => {
    const queryFn = vi.fn(async (_url: string, _sql: string) => [{ row_count: 0, content: '' }])
    await getTableFingerprint('postgres://x', 'public.plans', queryFn)

    const sql = queryFn.mock.calls[0][1]
    expect(sql).toContain('md5')
    expect(sql).not.toContain('pg_total_relation_size')
  })

  it('combines the row digests by summing, so physical order does not matter', async () => {
    // Otherwise an identical table fingerprints differently after a VACUUM
    // FULL, and every run reports drift that is not there. A sum rather than
    // an ordered string_agg, which grew with the table and failed at 1 GB.
    const queryFn = vi.fn(async (_url: string, _sql: string) => [{ row_count: 0, content: '' }])
    await getTableFingerprint('postgres://x', 'public.plans', queryFn)

    const sql = queryFn.mock.calls[0][1]
    expect(sql).toContain('sum(')
    expect(sql).not.toContain('string_agg')
  })

  it('digests a whole row, so it covers every column', async () => {
    const queryFn = vi.fn(async (_url: string, _sql: string) => [{ row_count: 0, content: '' }])
    await getTableFingerprint('postgres://x', 'public.plans', queryFn)

    expect(queryFn.mock.calls[0][1]).toContain('md5(ROW(t.*)::text)')
  })
})
