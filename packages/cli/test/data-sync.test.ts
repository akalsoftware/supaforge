import { describe, it, expect } from 'vitest'
import { DataSyncGuard, writtenTable } from '../src/data-sync.js'

describe('writtenTable', () => {
  it('reads the table a data fix writes, as written', () => {
    expect(writtenTable('INSERT INTO "public"."tree" ("id") VALUES (1);')).toBe('"public"."tree"')
    expect(writtenTable('UPDATE "a""b" SET x = 1 WHERE id = 1;')).toBe('"a""b"')
    expect(writtenTable('  DELETE FROM ONLY app.plans WHERE id = 1;')).toBe('app.plans')
    expect(writtenTable('update "Ünï cøde ""Sch€ma"""."ta""ble; drop" set v = 1')).toBe('"Ünï cøde ""Sch€ma"""."ta""ble; drop"')
  })

  it('reads nothing from a statement that writes no rows', () => {
    expect(writtenTable('CREATE TABLE t (id int);')).toBeUndefined()
    expect(writtenTable("SELECT setval('s', 1);")).toBeUndefined()
  })
})

/** A client that answers the facts query with `facts` and records everything else. */
function fakeClient(facts: Record<string, unknown> | undefined) {
  const ran: string[] = []
  return {
    ran,
    client: {
      query: async (sql: string) => {
        if (sql.includes('to_regclass($1)')) return { rows: facts ? [facts] : [] }
        ran.push(sql)
        return { rows: [] }
      },
    },
  }
}

const TREE = { rel: 'tree', owned: true, triggers: ['touch'], selfKeys: [{ name: 'tree_parent_fkey', qualified: 'public.tree_parent_fkey' }] }

describe('DataSyncGuard', () => {
  it('holds a table\'s triggers off once, and puts them back at the end', async () => {
    const { ran, client } = fakeClient(TREE)
    const guard = new DataSyncGuard(client as never)
    await guard.before('INSERT INTO "tree" VALUES (1);')
    await guard.before('INSERT INTO "tree" VALUES (2);')
    expect(ran).toEqual(['ALTER TABLE tree DISABLE TRIGGER "touch"'])
    await guard.finish()
    expect(ran.at(-1)).toBe('ALTER TABLE tree ENABLE TRIGGER "touch"')
    expect(guard.notes).toEqual(['Held off trigger "touch" on tree while its rows were synced.'])
  })

  it('warns, and changes nothing, when the role does not own the table', async () => {
    const { ran, client } = fakeClient({ ...TREE, owned: false })
    const guard = new DataSyncGuard(client as never)
    await guard.before('INSERT INTO "tree" VALUES (1);')
    expect(ran).toEqual([])
    expect(guard.warnings[0]).toMatch(/Triggers on tree fired .*does not own the table/)
  })

  it('defers only the table\'s own key, once, and checks it before the triggers come back', async () => {
    const { ran, client } = fakeClient(TREE)
    const guard = new DataSyncGuard(client as never)
    const sql = 'INSERT INTO "tree" VALUES (1, 2);'
    await guard.before(sql)
    const fk = Object.assign(new Error('violates'), { code: '23503', constraint: 'tree_parent_fkey' })
    expect(await guard.deferSelfReference(sql, fk)).toBe(true)
    expect(await guard.deferSelfReference(sql, fk)).toBe(false)
    expect(await guard.deferSelfReference(sql, { code: '23503', constraint: 'other_fkey' })).toBe(false)
    expect(await guard.deferSelfReference(sql, { code: '23505', constraint: 'tree_parent_fkey' })).toBe(false)
    ran.length = 0
    await guard.finish()
    expect(ran).toEqual([
      'SET CONSTRAINTS public.tree_parent_fkey IMMEDIATE',
      'ALTER TABLE tree ALTER CONSTRAINT "tree_parent_fkey" NOT DEFERRABLE',
      'ALTER TABLE tree ENABLE TRIGGER "touch"',
    ])
  })

  it('leaves a table the target does not have to the fix itself', async () => {
    const { ran, client } = fakeClient(undefined)
    const guard = new DataSyncGuard(client as never)
    await guard.before('INSERT INTO "gone" VALUES (1);')
    expect(ran).toEqual([])
    expect(await guard.deferSelfReference('INSERT INTO "gone" VALUES (1);', { code: '23503' })).toBe(false)
  })
})
