import { afterEach, describe, expect, it } from 'vitest'
import { compareTables, emptiedTables, sampleRows, type TableSnapshot } from '../src/prove-data.js'

const snap = (rows: number, columns: Record<string, [string, string]>, filenode = '1'): TableSnapshot => ({
  rows, filenode, columns: Object.fromEntries(Object.entries(columns).map(([k, [type, hash]]) => [k, { type, hash }])),
})

describe('the data half of a proof', () => {
  afterEach(() => { delete process.env.SUPAFORGE_PROVE_ROWS })

  it('passes rows kept as they were, and says which tables were rewritten', () => {
    const before = new Map([['public.o', snap(3, { id: ['integer', 'a'], note: ['text', 'b'] }, '10')]])
    const after = new Map([['public.o', snap(3, { id: ['bigint', 'changed-text'], note: ['text', 'b'] }, '11')]])
    expect(compareTables(before, after, ['public.o'], 'ALTER TABLE o ALTER COLUMN id TYPE bigint;'))
      .toEqual({ lost: [], rewritten: ['public.o'] })
  })

  it('catches rows lost, and values changed in a column whose type did not', () => {
    const before = new Map([['public.a', snap(5, { x: ['text', 'h'] })], ['public.b', snap(2, { y: ['text', 'h1'] })]])
    const after = new Map([['public.a', snap(0, { x: ['text', ''] })], ['public.b', snap(2, { y: ['text', 'h2'] })]])
    expect(compareTables(before, after, ['public.a', 'public.b'], '').lost).toEqual([
      'public.a: 5 row(s) before, 0 after',
      'public.b: values changed in y',
    ])
  })

  it('expects rows to go from a table a fix deletes from or truncates', () => {
    expect([...emptiedTables('DELETE FROM "public"."plans" WHERE id = 1;\nTRUNCATE flags;')]).toEqual(['plans', 'flags'])
    const before = new Map([['public.plans', snap(5, { id: ['integer', 'h'] })]])
    const after = new Map([['public.plans', snap(4, { id: ['integer', 'h2'] })]])
    expect(compareTables(before, after, ['public.plans'], 'DELETE FROM plans WHERE id = 1;').lost).toEqual([])
  })

  it('samples a thousand rows a table unless told otherwise, and none for 0', () => {
    expect(sampleRows()).toBe(1000)
    process.env.SUPAFORGE_PROVE_ROWS = '0'
    expect(sampleRows()).toBe(0)
    process.env.SUPAFORGE_PROVE_ROWS = 'lots'
    expect(sampleRows()).toBe(1000)
  })
})
