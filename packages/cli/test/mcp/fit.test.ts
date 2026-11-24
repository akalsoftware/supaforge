import { describe, it, expect, afterEach } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fitForAgent, LONG_STRING, MAX_RESULT } from '../../src/mcp/fit.js'
import { createServer } from '../../src/mcp/server.js'
import { clearLastScanResult, setLastScanResult } from '../../src/mcp/state.js'
import type { ScanResult } from '../../src/types/drift.js'

/** A data check of `n` batches, each `bytes` of SQL: the shape a large sync takes. */
function bigScan(n: number, bytes: number): ScanResult {
  const issues = Array.from({ length: n }, (_, i) => ({
    id: `data-insert-public.t${i}`,
    check: 'data' as const,
    severity: 'warning' as const,
    title: `1,000 rows missing from public.t${i}`,
    description: 'Rows in the source are missing from the target. The fix inserts them.',
    rows: 1000,
    sql: { up: `INSERT INTO "t${i}" VALUES (1);\n`.repeat(Math.ceil(bytes / 30)), down: '' },
  }))
  return {
    timestamp: '', source: 's', target: 't', score: 0, postureScore: null,
    summary: { total: n, critical: 0, warning: n, info: 0 },
    checks: [{ check: 'data', status: 'drifted', durationMs: 1, issues }],
  }
}

describe('fitForAgent', () => {
  it('leaves a small result exactly as JSON.stringify writes it', () => {
    const v = { a: 1, b: ['x', { c: 'y' }], d: 'z'.repeat(LONG_STRING) }
    expect(fitForAgent(v)).toBe(JSON.stringify(v, null, 2))
  })

  it('cuts a long string to its start and says how much is left out', () => {
    const out = JSON.parse(fitForAgent({ sql: 'a\n'.repeat(5_000) }))
    expect(out.sql.length).toBeLessThan(LONG_STRING + 200)
    expect(out.sql).toMatch(/… 6,000 more characters \(3,000 more lines\) left out here/)
  })

  it('keeps a large result under its budget, and every id, title and count in it', () => {
    const scan = bigScan(300, 4 * 1024 * 1024 / 8)
    const text = fitForAgent(scan)
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT)
    const out = JSON.parse(text)
    // Past 200 items the list says how many more there are.
    const issues = out.checks[0].issues
    expect(issues.filter((i: unknown) => typeof i === 'object').every((i: { id: string; title: string; rows: number }) =>
      /^data-insert-public\.t\d+$/.test(i.id) && /rows missing/.test(i.title) && i.rows === 1000)).toBe(true)
    expect(out.summary).toEqual(scan.summary)
  })

  it('never cuts an id, title or error, however long', () => {
    const title = 't'.repeat(LONG_STRING * 2)
    expect(JSON.parse(fitForAgent({ title, error: title })).title).toBe(title)
  })
})

describe('the MCP server, on a large scan', () => {
  let dir: string
  afterEach(async () => { clearLastScanResult(); if (dir) await rm(dir, { recursive: true, force: true }) })

  async function client() {
    dir = await mkdtemp(join(tmpdir(), 'sf-mcp-fit-'))
    await writeFile(join(dir, 'supaforge.config.json'), JSON.stringify({
      environments: { a: { dbUrl: 'postgresql://u:p@localhost:1/a' }, b: { dbUrl: 'postgresql://u:p@localhost:1/b' } }, source: 'a', target: 'b',
    }))
    const server = createServer(dir)
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const mcp = new Client({ name: 't', version: '1' })
    await mcp.connect(c)
    return mcp
  }

  it('get_check_result fits the check, and returns one finding whole by its id', async () => {
    const scan = bigScan(50, 2 * 1024 * 1024)
    setLastScanResult(scan)
    const mcp = await client()
    const all = await mcp.callTool({ name: 'get_check_result', arguments: { check: 'data' } })
    const allText = (all.content as Array<{ text: string }>)[0].text
    expect(allText.length).toBeLessThanOrEqual(MAX_RESULT)

    const one = await mcp.callTool({ name: 'get_check_result', arguments: { check: 'data', issueId: 'data-insert-public.t7' } })
    const issue = JSON.parse((one.content as Array<{ text: string }>)[0].text)
    expect(issue.id).toBe('data-insert-public.t7')
    expect(issue.sql.up).toBe(scan.checks[0].issues[7].sql!.up)
    expect(issue.sql.up.length).toBeGreaterThan(MAX_RESULT)

    const missing = await mcp.callTool({ name: 'get_check_result', arguments: { check: 'data', issueId: 'nope' } })
    expect(missing.isError).toBe(true)
    await mcp.close()
  })
})
