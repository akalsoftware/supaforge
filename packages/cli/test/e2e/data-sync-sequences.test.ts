/**
 * A data sync writes the source's ids; the target's sequences stayed where
 * they were, so the app's next insert took an id the sync had just written
 * and failed on a duplicate key. Restore moved its sequences; sync did not.
 *
 * Verdicts are read from the target database: an insert that takes the
 * sequence's next value must succeed after the sync.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const TABLES = `
  CREATE TABLE public.plans (id serial PRIMARY KEY, name text);
  CREATE TABLE public.flags (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text);
  CREATE TABLE public.synced (id bigserial PRIMARY KEY, v text);
  CREATE TABLE public.ahead (id serial PRIMARY KEY, v text);
`
const ROWS = `
  INSERT INTO public.synced (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'c');
  INSERT INTO public.ahead (id, v) VALUES (1, 'a'), (2, 'b');
`

describeE2E('e2e: sequences after a data sync', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', TABLES + ROWS + `
      INSERT INTO public.plans (name) VALUES ('free'), ('pro'), ('team');
      INSERT INTO public.flags (v) VALUES ('x'), ('y'), ('z');`)
    // `synced` as an earlier sync left it: the rows, and the sequence at 1.
    // `ahead` has handed out ids up to 99 here already.
    await h.applySql('target', TABLES + ROWS + `SELECT setval('public.ahead_id_seq', 99);`)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('reports the sequences the rows would run into, a target synced earlier included', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['plans', 'flags', 'synced', 'ahead'] } } })
    const plan = JSON.parse((await h.cli(['diff', '--check', 'data', '--json'], { cwd: ws })).stdout)
    const ids = plan.checks.flatMap((c: { issues: Array<{ id: string }> }) => c.issues).map((i: { id: string }) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['data-sequence-plans', 'data-sequence-flags', 'data-sequence-synced']))
    expect(ids).not.toContain('data-sequence-ahead')
  }, 300_000)

  it('moves them past the synced ids, and never back', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['plans', 'flags', 'synced', 'ahead'] } } })
    const run = await h.cli(['diff', '--check', 'data', '--apply', '--json'], { cwd: ws })
    expect(JSON.parse(run.stdout).errors).toEqual([])

    expect(await h.sql('target', `WITH i AS (INSERT INTO public.plans (name) VALUES ('new') RETURNING id) SELECT id FROM i`)).toBe('4')
    expect(await h.sql('target', `WITH i AS (INSERT INTO public.flags (v) VALUES ('new') RETURNING id) SELECT id FROM i`)).toBe('4')
    expect(await h.sql('target', `WITH i AS (INSERT INTO public.synced (v) VALUES ('new') RETURNING id) SELECT id FROM i`)).toBe('4')
    expect(await h.sql('target', `WITH i AS (INSERT INTO public.ahead (v) VALUES ('new') RETURNING id) SELECT id FROM i`)).toBe('100')
  }, 300_000)
})
