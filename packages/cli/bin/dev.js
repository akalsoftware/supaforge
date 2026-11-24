#!/usr/bin/env tsx
import {flush, handle, run, settings} from '@oclif/core'

/**
 * oclif's execute(), except that a failure before any command runs (an
 * unknown command) is reported as a command's failures are, in
 * BaseCommand.catch: one line on stderr when it is not a terminal, and
 * `{ error, code }` on stdout under --json. A command's own failures arrive
 * marked as reported, and oclif doesn't print them again. bin/run.js and
 * bin/dev.js each carry this: neither can import the other's source.
 */
async function execute(options) {
  if (options.development) {
    process.env.NODE_ENV = 'development'
    settings.debug = true
  }
  try {
    await run(process.argv.slice(2), options.dir)
    await flush()
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    if (!err.skipOclifErrorHandling && err.code !== 'EEXIT' && err.oclif?.exit !== 0) {
      const json = process.argv.includes('--json')
      if (json || !process.stderr.isTTY) {
        const message = String(err.message).replace(/\n?\s*See more help with --help\s*$/i, '')
          .split('\n').map((l) => l.trim()).filter(Boolean).join('; ')
        if (json) process.stdout.write(JSON.stringify({error: message, code: 'E_USAGE'}, null, 2) + '\n')
        process.stderr.write(`Error: ${message}\n`)
        err.skipOclifErrorHandling = true
      }
    }
    await handle(err)
  }
}

await execute({development: true, dir: import.meta.url}).catch((err) => {
  if (err && typeof err === 'object' && 'oclif' in err) return
  process.stderr.write(`\nUnexpected error: ${err?.message ?? err}\n`)
  process.stderr.write('If this looks like a bug, please report it:\n')
  process.stderr.write('  https://github.com/akalsoftware/supaforge/issues/new\n\n')
  process.exitCode = 1
})
