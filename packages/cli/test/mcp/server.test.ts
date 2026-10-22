/**
 * MCP server unit tests (CLI-embedded server).
 *
 * Uses the MCP SDK InMemoryTransport to test tools, resources, and prompts
 * without spawning a subprocess.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearLastScanResult, setLastScanResult, getLastScanResult } from '../../src/mcp/state.js'
import { createServer } from '../../src/mcp/server.js'
import type { ScanResult } from '../../src/types/drift.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createTestConfig(dir: string, extra: object = {}): Promise<void> {
  const config = {
    environments: {
      dev: { dbUrl: 'postgresql://postgres:dev@localhost:5432/dev' },
      prod: { dbUrl: 'postgresql://postgres:prod@localhost:5432/prod' },
    },
    source: 'dev',
    target: 'prod',
    ...extra,
  }
  await writeFile(join(dir, 'supaforge.config.json'), JSON.stringify(config))
}

async function makeClient(cwd: string): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createServer(cwd)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)

  return {
    client,
    cleanup: async () => {
      await client.close()
    },
  }
}

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  const base: ScanResult = {
    timestamp: '2026-06-02T12:00:00.000Z',
    source: 'dev',
    target: 'prod',
    score: 85,
    postureScore: null,
    summary: { total: 1, critical: 1, warning: 0, info: 0 },
    checks: [
      {
        check: 'rls-coverage',
        status: 'drifted',
        durationMs: 10,
        issues: [
          {
            id: 'rls-coverage-public.orders',
            check: 'rls-coverage',
            severity: 'critical',
            title: 'RLS not enabled: public.orders',
            description: 'CVE-2025-48757 risk',
            targetValue: { schemaname: 'public', tablename: 'orders' },
            sql: {
              up: 'ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;',
              down: 'ALTER TABLE "public"."orders" DISABLE ROW LEVEL SECURITY;',
            },
          },
        ],
      },
    ],
  }
  // Object.assign rather than a spread: spreading Partial<ScanResult> widens
  // every property to `| undefined`, which no longer satisfies ScanResult.
  return Object.assign(base, overrides)
}

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Read the text body of an MCP resource result.
 *
 * `contents` entries are a `{ text }` | `{ blob }` union, so the property is
 * not accessible without narrowing. Every resource under test is textual;
 * this fails loudly rather than silently yielding undefined if that changes.
 */
function resourceText(result: { contents: Array<Record<string, unknown>> }): string {
  const first = result.contents[0]
  if (typeof first?.text !== 'string') {
    throw new Error(`expected a text resource, got ${JSON.stringify(first)}`)
  }
  return first.text
}

describe('mcp/state', () => {
  beforeEach(() => clearLastScanResult())

  it('getLastScanResult returns null initially', () => {
    clearLastScanResult()
    expect(getLastScanResult()).toBeNull()
  })

  it('setLastScanResult persists a result', () => {
    const result = makeScanResult()
    setLastScanResult(result)
    expect(getLastScanResult()).toEqual(result)
  })

  it('clearLastScanResult resets to null', () => {
    setLastScanResult(makeScanResult())
    clearLastScanResult()
    expect(getLastScanResult()).toBeNull()
  })
})

// ── Tool registration ─────────────────────────────────────────────────────────

describe('MCP tool registration', () => {
  let tmpDir: string
  let client: Client
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `supaforge-cli-mcp-test-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    ;({ client, cleanup } = await makeClient(tmpDir))
  })

  afterEach(async () => {
    await cleanup?.()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('lists all expected tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('diff')
    expect(names).toContain('sync')
    expect(names).toContain('list_environments')
    expect(names).toContain('take_snapshot')
    expect(names).toContain('create_migration')
    expect(names).toContain('get_check_result')
  })
})

// ── Tools ─────────────────────────────────────────────────────────────────────

describe('MCP tools', () => {
  let tmpDir: string
  let client: Client
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `supaforge-cli-mcp-tools-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    clearLastScanResult()
  })

  afterEach(async () => {
    await cleanup?.()
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('list_environments', () => {
    it('names each environment and the defaults, and never the credentials', async () => {
      await createTestConfig(tmpDir)
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'list_environments', arguments: {} })
      expect(result.isError).toBeFalsy()
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(JSON.parse(text)).toMatchObject({
        source: 'dev',
        target: 'prod',
        environments: [
          { name: 'dev', database: true, supabaseProject: false, accessToken: false },
          { name: 'prod', database: true, supabaseProject: false, accessToken: false },
        ],
      })
      expect(text).not.toContain('postgresql://')
    })
  })

  describe('diff', () => {
    it('errors when config file is missing', async () => {
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'diff', arguments: {} })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).toContain('Error')
    })

    it('errors when config has no environments', async () => {
      await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify({ environments: {}, source: 'x', target: 'y' }))
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'diff', arguments: {} })
      expect(result.isError).toBe(true)
    })
  })

  describe('get_check_result', () => {
    it('errors when no scan result is available', async () => {
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'get_check_result', arguments: { check: 'rls-coverage' } })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).toContain('Run diff first')
    })

    it('returns the check result when a scan exists', async () => {
      setLastScanResult(makeScanResult())
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'get_check_result', arguments: { check: 'rls-coverage' } })
      expect(result.isError).toBeFalsy()
      const text = (result.content as Array<{ text: string }>)[0].text
      const parsed = JSON.parse(text)
      expect(parsed.check).toBe('rls-coverage')
      expect(parsed.status).toBe('drifted')
      expect(parsed.issues).toHaveLength(1)
    })

    it('errors when requested check is not in last scan', async () => {
      setLastScanResult(makeScanResult())
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'get_check_result', arguments: { check: 'rls' } })
      expect(result.isError).toBe(true)
    })
  })

  describe('sync', () => {
    it('errors when config is missing', async () => {
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'sync', arguments: {} })
      expect(result.isError).toBe(true)
    })

    it('applies nothing, and says why, when a database cannot be reached', async () => {
      // Without a reachability check, an unreadable source looked empty and
      // the target's webhooks were dropped as extra.
      await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify({
        environments: {
          dev: { dbUrl: 'postgresql://postgres:wrong@invalid:5432/dev' },
          prod: { dbUrl: 'postgresql://postgres:prod@invalid:5432/prod' },
        },
        source: 'dev',
        target: 'prod',
      }))
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'sync', arguments: { checks: ['webhooks'] } })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).toMatch(/Nothing compared/)
      expect(text).toMatch(/Source \(dev\) not reachable/)
      expect(text).not.toContain('wrong')
    }, 60_000)
  })

  describe('take_snapshot', () => {
    it('errors when config is missing', async () => {
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'take_snapshot', arguments: {} })
      expect(result.isError).toBe(true)
    })

    it('errors when environment is not found', async () => {
      await createTestConfig(tmpDir)
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'take_snapshot', arguments: { environment: 'nonexistent' } })
      expect(result.isError).toBe(true)
      const text = (result.content as Array<{ text: string }>)[0].text
      expect(text).toContain('not found')
    })
  })

  describe('create_migration', () => {
    it('errors when config is missing', async () => {
      ;({ client, cleanup } = await makeClient(tmpDir))
      const result = await client.callTool({ name: 'create_migration', arguments: { name: 'x' } })
      expect(result.isError).toBe(true)
    })
  })
})

// ── Resources ─────────────────────────────────────────────────────────────────

describe('MCP resources', () => {
  let tmpDir: string
  let client: Client
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `supaforge-cli-mcp-res-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    clearLastScanResult()
  })

  afterEach(async () => {
    await cleanup?.()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('lists expected resources', async () => {
    ;({ client, cleanup } = await makeClient(tmpDir))
    const { resources } = await client.listResources()
    const uris = resources.map(r => r.uri)
    expect(uris).toContain('supaforge://config')
    expect(uris).toContain('supaforge://last-scan')
    expect(uris).toContain('supaforge://migrations')
  })

  it('config resource returns masked fields when config exists', async () => {
    await createTestConfig(tmpDir)
    ;({ client, cleanup } = await makeClient(tmpDir))
    const result = await client.readResource({ uri: 'supaforge://config' })
    const text = resourceText(result)
    const parsed = JSON.parse(text)
    for (const env of Object.values(parsed.environments as Record<string, { dbUrl: string }>)) {
      expect(env.dbUrl).toBe('***')
    }
  })

  it('config resource returns error text when file is missing', async () => {
    ;({ client, cleanup } = await makeClient(tmpDir))
    const result = await client.readResource({ uri: 'supaforge://config' })
    const text = resourceText(result)
    expect(text).toContain('Error')
  })

  it('last-scan resource returns no-scan message initially', async () => {
    ;({ client, cleanup } = await makeClient(tmpDir))
    const result = await client.readResource({ uri: 'supaforge://last-scan' })
    const text = resourceText(result)
    const parsed = JSON.parse(text)
    expect(parsed.message).toContain('Run diff first')
  })

  it('last-scan resource returns scan result after setLastScanResult', async () => {
    setLastScanResult(makeScanResult())
    ;({ client, cleanup } = await makeClient(tmpDir))
    const result = await client.readResource({ uri: 'supaforge://last-scan' })
    const text = resourceText(result)
    const parsed = JSON.parse(text)
    expect(parsed.score).toBe(85)
    expect(parsed.source).toBe('dev')
  })

  it('migrations resource returns empty list when directory does not exist', async () => {
    ;({ client, cleanup } = await makeClient(tmpDir))
    const result = await client.readResource({ uri: 'supaforge://migrations' })
    const text = resourceText(result)
    const parsed = JSON.parse(text)
    expect(parsed.files).toEqual([])
  })

  it('migrations resource lists json files when directory exists', async () => {
    const migrationsDir = join(tmpDir, '.supaforge', 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(join(migrationsDir, '20260101_init.json'), '{}')
    await writeFile(join(migrationsDir, '20260102_add-rls.json'), '{}')
    ;({ client, cleanup } = await makeClient(tmpDir))
    const result = await client.readResource({ uri: 'supaforge://migrations' })
    const text = resourceText(result)
    const parsed = JSON.parse(text)
    expect(parsed.files).toContain('20260101_init.json')
    expect(parsed.files).toContain('20260102_add-rls.json')
  })
})

// ── Prompts ───────────────────────────────────────────────────────────────────

describe('MCP prompts', () => {
  let tmpDir: string
  let client: Client
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `supaforge-cli-mcp-prompt-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    clearLastScanResult()
    ;({ client, cleanup } = await makeClient(tmpDir))
  })

  afterEach(async () => {
    await cleanup?.()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('lists expected prompts', async () => {
    const { prompts } = await client.listPrompts()
    const names = prompts.map(p => p.name)
    expect(names).toContain('review_drift_before_deploy')
    expect(names).toContain('fix_critical_issues')
  })

  it('review_drift_before_deploy prompt mentions diff and sync', async () => {
    const result = await client.getPrompt({ name: 'review_drift_before_deploy', arguments: {} })
    const text = result.messages[0].content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('Call diff')
    expect(text).toContain('run sync')
  })

  it('review_drift_before_deploy prompt includes environment name when provided', async () => {
    const result = await client.getPrompt({
      name: 'review_drift_before_deploy',
      arguments: { environment: 'production' },
    })
    const text = result.messages[0].content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('production')
  })

  it('fix_critical_issues prompt mentions CVE-2025-48757', async () => {
    const result = await client.getPrompt({ name: 'fix_critical_issues', arguments: {} })
    const text = result.messages[0].content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('CVE-2025-48757')
  })

  it('fix_critical_issues prompt lists critical issues from last scan', async () => {
    setLastScanResult(makeScanResult())
    const result = await client.getPrompt({ name: 'fix_critical_issues', arguments: {} })
    const text = result.messages[0].content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('rls-coverage')
    expect(text).toContain('RLS not enabled: public.orders')
  })

  it('fix_critical_issues prompt shows healthy message when no critical issues', async () => {
    setLastScanResult(
      makeScanResult({ summary: { total: 0, critical: 0, warning: 0, info: 0 }, checks: [] }),
    )
    const result = await client.getPrompt({ name: 'fix_critical_issues', arguments: {} })
    const text = result.messages[0].content.type === 'text' ? result.messages[0].content.text : ''
    expect(text).toContain('No critical issues')
  })
})
