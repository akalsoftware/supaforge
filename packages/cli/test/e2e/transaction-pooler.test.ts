/**
 * A URL that goes through a transaction-mode pooler is said to, once, on
 * stderr, and the run still works. Through one, a setting SupaForge makes on
 * its connection can stay on the server connection the application gets
 * next: checked by hand against Supavisor, where a TimeZone set by one client
 * was what the next client on that connection read.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: a transaction-mode pooler URL', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    await h.applySql('source', 'CREATE TABLE public.t (id int PRIMARY KEY);')
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('is warned about once, and the run goes on', async () => {
    const ws = await h.workspace({
      environments: { source: { dbUrl: h.connectionString('source') }, target: { dbUrl: `${h.connectionString('target')}?pgbouncer=true` } },
    })
    const run = await h.cli(['diff', '--check', 'schema', '--json'], { cwd: ws })
    expect(JSON.parse(run.stdout).checks[0].status).toBe('drifted')
    expect(run.stderr.match(/looks like a transaction-mode connection pooler/g)).toHaveLength(1)
    expect(run.stderr).toMatch(/session pooler \(Supabase's is on port 5432\)/)
  }, 300_000)
})
