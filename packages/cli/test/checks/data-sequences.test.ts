import { counterIssues, counterFixSql } from '../../src/checks/data-sequences.js'
import { matchesGlob } from '../../src/utils/strings.js'
import { describe, it, expect } from 'vitest'
import { sequenceFixSql, sequenceIssues } from '../../src/checks/data-sequences.js'
import { planWork } from '../../src/promote.js'
import { statementPhase, PHASE } from '../../src/sql-deps.js'
import type { QueryFn } from '../../src/db.js'
import type { ScanResult } from '../../src/types/drift.js'

/** Answers the source's column list, its max, and the target's next value. */
function fake(opts: { max: string | null; target?: { ascending: boolean; next: string } }): QueryFn {
  return async (url, sql) => {
    if (url === 'src' && sql.includes('pg_depend')) return [{ col: 'id' }]
    if (url === 'src' && sql.includes('max(')) return [{ max: opts.max }]
    if (url === 'tgt') return opts.target ? [opts.target] : []
    return []
  }
}

describe('sequenceIssues', () => {
  it('reports a sequence whose next value is at or below the source\'s largest id', async () => {
    const [issue] = await sequenceIssues('src', 'tgt', ['plans'], fake({ max: '3', target: { ascending: true, next: '1' } }))
    expect(issue.id).toBe('data-sequence-plans')
    expect(issue.description).toContain('id (next 1, rows up to 3)')
    expect(issue.sql!.up).toBe(sequenceFixSql('plans', 'id'))
    expect(await sequenceIssues('src', 'tgt', ['plans'], fake({ max: '3', target: { ascending: true, next: '3' } }))).toHaveLength(1)
  })

  it('leaves a sequence already past the rows, an empty table and a descending sequence alone', async () => {
    expect(await sequenceIssues('src', 'tgt', ['plans'], fake({ max: '3', target: { ascending: true, next: '4' } }))).toEqual([])
    expect(await sequenceIssues('src', 'tgt', ['plans'], fake({ max: null, target: { ascending: true, next: '1' } }))).toEqual([])
    expect(await sequenceIssues('src', 'tgt', ['plans'], fake({ max: '3', target: { ascending: false, next: '-1' } }))).toEqual([])
  })

  it('compares ids past 2^53 exactly', async () => {
    const big = fake({ max: '9007199254740993', target: { ascending: true, next: '9007199254740993' } })
    expect(await sequenceIssues('src', 'tgt', ['plans'], big)).toHaveLength(1)
    const past = fake({ max: '9007199254740993', target: { ascending: true, next: '9007199254740994' } })
    expect(await sequenceIssues('src', 'tgt', ['plans'], past)).toEqual([])
  })

  it('fixes a table the target does not have yet, whose sequence the sync creates', async () => {
    const [issue] = await sequenceIssues('src', 'tgt', ['app.plans'], fake({ max: '3' }))
    expect(issue.description).toContain('on a sequence the sync creates')
    expect(issue.sql!.up).toContain(`to_regclass('"app"."plans"')`)
  })
})

describe('the sequence fix in a plan', () => {
  const scan = (ids: string[]): ScanResult => ({
    timestamp: '', source: 's', target: 't', score: 0, postureScore: 100,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    checks: [{
      check: 'data',
      status: 'drifted',
      issues: [
        { id: 'data-sequence-plans', check: 'data', severity: 'warning', title: '', description: '', sql: { up: sequenceFixSql('plans', 'id'), down: '' } },
        ...ids.map(id => ({ id, check: 'data' as const, severity: 'info' as const, title: '', description: '', sql: { up: `INSERT INTO "plans" ("id") VALUES (${id.slice(-1)});`, down: '' } })),
      ],
    }],
  } as unknown as ScanResult)

  it('runs after the rows, whatever order the check reported them in', () => {
    expect(statementPhase(sequenceFixSql('plans', 'id'))).toBe(PHASE.AFTER_DATA)
    const order = planWork(scan(['data-insert-1', 'data-insert-2'])).sqlStatements.map(s => s.issueId)
    expect(order).toEqual(['data-insert-1', 'data-insert-2', 'data-sequence-plans'])
  })

  it('comes along with rows picked by --only', () => {
    const picked = planWork(scan(['data-insert-1', 'data-insert-2']), { only: ['data-insert-2'] }).sqlStatements.map(s => s.issueId)
    expect(picked).toEqual(['data-insert-2', 'data-sequence-plans'])
    const none = planWork(scan(['data-insert-1']), { only: ['schema-*'] }).sqlStatements
    expect(none).toEqual([])
  })
})

describe('counterIssues: sequences of their own', () => {
  const counter = (name: string, last: string | null, next: string, schema = 'public', ascending = true) => ({ schema, name, last, next, ascending })
  const run = (source: unknown[], target: unknown[], configured: string[] = []) =>
    counterIssues('source', 'target', configured, ['auth', 'storage'], async (url: string) => (url === 'source' ? source : target) as never, matchesGlob)

  it('moves a named counter the source has counted past, and only reports one not named', async () => {
    const issues = await run(
      [counter('invoice_no', '1039', '1040'), counter('ticket_no', '7', '8')],
      [counter('invoice_no', null, '1000'), counter('ticket_no', null, '1')],
      ['invoice_*'],
    )
    expect(issues.map(i => [i.id, i.severity, Boolean(i.sql), Boolean(i.manualOnly)])).toEqual([
      ['data-counter-public.invoice_no', 'warning', true, false],
      ['data-counter-public.ticket_no', 'info', false, true],
    ])
    expect(issues[0].sql!.up).toBe(counterFixSql('public.invoice_no', '1039'))
  })

  it('says nothing of a counter the target is level with or past, one the source never used, one counting down, or one in an ignored schema', async () => {
    const issues = await run(
      [counter('level', '9', '10'), counter('unused', null, '1'), counter('down', '5', '4', 'public', false), counter('s', '9', '10', 'auth')],
      [counter('level', '9', '10'), counter('unused', null, '1'), counter('down', null, '9', 'public', false), counter('s', null, '1', 'auth')],
      ['*'],
    )
    expect(issues).toEqual([])
  })

  it('leaves one the target lacks to the schema check', async () => {
    expect(await run([counter('new_no', '5', '6')], [], ['*'])).toEqual([])
  })

  it('the fix only ever moves it forward', () => {
    expect(counterFixSql('public.invoice_no', '1039')).toMatch(/AND 1039 >= coalesce\(pg_sequence_last_value\(q\.seqrelid\) \+ q\.seqincrement, q\.seqstart\);$/)
  })
})
