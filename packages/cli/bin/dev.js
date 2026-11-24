#!/usr/bin/env tsx
import {execute} from '../src/cli-entry.ts'

await execute(import.meta.url, true).catch((err) => {
  if (err && typeof err === 'object' && 'oclif' in err) return
  process.stderr.write(`\nUnexpected error: ${err?.message ?? err}\n`)
  process.stderr.write('If this looks like a bug, please report it:\n')
  process.stderr.write('  https://github.com/akalsoftware/supaforge/issues/new\n\n')
  process.exitCode = 1
})
