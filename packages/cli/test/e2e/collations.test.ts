/**
 * A table collated by a collation of its own schema syncs.
 *
 * A case-insensitive ICU collation for Gurmukhi, say, used by a column and a
 * domain. Before @dbdiff/cli 3.0.0-rc.27 collations were not compared, so
 * the CREATE TABLE that used one failed on the target: 'collation
 * "gurmukhi_ci" for encoding "UTF8" does not exist'.
 *
 * Verdicts are read from the target database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: custom collations', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', `
      CREATE COLLATION public.gurmukhi_ci (provider = icu, locale = 'pa-u-ks-level2', deterministic = false);
      CREATE DOMAIN public.shabad_title AS text COLLATE public.gurmukhi_ci;
      CREATE TABLE public.shabads (id int PRIMARY KEY, title public.shabad_title, line text COLLATE public.gurmukhi_ci);`)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('creates the collation before the domain and table that use it', async () => {
    const ws = await h.workspace()
    const r = await h.cli(['diff', '--check', 'schema', '--apply'], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)

    expect(await h.sql('target', `SELECT collprovider::text || ':' || collisdeterministic FROM pg_collation WHERE collname = 'gurmukhi_ci'`)).toBe('i:false')
    // Both columns — the domain's carries its collation too — as on the source.
    const collated = `SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
                       WHERE a.attrelid = 'public.shabads'::regclass AND c.collname = 'gurmukhi_ci'`
    expect(await h.sql('target', collated)).toBe(await h.sql('source', collated))

    // And it compares case-insensitively there, as on the source.
    await h.sql('target', `INSERT INTO public.shabads VALUES (1, 'ਜਪੁ', 'Japu')`)
    expect(await h.sql('target', `SELECT count(*) FROM public.shabads WHERE line = 'JAPU'`)).toBe('1')
  }, 300_000)
})
