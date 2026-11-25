import { describe, it, expect, vi, afterEach } from 'vitest'
import { outputMode, writeResultRecords } from '../src/utils/jsonl.js'

function records(value: unknown): Array<Record<string, unknown>> {
  const lines: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true })
  try { writeResultRecords(value) } finally { spy.mockRestore() }
  // Each write is exactly one line.
  expect(lines.every(l => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true)
  return lines.map(l => JSON.parse(l))
}

afterEach(() => vi.restoreAllMocks())

describe('outputMode', () => {
  it('reads --jsonl before --json, and neither as none', () => {
    expect(outputMode(['diff', '--jsonl'])).toBe('jsonl')
    expect(outputMode(['diff', '--json'])).toBe('json')
    expect(outputMode(['diff'])).toBeUndefined()
    expect(outputMode(undefined)).toBeUndefined()
  })
})

describe('writeResultRecords', () => {
  it('a scan: a record per finding, then the result with the counts', () => {
    const out = records({
      score: 90, summary: { total: 2 },
      checks: [
        { check: 'schema', status: 'drifted', issues: [{ id: 'schema-create-table-1', check: 'schema' }] },
        { check: 'data', status: 'drifted', issues: [{ id: 'data-insert-public.t', check: 'data', rows: 3 }] },
      ],
    })
    expect(out.map(r => r.type)).toEqual(['issue', 'issue', 'result'])
    expect(out[1]).toEqual({ type: 'issue', id: 'data-insert-public.t', check: 'data', rows: 3 })
    expect(out[2]).toEqual({
      type: 'result', score: 90, summary: { total: 2 },
      checks: [{ check: 'schema', status: 'drifted', issues: 1 }, { check: 'data', status: 'drifted', issues: 1 }],
    })
  })

  it('an apply: what was applied, held back, failed and undone, what it said, then the counts', () => {
    const out = records({
      applied: [{ check: 'schema', issueId: 'a', sql: 'CREATE ...' }], skipped: [{ check: 'roles', issueId: 'b', reason: 'x' }],
      errors: [{ check: 'data', issueId: 'c', error: 'boom' }], rolledBack: [{ check: 'schema', issueId: 'a' }],
      notes: ['held off'], warnings: ['careful'], unchecked: [],
    })
    expect(out.map(r => r.type)).toEqual(['applied', 'skipped', 'failed', 'rolled-back', 'note', 'warning', 'result'])
    expect(out[4]).toEqual({ type: 'note', text: 'held off' })
    expect(out.at(-1)).toEqual({ type: 'result', applied: 1, skipped: 1, errors: 1, rolledBack: 1, unchecked: [] })
  })

  it('a failure is an error record and nothing else', () => {
    expect(records({ error: 'Diff aborted', code: 'E_CONNECT', preflight: [] }))
      .toEqual([{ type: 'error', error: 'Diff aborted', code: 'E_CONNECT', preflight: [] }])
  })
})
