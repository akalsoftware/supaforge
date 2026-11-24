/**
 * Rows of tables that reference each other, synced in one apply.
 *
 * DBDiff writes rows table by table in name order, so `orders` came before the
 * `users` they reference and the sync failed on the key, on any target —
 * unless the parent's name sorted first. Rows are now written parents first
 * (and deleted children first), and two tables that reference each other
 * have the key a row fails checked at commit instead.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: rows of tables that reference each other', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    const SCHEMA = `
      CREATE TABLE users (id int PRIMARY KEY, name text);
      CREATE TABLE orders (id int PRIMARY KEY, user_id int NOT NULL REFERENCES users(id));
      CREATE TABLE a (id int PRIMARY KEY, b_id int);
      CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));
      ALTER TABLE a ADD FOREIGN KEY (b_id) REFERENCES b(id);`
    await h.applySql('source', SCHEMA + `
      INSERT INTO users VALUES (1, 'u1'), (2, 'u2');
      INSERT INTO orders VALUES (10, 1), (11, 2);
      INSERT INTO a VALUES (1, NULL); INSERT INTO b VALUES (1, 1); UPDATE a SET b_id = 1;`)
    // The target has a user and an order the source no longer has.
    await h.applySql('target', SCHEMA + `INSERT INTO users VALUES (9, 'gone'); INSERT INTO orders VALUES (90, 9);`)
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('inserts parents first, deletes children first, and a cycle by checking at commit', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['users', 'orders', 'a', 'b'] } } })
    const run = await h.cli(['diff', '--check', 'data', '--apply', '--allow-destructive', '--json'], { cwd: ws })
    const result = JSON.parse(run.stdout)
    expect(result.errors).toEqual([])
    const rows = (role: 'source' | 'target') => h.sql(role,
      `SELECT (SELECT string_agg(id || ':' || name, ',' ORDER BY id) FROM users) || ' / ' || (SELECT string_agg(id || ':' || user_id, ',' ORDER BY id) FROM orders)
        || ' / ' || (SELECT string_agg(id || ':' || b_id, ',' ORDER BY id) FROM a) || ' / ' || (SELECT string_agg(id || ':' || a_id, ',' ORDER BY id) FROM b)`)
    expect(await rows('target')).toBe(await rows('source'))
    // The keys are back as they were.
    expect(await h.sql('target', `SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND condeferrable`)).toBe('0')
  }, 300_000)
})
