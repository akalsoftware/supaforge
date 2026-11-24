/**
 * Sequences no column owns, after a data sync.
 *
 * - One two tables' defaults call, `DEFAULT nextval('doc_no')`: the synced
 *   rows' ids reached past it, and the next insert took one of them. Moved
 *   past both tables' rows, forward only.
 * - Counters of their own, an invoice series: nothing in the rows says where
 *   one belongs, so it moves to the source's only when checks.data.sequences
 *   names it, and is otherwise reported.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: sequences no column owns', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    const SCHEMA = `
      CREATE SEQUENCE doc_no;
      CREATE TABLE quotes (id bigint PRIMARY KEY DEFAULT nextval('doc_no'), body text);
      CREATE TABLE orders (id bigint PRIMARY KEY DEFAULT nextval('doc_no'), body text);
      CREATE SEQUENCE invoice_no START 1000;
      CREATE SEQUENCE ticket_no START 1;`
    await h.applySql('target', SCHEMA)
    await h.applySql('source', SCHEMA + `
      INSERT INTO quotes (body) SELECT 'q' FROM generate_series(1, 30);
      INSERT INTO orders (body) SELECT 'o' FROM generate_series(1, 20);
      SELECT nextval('invoice_no') FROM generate_series(1, 40);
      SELECT nextval('ticket_no') FROM generate_series(1, 7);`)
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('moves a shared default sequence past every table\'s rows, and a named counter to the source\'s', async () => {
    const ws = await h.workspace({ checks: { data: { tables: ['quotes', 'orders'], sequences: ['invoice_no'] } } })
    const plan = JSON.parse((await h.cli(['diff', '--check', 'data', '--json'], { cwd: ws })).stdout)
    const issues = plan.checks.flatMap((c: { issues: Array<{ id: string; severity: string }> }) => c.issues)
    const byId = Object.fromEntries(issues.map((i: { id: string; severity: string }) => [i.id, i.severity]))
    expect(byId['data-sequence-quotes']).toBe('warning')
    expect(byId['data-sequence-orders']).toBe('warning')
    expect(byId['data-counter-public.invoice_no']).toBe('warning')
    // Not named: reported, not moved.
    expect(byId['data-counter-public.ticket_no']).toBe('info')

    const run = await h.cli(['diff', '--check', 'data', '--apply', '--json'], { cwd: ws })
    expect(JSON.parse(run.stdout).errors).toEqual([])
    // 50 ids were handed out on the source, across both tables.
    expect(await h.sql('target', `SELECT nextval('doc_no')`)).toBe('51')
    expect(await h.sql('target', `SELECT nextval('invoice_no')`)).toBe('1040')
    expect(await h.sql('target', `SELECT nextval('ticket_no')`)).toBe('1')
  }, 300_000)
})
