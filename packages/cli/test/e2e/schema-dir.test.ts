/**
 * A directory of schema files as the source (`diff --source-dir`).
 *
 * The files are loaded into a throwaway database on the target's server and
 * compared with the target; a file using what a later one creates still
 * loads. Verdicts are read from the target, and the throwaway database must
 * be gone afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: schema files as the source', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('target', 'CREATE TABLE public.tasks (id int PRIMARY KEY);')
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('applies the files to the target, whatever order they name things in', async () => {
    const ws = await h.workspace()
    const dir = join(ws, 'supabase', 'schemas')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '01_views.sql'), 'create view public.open_tasks as select id, title from public.tasks where not done;\n')
    await writeFile(join(dir, '02_tasks.sql'), `
      create table public.tasks (id int primary key, title text not null default '', done boolean not null default false);
      create index tasks_open on public.tasks (id) where not done;
    `)

    const r = await h.cli(['diff', '--source-dir', dir, '--check', 'schema', '--apply'], { cwd: ws })
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(await h.sql('target', `SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.tasks'::regclass AND attnum > 0`)).toBe('id,title,done')
    expect(await h.sql('target', `SELECT to_regclass('public.open_tasks') IS NOT NULL`)).toBe('t')

    const again = await h.cli(['diff', '--source-dir', dir, '--check', 'schema', '--json'], { cwd: ws })
    expect(JSON.parse(again.stdout).checks[0].issues).toEqual([])
    expect(await h.sql('target', `SELECT count(*) FROM pg_database WHERE datname LIKE 'supaforge_schema_%'`)).toBe('0')
  }, 300_000)
})
