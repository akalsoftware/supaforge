/**
 * A Supabase project synced into plain PostgreSQL: its platform extensions
 * (pg_graphql, supabase_vault, pgjwt, …) are not shipped there and never will
 * be. Each was reported as a failed fix, so the apply exited 1 on every run
 * however clean the rest was, though the README said such a fix is skipped.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: extensions the target server does not ship', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({
      images: { source: 'public.ecr.aws/supabase/postgres:15.8.1.085', target: 'docker.io/library/postgres:15-alpine' },
      readyTimeoutSec: 180,
      verbose: !!process.env.E2E_VERBOSE,
    })
    await h.up()
    await h.applySql('source', 'CREATE EXTENSION IF NOT EXISTS pgjwt SCHEMA extensions CASCADE; CREATE EXTENSION IF NOT EXISTS citext;')
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('skips them with the reason, applies what the server has, and exits 0', async () => {
    const ws = await h.workspace()
    const run = await h.cli(['diff', '--check', 'extensions', '--apply', '--json'], { cwd: ws })
    const result = JSON.parse(run.stdout)

    expect(result.errors).toEqual([])
    expect(run.code).toBe(0)
    const skipped = result.skipped.filter((s: { reason: string }) => s.reason === 'An extension this server does not ship')
      .map((s: { issueId: string }) => s.issueId)
    expect(skipped).toEqual(expect.arrayContaining(['ext-missing-pgjwt']))
    expect(await h.sql('target', `SELECT count(*) FROM pg_extension WHERE extname = 'citext'`)).toBe('1')
  }, 300_000)
})
