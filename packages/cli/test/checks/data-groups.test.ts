import { describe, it, expect } from 'vitest'
import { dataIssues, inForeignKeyOrder, MAX_BYTES, MAX_ROWS } from '../../src/checks/data-groups.js'
import { thenSavepoint } from '../../src/promote.js'

const ins = (t: string, id: number) => `INSERT INTO ${t} ("id") VALUES('${id}');`
const del = (t: string, id: number) => `DELETE FROM ${t} WHERE "id" = '${id}';`
const upd = (t: string, id: number) => `UPDATE ${t} SET "n" = 'x' WHERE "id" = '${id}';`

describe('dataIssues', () => {
  it('one finding per run of one kind on one table, in DBDiff\'s order', () => {
    const up = [ins('"plans"', 1), ins('"plans"', 2), upd('"plans"', 3), ins('"app"."orders"', 4), ins('"plans"', 5)]
    const down = up.map((_, i) => `-- down ${i}`)
    const issues = dataIssues(up, down)
    expect(issues.map(i => i.id)).toEqual([
      'data-insert-public.plans', 'data-update-public.plans', 'data-insert-app.orders', 'data-insert-public.plans:2',
    ])
    expect(issues.map(i => i.rows)).toEqual([2, 1, 1, 1])
    // Nothing reordered: the fixes in order are DBDiff's statements in order.
    expect(issues.map(i => i.sql!.up).join('\n')).toBe(up.join('\n'))
    // A batch's DOWN undoes its rows last first.
    expect(issues[0].sql!.down).toBe('-- down 1\n-- down 0')
  })

  it('says how many rows, and what the fix does', () => {
    const [many, one, gone] = dataIssues(
      [ins('"plans"', 1), ins('"plans"', 2), upd('"plans"', 3), del('"plans"', 4)], [],
    ).map(i => [i.title, i.description])
    expect(many).toEqual(['2 rows missing from public.plans', 'Rows in the source are missing from the target. The fix inserts them.'])
    expect(one[0]).toBe('1 row modified in public.plans')
    expect(gone).toEqual(['1 extra row in public.plans', 'The target has rows the source does not. The fix deletes it from the target.'])
  })

  it('caps a batch at MAX_ROWS rows', () => {
    const up = Array.from({ length: MAX_ROWS * 2 + 5 }, (_, i) => ins('"t"', i))
    const issues = dataIssues(up, [])
    expect(issues.map(i => [i.id, i.rows])).toEqual([
      ['data-insert-public.t', MAX_ROWS], ['data-insert-public.t:2', MAX_ROWS], ['data-insert-public.t:3', 5],
    ])
  })

  it('caps a batch at MAX_BYTES of SQL, and a row larger than that is a batch of its own', () => {
    const big = (i: number) => `INSERT INTO "t" ("id","b") VALUES('${i}','${'x'.repeat(MAX_BYTES / 3)}');`
    const huge = `INSERT INTO "t" ("id","b") VALUES('h','${'x'.repeat(MAX_BYTES + 10)}');`
    const issues = dataIssues([big(1), big(2), big(3), huge, big(4)], [])
    expect(issues.map(i => i.rows)).toEqual([2, 1, 1, 1])
    expect(issues.every(i => i.sql!.up.length <= MAX_BYTES || i.rows === 1)).toBe(true)
  })

  it('keeps a quoted name as written and reads an unquoted one as PostgreSQL does', () => {
    const issues = dataIssues([ins('"Ünï cøde ""Sch€ma"""."T.1"', 1), ins('Plans', 2)], [])
    expect(issues.map(i => i.id)).toEqual(['data-insert-Ünï cøde "Sch€ma".T.1', 'data-insert-public.plans'])
  })

  it('a statement that writes no table is a finding of its own', () => {
    const issues = dataIssues(['SELECT 1;', ins('"t"', 1)], ['', ''])
    expect(issues.map(i => i.id)).toEqual(['data-change-1', 'data-insert-public.t'])
  })

  it('deletes stay warnings, so a sync\'s exit code is what it was', () => {
    expect(dataIssues([del('"t"', 1)], [])[0].severity).toBe('warning')
  })
})

describe('thenSavepoint', () => {
  it('one query: the fix, then the savepoint the next one rolls back to', () => {
    expect(thenSavepoint('INSERT INTO t VALUES (1);')).toBe('INSERT INTO t VALUES (1);\n;RELEASE SAVEPOINT sf_fix;SAVEPOINT sf_fix')
  })

  it('a trailing line comment in the fix cannot swallow what follows', () => {
    expect(thenSavepoint('SELECT 1 -- note').split('\n').at(-1)).toBe(';RELEASE SAVEPOINT sf_fix;SAVEPOINT sf_fix')
  })
})

describe('inForeignKeyOrder', () => {
  const issue = (id: string) => ({ id, check: 'data' as const, severity: 'warning' as const, title: id, description: '', sql: { up: id, down: '' } })
  const ids = (xs: Array<{ id: string }>) => xs.map(x => x.id)

  it('writes a referenced table\'s rows before the rows that reference them, and deletes the other way round', () => {
    const order = inForeignKeyOrder([
      issue('data-insert-public.orders'), issue('data-delete-public.orders'),
      issue('data-insert-public.users'), issue('data-delete-public.users'), issue('data-update-public.users'),
      issue('data-insert-public.lines'), issue('data-insert-public.orders:2'),
    ], [{ child: 'public.orders', parent: 'public.users' }, { child: 'public.lines', parent: 'public.orders' }])
    expect(ids(order)).toEqual([
      'data-delete-public.orders', 'data-delete-public.users',
      'data-insert-public.users', 'data-update-public.users',
      'data-insert-public.orders', 'data-insert-public.orders:2',
      'data-insert-public.lines',
    ])
  })

  it('keeps DBDiff\'s order where no key decides, a table in a cycle included', () => {
    const xs = [issue('data-insert-public.a'), issue('data-insert-public.b'), issue('data-change-3')]
    expect(ids(inForeignKeyOrder(xs, []))).toEqual(ids(xs))
    expect(ids(inForeignKeyOrder(xs, [{ child: 'public.a', parent: 'public.b' }, { child: 'public.b', parent: 'public.a' }]))).toEqual(ids(xs))
  })

  it('ignores a key to a table whose rows are not being written, and a table’s key to itself', () => {
    const xs = [issue('data-insert-public.b'), issue('data-insert-public.a')]
    expect(ids(inForeignKeyOrder(xs, [{ child: 'public.a', parent: 'public.z' }, { child: 'public.b', parent: 'public.b' }]))).toEqual(ids(xs))
  })
})
