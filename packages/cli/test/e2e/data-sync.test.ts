/**
 * Reference-data sync (`diff --check data --apply`) on the table shapes that
 * went wrong underneath it, in @dbdiff/cli before 3.0.0-rc.26.
 *
 * Text primary keys: rows were matched by walking both tables in key order,
 * but the server sorted text keys by collation ('a' before 'B') and as text
 * ('10' before '9') while the merge compared them as bytes and numbers. Rows
 * both sides had came out as a DELETE and an INSERT — the table itself ended
 * up right, so the drift report looked clean, but an ON DELETE CASCADE child
 * of each row went with it.
 *
 * A table with no primary key and a json column: the rows could not be
 * diffed at all ("could not identify an ordering operator for type json").
 *
 * Verdicts are read from the target database, not from SupaForge's report.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

/** ICU's root collation: the harness image is Alpine, whose en_US sorts as bytes and would hide the bug. */
const PLANS = `
  CREATE TABLE public.plans (code text COLLATE "und-x-icu" PRIMARY KEY, v int);
  CREATE TABLE public.features (id int PRIMARY KEY, plan_code text COLLATE "und-x-icu" REFERENCES public.plans (code) ON DELETE CASCADE);
`
const EVENTS = 'CREATE TABLE public.events (msg text, n int, payload json);'

describeE2E('e2e: data sync on text keys and keyless tables', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', PLANS + EVENTS + `
      INSERT INTO public.plans VALUES ('a',1),('B',2),('c',3),('9',4),('10',5),('apple',6),('Cherry',7);
      INSERT INTO public.features VALUES (1,'B'),(2,'9'),(3,'Cherry');
      INSERT INTO public.events VALUES ('dup',1,'{"a": 1}'),('a',2,NULL),('q''s',5,'[1, 2]'),('withnull',NULL,NULL);`)
    await h.applySql('target', PLANS + EVENTS + `
      INSERT INTO public.plans VALUES ('B',2),('c',3),('9',4),('Cherry',70);
      INSERT INTO public.features VALUES (1,'B'),(2,'9'),(3,'Cherry');
      INSERT INTO public.events VALUES ('dup',1,'{"a": 1}'),('dup',1,'{"a": 1}'),('dup',1,'{"a": 1}'),
        ('b',3,NULL),('withnull',NULL,NULL),('extra',NULL,'{"x": [1]}');`)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  const rows = (role: 'source' | 'target', expr: string, table: string) =>
    h.sql(role, `SELECT coalesce(string_agg(x, ' | ' ORDER BY x COLLATE "C"), '') FROM (SELECT ${expr} AS x FROM ${table}) s`)

  it('syncs text keys without deleting rows both sides have', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['public.plans'] } } })

    const plan = await h.cli(['diff', '--check', 'data', '--json'], { cwd: ws })
    const sql = JSON.parse(plan.stdout).checks
      .flatMap((c: { issues: Array<{ sql?: { up: string } }> }) => c.issues)
      .map((i: { sql?: { up: string } }) => i.sql?.up ?? '')
      .join('\n')
    expect(sql, 'only the rows the target lacks or has different').not.toMatch(/^DELETE/m)

    const r = await h.cli(['diff', '--check', 'data', '--apply', '--allow-destructive'], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)

    expect(await rows('target', "code || '=' || v", 'public.plans')).toBe(await rows('source', "code || '=' || v", 'public.plans'))
    expect(await h.sql('target', 'SELECT count(*) FROM public.features'), 'cascade children kept').toBe('3')
  }, 300_000)

  it('syncs a table with no primary key, json and duplicate rows included', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['public.events'] } } })

    const r = await h.cli(['diff', '--check', 'data', '--apply', '--allow-destructive'], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)

    const e = "concat_ws(':', msg, coalesce(n::text, 'N'), coalesce(payload::text, 'N'))"
    expect(await rows('target', e, 'public.events')).toBe(await rows('source', e, 'public.events'))
  }, 300_000)
})
