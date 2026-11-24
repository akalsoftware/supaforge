import { describe, it, expect } from 'vitest'
import {
  PHASE,
  statementPhase,
  sqlSkeleton,
  bareName,
  providedNames,
  referencedTables,
  orderStatements,
  createdTriggers,
  createsOnlyTriggers,
  createdPolicies,
  droppedPolicies,
} from '../src/sql-deps.js'

/**
 * The exact fix set @dbdiff/cli produced for the two databases in issue #48,
 * in the order it reported them. Applying this top-to-bottom failed on
 * `schema-create-trigger-6`, because the trigger sorted ahead of the function
 * it executes.
 */
const ISSUE_48_FIXES = [
  { id: 'schema-drop-1', sql: 'DROP TABLE "legacy_notes";' },
  { id: 'schema-alter-2', sql: `ALTER TABLE "orders" ADD COLUMN "status" text DEFAULT 'pending'::text;` },
  { id: 'schema-alter-3', sql: 'ALTER TABLE "users" ADD COLUMN "created_at" timestamptz(6) DEFAULT now();' },
  { id: 'schema-create-index-4', sql: 'CREATE INDEX idx_orders_status ON public.orders USING btree (status);' },
  {
    id: 'schema-create-view-5',
    sql: `CREATE VIEW "active_orders" AS SELECT id, user_id, total FROM orders WHERE (status = 'pending'::text);`,
  },
  {
    id: 'schema-create-trigger-6',
    sql: 'CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated();',
  },
  {
    id: 'schema-create-function-7',
    sql: 'CREATE OR REPLACE FUNCTION public.touch_updated()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END; $function$;',
  },
  {
    id: 'schema-alter-function-8',
    sql:
      'DROP FUNCTION IF EXISTS "calc_total"(integer);\n' +
      'CREATE OR REPLACE FUNCTION public.calc_total(order_id integer)\n RETURNS numeric\n LANGUAGE sql\n' +
      'AS $function$SELECT total * 1.20 FROM orders WHERE id = order_id$function$;',
  },
]

function orderIds(fixes: { id: string; sql: string }[]): string[] {
  return orderStatements(fixes, f => f.sql).map(f => f.id)
}

describe('sqlSkeleton', () => {
  it('blanks dollar-quoted routine bodies', () => {
    const sql = 'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ CREATE TABLE inner_t (id int); $body$;'
    expect(sqlSkeleton(sql)).not.toMatch(/CREATE TABLE/i)
    expect(sqlSkeleton(sql)).toMatch(/CREATE FUNCTION/i)
  })

  it('blanks single-quoted literals, doubled quotes included', () => {
    expect(sqlSkeleton(`SELECT 'DROP TABLE x'`)).not.toMatch(/DROP TABLE/i)
    expect(sqlSkeleton(`SELECT 'it''s DROP TABLE x' , 1`)).not.toMatch(/DROP TABLE/i)
  })

  it('leaves a statement without literals untouched', () => {
    expect(sqlSkeleton('ALTER TABLE "orders" ADD COLUMN "n" int;')).toBe('ALTER TABLE "orders" ADD COLUMN "n" int;')
  })
})

describe('bareName', () => {
  it('strips quoting and the schema qualifier', () => {
    expect(bareName('"public"."orders"')).toBe('orders')
    expect(bareName('public.orders')).toBe('orders')
    expect(bareName('Orders')).toBe('orders')
  })
})

describe('statementPhase', () => {
  it('creates a routine before the trigger that executes it', () => {
    const fn = statementPhase('CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $$ $$;')
    const trg = statementPhase('CREATE TRIGGER t BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated();')
    expect(fn).toBeLessThan(trg)
  })

  it('does not read a trigger as a function just because it executes one', () => {
    const sql = 'CREATE TRIGGER t BEFORE UPDATE ON o FOR EACH ROW EXECUTE FUNCTION f();'
    expect(statementPhase(sql)).toBe(PHASE.CREATE_DEPENDANT)
  })

  it('creates tables before the columns, indexes and views that need them', () => {
    const table = statementPhase('CREATE TABLE "orders" (id int);')
    expect(table).toBeLessThan(statementPhase('ALTER TABLE "orders" ADD COLUMN s text;'))
    expect(table).toBeLessThan(statementPhase('CREATE INDEX i ON public.orders USING btree (s);'))
    expect(table).toBeLessThan(statementPhase('CREATE VIEW v AS SELECT * FROM orders;'))
  })

  it('drops dependants before what they depend on, and tables last', () => {
    expect(statementPhase('DROP TRIGGER t ON o;')).toBeLessThan(statementPhase('DROP FUNCTION IF EXISTS "f"();'))
    expect(statementPhase('DROP VIEW v;')).toBeLessThan(statementPhase('DROP TABLE "legacy_notes";'))
    expect(statementPhase('CREATE TABLE t (id int);')).toBeLessThan(statementPhase('DROP TABLE "legacy_notes";'))
  })

  it('phases a merged DROP + CREATE routine pair by what it leaves behind', () => {
    const merged =
      'DROP FUNCTION IF EXISTS "calc_total"(integer);\nCREATE OR REPLACE FUNCTION public.calc_total(o integer) RETURNS numeric AS $$ $$;'
    expect(statementPhase(merged)).toBe(PHASE.CREATE_ROUTINE)
    // Still after the table changes its body may depend on.
    expect(statementPhase(merged)).toBeGreaterThan(statementPhase('ALTER TABLE "orders" ADD COLUMN s text;'))
  })

  it('runs data changes after the structure holding them', () => {
    expect(statementPhase('CREATE TABLE t (id int);')).toBeLessThan(statementPhase("INSERT INTO t VALUES (1);"))
    expect(statementPhase('CREATE VIEW v AS SELECT 1;')).toBeLessThan(statementPhase('UPDATE t SET id = 2;'))
  })

  it('gives an unrecognised statement a phase after the creates', () => {
    expect(statementPhase('GRANT SELECT ON t TO anon;')).toBe(PHASE.OTHER)
    expect(statementPhase('GRANT SELECT ON t TO anon;')).toBeGreaterThan(PHASE.CREATE_VIEW)
  })
})

describe('providedNames', () => {
  it('names what a statement creates, unqualified and unquoted', () => {
    expect(providedNames('CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $$ $$;')).toEqual(['touch_updated'])
    expect(providedNames('CREATE VIEW "active_orders" AS SELECT 1;')).toEqual(['active_orders'])
    expect(providedNames('CREATE UNIQUE INDEX idx_a ON t (a);')).toEqual(['idx_a'])
    expect(providedNames('CREATE TABLE IF NOT EXISTS "public"."orders" (id int);')).toEqual(['orders'])
  })

  it('reports the name a merged DROP + CREATE pair recreates', () => {
    const merged =
      'DROP FUNCTION IF EXISTS "calc_total"(integer);\nCREATE OR REPLACE FUNCTION public.calc_total(o integer) RETURNS numeric AS $$ $$;'
    expect(providedNames(merged)).toEqual(['calc_total'])
  })

  it('ignores objects created inside a routine body', () => {
    expect(providedNames('CREATE FUNCTION f() RETURNS void AS $b$ CREATE TABLE tmp_t (id int); $b$;')).toEqual(['f'])
  })

  it('reports nothing for a pure drop', () => {
    expect(providedNames('DROP TABLE "legacy_notes";')).toEqual([])
  })
})

describe('referencedTables', () => {
  it('finds the table a view selects from', () => {
    expect(referencedTables(`CREATE VIEW v AS SELECT id FROM orders WHERE (status = 'x');`)).toContain('orders')
  })

  it('finds the table an index or trigger hangs off', () => {
    expect(referencedTables('CREATE INDEX i ON public.orders USING btree (status);')).toEqual(['orders'])
    expect(
      referencedTables('CREATE TRIGGER t BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION f();'),
    ).toEqual(['orders'])
  })

  it('does not read the ON of a join condition as a table', () => {
    const sql = 'CREATE VIEW v AS SELECT * FROM orders o JOIN users u ON u.id = o.user_id;'
    expect(referencedTables(sql).sort()).toEqual(['orders', 'users'])
  })

  it('finds a foreign key target and the table being altered', () => {
    const sql = 'ALTER TABLE "orders" ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES "users"(id);'
    expect(referencedTables(sql).sort()).toEqual(['orders', 'users'])
  })

  it('looks inside a routine body', () => {
    const sql =
      'CREATE OR REPLACE FUNCTION calc(o integer) RETURNS numeric AS $f$SELECT total FROM orders WHERE id = o$f$;'
    expect(referencedTables(sql)).toContain('orders')
  })

  it('reads none of these as a table: a keyword, a role, a catalog', () => {
    // Each of these was once a table to --tables, and its fix skipped as
    // depending on it.
    expect(referencedTables('CREATE TABLE "a" ("id" int REFERENCES "b"("id") ON UPDATE NO ACTION ON DELETE NO ACTION);').sort()).toEqual(['a', 'b'])
    expect(referencedTables('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT EXECUTE ON FUNCTIONS TO "postgres";')).toEqual([])
    expect(referencedTables('ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "anon";')).toEqual([])
    expect(referencedTables('REVOKE SELECT ON "public"."orders" FROM "anon", "authenticated";')).toEqual(['orders'])
    expect(referencedTables('SELECT setval(q.seqrelid, top) FROM (SELECT max("id") AS top FROM "plans") x, pg_depend d JOIN pg_sequence q ON q.seqrelid = d.objid JOIN pg_attribute a ON a.attrelid = d.refobjid;')).toEqual(['plans'])
  })

  it('a sequence is its table\'s; a view is scoped by what it reads', () => {
    expect(referencedTables('ALTER SEQUENCE "orders_id_seq" OWNED BY "public"."orders"."id";')).toEqual(['orders'])
    expect(referencedTables('GRANT USAGE ON SEQUENCE "public"."orders_id_seq" TO "anon";')).toEqual([])
    expect(referencedTables('CREATE MATERIALIZED VIEW "totals" AS SELECT 1 FROM "orders";')).toEqual(['orders'])
  })

  it('a comment on a column or constraint is its table\'s', () => {
    expect(referencedTables(`COMMENT ON COLUMN "public"."orders"."total" IS 'x';`)).toEqual(['orders'])
    expect(referencedTables(`COMMENT ON CONSTRAINT "k" ON "public"."orders" IS 'x';`)).toEqual(['orders'])
    expect(referencedTables(`COMMENT ON TABLE "orders" IS 'x';`)).toEqual(['orders'])
  })

  it('falls back to reading the text when the parser refuses the SQL', () => {
    expect(referencedTables('CREATE VIEW v AS SELECT id FROM orders WHERE ((;')).toContain('orders')
  })

  it('reports nothing for a statement that touches no table', () => {
    expect(referencedTables('CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$;')).toEqual([])
  })
})

describe('orderStatements', () => {
  it('puts the issue #48 fix set into an order that applies in one pass', () => {
    const ordered = orderIds(ISSUE_48_FIXES)

    // The reported failure: the trigger ran before the function it executes.
    expect(ordered.indexOf('schema-create-function-7')).toBeLessThan(ordered.indexOf('schema-create-trigger-6'))
    // The column the index and the view both need.
    expect(ordered.indexOf('schema-alter-2')).toBeLessThan(ordered.indexOf('schema-create-index-4'))
    expect(ordered.indexOf('schema-alter-2')).toBeLessThan(ordered.indexOf('schema-create-view-5'))
    // Destructive drops last, so nothing is removed out from under a fix.
    expect(ordered[ordered.length - 1]).toBe('schema-drop-1')
  })

  it('keeps every statement exactly once', () => {
    const ordered = orderIds(ISSUE_48_FIXES)
    expect(ordered).toHaveLength(ISSUE_48_FIXES.length)
    expect(new Set(ordered).size).toBe(ISSUE_48_FIXES.length)
  })

  it('is stable for statements that neither depend on each other nor differ in kind', () => {
    const fixes = [
      { id: 'a', sql: 'ALTER TABLE "a" ADD COLUMN x int;' },
      { id: 'b', sql: 'ALTER TABLE "b" ADD COLUMN y int;' },
      { id: 'c', sql: 'ALTER TABLE "c" ADD COLUMN z int;' },
    ]
    expect(orderIds(fixes)).toEqual(['a', 'b', 'c'])
  })

  it('creates a table before the view built on it, whatever order they arrive in', () => {
    const fixes = [
      { id: 'view', sql: 'CREATE VIEW v AS SELECT id FROM new_table;' },
      { id: 'table', sql: 'CREATE TABLE new_table (id int);' },
    ]
    expect(orderIds(fixes)).toEqual(['table', 'view'])
  })

  it('orders a chain of routines by the calls between them', () => {
    const fixes = [
      { id: 'outer', sql: 'CREATE OR REPLACE FUNCTION outer_fn() RETURNS int AS $$ SELECT inner_fn(); $$;' },
      { id: 'inner', sql: 'CREATE OR REPLACE FUNCTION inner_fn() RETURNS int AS $$ SELECT 1; $$;' },
    ]
    expect(orderIds(fixes)).toEqual(['inner', 'outer'])
  })

  it('does not hold a DROP back behind the CREATE of the same name', () => {
    const fixes = [
      { id: 'drop', sql: 'DROP TABLE "orders";' },
      { id: 'view', sql: 'CREATE VIEW v AS SELECT 1;' },
    ]
    // The drop is last because it is destructive, not because it waits on a
    // create — a cycle here would stall the sort.
    expect(orderIds(fixes)).toEqual(['view', 'drop'])
  })

  it('emits every statement even when references form a cycle', () => {
    const fixes = [
      { id: 'a', sql: 'CREATE TABLE a (id int, b_id int REFERENCES b(id));' },
      { id: 'b', sql: 'CREATE TABLE b (id int, a_id int REFERENCES a(id));' },
    ]
    expect(orderIds(fixes).sort()).toEqual(['a', 'b'])
  })

  it('handles the empty and single-statement cases', () => {
    expect(orderStatements([], (s: { sql: string }) => s.sql)).toEqual([])
    const one = [{ id: 'only', sql: 'CREATE TABLE t (id int);' }]
    expect(orderIds(one)).toEqual(['only'])
  })
})

/**
 * Triggers collide the way policies did (issue #77).
 *
 * The schema check's SQL creates webhook triggers — they are ordinary triggers
 * to dbdiff — and the webhooks check now emits the server's own
 * `pg_get_triggerdef()` for the same trigger. Applied together the second fails
 * with `trigger ... already exists` and the transactional apply discards every
 * other fix with it.
 */
describe('createdTriggers', () => {
  it('keys a trigger by its table as well as its name', () => {
    // A trigger name is unique per table, not per schema, so two webhooks may
    // share a name — which is exactly how one of them used to be lost.
    expect(createdTriggers(
      'CREATE TRIGGER notify_webhook AFTER INSERT ON public.a_items FOR EACH ROW EXECUTE FUNCTION f();',
    )).toEqual(['a_items.notify_webhook'])
  })

  it('matches however the two layers spell the table', () => {
    const bare = createdTriggers('CREATE TRIGGER t AFTER INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION f();')
    const qualified = createdTriggers(
      'CREATE TRIGGER "t"\n  AFTER INSERT\n  ON "public"."orders"\n  FOR EACH ROW\n  EXECUTE FUNCTION f();',
    )
    expect(bare).toEqual(qualified)
  })

  it('finds every trigger in a multi-statement fix', () => {
    expect(createdTriggers([
      'CREATE TRIGGER a AFTER INSERT ON t1 FOR EACH ROW EXECUTE FUNCTION f();',
      'CREATE TRIGGER b AFTER UPDATE ON t2 FOR EACH ROW EXECUTE FUNCTION f();',
    ].join('\n')).sort()).toEqual(['t1.a', 't2.b'])
  })

  it('reads a constraint trigger too', () => {
    expect(createdTriggers(
      'CREATE CONSTRAINT TRIGGER c AFTER INSERT ON t DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();',
    )).toEqual(['t.c'])
  })

  it('ignores a trigger name inside a string or comment', () => {
    expect(createdTriggers("SELECT 'CREATE TRIGGER x AFTER INSERT ON t';")).toEqual([])
    expect(createdTriggers('-- CREATE TRIGGER x AFTER INSERT ON t\nSELECT 1;')).toEqual([])
  })

  it('finds nothing in unrelated SQL', () => {
    expect(createdTriggers('ALTER TABLE t ADD COLUMN c text;')).toEqual([])
  })
})

describe('createsOnlyTriggers', () => {
  it('is true for a statement that only creates a trigger', () => {
    expect(createsOnlyTriggers(
      'CREATE TRIGGER t AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f();',
    )).toBe(true)
  })

  it('tolerates the DROP the webhooks check emits before recreating', () => {
    expect(createsOnlyTriggers([
      'DROP TRIGGER IF EXISTS "t" ON public.orders;',
      'CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f();',
    ].join('\n'))).toBe(true)
  })

  it('is false when the statement also creates the function the trigger calls', () => {
    // The schema check bundles them, and dropping that as a duplicate would
    // lose the function.
    expect(createsOnlyTriggers([
      'CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;',
      'CREATE TRIGGER t AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION touch();',
    ].join('\n'))).toBe(false)
  })

  it('is false when the statement also creates the table', () => {
    expect(createsOnlyTriggers([
      'CREATE TABLE orders (id integer);',
      'CREATE TRIGGER t AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f();',
    ].join('\n'))).toBe(false)
  })

  it('is false when there is no trigger at all', () => {
    expect(createsOnlyTriggers('ALTER TABLE t ADD COLUMN c text;')).toBe(false)
  })
})

/**
 * A replaced object's drop and create must stay together (issue #81).
 *
 * `orderStatements` sends drops to the last phase and creates to an early one,
 * which is right for independent statements and wrong for the two halves of
 * replacing one object. An enum whose values changed failed to apply with
 * `type "order_state" already exists`.
 */
describe('statementPhase: a merged replacement pair', () => {
  const pair = (drop: string, create: string) => `${drop}\n${create}`

  it('phases a type replacement by the type it leaves behind', () => {
    const merged = pair(
      'DROP TYPE IF EXISTS "order_state";',
      `CREATE TYPE "order_state" AS ENUM ('new', 'paid');`,
    )

    expect(statementPhase(merged)).toBe(PHASE.CREATE_BASE)
    expect(statementPhase(merged)).toBeLessThan(PHASE.DROP_BASE)
  })

  it('phases a domain replacement the same way', () => {
    const merged = pair(
      'DROP DOMAIN IF EXISTS "positive_int";',
      'CREATE DOMAIN "positive_int" AS integer CHECK (VALUE > 0);',
    )

    expect(statementPhase(merged)).toBe(PHASE.CREATE_BASE)
  })

  it('phases a sequence replacement the same way', () => {
    const merged = pair(
      'DROP SEQUENCE IF EXISTS "counter";',
      'CREATE SEQUENCE "counter" START 42;',
    )

    expect(statementPhase(merged)).toBe(PHASE.CREATE_BASE)
  })

  it('still phases a lone DROP TYPE last', () => {
    // An unmerged drop is a genuinely extra type, and dropping it last is
    // correct — anything using it has to go first.
    expect(statementPhase('DROP TYPE IF EXISTS "gone";')).toBe(PHASE.DROP_BASE)
  })

  it('orders a merged type replacement before the table that uses it', () => {
    const merged = pair(
      'DROP TYPE IF EXISTS "order_state";',
      `CREATE TYPE "order_state" AS ENUM ('new');`,
    )
    const items = [
      'ALTER TABLE "orders" ADD COLUMN "state" "order_state";',
      merged,
    ]

    const ordered = orderStatements(items, s => s)

    expect(ordered[0]).toBe(merged)
  })
})

describe('dropping a routine', () => {
  it('waits for the defaults, constraints, indexes and tables that may call it', () => {
    const order = orderStatements([
      'DROP FUNCTION IF EXISTS "lim"();',
      'ALTER TABLE "t" DROP CONSTRAINT "t_id_check";',
      'DROP INDEX "t_l";',
      'ALTER TABLE "t" ALTER COLUMN "x" DROP DEFAULT;',
      'DROP TABLE IF EXISTS "t2";',
      'DROP TYPE IF EXISTS "e";',
    ], s => s)
    expect(order.indexOf('DROP FUNCTION IF EXISTS "lim"();')).toBe(4)
    expect(order[5]).toBe('DROP TYPE IF EXISTS "e";')
  })
})

/**
 * DBDiff orders its migration from the catalog; this module can only read
 * names in the text. Between two of DBDiff's own fixes its order now stands,
 * and the phase table only places the other checks' fixes around them.
 */
describe('orderStatements: DBDiff\'s order kept for its own fixes', () => {
  const serialDrop = { sql: 'ALTER TABLE "a" ALTER COLUMN "id" DROP DEFAULT; DROP SEQUENCE IF EXISTS public.shared_seq;', rank: 1 }
  const dropTable = { sql: 'DROP TABLE "b";', rank: 0 }

  it('keeps DBDiff\'s order where the phase table would swap it', () => {
    // b's default uses shared_seq: DBDiff drops b first. By phase alone the
    // ALTER TABLE ran first and the sequence could not be dropped.
    const ordered = orderStatements([serialDrop, dropTable], s => s.sql, s => s.rank)
    expect(ordered.map(s => s.rank)).toEqual([0, 1])
  })

  it('still lets a dependency read from the names come first', () => {
    // An older DBDiff wrote a trigger before the function it executes.
    const trigger = { sql: 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION touch();', rank: 0 }
    const fn = { sql: 'CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;', rank: 1 }
    expect(orderStatements([trigger, fn], s => s.sql, s => s.rank)).toEqual([fn, trigger])
  })

  // The RLS check's fix for a policy needing a column change DBDiff makes
  // later: it waits for everything DBDiff still has at an earlier phase, not
  // just the fix at the head of DBDiff's sequence.
  it('keeps another check\'s fix behind a later DBDiff fix it may need', () => {
    const identity = { sql: 'ALTER TABLE "a" ALTER COLUMN "id" DROP DEFAULT; DROP SEQUENCE IF EXISTS public.a_id_seq; ALTER TABLE "a" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY;', rank: 0 }
    const retype = { sql: 'DROP POLICY IF EXISTS "own" ON "p"; ALTER TABLE "p" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;', rank: 1 }
    const policy = { sql: 'DROP POLICY IF EXISTS "own" ON "public"."p"; CREATE POLICY "own" ON "public"."p" USING ((user_id = uid()));', rank: undefined }
    expect(orderStatements([policy, identity, retype], s => s.sql, s => s.rank)).toEqual([identity, retype, policy])
  })

  // DBDiff drops an index after the tables it creates; that drop provides
  // nothing, and must not hold back the extension a new table needs.
  it('puts an extension ahead of the DBDiff tables needing it, whatever DBDiff drops later', () => {
    const table = { sql: 'CREATE TABLE public.bookings (room integer, during tsrange, EXCLUDE USING gist (room WITH =, during WITH &&));', rank: 0 }
    const dropIndex = { sql: 'DROP INDEX "accounts_legacy";', rank: 1 }
    const extension = { sql: 'CREATE EXTENSION IF NOT EXISTS "btree_gist" SCHEMA "extensions";', rank: undefined }
    expect(orderStatements([table, dropIndex, extension], s => s.sql, s => s.rank)).toEqual([extension, table, dropIndex])
  })

  it('places a fix without a rank by its phase', () => {
    const policy = { sql: 'CREATE POLICY p ON t USING (true);', rank: undefined }
    const table = { sql: 'CREATE TABLE t (id int);', rank: 0 }
    expect(orderStatements([policy, table], s => s.sql, s => s.rank)).toEqual([table, policy])
  })
})

describe('statementPhase: schemas and extensions', () => {
  // The extensions check's CREATE EXTENSION, read as OTHER, ran after the
  // table whose exclusion constraint needs btree_gist.
  it('makes a schema, then an extension, before the types and tables that use them', () => {
    const schema = statementPhase('CREATE SCHEMA IF NOT EXISTS "app";')
    const ext = statementPhase('CREATE EXTENSION IF NOT EXISTS "btree_gist";')
    expect(schema).toBeLessThan(ext)
    expect(ext).toBeLessThan(statementPhase('CREATE TYPE t AS ENUM (\'a\');'))
    expect(ext).toBeLessThan(statementPhase('CREATE TABLE b (room int, EXCLUDE USING gist (room WITH =));'))
  })

  it('drops an extension after what used it', () => {
    expect(statementPhase('DROP EXTENSION IF EXISTS "btree_gist";')).toBeGreaterThan(statementPhase('DROP TABLE b;'))
    expect(statementPhase('DROP EXTENSION IF EXISTS "btree_gist";')).toBeGreaterThan(statementPhase('DROP TYPE t;'))
  })
})

describe('statementPhase: comments', () => {
  // A COMMENT ON a policy the RLS check creates ran before the policy existed.
  it('sets a comment after what it names is created', () => {
    const comment = statementPhase(`COMMENT ON POLICY "own" ON "public"."orders" IS 'x';`)
    expect(comment).toBeGreaterThan(statementPhase('CREATE POLICY "own" ON "public"."orders" USING (true);'))
    expect(comment).toBeGreaterThan(statementPhase('CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION f();'))
  })
})


// A name with a double quote in it is written with it doubled, and read as
// two names the schema check's policy and the RLS check's never matched: both
// were applied, and the second failed with `policy ... already exists`.
describe('created and dropped objects, by names with doubled quotes', () => {
  it('keys a policy the same however it is written', () => {
    const dbdiff = 'CREATE POLICY "say ""hi"" there" ON "q1" FOR SELECT USING (true);'
    const rls = 'CREATE POLICY "say ""hi"" there"\n  ON "public"."q1"\n  AS PERMISSIVE\n  FOR SELECT\n  TO PUBLIC\n  USING (true)\n;'
    expect(createdPolicies(dbdiff)).toEqual(['public.q1.say "hi" there'])
    expect(createdPolicies(rls)).toEqual(createdPolicies(dbdiff))
    expect(droppedPolicies('DROP POLICY IF EXISTS "say ""hi"" there" ON "public"."q1";')).toEqual(['public.q1.say "hi" there'])
  })

  it('keys a trigger by its table, with doubled quotes read as one', () => {
    expect(createdTriggers('CREATE TRIGGER "t ""x""" AFTER INSERT ON "Odd ""t""" FOR EACH ROW EXECUTE FUNCTION f();'))
      .toEqual(['odd "t".t "x"'])
  })
})
