/**
 * `--tables` through the command: what it selects arrives, whole, and
 * nothing else does.
 *
 * A table with a foreign key was skipped as depending on a table called "no"
 * (`ON UPDATE NO ACTION`), its sequence fix as depending on `pg_sequence`,
 * grants as depending on tables called "anon" and "postgres"; meanwhile
 * every new type and function, and grants on tables --tables had left out,
 * were applied, and one of those failing rolled everything back.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: --tables scope', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    const ROLES = 'DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;'
    await h.applySql('target', ROLES)
    await h.applySql('source', ROLES + `
      CREATE TYPE order_state AS ENUM ('new', 'paid');
      CREATE TYPE unrelated AS ENUM ('x');
      CREATE TABLE accounts (id serial PRIMARY KEY, name text);
      CREATE TABLE orders (id serial PRIMARY KEY, user_id int REFERENCES accounts(id) ON UPDATE NO ACTION ON DELETE NO ACTION, state order_state);
      CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch();
      CREATE FUNCTION report() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE TABLE audit (id int PRIMARY KEY);
      GRANT SELECT ON audit TO anon;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
      INSERT INTO accounts (name) VALUES ('a'), ('b');
      INSERT INTO orders (user_id, state) VALUES (1, 'new'), (2, 'paid');`)
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  // The parent sorts first: rows reach tables in DBDiff's order, and one
  // referencing a table later in it is a separate matter from scope.
  it('creates the selected tables with what they need, syncs their rows, and leaves the rest', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['accounts', 'orders'] } } })
    const run = await h.cli(['diff', '--apply', '--tables', 'accounts,orders', '--skip', 'roles', '--json'], { cwd: ws })
    const result = JSON.parse(run.stdout)
    expect(result.errors).toEqual([])
    expect(run.code).toBe(0)

    const has = (sql: string) => h.sql('target', sql)
    expect(await has(`SELECT count(*) FROM orders o JOIN accounts u ON u.id = o.user_id`)).toBe('2')
    expect(await has(`SELECT count(*) FROM pg_trigger WHERE tgname = 'orders_touch'`)).toBe('1')
    // The sequences moved past the synced ids.
    expect(await has(`SELECT nextval('orders_id_seq')`)).toBe('3')
    // What --tables left out stayed out.
    expect(await has(`SELECT count(*) FROM pg_type WHERE typname = 'unrelated'`)).toBe('0')
    expect(await has(`SELECT count(*) FROM pg_proc WHERE proname = 'report'`)).toBe('0')
    expect(await has(`SELECT count(*) FROM pg_class WHERE relname = 'audit'`)).toBe('0')
    expect(await has(`SELECT count(*) FROM pg_default_acl`)).toBe('0')
    const reasons = result.skipped.map((s: { reason: string }) => s.reason).join('\n')
    expect(reasons).not.toMatch(/'(no|tables|functions|anon|postgres|pg_\w+)'/)
  }, 300_000)
})
