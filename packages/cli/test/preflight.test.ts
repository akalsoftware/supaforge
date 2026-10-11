import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── pg mock with a behaviour queue ──────────────────────────────────────────
// Each entry describes what the next pg.Client instance should do.
interface ClientBehaviour {
  connectError?: Error
  version?: string
}

const clientQueue: ClientBehaviour[] = []

/** Config each pg.Client was constructed with, so the bounds can be asserted. */
const clientConfigs: Array<Record<string, unknown>> = []

vi.mock('pg', () => ({
  default: {
    // `function`, not an arrow: the code under test calls `new pg.Client()`.
    Client: vi.fn(function (config: Record<string, unknown>) {
      clientConfigs.push(config)
      const behaviour = clientQueue.shift() ?? {}
      return {
        connect: vi.fn(async () => {
          if (behaviour.connectError) throw behaviour.connectError
        }),
        query: vi.fn(async () => ({
          rows: [{ server_version: behaviour.version ?? '17.0' }],
        })),
        end: vi.fn(),
      }
    }),
  },
}))

// Mock local-pg (detectRuntime)
vi.mock('../src/local-pg.js', () => ({
  detectRuntime: vi.fn(async () => null),
}))

import {
  checkConnection,
  buildLocalHints,
  buildConnectionHints,
  buildTimeoutHints,
  describeTimeout,
  Preflight,
} from '../src/preflight.js'
import pg from 'pg'
import { detectRuntime } from '../src/local-pg.js'
import { DB_CONNECT_TIMEOUT_MS, DB_PROBE_TIMEOUT_MS } from '../src/constants.js'

describe('checkConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientQueue.length = 0
    clientConfigs.length = 0
    delete process.env.SUPAFORGE_CONNECT_TIMEOUT
  })

  it('returns reachable with version on success', async () => {
    clientQueue.push({ version: '17.2' })
    const result = await checkConnection('postgres://user:pass@localhost:5432/db')
    expect(result).toEqual({ reachable: true, version: '17.2' })
  })

  it('returns not reachable with error message on failure', async () => {
    clientQueue.push({ connectError: new Error('Connection refused') })
    const result = await checkConnection('postgres://user:pass@localhost:5432/db')
    expect(result).toEqual({ reachable: false, error: 'Connection refused' })
  })

  it('captures auth failures', async () => {
    clientQueue.push({ connectError: new Error('password authentication failed for user "postgres"') })
    const result = await checkConnection('postgres://user:pass@localhost:5432/db')
    expect(result.reachable).toBe(false)
    expect(result.error).toContain('password authentication failed')
  })
})

describe('buildLocalHints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty hints for non-local URLs', async () => {
    const hints = await buildLocalHints('postgres://user:pass@remote.host.com:5432/db')
    expect(hints).toEqual([])
  })

  it('suggests supabase start for port 54322', async () => {
    const hints = await buildLocalHints('postgres://user:pass@localhost:54322/db')
    expect(hints.some(h => h.includes('supabase start'))).toBe(true)
  })

  it('mentions detected container runtime', async () => {
    vi.mocked(detectRuntime).mockResolvedValueOnce('podman')
    const hints = await buildLocalHints('postgres://user:pass@localhost:5432/db')
    expect(hints.some(h => h.includes('podman'))).toBe(true)
  })

  it('suggests manual start when no runtime available', async () => {
    vi.mocked(detectRuntime).mockResolvedValueOnce(null)
    const hints = await buildLocalHints('postgres://user:pass@localhost:5432/db')
    expect(hints.some(h => h.includes('Start PostgreSQL manually'))).toBe(true)
  })

  it('returns empty hints for invalid URLs', async () => {
    const hints = await buildLocalHints('not-a-url')
    expect(hints).toEqual([])
  })

  it('suggests config fix instead of startup for auth errors', async () => {
    const hints = await buildLocalHints(
      'postgres://user:pass@localhost:5432/db',
      'password authentication failed for user "postgres"',
    )
    expect(hints.some(h => h.includes('username and password'))).toBe(true)
    expect(hints.some(h => h.includes('Start PostgreSQL'))).toBe(false)
    expect(hints.some(h => h.includes('start a PostgreSQL container'))).toBe(false)
  })

  it('suggests config fix for missing database errors', async () => {
    const hints = await buildLocalHints(
      'postgres://user:pass@localhost:5432/nope',
      'database "nope" does not exist',
    )
    expect(hints.some(h => h.includes('username and password'))).toBe(true)
    expect(hints.some(h => h.includes('Start PostgreSQL'))).toBe(false)
  })

  it('suggests startup hints for connection refused errors', async () => {
    vi.mocked(detectRuntime).mockResolvedValueOnce('podman')
    const hints = await buildLocalHints(
      'postgres://user:pass@localhost:5432/db',
      'connect ECONNREFUSED 127.0.0.1:5432',
    )
    expect(hints.some(h => h.includes('podman'))).toBe(true)
    expect(hints.some(h => h.includes('username and password'))).toBe(false)
  })

  it('mentions default password for auth errors on Supabase port', async () => {
    const hints = await buildLocalHints(
      'postgres://user:pass@localhost:54322/db',
      'password authentication failed for user "postgres"',
    )
    expect(hints.some(h => h.includes('default password'))).toBe(true)
  })
})

describe('Preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientQueue.length = 0
  })

  it('passes when all databases are reachable', async () => {
    clientQueue.push({ version: '17.2' })  // source
    clientQueue.push({ version: '17.2' })  // target

    const lines: string[] = []
    const pre = new Preflight('Diff preflight checks', (m) => lines.push(m))
      .addDatabase('Source', 'local', 'postgres://user:pass@localhost:5432/db')
      .addDatabase('Target', 'prod', 'postgres://user:pass@remote:5432/db')
    const report = await pre.run()

    expect(report.passed).toBe(true)
    expect(report.checks).toHaveLength(2)
    expect(report.checks[0].passed).toBe(true)
    expect(report.checks[1].passed).toBe(true)
    expect(lines.some(l => l.includes('All checks passed'))).toBe(true)
  })

  it('fails when source is unreachable', async () => {
    clientQueue.push({ connectError: new Error('Connection refused') })
    clientQueue.push({ version: '17.2' })

    const lines: string[] = []
    const pre = new Preflight('Diff preflight checks', (m) => lines.push(m))
      .addDatabase('Source', 'local', 'postgres://user:pass@localhost:5432/db')
      .addDatabase('Target', 'prod', 'postgres://user:pass@remote:5432/db')
    const report = await pre.run()

    expect(report.passed).toBe(false)
    expect(report.checks[0].passed).toBe(false)
    expect(report.checks[0].error).toContain('Connection refused')
    expect(lines.some(l => l.includes('Some checks failed'))).toBe(true)
  })

  it('fails when target is unreachable', async () => {
    clientQueue.push({ version: '17.2' })
    clientQueue.push({ connectError: new Error('ETIMEDOUT') })

    const lines: string[] = []
    const pre = new Preflight('Diff preflight checks', (m) => lines.push(m))
      .addDatabase('Source', 'local', 'postgres://user:pass@localhost:5432/db')
      .addDatabase('Target', 'prod', 'postgres://user:pass@remote:5432/db')
    const report = await pre.run()

    expect(report.passed).toBe(false)
    expect(report.checks[1].passed).toBe(false)
  })

  it('redacts credentials in output', async () => {
    clientQueue.push({ connectError: new Error('Connection refused') })
    clientQueue.push({ connectError: new Error('Connection refused') })

    const lines: string[] = []
    const pre = new Preflight('Test', (m) => lines.push(m))
      .addDatabase('Source', 'local', 'postgres://admin:supersecret@localhost:5432/db')
      .addDatabase('Target', 'prod', 'postgres://admin:topsecret@remote:5432/db')
    await pre.run()

    const output = lines.join('\n')
    expect(output).not.toContain('supersecret')
    expect(output).not.toContain('topsecret')
  })

  it('shows header with title and environment names', async () => {
    clientQueue.push({ version: '16.1' })
    clientQueue.push({ version: '16.1' })

    const lines: string[] = []
    const pre = new Preflight('Diff preflight checks', (m) => lines.push(m))
      .addDatabase('Source', 'staging', 'postgres://user:pass@localhost:5432/db')
      .addDatabase('Target', 'production', 'postgres://user:pass@remote:5432/db')
    await pre.run()

    const output = lines.join('\n')
    expect(output).toContain('Diff preflight checks')
    expect(output).toContain('staging')
    expect(output).toContain('production')
  })

  it('works with a single database', async () => {
    clientQueue.push({ version: '15.4' })

    const lines: string[] = []
    const pre = new Preflight('Snapshot preflight checks', (m) => lines.push(m))
      .addDatabase('Database', 'staging', 'postgres://user:pass@host:5432/db')
    const report = await pre.run()

    expect(report.passed).toBe(true)
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0].detail).toContain('15.4')
    expect(lines.some(l => l.includes('Snapshot preflight checks'))).toBe(true)
  })

  it('runs custom checks after database checks', async () => {
    clientQueue.push({ version: '17.0' })

    const lines: string[] = []
    const pre = new Preflight('Clone preflight checks', (m) => lines.push(m))
      .addDatabase('Remote', 'prod', 'postgres://user:pass@remote:5432/db')
      .addCheck('pg_dump compatibility', async () => ({ detail: 'v17 ↔ server v17' }))
    const report = await pre.run()

    expect(report.passed).toBe(true)
    expect(report.checks).toHaveLength(2)
    expect(report.checks[0].label).toBe('Remote')
    expect(report.checks[1].label).toBe('pg_dump compatibility')
    expect(report.checks[1].detail).toContain('v17')
  })

  it('fails when a custom check returns an error', async () => {
    clientQueue.push({ version: '17.0' })

    const lines: string[] = []
    const pre = new Preflight('Test', (m) => lines.push(m))
      .addDatabase('DB', 'local', 'postgres://user:pass@localhost:5432/db')
      .addCheck('Target database', async () => ({
        error: '"mydb" already exists on local server',
        hints: ['Use --force to drop and recreate it.'],
      }))
    const report = await pre.run()

    expect(report.passed).toBe(false)
    expect(report.checks[1].passed).toBe(false)
    expect(report.checks[1].error).toContain('already exists')
    expect(report.checks[1].hints).toHaveLength(1)
  })

  it('renders info lines in header', async () => {
    clientQueue.push({ version: '17.0' })

    const lines: string[] = []
    const pre = new Preflight('Clone preflight checks', (m) => lines.push(m))
      .addDatabase('Remote', 'prod', 'postgres://user:pass@remote:5432/db')
      .addInfo('Local DB', 'supaforge_local')
      .addInfo('Schema only', 'false')
    await pre.run()

    const output = lines.join('\n')
    expect(output).toContain('Local DB')
    expect(output).toContain('supaforge_local')
    expect(output).toContain('Schema only')
  })
})

// ─── issue #44: a database that accepts TCP and never answers ───────────────

describe('checkConnection bounds the wait (issue #44)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientQueue.length = 0
    clientConfigs.length = 0
    delete process.env.SUPAFORGE_CONNECT_TIMEOUT
  })

  it('sets both a connection and a probe bound', async () => {
    clientQueue.push({ version: '16.1' })
    await checkConnection('postgres://user:pass@localhost:5432/db')

    // pg defaults connectionTimeoutMillis to 0 — wait forever. A host that
    // accepts the connection and then goes silent hung the whole command.
    expect(clientConfigs[0].connectionTimeoutMillis).toBe(DB_CONNECT_TIMEOUT_MS)
    expect(clientConfigs[0].query_timeout).toBe(DB_PROBE_TIMEOUT_MS)
  })

  it('honours SUPAFORGE_CONNECT_TIMEOUT', async () => {
    process.env.SUPAFORGE_CONNECT_TIMEOUT = '30'
    clientQueue.push({ version: '16.1' })
    await checkConnection('postgres://user:pass@localhost:5432/db')
    expect(clientConfigs[0].connectionTimeoutMillis).toBe(30_000)
  })

  it('translates the driver connect timeout into a diagnosis', async () => {
    clientQueue.push({ connectError: new Error('timeout expired') })
    const result = await checkConnection('postgres://user:pass@localhost:5599/db')
    expect(result.reachable).toBe(false)
    expect(result.error).toContain('timed out after 15s connecting')
    expect(result.error).toContain('never completed the handshake')
    // The bare driver text reads as a bug rather than an explanation.
    expect(result.error).not.toBe('timeout expired')
  })

  it('closes the client even when the connection timed out', async () => {
    // A half-open socket keeps the event loop alive and hangs the process
    // after the report has already printed.
    clientQueue.push({ connectError: new Error('timeout expired') })
    await checkConnection('postgres://user:pass@localhost:5599/db')
    const instance = vi.mocked(pg.Client).mock.results[0].value as { end: ReturnType<typeof vi.fn> }
    expect(instance.end).toHaveBeenCalled()
  })
})

describe('describeTimeout', () => {
  it('names the connect wait', () => {
    expect(describeTimeout('timeout expired', 15_000, 15_000)).toContain('timed out after 15s connecting')
  })

  it('names the probe wait separately', () => {
    const out = describeTimeout('Query read timeout', 15_000, 20_000)
    expect(out).toContain('timed out after 20s waiting for server response')
    expect(out).toContain('connected, but the server did not answer')
  })

  it('leaves unrelated errors alone', () => {
    // An OS-level ETIMEDOUT is a different failure and already reads clearly.
    for (const msg of ['connect ECONNREFUSED 127.0.0.1:5432', 'connect ETIMEDOUT 10.0.0.1:5432', 'password authentication failed']) {
      expect(describeTimeout(msg, 15_000, 15_000)).toBe(msg)
    }
  })
})

describe('buildConnectionHints', () => {
  beforeEach(() => vi.clearAllMocks())

  it('gives stall hints for a timeout, on a remote host too', async () => {
    const hints = await buildConnectionHints(
      'postgres://user:pass@db.example.com:5432/db',
      'timed out after 15s connecting — the host accepted the connection but never completed the handshake',
    )
    expect(hints).toEqual(buildTimeoutHints())
    expect(hints.some(h => h.includes('did not answer'))).toBe(true)
    expect(hints.some(h => h.includes('SUPAFORGE_CONNECT_TIMEOUT'))).toBe(true)
  })

  it('does not suggest starting a local server when a remote one stalled', async () => {
    const hints = await buildConnectionHints(
      'postgres://user:pass@db.example.com:5432/db',
      'timed out after 15s connecting — the host accepted the connection but never completed the handshake',
    )
    expect(hints.some(h => h.includes('Start PostgreSQL manually'))).toBe(false)
    expect(hints.some(h => h.includes('supabase start'))).toBe(false)
  })

  it('falls through to the local hints for a refusal', async () => {
    vi.mocked(detectRuntime).mockResolvedValueOnce('podman')
    const hints = await buildConnectionHints(
      'postgres://user:pass@localhost:5432/db',
      'connect ECONNREFUSED 127.0.0.1:5432',
    )
    expect(hints.some(h => h.includes('podman'))).toBe(true)
  })
})

/**
 * Issue #47 (3): a connection failure that reached the renderer with no
 * `message` printed the label, a colon, and nothing —
 * `✗ Source database not reachable:`. No failure path may end that way.
 */
describe('a connection failure always reports a reason (issue #47)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientQueue.length = 0
    clientConfigs.length = 0
  })

  it('reports the error code when the driver gives no message', async () => {
    clientQueue.push({ connectError: Object.assign(new Error(''), { code: 'ECONNRESET' }) })
    const result = await checkConnection('postgres://user:pass@localhost:5432/db')

    expect(result.reachable).toBe(false)
    expect(result.error).toContain('ECONNRESET')
  })

  it('reports something for an error carrying nothing at all', async () => {
    clientQueue.push({ connectError: new Error('') })
    const result = await checkConnection('postgres://user:pass@localhost:5432/db')

    expect(result.reachable).toBe(false)
    expect(result.error?.trim().length ?? 0).toBeGreaterThan(0)
  })

  it('never renders a bare colon, whatever the failure carried', async () => {
    const failures = [
      new Error(''),
      new Error('   '),
      Object.assign(new Error(''), { code: 'EPIPE' }),
      new TypeError(''),
    ]

    for (const connectError of failures) {
      clientQueue.length = 0
      clientQueue.push({ connectError })

      const lines: string[] = []
      const pre = new Preflight('Test', m => lines.push(m), () => {})
      pre.addDatabase('Source', 'source', 'postgres://user:pass@localhost:5432/db')
      await pre.run()

      const failureLine = lines.find(l => l.includes('not reachable'))
      expect(failureLine, `no failure line for ${connectError.name}`).toBeDefined()
      expect(failureLine!.trimEnd()).not.toMatch(/not reachable:$/)
    }
  })

  it('still reports a populated message unchanged', async () => {
    clientQueue.push({ connectError: new Error('connect ECONNREFUSED 127.0.0.1:5434') })
    const result = await checkConnection('postgres://user:pass@localhost:5434/db')
    expect(result.error).toBe('connect ECONNREFUSED 127.0.0.1:5434')
  })

  it('still names which wait elapsed on a timeout', async () => {
    clientQueue.push({ connectError: new Error('timeout expired') })
    const result = await checkConnection('postgres://user:pass@localhost:5432/db')
    expect(result.error).toContain('timed out after')
  })
})
