import { redactUrls } from './error.js'

/**
 * How a failure is reported to whatever runs SupaForge: one line on stderr,
 * and under --json a stable code beside the message.
 *
 * Errors were oclif's: wrapped at 80 columns whatever stderr was, each piece
 * prefixed ` ›   `, a flag error followed by the whole usage text, and under
 * --json the message carried oclif's "\nSee more help with --help". A script
 * or log collector got one error as several lines, and had only the wording
 * to tell a typo in a flag from a database it could not reach.
 */

/**
 * - `E_USAGE`: the command line: an unknown flag, command or value.
 * - `E_CONFIG`: supaforge.config.json is missing, unreadable or invalid.
 * - `E_CONNECT`: a database could not be reached or refused the login.
 * - `E_TLS`: a database's certificate could not be verified.
 * - `E_PRECONDITION`: something the command needs first is missing (a tool, a snapshot).
 * - `E_FAILED`: anything else that stopped the command.
 */
export type ErrorCode = 'E_USAGE' | 'E_CONFIG' | 'E_CONNECT' | 'E_TLS' | 'E_PRECONDITION' | 'E_FAILED'

export const ERROR_CODES: readonly ErrorCode[] = ['E_USAGE', 'E_CONFIG', 'E_CONNECT', 'E_TLS', 'E_PRECONDITION', 'E_FAILED']

/** oclif's parser errors, by class name: they reach a command's catch() like any other. */
const PARSE_ERRORS = new Set([
  'CLIParseError', 'NonExistentFlagsError', 'FailedFlagValidationError', 'RequiredArgsError',
  'UnexpectedArgsError', 'ArgInvalidOptionError', 'FlagInvalidOptionError',
])
const USAGE_TEXT = /^(?:Nonexistent flags?:|Expected --|Missing \d+ required arg|Unexpected arguments?:|Flag --|--\S+=\S+ cannot also be provided|command \S+ not found|Expected .* to be one of)/i
const CONFIG_TEXT = /supaforge\.config\.json|^Invalid configuration|^No environment specified|^Environment "[^"]*" not found/i

/** The code for a failure: one a throw site set (`this.error(msg, { code })`), or one read from it. */
export function errorCode(err: unknown): ErrorCode {
  const e = err as { code?: unknown; parse?: unknown; constructor?: { name?: string } } | null
  if (typeof e?.code === 'string' && (ERROR_CODES as readonly string[]).includes(e.code)) return e.code as ErrorCode
  const message = err instanceof Error ? err.message : String(err)
  if (e?.parse !== undefined || PARSE_ERRORS.has(e?.constructor?.name ?? '') || USAGE_TEXT.test(message)) return 'E_USAGE'
  if (CONFIG_TEXT.test(message)) return 'E_CONFIG'
  if (/TLS check of /.test(message)) return 'E_TLS'
  return 'E_FAILED'
}

/**
 * A message as one line, for a log or a script: colour codes and oclif's
 * "See more help" pointer taken out, its lines joined, URLs' passwords
 * hidden.
 */
export function oneLine(message: string): string {
  return redactUrls(message)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\n?\s*See more help with --help\s*$/i, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    // A list under a heading reads as one: "Invalid configuration: a; b".
    .reduce((line, next) => (line === '' ? next : `${line}${/[:;,]$/.test(line) ? ' ' : '; '}${next}`), '')
}

/** The line written to stderr for a failure: `Error: <message>`. */
export function errorLine(err: unknown): string {
  return `Error: ${oneLine(err instanceof Error ? err.message : String(err))}`
}

/** What --json prints for a failure. */
export function errorJson(err: unknown, message?: string): { error: string; code: ErrorCode } {
  return { error: oneLine(message ?? (err instanceof Error ? err.message : String(err))), code: errorCode(err) }
}

/**
 * The code for a preflight that failed, from its failed checks: a database
 * that could not be reached, one whose certificate failed, or (for any other
 * check) a precondition.
 */
export function preflightCode(failed: Array<{ kind?: string; error?: unknown }>): ErrorCode {
  const dbFailures = failed.filter(c => c.kind === 'database')
  if (dbFailures.length === 0) return 'E_PRECONDITION'
  return dbFailures.some(c => /TLS check of /.test(String(c.error ?? ''))) ? 'E_TLS' : 'E_CONNECT'
}
