/**
 * A source reached as a role that can see the tables but not read them.
 *
 * A natural choice for a "read-only" connection, and it used to produce
 * destructive phantom drift: DBDiff read columns from information_schema,
 * which hid every column from such a role, so the schema check proposed
 * `DROP COLUMN … CASCADE` for each one; and checks that met "permission
 * denied" reported clean. Now the schema is read in full, and a check that
 * cannot read its rows says so.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const SCHEMA = `
  CREATE TABLE public.plans (id int PRIMARY KEY, name text NOT NULL, price numeric(10,2));
  CREATE TABLE public.subscriptions (id int PRIMARY KEY, plan_id int REFERENCES public.plans(id));
  INSERT INTO public.plans VALUES (1, 'free', 0);
`

describeE2E('e2e: a source role without SELECT', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', SCHEMA + `
      CREATE ROLE sf_probe LOGIN PASSWORD 'probe';
      GRANT USAGE ON SCHEMA public TO sf_probe;`)
    await h.applySql('target', SCHEMA)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('sees every column and key, and reports rows it cannot read as an error', async () => {
    const source = new URL(h.connectionString('source'))
    source.username = 'sf_probe'
    source.password = 'probe'
    const ws = await h.workspace({
      environments: { source: { dbUrl: source.toString() }, target: { dbUrl: h.connectionString('target') } },
      checks: { data: { tables: ['public.plans'] } },
    })
    const r = await h.cli(['diff', '--json', '--check=schema'], { cwd: ws })
    const schema = JSON.parse(r.stdout).checks[0]
    expect(schema.status, r.stdout).toBe('clean')

    const data = JSON.parse((await h.cli(['diff', '--json', '--check=data'], { cwd: ws })).stdout).checks[0]
    expect(data.status).toBe('error')
    expect(data.error).toMatch(/permission denied/i)
  }, 300_000)
})
