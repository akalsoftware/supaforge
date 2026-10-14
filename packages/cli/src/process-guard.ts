import { describeFailure, redactUrls } from './utils/error.js'

/**
 * What happens to an error nothing caught: an `'error'` event no one listens
 * for, a promise no one awaits.
 *
 * Node's answer is a stack trace and exit 1 — and under --json, no JSON, so a
 * script reading stdout had nothing to parse. A command now ends on one the
 * way it ends on any failure: a line naming it, exit 1, and under --json an
 * `{ "error" }` object if it had not printed its result yet. The MCP server
 * logs it and keeps serving instead: one bad call should not end the session.
 */
let installed = false
let jsonWritten = false
let keepRunning = false

/** A command's JSON result went to stdout; a later error must not add a second document. */
export function noteJsonWritten(): void {
  jsonWritten = true
}

/** For a long-running server: log stray errors rather than exit. */
export function keepRunningOnStrayErrors(): void {
  keepRunning = true
}

export function installProcessGuard(argv: readonly string[] = process.argv): void {
  if (installed) return
  installed = true
  const onStray = (err: unknown): void => {
    const message = redactUrls(describeFailure(err))
    if (keepRunning) {
      process.stderr.write(`SupaForge: an error no handler caught, carrying on: ${message}\n`)
      return
    }
    if (argv.includes('--json') && !jsonWritten) {
      jsonWritten = true
      process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n')
    }
    process.stderr.write(
      `\nUnexpected error: ${message}\n`
      + 'If this looks like a bug, please report it:\n'
      + '  https://github.com/akalsoftware/supaforge/issues/new\n\n',
    )
    process.exitCode = 1
    // The state that threw is not to be trusted: out, once stdout has drained.
    process.stdout.write('', () => process.exit(1))
  }
  process.on('uncaughtException', onStray)
  process.on('unhandledRejection', onStray)
}
