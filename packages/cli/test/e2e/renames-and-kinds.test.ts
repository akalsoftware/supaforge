/**
 * What @dbdiff/cli 3.0.0-rc.29 compares, through the CLI.
 *
 * - A renamed column or table is renamed, keeping its rows, rather than
 *   dropped and created again.
 * - Range types, aggregates, default privileges and replica identity are
 *   compared and synced.
 * - A kind it does not compare is named beside the schema check, not counted
 *   as drift.
 *
 * Verdicts are read from the target database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const titles = (stdout: string): string[] =>
  JSON.parse(stdout).checks.flatMap((c: { issues: Array<{ title: string }> }) => c.issues.map(i => i.title))

describeE2E('e2e: renames, more kinds, and what is not compared', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  beforeEach(async () => {
    for (const role of ['source', 'target'] as const) {
      await h.applySql(role, 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
    }
  }, 60_000)

  it('renames a column and a table, and their rows stay', async () => {
    await h.applySql('source', `
      CREATE TABLE public.people (id int PRIMARY KEY, full_name text NOT NULL);
      CREATE TABLE public.customers (id int PRIMARY KEY, email text);`)
    await h.applySql('target', `
      CREATE TABLE public.people (id int PRIMARY KEY, name text NOT NULL);
      CREATE TABLE public.clients (id int PRIMARY KEY, email text);
      INSERT INTO public.people SELECT i, 'p' || i FROM generate_series(1, 3) i;
      INSERT INTO public.clients SELECT i, i || '@example.com' FROM generate_series(1, 4) i;`)

    const ws = await h.workspace()
    const plan = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
    expect(titles(plan.stdout)).toEqual(expect.arrayContaining([
      'Column renamed: public.people.name → full_name',
      'Table renamed: public.clients → customers',
    ]))

    const r = await h.cli(['diff', '--check', 'schema', '--apply'], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(await h.sql('target', 'SELECT count(full_name) FROM public.people')).toBe('3')
    expect(await h.sql('target', 'SELECT count(*) FROM public.customers')).toBe('4')

    const again = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
    expect(titles(again.stdout)).toEqual([])
  }, 300_000)

  it('syncs a range type, an aggregate, default privileges and replica identity', async () => {
    await h.applySql('source', `
      CREATE TYPE public.floatrange AS RANGE (subtype = float8, subtype_diff = float8mi);
      CREATE FUNCTION public.add2(int, int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT $1 + $2';
      CREATE AGGREGATE public.total(int) (SFUNC = public.add2, STYPE = int, INITCOND = '0');
      CREATE TABLE public.events (id int PRIMARY KEY, kind text);
      ALTER TABLE public.events REPLICA IDENTITY FULL;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;`)
    await h.applySql('target', 'CREATE TABLE public.events (id int PRIMARY KEY, kind text);')

    const ws = await h.workspace()
    const r = await h.cli(['diff', '--check', 'schema', '--apply'], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)

    expect(await h.sql('target', `SELECT to_regtype('public.floatrange') IS NOT NULL`)).toBe('t')
    expect(await h.sql('target', 'SELECT public.total(x) FROM generate_series(1, 4) x')).toBe('10')
    expect(await h.sql('target', `SELECT relreplident FROM pg_class WHERE oid = 'public.events'::regclass`)).toBe('f')
    await h.applySql('target', 'CREATE TABLE public.after_sync (id int);')
    expect(await h.sql('target', `SELECT has_table_privilege('public', 'public.after_sync', 'SELECT')`)).toBe('t')
    await h.applySql('target', 'DROP TABLE public.after_sync;')

    const again = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
    expect(titles(again.stdout)).toEqual([])
  }, 300_000)

  it('names an operator under the schema check without counting it', async () => {
    await h.applySql('source', `
      CREATE FUNCTION public.same_parity(int, int) RETURNS bool LANGUAGE sql IMMUTABLE AS 'SELECT $1 % 2 = $2 % 2';
      CREATE OPERATOR public.=== (LEFTARG = int, RIGHTARG = int, FUNCTION = public.same_parity);`)
    await h.applySql('target', `
      CREATE FUNCTION public.same_parity(int, int) RETURNS bool LANGUAGE sql IMMUTABLE AS 'SELECT $1 % 2 = $2 % 2';`)

    const ws = await h.workspace()
    const r = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
    const schema = JSON.parse(r.stdout).checks[0]
    expect(schema.issues).toEqual([])
    expect(schema.status).toBe('clean')
    expect(schema.notices).toEqual([expect.stringMatching(/^Not compared: Operator \(source 1, target 0: ===\)/)])

    const text = await h.cli(['diff', '--check', 'schema'], { cwd: ws })
    expect(text.stdout).toMatch(/ⓘ Not compared: Operator/)
  }, 300_000)
})
