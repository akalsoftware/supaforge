import pg from 'pg'
import { detectRuntime } from './local-pg.js'
import { resolveConnectTimeoutMs, newPgClient } from './db.js'
import { DB_PROBE_TIMEOUT_MS } from './constants.js'
import { ok, warn, dim, cmd, bold } from './ui.js'
import { redactUrls, describeFailure } from './utils/error.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of a single connectivity check. */
export interface ConnCheckResult {
  reachable: boolean
  version?: string
  error?: string
}

/** Outcome of a single preflight check (DB connectivity or custom). */
export interface CheckEntry {
  label: string
  passed: boolean
  detail?: string
  error?: string
  hints?: string[]
}

/** Full report returned by Preflight.run(). */
export interface PreflightReport {
  passed: boolean
  checks: CheckEntry[]
}

/** Supabase CLI default PostgreSQL port. */
const SUPABASE_LOCAL_PORT = '54322'

/** Standard PostgreSQL port. */
const DEFAULT_PG_PORT = '5432'

// ─── Standalone helpers (remain exported for direct use / tests) ─────────────

/**
 * `pg`'s messages for the two bounds this module sets. Neither says what was
 * being waited for, and "timeout expired" in particular reads like a bug
 * rather than a diagnosis.
 */
const CONNECT_TIMEOUT_RE = /timeout expired|connection timeout/i
const QUERY_TIMEOUT_RE = /query read timeout/i

/**
 * Replace a bare driver timeout with something that says which wait elapsed.
 *
 * Left untouched when it is not one of ours: a server-side `statement_timeout`
 * or an OS-level ETIMEDOUT is a different failure and already reads clearly.
 */
export function describeTimeout(message: string, connectTimeoutMs: number, probeTimeoutMs: number): string {
  if (CONNECT_TIMEOUT_RE.test(message)) {
    return `timed out after ${Math.round(connectTimeoutMs / 1000)}s connecting — the host accepted the connection but never completed the handshake`
  }
  if (QUERY_TIMEOUT_RE.test(message)) {
    return `timed out after ${Math.round(probeTimeoutMs / 1000)}s waiting for server response — connected, but the server did not answer`
  }
  return message
}

/**
 * Test that a PostgreSQL database is reachable and return the server version.
 *
 * Both waits are bounded. Without that, a host that accepts the connection and
 * then goes silent blocks here forever, and the command produces no output at
 * all past the `Checks:` header (issue #44).
 */
export async function checkConnection(dbUrl: string): Promise<ConnCheckResult> {
  const connectTimeoutMs = resolveConnectTimeoutMs()
  let client: pg.Client | undefined
  try {
    client = newPgClient(dbUrl, DB_PROBE_TIMEOUT_MS)
    await client.connect()
    const { rows } = await client.query('SHOW server_version')
    const version = (rows[0] as Record<string, string>).server_version
    return { reachable: true, version }
  } catch (err) {
    return {
      reachable: false,
      error: describeTimeout(describeFailure(err), connectTimeoutMs, DB_PROBE_TIMEOUT_MS),
    }
  } finally {
    // A client that timed out mid-handshake still holds an open socket, which
    // keeps the event loop alive and hangs the process after the report has
    // already printed. end() on a never-connected client is a no-op, and a
    // failure closing it must not mask the real error above.
    try {
      await client?.end()
    } catch {
      // ignore
    }
  }
}

/** Errors that indicate the server IS running but rejecting the connection. */
const SERVER_REACHABLE_RE = /password authentication failed|does not exist|database .* does not exist|SSL.*required|no pg_hba\.conf entry/i

/**
 * Build context-aware hints when a local PostgreSQL is not reachable.
 * Detects Supabase CLI port, available container runtimes, etc.
 *
 * When `error` is provided and indicates the server IS running (auth failure,
 * missing database, SSL rejection), startup hints are suppressed in favour of
 * configuration hints.
 */
export async function buildLocalHints(dbUrl: string, error?: string): Promise<string[]> {
  const hints: string[] = []
  try {
    const urlObj = new URL(dbUrl)
    const isSupabasePort = urlObj.port === SUPABASE_LOCAL_PORT
    const isLocal = ['localhost', '127.0.0.1', '::1', ''].includes(urlObj.hostname)

    if (!isLocal) return hints

    // Server is reachable but rejecting — suggest config fixes, not startup.
    if (error && SERVER_REACHABLE_RE.test(error)) {
      hints.push(`Check the username and password in your database URL.`)
      if (isSupabasePort) {
        hints.push(`Port ${SUPABASE_LOCAL_PORT} is the Supabase CLI default. The default password is "postgres".`)
      }
      return hints
    }

    if (isSupabasePort) {
      hints.push(`Port ${SUPABASE_LOCAL_PORT} is the Supabase CLI default. Run ${cmd('"supabase start"')} to start your local Supabase instance.`)
    }

    const runtime = await detectRuntime()
    if (runtime) {
      hints.push(`${bold(runtime)} detected — you can start a PostgreSQL container manually.`)
    }

    if (!isSupabasePort) {
      hints.push(`Start PostgreSQL manually on port ${urlObj.port || DEFAULT_PG_PORT}.`)
    }
  } catch {
    // Invalid URL — no hints
  }
  return hints
}

/**
 * Hints for a connection that was bounded rather than refused.
 *
 * These apply to any host, unlike the local-startup hints — a stalled server
 * is just as likely to be a remote one behind a dropped tunnel, which is the
 * case that motivated bounding the wait at all (issue #44).
 */
export function buildTimeoutHints(): string[] {
  return [
    'The host is listening but the database did not answer.',
    'Check the database process is running and not paused, restarting, or overloaded.',
    'Over a VPN or tunnel, check the connection is still up.',
    `Raise the bound with ${cmd('SUPAFORGE_CONNECT_TIMEOUT')} (in seconds) if the link is simply slow.`,
  ]
}

/**
 * Pick the right hints for a failed connection.
 *
 * A timeout and a refusal need different advice, and the local-startup hints
 * are actively misleading for a remote host that stalled.
 */
export async function buildConnectionHints(dbUrl: string, error?: string): Promise<string[]> {
  if (error && /timed out after \d+s/.test(error)) return buildTimeoutHints()
  return buildLocalHints(dbUrl, error)
}

// ─── Preflight class ─────────────────────────────────────────────────────────

type LogFn = (msg: string) => void

/**
 * Render a transient "in progress" line, or clear it when passed null.
 *
 * Separate from LogFn because these lines are overwritten rather than kept:
 * on a TTY the finished result replaces them, and off a TTY they are dropped
 * entirely so piped output and CI logs stay one line per check.
 */
export type PendingFn = (msg: string | null) => void

const defaultPending: PendingFn = (msg) => {
  if (!process.stdout.isTTY) return
  process.stdout.write(msg === null ? '\r\u001b[2K' : `\r\u001b[2K${msg}`)
}

/** Queued database to check during run(). */
interface DbEntry {
  label: string
  envName: string
  dbUrl: string
}

/** Custom check callback. Return null on success, or an error string on failure. */
export type CustomCheckFn = () => Promise<{ error?: string; detail?: string; hints?: string[] }>

/** Queued custom check. */
interface CustomEntry {
  label: string
  fn: CustomCheckFn
}

/**
 * Composable preflight check runner.
 *
 * Usage:
 * ```ts
 * const pre = new Preflight('Diff preflight checks', (m) => this.log(m))
 * pre.addDatabase('Source', 'local', sourceUrl)
 * pre.addDatabase('Target', 'prod', targetUrl)
 * const report = await pre.run()
 * if (!report.passed) this.error('Aborted.', { exit: 1 })
 * ```
 *
 * For commands with extra checks (e.g. clone's pg_dump compat):
 * ```ts
 * pre.addCheck('pg_dump compatibility', async () => { ... })
 * ```
 */
export class Preflight {
  private readonly title: string
  private readonly log: LogFn
  private readonly pending: PendingFn
  private readonly databases: DbEntry[] = []
  private readonly customs: CustomEntry[] = []
  private readonly infoLines: Array<{ label: string; value: string }> = []

  constructor(title: string, log: LogFn, pending: PendingFn = defaultPending) {
    this.title = title
    this.log = log
    this.pending = pending
  }

  /** Register a database connectivity check. */
  addDatabase(label: string, envName: string, dbUrl: string): this {
    this.databases.push({ label, envName, dbUrl })
    return this
  }

  /** Add an informational line to the header (displayed after database lines). */
  addInfo(label: string, value: string): this {
    this.infoLines.push({ label, value })
    return this
  }

  /** Register a custom check (runs after all DB connectivity checks). */
  addCheck(label: string, fn: CustomCheckFn): this {
    this.customs.push({ label, fn })
    return this
  }

  /** Execute all registered checks, render results, and return the report. */
  async run(): Promise<PreflightReport> {
    const entries: CheckEntry[] = []
    const log = this.log

    // Header
    log(`\n  ${bold(this.title)}\n`)
    for (const db of this.databases) {
      log(`    ${db.label}: ${db.envName} ${dim(`(${redactUrls(db.dbUrl)})`)}`)
    }
    for (const info of this.infoLines) {
      log(`    ${info.label}: ${info.value}`)
    }
    log('')
    log('    Checks:')

    // Database connectivity checks
    for (const db of this.databases) {
      // Named before the wait, not after: a connection that is merely slow
      // otherwise leaves the header on screen with no clue which of the two
      // environments is holding things up (issue #44).
      // The label is already the noun — "Database", "Target", "Source" — so
      // appending "database" gave "Database database reachable" (issue #97).
      this.pending(`      ${dim(`… connecting to ${db.label.toLowerCase()}`)}`)
      const result = await checkConnection(db.dbUrl)
      this.pending(null)
      if (result.reachable) {
        log(`      ${ok('✓')} ${db.label} reachable ${dim(`(PostgreSQL ${result.version})`)}`)
        entries.push({ label: db.label, passed: true, detail: `PostgreSQL ${result.version}` })
      } else {
        log(`      ${warn('✗')} ${db.label} not reachable: ${redactUrls(describeFailure(result.error))}`)
        const hints = await buildConnectionHints(db.dbUrl, result.error)
        if (hints.length > 0) {
          log(`\n      ${dim('Hints:')}`)
          for (const h of hints) log(`        ${dim('•')} ${h}`)
        }
        entries.push({ label: db.label, passed: false, error: result.error, hints })
      }
    }

    // Custom checks
    for (const custom of this.customs) {
      this.pending(`      ${dim(`… ${custom.label}`)}`)
      const result = await custom.fn()
      this.pending(null)
      if (!result.error) {
        const suffix = result.detail ? ` ${dim(result.detail)}` : ''
        log(`      ${ok('✓')} ${custom.label}${suffix}`)
        entries.push({ label: custom.label, passed: true, detail: result.detail })
      } else {
        log(`      ${warn('✗')} ${custom.label}: ${redactUrls(describeFailure(result.error))}`)
        if (result.hints?.length) {
          log(`\n      ${dim('Hints:')}`)
          for (const h of result.hints) log(`        ${dim('•')} ${h}`)
        }
        entries.push({ label: custom.label, passed: false, error: result.error, hints: result.hints })
      }
    }

    const passed = entries.every(e => e.passed)
    log('')
    if (!passed) {
      log(`    ${warn('Some checks failed.')} Fix the issues above first.\n`)
    } else {
      log(`    ${ok('All checks passed.')}\n`)
    }

    return { passed, checks: entries }
  }
}
