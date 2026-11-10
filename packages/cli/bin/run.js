#!/usr/bin/env node
import {existsSync} from 'node:fs'
import {execute, settings} from '@oclif/core'

// The published package is compiled and ships no src/. Left on, oclif looks
// for TypeScript whenever NODE_ENV is development or test — as in many
// projects running npx supaforge — and warned on every command that it could
// not find it. A checkout keeps the lookup, which its tests rely on.
if (!existsSync(new URL('../src', import.meta.url))) settings.enableAutoTranspile = false

// A reader that stops early (supaforge --help | head) closes stdout. oclif
// then waits for a drain that never comes and Node exits 13 with a warning;
// there is nothing left to write to, so finish as a completed run would.
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(process.exitCode ?? 0)
  throw err
})

await execute({dir: import.meta.url}).catch((err) => {
  // oclif handles CLIError internally — this catches truly unexpected errors.
  if (err && typeof err === 'object' && 'oclif' in err) return
  process.stderr.write(`\nUnexpected error: ${err?.message ?? err}\n`)
  process.stderr.write('If this looks like a bug, please report it:\n')
  process.stderr.write('  https://github.com/akalsoftware/supaforge/issues/new\n\n')
  process.exitCode = 1
})
