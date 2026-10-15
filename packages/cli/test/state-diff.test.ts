import { describe, it, expect } from 'vitest'
import { diffState } from '../src/state-diff.js'
import type { SchemaState } from '@akal/pg-conformance'

const empty = (): SchemaState => ({
  meta: { server_version_num: 170000, schemas: ['public'] },
  tables: [], views: [], sequences: [], routines: [], types: [], extensions: [],
})

const table = (over: Record<string, unknown> = {}) => ({
  schema: 'public', name: 't', kind: 'table' as const, unlogged: false,
  partition_of: null, partition_bound: null, partition_by: null, inherits: null,
  options: null, rls_enabled: false, rls_forced: false, comment: null,
  columns: null, constraints: null, indexes: null, policies: null, triggers: null,
  ...over,
})

const column = (over: Record<string, unknown> = {}) => ({
  name: 'c', position: 1, type: 'text', not_null: false, default: null,
  identity: null, identity_options: null, generated: null, storage: 'extended' as const,
  storage_is_default: true, compression: null, collation: null, comment: null,
  ...over,
})

describe('diffState', () => {
  it('finds nothing between identical states', () => {
    const a = empty(); a.tables = [table() as never]
    const b = empty(); b.tables = [table() as never]
    expect(diffState(a, b)).toEqual([])
  })

  it('names a missing and an unexpected object rather than listing its parts', () => {
    const a = empty(); a.tables = [table({ name: 'gone', columns: [column(), column({ name: 'd' })] }) as never]
    const b = empty(); b.tables = [table({ name: 'extra' }) as never]

    expect(diffState(a, b)).toEqual([
      'table public.gone: missing',
      'table public.extra: unexpected',
    ])
  })

  // The point of the change: a moved field is named, not left to be spotted
  // between two near-identical lines of catalog shorthand.
  it('names the field that moved on a column', () => {
    const a = empty(); a.tables = [table({ columns: [column({ storage: 'extended' })] }) as never]
    const b = empty(); b.tables = [table({ columns: [column({ storage: 'plain' })] }) as never]

    expect(diffState(a, b)).toEqual(['column public.t.c: storage extended → plain'])
  })

  it('renders absent values as a word rather than null', () => {
    const a = empty(); a.tables = [table({ columns: [column({ collation: 'C' })] }) as never]
    const b = empty(); b.tables = [table({ columns: [column({ collation: null })] }) as never]

    expect(diffState(a, b)).toEqual(['column public.t.c: collation C → none'])
  })

  it('compares identity options by value, not by identity', () => {
    const opts = { start: 1, increment: 10, min: 1, max: 99, cache: 1, cycle: false }
    const a = empty(); a.tables = [table({ columns: [column({ identity: 'always', identity_options: { ...opts } })] }) as never]
    const b = empty(); b.tables = [table({ columns: [column({ identity: 'always', identity_options: { ...opts } })] }) as never]
    expect(diffState(a, b)).toEqual([])

    const c = empty(); c.tables = [table({ columns: [column({ identity: 'always', identity_options: { ...opts, increment: 5 } })] }) as never]
    expect(diffState(a, c)).toHaveLength(1)
    expect(diffState(a, c)[0]).toMatch(/identity options/)
  })

  it('reports several differences on one object', () => {
    const a = empty(); a.tables = [table({ kind: 'partitioned_table', partition_by: 'RANGE (d)' }) as never]
    const b = empty(); b.tables = [table({ kind: 'table', partition_by: null }) as never]

    expect(diffState(a, b)).toEqual([
      'table public.t: kind partitioned_table → table',
      'table public.t: partition by RANGE (d) → none',
    ])
  })

  it('covers every top-level object kind', () => {
    const a = empty(), b = empty()
    a.views = [{ schema: 'public', name: 'v', materialized: false, definition: 'SELECT 1', options: null, comment: null, columns: null }]
    a.sequences = [{ schema: 'public', name: 's', type: 'bigint', start: 1, increment: 1, min: 1, max: 9, cache: 1, cycle: false, owned_by: null }]
    a.routines = [{ schema: 'public', name: 'f', kind: 'function', arguments: '', definition: 'x', comment: null }]
    a.types = [{ schema: 'public', name: 'e', kind: 'enum', labels: ['a'], base_type: null, not_null: false, default: null, constraints: null, attributes: null }]
    a.extensions = [{ name: 'btree_gist', version: '1.7' }]

    expect(diffState(a, b)).toEqual([
      'view public.v: missing',
      'sequence public.s: missing',
      'routine public.f(): missing',
      'type public.e: missing',
      'extension btree_gist: missing',
    ])
  })

  it('names the column that owns an unexpected sequence', () => {
    const seq = (name: string, owned_by: string | null) =>
      ({ schema: 'public', name, type: 'integer', start: 1, increment: 1, min: 1, max: 9, cache: 1, cycle: false, owned_by })
    const b = empty()
    b.sequences = [seq('tasks_id_seq', 'tasks.id'), seq('free_seq', null)]

    expect(diffState(empty(), b)).toEqual([
      'sequence public.tasks_id_seq: unexpected (owned by tasks.id)',
      'sequence public.free_seq: unexpected',
    ])
  })
})
