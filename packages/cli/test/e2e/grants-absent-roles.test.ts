/**
 * Grants to a role only one side has, between a Supabase project and plain
 * PostgreSQL, through the command.
 *
 * - Plain PostgreSQL into Supabase: the source has no `anon`, so the roles
 *   check offered to revoke everything the target grants it — USAGE on
 *   `public` and every table grant — which takes the Data API offline.
 * - Supabase into plain PostgreSQL: every GRANT to `anon`, `authenticated`
 *   and `service_role` failed on a target without them, so the apply could
 *   never exit 0.
 *
 * Verdicts are read from the target database.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: grants to a role only one side has', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({
      images: { source: 'public.ecr.aws/supabase/postgres:15.8.1.085', target: 'docker.io/library/postgres:15-alpine' },
      readyTimeoutSec: 180,
      verbose: !!process.env.E2E_VERBOSE,
    })
    await h.up()
    const NOTES = 'CREATE TABLE public.notes (id int PRIMARY KEY, body text);'
    await h.applySql('source', NOTES + `
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT SELECT ON public.notes TO anon, authenticated;
      GRANT ALL ON public.notes TO service_role;`)
    await h.applySql('target', NOTES)
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  const anonCan = () => h.sql('source', `SELECT has_schema_privilege('anon', 'public', 'USAGE') AND has_table_privilege('anon', 'public.notes', 'SELECT')`)

  it('plain PostgreSQL into Supabase leaves the Data API roles\' grants alone', async () => {
    // Swapped: the plain database is the source, the Supabase one the target.
    const ws = await h.workspace({
      environments: { source: { dbUrl: h.connectionString('target') }, target: { dbUrl: h.connectionString('source') } },
    })
    expect(await anonCan()).toBe('t')
    const run = await h.cli(['diff', '--check', 'roles', '--apply', '--allow-destructive', '--json'], { cwd: ws })
    const result = JSON.parse(run.stdout)
    expect(result.errors).toEqual([])
    expect(result.applied.filter((a: { sql?: string }) => /REVOKE[\s\S]*FROM "(anon|authenticated|service_role)"/.test(a.sql ?? ''))).toEqual([])
    expect(await anonCan()).toBe('t')
  }, 300_000)

  it('Supabase into plain PostgreSQL grants nothing to roles the target does not have, and succeeds', async () => {
    const ws = await h.workspace()
    const run = await h.cli(['diff', '--check', 'roles', '--apply', '--json'], { cwd: ws })
    const result = JSON.parse(run.stdout)
    expect(result.errors).toEqual([])
    expect(run.code).toBe(0)
    expect(result.skipped.map((s: { issueId: string }) => s.issueId)).toEqual(expect.arrayContaining(['roles-grant-missing-role-anon']))
  }, 300_000)
})
