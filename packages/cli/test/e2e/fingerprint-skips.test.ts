/**
 * The data check skips a table whose fingerprint matches on both sides. Two
 * fingerprints matched over different rows, so a real difference was
 * reported clean and never synced:
 *
 * - a table with a column named `t`: the digest read `t::text`, which named
 *   that column rather than the row, and covered it alone;
 * - doubles under `extra_float_digits = 0`, Supabase's default: both sides
 *   print 0.30000000000000004 and 0.3 as `0.3`.
 *
 * Verdicts are read from SupaForge's report and from the target database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { tablesMatch } from '../../src/checksum.js'
import { pgQuery, closePgPools } from '../../src/db.js'

const describeE2E = describeWithContainers()

const TABLES = `
  CREATE TABLE public.notes (id int PRIMARY KEY, t text, v int);
  CREATE TABLE public.rates (id int PRIMARY KEY, r float8);
  DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET extra_float_digits = 0', current_database()); END $$;
`

describeE2E('e2e: tables the fingerprint must not skip', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', TABLES + `
      INSERT INTO public.notes VALUES (1, 'same', 1), (2, 'same', 2);
      INSERT INTO public.rates VALUES (1, 0.30000000000000004), (2, 1/3::float8);`)
    await h.applySql('target', TABLES + `
      INSERT INTO public.notes VALUES (1, 'same', 1), (2, 'same', 20);
      INSERT INTO public.rates VALUES (1, 0.3), (2, 0.333333333333333);`)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('reports a change beside a column named t, and syncs it', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['notes'] } } })

    const plan = await h.cli(['diff', '--check', 'data', '--json'], { cwd: ws })
    const issues = JSON.parse(plan.stdout).checks
      .flatMap((c: { issues: Array<{ title: string }> }) => c.issues)
      .map((i: { title: string }) => i.title)
    expect(issues).toContain('Modified row in notes')

    await h.cli(['diff', '--check', 'data', '--apply'], { cwd: ws })
    const rows = (role: 'source' | 'target') => h.sql(role, 'SELECT string_agg(v::text, \',\' ORDER BY id) FROM public.notes')
    expect(await rows('target')).toBe(await rows('source'))
  }, 300_000)

  // Past the fingerprint, the row diff itself needs @dbdiff/cli to pin the
  // same setting (DBDiff #314); this is the part SupaForge decides.
  it('does not take doubles that differ past 15 digits for equal', async () => {
    const match = await tablesMatch(h.connectionString('source'), h.connectionString('target'), 'rates', pgQuery)
    await closePgPools()
    expect(match).toBe(false)
  }, 60_000)
})
