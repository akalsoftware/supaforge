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

/** A table's foreign keys, by name, as the key query answers for them. */
type Keys = Record<string, { rel: string; qualified: string; owned: boolean; self: boolean }>

/** A client that answers the facts query with `facts`, the key query from `keys`, and records everything else. */
function fakeClient(facts: Record<string, unknown> | undefined, keys: Keys = {}) {
  const ran: string[] = []
  return {
    ran,
    client: {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('to_regclass($1)')) return { rows: facts ? [facts] : [] }
        if (sql.includes('k.conname = $3')) return { rows: keys[String(params?.[2])] ? [keys[String(params?.[2])]] : [] }
        ran.push(sql)
        return { rows: [] }
      },
    },
  }
}

const TREE = { rel: 'tree', owned: true, triggers: ['touch'] }
const TREE_KEY: Keys = { tree_parent_fkey: { rel: 'tree', qualified: 'public.tree_parent_fkey', owned: true, self: true } }

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

  it('defers the key a row fails, once, and checks it before the triggers come back', async () => {
    const { ran, client } = fakeClient(TREE, TREE_KEY)
    const guard = new DataSyncGuard(client as never)
    const sql = 'INSERT INTO "tree" VALUES (1, 2);'
    await guard.before(sql)
    const fk = Object.assign(new Error('violates'), { code: '23503', schema: 'public', table: 'tree', constraint: 'tree_parent_fkey' })
    expect(await guard.deferForeignKey(sql, fk)).toBe(true)
    expect(await guard.deferForeignKey(sql, fk)).toBe(false)
    expect(await guard.deferForeignKey(sql, { code: '23503', table: 'tree', constraint: 'unknown_fkey' })).toBe(false)
    expect(await guard.deferForeignKey(sql, { code: '23505', table: 'tree', constraint: 'tree_parent_fkey' })).toBe(false)
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
    expect(await guard.deferForeignKey('INSERT INTO "gone" VALUES (1);', { code: '23503' })).toBe(false)
  })

  it('defers another table\'s key too, the one a delete fails, and says which', async () => {
    const keys: Keys = { orders_user_fkey: { rel: 'orders', qualified: 'public.orders_user_fkey', owned: true, self: false } }
    const { ran, client } = fakeClient({ ...TREE, triggers: [] }, keys)
    const guard = new DataSyncGuard(client as never)
    const sql = 'DELETE FROM "users" WHERE "id" = 1;'
    expect(await guard.deferForeignKey(sql, { code: '23503', schema: 'public', table: 'orders', constraint: 'orders_user_fkey' })).toBe(true)
    expect(ran).toEqual(['ALTER TABLE orders ALTER CONSTRAINT "orders_user_fkey" DEFERRABLE INITIALLY DEFERRED'])
    expect(guard.notes[0]).toMatch(/orders's rows against its foreign key "orders_user_fkey".*tables that reference each other/)
  })

  it('leaves a key it does not own to fail', async () => {
    const keys: Keys = { orders_user_fkey: { rel: 'orders', qualified: 'public.orders_user_fkey', owned: false, self: false } }
    const { client } = fakeClient(TREE, keys)
    const guard = new DataSyncGuard(client as never)
    expect(await guard.deferForeignKey('INSERT INTO "orders" VALUES (1);', { code: '23503', table: 'orders', constraint: 'orders_user_fkey' })).toBe(false)
  })
})
