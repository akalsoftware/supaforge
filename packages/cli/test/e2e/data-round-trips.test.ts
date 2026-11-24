/**
 * Rows reach the target in batches, not a round trip or three each.
 *
 * Each row was a fix of its own, sent as SAVEPOINT, statement, RELEASE: three
 * round trips. 5,000 rows took 47 seconds at 2 ms a round trip and 14
 * minutes at 50 ms. Counted here at the wire, so the run time over a slow
 * link cannot creep back unseen, and checked against the source after.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { roundTripCounter } from '../harness/round-trips.js'

const describeE2E = describeWithContainers()
const ROWS = 3000

describeE2E('e2e: reference rows in batches', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    const TABLE = 'CREATE TABLE public.items (id int PRIMARY KEY, name text NOT NULL);'
    await h.applySql('source', `${TABLE} INSERT INTO public.items SELECT g, 'item ' || g FROM generate_series(1, ${ROWS}) g;`)
    await h.applySql('target', `${TABLE} INSERT INTO public.items SELECT g, 'old ' || g FROM generate_series(1, 10) g;`)
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it(`syncs ${ROWS} rows in a few batches, in a few dozen round trips`, async () => {
    const counter = await roundTripCounter(h.port('target'))
    try {
      const ws = await h.workspace({
        environments: { source: { dbUrl: h.connectionString('source') }, target: { dbUrl: counter.url(h.connectionString('target')) } },
        checks: { data: { tables: ['items'] } },
      })
      const plan = JSON.parse((await h.cli(['diff', '--check', 'data', '--json'], { cwd: ws })).stdout)
      const issues = plan.checks.flatMap((c: { issues: Array<{ id: string; rows?: number }> }) => c.issues)
      // In DBDiff's order: the rows to insert, then the ones to update.
      expect(issues.map((i: { id: string }) => i.id)).toEqual([
        'data-insert-public.items', 'data-insert-public.items:2', 'data-insert-public.items:3', 'data-update-public.items',
      ])
      expect(issues.map((i: { rows?: number }) => i.rows)).toEqual([1000, 1000, 990, 10])

      const before = counter.count()
      const run = await h.cli(['diff', '--check', 'data', '--apply', '--json'], { cwd: ws })
      const result = JSON.parse(run.stdout)
      expect(result.errors).toEqual([])
      expect(result.applied).toHaveLength(4)
      // The scan the apply starts with, a transaction, and one round trip
      // per batch. A round trip per row would be over 3,000.
      const trips = counter.count() - before
      expect(trips, `${trips} round trips`).toBeLessThan(150)
    } finally {
      await counter.close()
    }
    const rows = (role: 'source' | 'target') => h.sql(role, `SELECT md5(string_agg(id || ':' || name, ',' ORDER BY id)) FROM public.items`)
    expect(await rows('target')).toBe(await rows('source'))
  }, 300_000)
})
