import { describe, it, expect, afterEach } from 'vitest'
import { setSnapshotsOff } from '../src/db.js'
import { pairUnits, parseUnits } from '../src/dbdiff-units.js'
import { buildDbDiffArgs, dbdiffNotices, destructiveReason, sqlToIssues, schemaNotices } from '../src/dbdiff.js'

/** A section as `dbdiff --units` writes it. */
function units(...parts: Array<[kind: string, object: string, sql: string]>): string {
  return parts.map(([kind, object, sql]) => `-- dbdiff:unit ${kind} ${object}\n${sql}\n-- dbdiff:end`).join('\n')
}

const SWAP_UP = [
  `CREATE TYPE "st__new" AS ENUM ('new', 'shipped');`,
  `DROP POLICY IF EXISTS "own" ON "orders";`,
  `DROP VIEW IF EXISTS "open_orders";`,
  `ALTER TABLE "orders" ALTER COLUMN "state" DROP DEFAULT;`,
  `ALTER TABLE "orders" ALTER COLUMN "state" TYPE "st__new" USING "state"::text::"st__new";`,
  `DROP TYPE "st";`,
  `ALTER TYPE "st__new" RENAME TO "st";`,
  `ALTER TABLE "orders" ALTER COLUMN "state" SET DEFAULT 'new'::st;`,
  `CREATE VIEW "open_orders" AS SELECT id, state FROM orders;`,
  `CREATE POLICY "own" ON "orders" USING ((state = 'new'::st));`,
].join('\n')

describe('parseUnits', () => {
  it('reads each unit with its kind, object and SQL', () => {
    const parsed = parseUnits(units(
      ['AlterEnum', 'st', SWAP_UP],
      ['CreateView', 'v', 'CREATE VIEW "v" AS SELECT 1;'],
    ))
    expect(parsed?.map(u => [u.kind, u.object])).toEqual([['AlterEnum', 'st'], ['CreateView', 'v']])
    expect(parsed?.[0].sql).toBe(SWAP_UP)
  })

  it('is undefined for output without markers', () => {
    expect(parseUnits('CREATE VIEW "v" AS SELECT 1;')).toBeUndefined()
  })

  it('ignores what is outside a unit, and a unit with no SQL', () => {
    const parsed = parseUnits(`-- header\n\n${units(['DropView', 'v', ''], ['CreateView', 'w', 'CREATE VIEW "w" AS SELECT 1;'])}\n`)
    expect(parsed?.map(u => u.object)).toEqual(['w'])
  })
})

describe('pairUnits', () => {
  it('pairs by kind and object, not by position', () => {
    const up = parseUnits(units(['CreateView', 'a', 'A;'], ['AlterTableChangeColumn', 't.c', 'C;']))!
    const down = parseUnits(units(['AlterTableChangeColumn', 't.c', 'C-down;'], ['CreateView', 'a', 'A-down;']))!
    expect(pairUnits(up, down).map(p => p.down?.sql)).toEqual(['A-down;', 'C-down;'])
  })

  it('pairs units of the same key first with first, and leaves an UP without a DOWN alone', () => {
    const up = parseUnits(units(['AlterRoutine', 'f(int)', 'one;'], ['AlterRoutine', 'f(int)', 'two;'], ['AlterTableColumnStorage', 't.c', 'x;']))!
    const down = parseUnits(units(['AlterRoutine', 'f(int)', 'one-down;'], ['AlterRoutine', 'f(int)', 'two-down;']))!
    expect(pairUnits(up, down).map(p => p.down?.sql)).toEqual(['one-down;', 'two-down;', undefined])
  })
})

describe('sqlToIssues with units', () => {
  it('makes an enum label swap one "Type modified" finding, in order', () => {
    const issues = sqlToIssues({ up: units(['AlterEnum', 'st', SWAP_UP]), down: '' }, 'schema')
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Type modified: public.st')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].sql?.up).toBe(SWAP_UP)
  })

  it('keeps an enum label addition titled as an alteration', () => {
    const issues = sqlToIssues({
      up: units(['AlterEnum', 'st', `ALTER TYPE "st" ADD VALUE IF NOT EXISTS 'a';\nALTER TYPE "st" ADD VALUE IF NOT EXISTS 'b' AFTER 'a';`]),
      down: '',
    }, 'schema')
    expect(issues.map(i => i.title)).toEqual(['Type altered: public.st'])
  })

  it('names a column change by its ALTER TABLE, not the view it stands aside', () => {
    const sql = `DROP VIEW IF EXISTS "v";\nALTER TABLE "orders" ALTER COLUMN "amount" TYPE numeric(12,2);\nCREATE VIEW "v" AS SELECT amount FROM orders;`
    const issues = sqlToIssues({ up: units(['AlterTableChangeColumn', 'orders.amount', sql]), down: '' }, 'schema')
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Table altered: public.orders')
  })

  it('takes each finding\'s DOWN from the same change', () => {
    const issues = sqlToIssues({
      up: units(['CreateView', 'a', 'CREATE VIEW "a" AS SELECT 1;'], ['CreateView', 'b', 'CREATE VIEW "b" AS SELECT 2;']),
      down: units(['CreateView', 'b', 'DROP VIEW IF EXISTS "b";'], ['CreateView', 'a', 'DROP VIEW IF EXISTS "a";']),
    }, 'schema')
    expect(issues.map(i => i.sql?.down)).toEqual(['DROP VIEW IF EXISTS "a";', 'DROP VIEW IF EXISTS "b";'])
  })

  it('names a replaced policy or routine as modified', () => {
    const issues = sqlToIssues({
      up: units(
        ['AlterPolicy', 'orders.own', `DROP POLICY IF EXISTS "own" ON "orders";\nCREATE POLICY "own" ON "orders" USING (true);`],
        ['AlterRoutine', 'f(integer)', `DROP FUNCTION IF EXISTS "f"(integer);\nCREATE OR REPLACE FUNCTION public.f(x integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`],
      ),
      down: '',
    }, 'schema')
    expect(issues.map(i => i.title)).toEqual(['Policy modified: public.orders.own', 'Function modified: public.f(integer)'])
  })

  // A changed trigger is a DROP and a CREATE too. Read by its DROP, it was a
  // critical "Extra trigger" for a trigger both sides have.
  // A changed view is a DROP and a CREATE: read by the DROP, a critical
  // "Extra view" for a view both sides have.
  // A view others read is replaced in place when its columns allow, with no
  // DROP; otherwise its unit drops and puts back what reads it too. Either
  // way the finding is the view itself.
  it('names a view replaced in place, or around its dependants, as modified', () => {
    const issues = sqlToIssues({
      up: units(
        ['AlterView', 'base_v', 'CREATE OR REPLACE VIEW "base_v" AS SELECT id FROM items WHERE grp = 2;'],
        ['AlterView', 'z_base', [
          'DROP POLICY IF EXISTS "reads" ON "notes";',
          'DROP VIEW IF EXISTS "deeper";',
          'DROP VIEW IF EXISTS "a_top";',
          'DROP VIEW IF EXISTS "z_base";',
          'CREATE VIEW "z_base" AS SELECT id AS key FROM items;',
          'CREATE VIEW "a_top" AS SELECT key FROM z_base;',
          'CREATE VIEW "deeper" AS SELECT key FROM a_top;',
          'CREATE POLICY "reads" ON "notes" USING (EXISTS (SELECT 1 FROM z_base));',
        ].join('\n')],
      ),
      down: '',
    }, 'schema')
    expect(issues.map(i => [i.title, i.severity])).toEqual([
      ['View modified: public.base_v', 'warning'],
      ['View modified: public.z_base', 'warning'],
    ])
  })

  it('names collations', () => {
    const issues = sqlToIssues({
      up: units(
        ['CreateCollation', 'ci', `CREATE COLLATION "ci" (provider = icu, locale = 'und-u-ks-level2', deterministic = false);`],
        ['AlterCollation', 'nd', `DROP COLLATION IF EXISTS "nd";\nCREATE COLLATION "nd" (provider = icu, locale = 'und');`],
        ['DropCollation', 'old', 'DROP COLLATION IF EXISTS "old";'],
      ),
      down: '',
    }, 'schema')
    expect(issues.map(i => [i.title, i.severity])).toEqual([
      ['Collation missing: public.ci', 'warning'],
      ['Collation modified: public.nd', 'warning'],
      ['Extra collation: public.old', 'critical'],
    ])
  })

  it('names a replaced view or materialized view as modified', () => {
    const issues = sqlToIssues({
      up: units(
        ['AlterView', 'vt_v', 'DROP VIEW IF EXISTS "vt_v";\nCREATE VIEW "vt_v" AS SELECT vt.id FROM vt;\nREVOKE ALL ON "vt_v" FROM anon;'],
        ['AlterMatView', 'vt_m', 'DROP MATERIALIZED VIEW IF EXISTS "vt_m";\nCREATE MATERIALIZED VIEW "vt_m" AS SELECT 1;'],
      ),
      down: '',
    }, 'schema')
    expect(issues.map(i => [i.title, i.severity])).toEqual([
      ['View modified: public.vt_v', 'warning'],
      ['View modified: public.vt_m', 'warning'],
    ])
  })

  it('names a replaced trigger as modified, by its table', () => {
    const [issue] = sqlToIssues({
      up: units(['AlterTrigger', 'orders.note_changed', [
        'DROP TRIGGER IF EXISTS "note_changed" ON "orders";',
        'CREATE TRIGGER note_changed BEFORE UPDATE OF note ON public.orders FOR EACH ROW EXECUTE FUNCTION touch();',
      ].join('\n')]),
      down: '',
    }, 'schema')
    expect(issue.title).toBe('Trigger modified: public.orders.note_changed')
    expect(issue.severity).toBe('warning')
  })

  it('drops a foreign key into an ignored schema, from either side', () => {
    const issues = sqlToIssues({
      up: units(
        ['AlterTableAddConstraint', 'p.p_user_fkey', `ALTER TABLE "p" ADD CONSTRAINT "p_user_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id");`],
        ['AlterTableDropConstraint', 'q.q_user_fkey', `ALTER TABLE "q" DROP CONSTRAINT "q_user_fkey";`],
        ['CreateView', 'v', 'CREATE VIEW "v" AS SELECT 1;'],
      ),
      down: units(['AlterTableDropConstraint', 'q.q_user_fkey', `ALTER TABLE "q" ADD CONSTRAINT "q_user_fkey" FOREIGN KEY ("user_id") REFERENCES "" ("");`]),
    }, 'schema', ['auth'])
    expect(issues.map(i => i.title)).toEqual(['View missing: public.v'])
  })
})

describe('an enum change dbdiff cannot move', () => {
  const blocked = [
    '-- Removing or reordering enum labels moves its users to a new type,',
    '-- but these cannot be moved automatically:',
    '--   function fe(st)',
    '--   type dst',
    '-- Migrate them first, or apply this by hand.',
    'DROP TYPE IF EXISTS "st";',
    `CREATE TYPE "st" AS ENUM ('new', 'shipped');`,
  ].join('\n')

  it('is a manual step naming what is in the way, with its SQL kept for review', () => {
    const [issue] = sqlToIssues({ up: units(['AlterEnum', 'st', blocked]), down: '' }, 'schema')
    expect(issue.manualOnly).toMatch(/cannot be moved automatically: function fe\(st\), type dst/)
    expect(issue.sql?.up).toContain('DROP TYPE IF EXISTS "st";')
  })

  it('leaves a swap or an addition to apply as usual', () => {
    const issues = sqlToIssues({
      up: units(['AlterEnum', 'st', SWAP_UP], ['AlterEnum', 'e2', `ALTER TYPE "e2" ADD VALUE IF NOT EXISTS 'x';`]),
      down: '',
    }, 'schema')
    expect(issues.map(i => i.manualOnly)).toEqual([undefined, undefined])
  })
})

describe('buildDbDiffArgs and --units', () => {
  const base = { sourceUrl: 'postgres://a', targetUrl: 'postgres://b', include: 'both' as const }

  it('asks for units on a schema diff only', () => {
    expect(buildDbDiffArgs({ ...base, type: 'schema' }, '/tmp/o.sql')).toContain('--units')
    expect(buildDbDiffArgs({ ...base, type: 'data' }, '/tmp/o.sql')).not.toContain('--units')
  })

  it('leaves it out for a dbdiff that predates it', () => {
    expect(buildDbDiffArgs({ ...base, type: 'schema', units: false }, '/tmp/o.sql')).not.toContain('--units')
  })
})

describe('destructiveReason and re-added columns', () => {
  it('lets through a generated column dropped and re-added in the same change', () => {
    expect(destructiveReason(
      `ALTER TABLE "t" DROP COLUMN "g";\nALTER TABLE "t" ADD COLUMN "g" numeric GENERATED ALWAYS AS ((a * 3)) STORED;`,
    )).toBeUndefined()
  })

  it('still holds back a column dropped for good', () => {
    expect(destructiveReason('ALTER TABLE "t" DROP COLUMN "g";')).toMatch(/drops a column/)
    expect(destructiveReason(`ALTER TABLE "t" DROP COLUMN "g";\nALTER TABLE "t" ADD COLUMN "h" int;`)).toMatch(/drops a column/)
    // Re-added before, not after, is not a re-add.
    expect(destructiveReason(`ALTER TABLE "t" ADD COLUMN "g" int;\nALTER TABLE "t" DROP COLUMN "g";`)).toMatch(/drops a column/)
  })
})

describe('statements after a comment', () => {
  it('are kept rather than dropped with the comment', () => {
    const up = `-- Removing or reordering enum labels needs the type replaced, which\n-- PostgreSQL refuses while any column still uses it.\nDROP TYPE IF EXISTS "st";\nCREATE TYPE "st" AS ENUM ('a');`
    const issues = sqlToIssues({ up, down: '' }, 'schema')
    expect(issues.flatMap(i => (i.sql?.up ?? '').split('\n')).filter(l => !l.startsWith('--'))).toEqual([
      'DROP TYPE IF EXISTS "st";',
      `CREATE TYPE "st" AS ENUM ('a');`,
    ])
  })
})

describe('sqlToIssues: kinds dbdiff learned to compare, and renames', () => {
  const titles = (...parts: Array<[string, string, string]>) =>
    sqlToIssues({ up: units(...parts), down: '' }, 'schema').map(i => i.title)

  it('names each kind', () => {
    expect(titles(
      ['CreateDefaultPrivileges', 'postgres.public.tables', 'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT ON TABLES TO "anon";'],
      ['CreateEventTrigger', 'audit', 'CREATE EVENT TRIGGER "audit" ON ddl_command_end EXECUTE FUNCTION audit_ddl();'],
      ['CreateRule', 'orders.keep', 'CREATE RULE keep AS ON DELETE TO public.orders DO INSTEAD NOTHING;'],
      ['DropRule', 'orders.old', 'DROP RULE IF EXISTS "old" ON "orders";'],
      ['CreateAggregate', 'my_sum(integer)', 'CREATE AGGREGATE "my_sum"(integer) (SFUNC = add_int, STYPE = integer);'],
      ['CreateStatistics', 'addr_stx', 'CREATE STATISTICS public.addr_stx (ndistinct) ON city, zip FROM addr;'],
      ['CreateTextSearchConfiguration', 'my_cfg', 'CREATE TEXT SEARCH CONFIGURATION "my_cfg" (PARSER = pg_catalog."default");'],
      ['CreateCast', 'flag AS boolean', 'CREATE CAST (flag AS boolean) WITH FUNCTION flag_to_bool(flag);'],
      ['CreateForeignServer', 'warehouse', `CREATE SERVER "warehouse" FOREIGN DATA WRAPPER "postgres_fdw" OPTIONS ("host" 'db');`],
      ['CreateUserMapping', 'reader@warehouse', `CREATE USER MAPPING FOR "reader" SERVER "warehouse" OPTIONS ("user" 'r');`],
      ['CreateForeignTable', 'remote', 'CREATE FOREIGN TABLE "remote" (\n  "id" integer\n) SERVER "warehouse";'],
    )).toEqual([
      'Default privileges differ: postgres in public on tables',
      'Event trigger missing: public.audit',
      'Rule missing: orders.keep',
      'Extra rule: orders.old',
      'Aggregate missing: public.my_sum',
      'Statistics missing: public.addr_stx',
      'Text search configuration missing: public.my_cfg',
      'Cast missing: flag AS boolean',
      'Foreign server missing: public.warehouse',
      'User mapping missing: reader@warehouse',
      'Foreign table missing: public.remote',
    ])
  })

  it('names renames by what they keep', () => {
    expect(titles(
      ['AlterTableRenameColumn', 'people.full_name', 'ALTER TABLE "people" RENAME COLUMN "name" TO "full_name";'],
      ['AlterTableRename', 'customers', 'ALTER TABLE "clients" RENAME TO "customers";'],
    )).toEqual(['Column renamed: public.people.name → full_name', 'Table renamed: public.clients → customers'])
  })

  it('names a changed object as modified, not by the DROP that replaces it', () => {
    const issues = sqlToIssues({ up: units(
      ['AlterAggregate', 'my_sum(integer)', 'DROP AGGREGATE IF EXISTS "my_sum"(integer);\nCREATE AGGREGATE "my_sum"(integer) (SFUNC = add_int, STYPE = integer);'],
      ['AlterForeignServer', 'warehouse', `ALTER SERVER "warehouse" OPTIONS (DROP "host");\nALTER SERVER "warehouse" OPTIONS (ADD "host" 'db');`],
    ), down: '' }, 'schema')
    expect(issues.map(i => [i.title, i.severity])).toEqual([
      ['Aggregate modified: public.my_sum', 'warning'],
      ['Foreign server modified: public.warehouse', 'warning'],
    ])
  })

  it('leaves dbdiff warnings out of the findings: they are not drift', () => {
    const issues = sqlToIssues({
      up: '', down: '',
      notices: ['Operator objects are not compared (source 1, target 0: ===) — check them by hand'],
    }, 'schema')
    expect(issues).toEqual([])
  })
})

describe('schemaNotices', () => {
  it('says what dbdiff did not compare, and leaves out what the Realtime check does', () => {
    expect(schemaNotices([
      'Operator objects are not compared (source 1, target 0: ===) — check them by hand',
      'Publication objects are not compared (source 1, target 1: supabase_realtime) — check them by hand',
      'public.a.b → c not taken for a rename',
    ])).toEqual([
      'Not compared: Operator (source 1, target 0: ===) — check them by hand.',
      'public.a.b → c not taken for a rename.',
    ])
  })
})

describe('dbdiffNotices', () => {
  it('reads the warnings out of dbdiff\'s output, colour and all', () => {
    expect(dbdiffNotices('\u001b[0;36mℹ Now generating UP migration\u001b[0m\n\u001b[0;33m⚠ Operator objects are not compared (source 1, target 0: ===) — check them by hand\u001b[0m\nWritten: x.sql'))
      .toEqual(['Operator objects are not compared (source 1, target 0: ===) — check them by hand'])
  })
})

// supabase_admin's default privileges are Supabase's, and postgres cannot
// change them: offered as a fix, they failed the whole apply.
describe('default privileges a platform role holds', () => {
  const defaults = (role: string) => units(['AlterDefaultPrivileges', `${role}.public.tables`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${role}" IN SCHEMA "public" REVOKE SELECT ON TABLES FROM "anon";`])

  it('are left out', () => {
    expect(sqlToIssues({ up: defaults('supabase_admin'), down: defaults('supabase_admin') }, 'schema')).toEqual([])
  })

  it('but postgres\'s, and any other role\'s, are the project\'s', () => {
    for (const role of ['postgres', 'app_owner']) {
      expect(sqlToIssues({ up: defaults(role), down: defaults(role) }, 'schema').map(i => i.title))
        .toEqual([`Default privileges differ: ${role} in public on tables`])
    }
  })
})

// The scan's instant, or none under --no-snapshot, reaches @dbdiff/cli.
describe('buildDbDiffArgs and snapshots', () => {
  const opts = { sourceUrl: 'postgres://s', targetUrl: 'postgres://t', type: 'schema' as const, include: 'both' as const }
  afterEach(() => setSnapshotsOff(false))

  it('names no snapshot when the scan holds none', () => {
    expect(buildDbDiffArgs(opts, '/tmp/o.sql').filter(a => /snapshot/.test(a))).toEqual([])
  })

  it('passes --no-snapshot when the scan reads each query on its own', () => {
    setSnapshotsOff(true)
    expect(buildDbDiffArgs(opts, '/tmp/o.sql')).toContain('--no-snapshot')
  })
})
