import { flush, handle, run, settings } from '@oclif/core'
import { oneLine } from './utils/error-report.js'

/**
 * What bin/run.js and bin/dev.js run: oclif's own execute(), with one
 * change. A failure before any command runs, an unknown command say, is
 * reported as a command's failures are (BaseCommand.catch): one line on
 * stderr when it is not a terminal, and `{ error, code }` on stdout under
 * --json. A command's own failures are marked as reported already, so oclif
 * does not print them again.
 */
export async function execute(dir: string, development = false): Promise<void> {
  if (development) {
    process.env.NODE_ENV = 'development'
    settings.debug = true
  }
  try {
    await run(process.argv.slice(2), dir)
    await flush()
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    reportForScripts(err)
    await handle(err)
  }
}

function reportForScripts(err: Error & { skipOclifErrorHandling?: boolean; code?: unknown; oclif?: { exit?: number } }): void {
  if (err.skipOclifErrorHandling || err.code === 'EEXIT' || err.oclif?.exit === 0) return
  const json = process.argv.includes('--json')
  if (!json && process.stderr.isTTY) return
  const message = oneLine(err.message)
  if (json) process.stdout.write(`${JSON.stringify({ error: message, code: 'E_USAGE' }, null, 2)}\n`)
  process.stderr.write(`Error: ${message}\n`)
  err.skipOclifErrorHandling = true
}
