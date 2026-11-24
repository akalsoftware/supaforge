/**
 * Regex matching database connection URL schemes (postgres, mysql, etc.).
 * Captures the scheme + `://` and the rest of the URL up to the next whitespace.
 */
const DB_URL_RE = /\b((?:postgres(?:ql)?|mysql|mariadb):\/\/)(\S+)/g

/**
 * Redact passwords from database connection URLs in a string.
 *
 * Replaces `://user:PASSWORD@host` with `://user:***@host` to prevent
 * credentials from leaking into logs, error messages, or terminal output.
 * Handles passwords containing special characters including `@`.
 */
export function redactUrls(message: string): string {
  return message.replace(DB_URL_RE, (_, scheme: string, rest: string) => {
    const lastAt = rest.lastIndexOf('@')
    if (lastAt === -1) return scheme + rest
    const creds = rest.slice(0, lastAt)
    const hostPart = rest.slice(lastAt)
    const colonIdx = creds.indexOf(':')
    if (colonIdx === -1) return scheme + rest
    return scheme + creds.slice(0, colonIdx) + ':***' + hostPart
  })
}

/** Shown when a failure carries nothing at all that could name it. */
export const UNDESCRIBED_ERROR = 'unknown error — no message reported'

/**
 * Get something printable out of a thrown value.
 *
 * Not every failure arrives as an `Error` with a populated `message`. One did
 * not — observed when a container runtime's daemon stopped while a port mapping
 * was still registered — and every renderer downstream printed its label, a
 * colon, and nothing: `✗ Source database not reachable:` (issue #47).
 *
 * Falls back through what a driver error still carries when its message is
 * empty: the `code` (`ECONNRESET`, `EPIPE`) is the most useful, then the error
 * type, then a fixed string. The return value is never empty, which is the
 * whole point — a reason a user cannot read is worse than a generic one.
 */
export function describeFailure(err: unknown): string {
  if (typeof err === 'string') return err.trim() || UNDESCRIBED_ERROR

  const candidate = err as { message?: unknown; code?: unknown; name?: unknown } | null | undefined
  const message = typeof candidate?.message === 'string' ? candidate.message.trim() : ''
  if (message) return message

  const code = typeof candidate?.code === 'string' ? candidate.code.trim() : ''
  if (code) return `${code} (no further detail reported)`

  const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
  if (name && name !== 'Error') return `${name} (no further detail reported)`

  if (err !== null && err !== undefined && !(err instanceof Error)) {
    const rendered = String(err).trim()
    if (rendered && rendered !== '[object Object]') return rendered
  }

  return UNDESCRIBED_ERROR
}

/**
 * Extract a concise error message from an unknown caught value.
 *
 * Safely handles Error instances, strings, and other thrown types, and never
 * returns an empty string — see describeFailure. Used across the codebase in
 * catch blocks to normalise error output. Automatically redacts database
 * credentials from the message.
 */
export function errMsg(err: unknown): string {
  return redactUrls(describeFailure(err))
}

/**
 * An error whose message is already written for the user — it has been
 * diagnosed, and usually carries remediation steps.
 *
 * friendlyDbError() passes these through untouched instead of pattern-matching
 * them into a generic connection error. Without this, any accurate message that
 * happens to mention a timeout (including one telling the user which timeout
 * env var to raise) got rewritten into advice to check their host and port.
 */
export class DiagnosticError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiagnosticError'
  }
}

/**
 * Structural check rather than `instanceof`.
 *
 * The CLI and its tests can load a module through more than one path (src vs
 * dist, ESM vs CJS interop), which yields two distinct class identities and
 * makes `instanceof` silently false. Matching on the name keeps the guard
 * working across those boundaries.
 */
export function isDiagnosticError(err: unknown): boolean {
  return err instanceof DiagnosticError || (err instanceof Error && err.name === 'DiagnosticError')
}

// ─── Connection Error Patterns ───────────────────────────────────────────────

/** Known patterns matched against error messages, checked in order. */
const CONNECTION_ERROR_PATTERNS: Array<{ test: (msg: string) => boolean; build: (host: string, raw: string) => string }> = [
  {
    // First: libpq reports each address it tried, and a refused ::1 ahead of
    // a certificate failure on 127.0.0.1 read as "the server does not appear
    // to be running", of a server that had answered.
    test: (m) => TLS_FAILURE.test(m),
    build: (host, raw) => `TLS check of ${host} failed: ${tlsDetail(raw)}. A server whose certificate comes from a CA `
      + 'of its own, as a hosted Supabase project\'s does, is verified with that CA: add sslrootcert=<file> to the '
      + 'database URL (with sslmode=verify-full). sslmode=require encrypts without verifying.',
  },
  {
    test: (m) => /ECONNREFUSED|Connection refused/i.test(m),
    build: (host) => `Cannot connect to PostgreSQL at ${host} — the server does not appear to be running. Start it and try again.`,
  },
  {
    test: (m) => /ENOTFOUND|getaddrinfo/i.test(m),
    build: (host) => `Cannot resolve hostname ${host} — check the database URL in your config.`,
  },
  {
    // Before the connection timeout: the server answered, and a query ran
    // past its statement_timeout. Calling that a connection problem sent
    // people to check a host and port that were fine.
    test: (m) => /canceling statement due to statement timeout|57014/i.test(m),
    build: (host) => `A query on ${host} was cancelled by statement_timeout — the server is reachable. Raise statement_timeout for this role or connection and try again.`,
  },
  {
    // Deliberately narrow. A bare /timeout/i also matches our own remediation
    // text — "set SUPAFORGE_DBDIFF_TIMEOUT=600" contains "TIMEOUT" — which is
    // how an accurate "Schema diff timed out after Ns" message was being
    // rewritten into a wrong "check the host and port" one (issue #29).
    // DiagnosticError below is the primary guard; this is defence in depth.
    test: (m) => /ETIMEDOUT|connection timed out|timeout expired/i.test(m),
    build: (host) => `Connection to ${host} timed out — verify the host and port are correct and that the server is reachable.`,
  },
  {
    test: (m) => /password authentication failed/i.test(m),
    build: (host) => `Authentication failed for ${host} — check the username and password in your database URL.`,
  },
  {
    // Must stay anchored to "database ... does not exist" (Postgres SQLSTATE
    // 3D000). A bare /does not exist/ is the same trap as the timeout pattern
    // above: it matched dbdiff's own CLI complaint — The "--allow-destructive"
    // option does not exist — and rewrote it into "Database does not exist on
    // 127.0.0.1:5432", sending you off to check a database name that was fine
    // while the real cause (an outdated @dbdiff/cli) went unmentioned.
    test: (m) => /database\s+"[^"]*"\s+does not exist|3D000/i.test(m),
    build: (host) => `Database does not exist on ${host} — verify the database name in your config.`,
  },
  {
    test: (m) => /SSL.*required|no pg_hba.conf entry/i.test(m),
    build: (host) => `Connection rejected by ${host} — the server requires SSL or your IP is not allowed. Check pg_hba.conf and SSL settings.`,
  },
]

/** A certificate or TLS failure, said as one and with what to do; undefined for any other error. */
export function tlsFailureMessage(err: unknown, dbUrl: string): string | undefined {
  return TLS_FAILURE.test(errMsg(err)) ? friendlyDbError(err, dbUrl) : undefined
}

/** What a certificate or TLS failure says, from pg (Node) or libpq (DBDiff, pg_dump). */
const TLS_FAILURE = /self[- ]signed certificate|unable to (?:verify|get local issuer)|certificate verify failed|root certificate file|Hostname\/IP does not match|certificate has expired|ERR_TLS_|SSL error|wrong version number|verifies the server against a CA/i

/** The part of an error that says what went wrong with TLS, without the other addresses libpq tried. */
function tlsDetail(raw: string): string {
  const pieces = raw.split(/\n|(?<=\.)\s+(?=connection to server)/)
  const found = pieces.find(p => TLS_FAILURE.test(p)) ?? raw
  return found.replace(/^.*?failed:\s*/, '').replace(/\.\s*$/, '').trim()
}

/**
 * Extract host:port from a PostgreSQL connection URL.
 * Returns just the host portion with the port for display.
 */
function extractHost(dbUrl: string): string {
  try {
    const url = new URL(dbUrl)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    return 'the configured host'
  }
}

/**
 * Translate a raw database error into a user-friendly message.
 *
 * Matches known pg error patterns and returns an actionable message
 * with the host identified. Returns the original (redacted) message
 * if no pattern matches.
 */
export function friendlyDbError(err: unknown, dbUrl?: string): string {
  const raw = errMsg(err)

  // Already a message written for the user, with its own diagnosis and
  // remediation — translating it again can only make it worse, and did:
  // the schema-diff timeout message was being replaced by a connection
  // error naming a host that was demonstrably reachable (issue #29).
  if (isDiagnosticError(err)) return raw

  // Already translated, by an inner call: once is enough.
  if (/^TLS check of /.test(raw)) return raw

  const host = dbUrl ? extractHost(dbUrl) : 'the configured host'

  for (const pattern of CONNECTION_ERROR_PATTERNS) {
    try {
      if (pattern.test(raw)) {
        return pattern.build(host, raw)
      }
    } catch {
      // A malformed host or an unexpected pattern failure must never turn a
      // reportable error into a crash — fall through to the raw message.
    }
  }

  return raw
}
