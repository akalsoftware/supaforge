/**
 * --jsonl through the command: a record a line, every line JSON, a check's
 * record written as it finishes, then the findings or the apply's outcomes,
 * and a result last.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: --jsonl', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    const TABLE = 'CREATE TABLE public.plans (id int PRIMARY KEY, name text);'
    await h.applySql('source', `${TABLE} INSERT INTO public.plans VALUES (1, 'free'), (2, 'pro');`)
    await h.applySql('target', TABLE)
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  const parse = (stdout: string) => stdout.trim().split('\n').map(l => JSON.parse(l) as { type: string } & Record<string, unknown>)

  it('plans, then applies, a record a line', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['plans'] } } })
    const plan = parse((await h.cli(['diff', '--check', 'data', '--jsonl'], { cwd: ws })).stdout)
    expect(plan[0]).toMatchObject({ type: 'start', schema: 1, apply: false })
    expect(plan.find(r => r.type === 'check')).toMatchObject({ check: 'data', status: 'drifted', issues: 1 })
    expect(plan.filter(r => r.type === 'issue').map(r => r.id)).toEqual(['data-insert-public.plans'])
    expect(plan.at(-1)).toMatchObject({ type: 'result' })
    // The check's record comes before the findings: it is written as the check finishes.
    expect(plan.findIndex(r => r.type === 'check')).toBeLessThan(plan.findIndex(r => r.type === 'issue'))

    const applied = parse((await h.cli(['diff', '--check', 'data', '--apply', '--jsonl'], { cwd: ws })).stdout)
    expect(applied.filter(r => r.type === 'applied').map(r => r.issueId)).toEqual(['data-insert-public.plans'])
    expect(applied.at(-1)).toMatchObject({ type: 'result', applied: 1, errors: 0 })
    expect(await h.sql('target', 'SELECT count(*) FROM public.plans')).toBe('2')
  }, 300_000)
})
