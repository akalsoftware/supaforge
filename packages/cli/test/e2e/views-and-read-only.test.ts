/**
 * Two things @dbdiff/cli 3.0.0-rc.28 changed, through the CLI.
 *
 * - A read-only source (`default_transaction_read_only`, a read replica, a
 *   read-only role) cannot render a definition to tell an equivalent one from
 *   a change. A CHECK a dump and restore rewrote, and an unchanged view, read
 *   as changes; applying them re-added the CHECK and recreated the view.
 * - A changed view that another view reads was dropped and created again,
 *   which PostgreSQL refuses, so the whole sync rolled back.
 *
 * Verdicts are read from the target database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const READ_ONLY = '?options=-c%20default_transaction_read_only%3Don'

describeE2E('e2e: a read-only source, and views others read', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('reports nothing for definitions that only read differently, over a read-only source', async () => {
    await h.applySql('source', `
      CREATE TABLE public.posts (id int PRIMARY KEY, status varchar(20), CONSTRAINT status_known CHECK (status IN ('draft', 'live')));
      CREATE VIEW public.latest AS SELECT DISTINCT ON (status) id, status FROM public.posts ORDER BY status, id;`)
    // As a dump and restore leaves them.
    await h.applySql('target', `
      CREATE TABLE public.posts (id int PRIMARY KEY, status varchar(20),
        CONSTRAINT status_known CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'live'::character varying])::text[]))));
      CREATE VIEW public.latest AS SELECT DISTINCT ON (posts.status) posts.id, posts.status FROM public.posts ORDER BY posts.status, posts.id;`)

    const ws = await h.workspace({
      environments: {
        source: { dbUrl: h.connectionString('source') + READ_ONLY },
        target: { dbUrl: h.connectionString('target') },
      },
    })
    const r = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
    const report = JSON.parse(r.stdout)
    expect(report.checks[0].issues.map((i: { title: string }) => i.title)).toEqual([])

    await h.applySql('source', 'DROP VIEW public.latest; DROP TABLE public.posts;')
    await h.applySql('target', 'DROP VIEW public.latest; DROP TABLE public.posts;')
  }, 300_000)

  it('syncs a changed view another view reads, with the rest of the changes', async () => {
    const both = `
      CREATE TABLE public.items (id int PRIMARY KEY, colour text, grp int);
      CREATE VIEW public.base_v AS SELECT id, colour FROM public.items WHERE grp = 1;
      CREATE VIEW public.on_top AS SELECT * FROM public.base_v;`
    await h.applySql('source', both)
    await h.applySql('target', both)
    await h.applySql('source', `
      CREATE OR REPLACE VIEW public.base_v AS SELECT id, colour FROM public.items WHERE grp = 2;
      CREATE TABLE public.new_on_source (id int PRIMARY KEY);`)

    const ws = await h.workspace()
    const r = await h.cli(['diff', '--check', 'schema', '--apply'], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)

    expect(await h.sql('target', `SELECT pg_get_viewdef('public.base_v')`)).toContain('grp = 2')
    expect(await h.sql('target', `SELECT to_regclass('public.new_on_source') IS NOT NULL`)).toBe('t')
    expect(await h.sql('target', `SELECT to_regclass('public.on_top') IS NOT NULL`)).toBe('t')

    const again = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
    expect(JSON.parse(again.stdout).checks[0].issues).toEqual([])
  }, 300_000)
})
