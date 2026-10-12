#!/usr/bin/env node
// Check what `npm publish` would ship, before it ships.
//
// Fails when the package contains a file outside the allow-list (source maps,
// sources, tests, configs, anything secret-shaped) or grows past its size
// budget, then installs the packed tarball into an empty directory and runs
// it, which catches a file the CLI needs at runtime but `files` leaves out.
//
//   node scripts/check-package.mjs            # after `npm run build`
//   node scripts/check-package.mjs --no-install
//
// The budgets are deliberately loose: they exist to catch an accident (maps
// or a vendored dependency creeping back in), not to fight over kilobytes.

import {execFileSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {gzipSync} from 'node:zlib'

const BUDGET = {
  tarball: 250 * 1024,
  unpacked: 900 * 1024,
  jsGzip: 150 * 1024,
}

const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^bin\/run\.js$/,
  /^dist\/[\w./-]+\.js$/,
  /^dist\/[\w./-]+\.d\.ts$/,
]

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const kb = (n) => `${(n / 1024).toFixed(1)} KB`
const problems = []

const [pack] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {encoding: 'utf8'}))
const paths = pack.files.map((f) => f.path)

for (const path of paths) {
  if (!ALLOWED.some((re) => re.test(path))) problems.push(`unexpected file in the package: ${path}`)
}
for (const required of ['package.json', 'README.md', 'LICENSE', 'bin/run.js', 'dist/index.js']) {
  if (!paths.includes(required)) problems.push(`missing from the package: ${required}`)
}

const js = paths.filter((p) => p.endsWith('.js')).map((p) => readFileSync(p))
const jsGzip = gzipSync(Buffer.concat(js), {level: 9}).length

const sizes = [
  ['tarball (gzip)', pack.size, BUDGET.tarball],
  ['unpacked', pack.unpackedSize, BUDGET.unpacked],
  ['JavaScript (gzip -9)', jsGzip, BUDGET.jsGzip],
]
console.log(`${pack.name}@${pack.version}: ${pack.entryCount} files`)
for (const [label, size, budget] of sizes) {
  console.log(`  ${label.padEnd(22)} ${kb(size).padStart(10)}  (budget ${kb(budget)})`)
  if (size > budget) problems.push(`${label} is ${kb(size)}, over its ${kb(budget)} budget`)
}

if (!process.argv.includes('--no-install') && problems.length === 0) {
  const dir = mkdtempSync(join(tmpdir(), 'supaforge-pack-'))
  try {
    const tarball = execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', dir], {encoding: 'utf8'})
      .trim()
      .split('\n')
      .pop()
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n')
    execFileSync(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', join(dir, tarball)], {
      cwd: dir,
      stdio: 'inherit',
    })
    const bin = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'supaforge.cmd' : 'supaforge')
    for (const args of [['--version'], ['--help'], ['diff', '--help']]) {
      const out = execFileSync(bin, args, {cwd: dir, encoding: 'utf8', env: {...process.env, NODE_ENV: 'production'}})
      if (!out.trim()) problems.push(`installed package printed nothing for: supaforge ${args.join(' ')}`)
    }
    console.log('  installed from the tarball and ran --version, --help, diff --help')
  } catch (err) {
    problems.push(`installing or running the packed tarball failed: ${err.message}`)
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log('Package check passed')
