import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Flags } from '@oclif/core'
import { newPgClient } from '../db.js'
import { BaseCommand } from '../base-command.js'
import { captureSnapshot, formatSnapshotLayers } from '../snapshot.js'
import {
  cloneRemoteToLocal,
  replaceDbName,
  listBranches,
  reconcileClones,
  deleteBranch,
  addBranchToManifest,
} from '../branch.js'
import type { BranchMeta, CloneResult, RestoreFailure } from '../branch.js'
import { loadConfig } from '../config.js'
import { checkPgDumpCompat } from '../pg-tools.js'
import { startLocalPg, DEFAULT_LOCAL_PORT, LOCAL_PG_USER, LOCAL_PG_PASSWORD } from '../local-pg.js'
import { ok, warn, dim, cmd, bold } from '../ui.js'
import { renderTip } from '../tips.js'
import { DEFAULT_IGNORE_SCHEMAS, CLONE_SKIP_FLAGS } from '../defaults.js'
import { CLONE_EXTRA_EXCLUDE_SCHEMAS, SUPAFORGE_DIR, MIGRATIONS_SUBDIR } from '../constants.js'
import { errMsg, redactUrls } from '../utils/error.js'
import type { SupaForgeConfig } from '../types/config.js'

/** Combined list of schemas to exclude from pg_dump when cloning. */
// De-duplicated: `_realtime` is in both lists, so it was excluded — and
// printed — twice (issue #97).
const CLONE_EXCLUDE_SCHEMAS = [...new Set([
  ...DEFAULT_IGNORE_SCHEMAS,
  ...CLONE_EXTRA_EXCLUDE_SCHEMAS,
])]

/**
 * Clone a remote environment to a local database and manage clones.
 *
 * Default:              preflight checks (dry-run)
 * --apply:              execute the clone
 * --list:               list existing clones
 * --delete=NAME:        remove a clone
 * --delete=NAME --apply: actually drop the database
 */
export default class Clone extends BaseCommand {
  static override description = 'Clone a remote Supabase environment to a local database'

  static override examples = [
    '<%= config.bin %> clone --env=production',
    '<%= config.bin %> clone --env=production --apply',
    '<%= config.bin %> clone --env=production --force --apply',
    '<%= config.bin %> clone --env=production --schema-only --apply',
    '<%= config.bin %> clone --env=production --start-local --apply',
    '<%= config.bin %> clone --list',
    '<%= config.bin %> clone --delete=my-clone --apply',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Source environment to clone from (defaults to config source)',
    }),
    'local-db': Flags.string({
      description: 'Name for the local database (default: supaforge_local)',
      default: 'supaforge_local',
    }),
    'local-url': Flags.string({
      description: 'Local PostgreSQL URL (default: postgres://postgres:postgres@localhost:5432/postgres)',
      default: `postgres://${LOCAL_PG_USER}:${LOCAL_PG_PASSWORD}@localhost:${DEFAULT_LOCAL_PORT}/postgres`,
    }),
    'start-local': Flags.boolean({
      description: 'Auto-start a local PostgreSQL container via Podman or Docker',
      default: false,
    }),
    'schema-only': Flags.boolean({
      description: 'Copy schema only, no data',
      default: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Drop and recreate the target database if it already exists',
      default: false,
    }),
    apply: Flags.boolean({
      description: 'Execute the operation (default: dry-run preview)',
      default: false,
    }),
    list: Flags.boolean({
      description: 'List existing clones',
      default: false,
    }),
    delete: Flags.string({
      description: 'Delete a clone by name (requires --apply to execute)',
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Clone)

    // ── List clones ──────────────────────────────────────────────────────────
    // The manifest alone misses clones it never recorded (older versions, a
    // different checkout, or a cleaned .supaforge/). Reconcile it against the
    // databases that actually exist on the local server so existing clones show
    // up too — not just freshly-created ones. Config is optional here.
    if (flags.list) {
      const softConfig = await loadConfig().catch(() => undefined)
      const localEnv = softConfig?.environments?.local
      let localServerUrl: string | undefined
      let configuredLocalDb: string | undefined
      if (localEnv?.dbUrl) {
        localServerUrl = localEnv.dbUrl
        try {
          configuredLocalDb = new URL(localEnv.dbUrl).pathname.replace(/^\//, '') || undefined
        } catch { /* unpar-seable url — skip discovery hint */ }
      }

      const branches = localServerUrl
        ? await reconcileClones({ localServerUrl, configuredLocalDb })
        : (await listBranches()).map(b => ({ ...b, missing: false, discovered: false }))

      if (branches.length === 0) {
        this.log(`\n  No clones found. Create one with: ${cmd('supaforge clone --env=<name> --apply')}\n`)
        return
      }

      if (flags.json) {
        this.json(branches)
        return
      }

      this.log(`\n  ${bold(`${branches.length} clone(s):`)}\n`)
      for (const b of branches) {
        const tags = [
          b.discovered ? dim('(discovered)') : '',
          b.missing ? warn('(database missing)') : '',
        ].filter(Boolean).join(' ')
        this.log(`    ${bold(b.name)}${tags ? ' ' + tags : ''}`)
        this.log(`      Database: ${b.dbName}`)
        this.log(`      From:     ${b.createdFrom}`)
        if (b.createdAt) this.log(`      Created:  ${b.createdAt}`)
        this.log(`      Schema:   ${b.schemaOnly ? 'only' : 'full'}`)
        this.log('')
      }
      return
    }

    const config = await this.loadConfigOrFail()

    // ── Delete clone ─────────────────────────────────────────────────────────
    if (flags.delete) {
      const { env } = this.resolveEnv(config, flags.env)

      const branches = await listBranches()
      const branch = branches.find(b => b.name === flags.delete)
      if (!branch) {
        this.error(`Clone "${flags.delete}" not found. Run "supaforge clone --list" to see clones.`)
      }

      if (!flags.apply) {
        this.log(`\n  ${bold('Delete clone preview')} ${dim('(dry-run)')}\n`)
        this.log(`    Clone:    ${branch.name}`)
        this.log(`    Database: ${branch.dbName}`)
        this.log(`    Created:  ${branch.createdAt}`)
        this.log(`    From:     ${branch.createdFrom}`)
        this.log('')
        this.log('    This would:')
        this.log(`      1. Terminate connections to "${branch.dbName}"`)
        this.log(`      2. DROP DATABASE "${branch.dbName}"`)
        this.log('      3. Remove clone from .supaforge/branches.json')
        this.log(`\n    → Add ${cmd('--apply')} to delete the clone.\n`)
        return
      }

      this.log(`\n  Deleting clone "${branch.name}"...\n`)
      await deleteBranch(flags.delete, env.dbUrl)
      this.log(`  ${ok('✓')} Clone "${branch.name}" deleted.\n`)
      return
    }

    // ── Clone: preflight + execute ───────────────────────────────────────────
    const { envName, env } = this.resolveEnv(config, flags.env)
    const localDbName = flags['local-db']
    let localBaseUrl = flags['local-url']

    // Auto-start a local PostgreSQL container if requested
    if (flags['start-local']) {
      this.log(`\n  ${bold('Starting local PostgreSQL container...')}\n`)
      const info = await startLocalPg()
      localBaseUrl = info.url
      this.log(`    ${ok('✓')} PostgreSQL running via ${bold(info.runtime)} on port ${info.port}\n`)
    }

    const localDbUrl = replaceDbName(localBaseUrl, localDbName)

    // Always run preflight checks — even with --apply
    const pre = this.createPreflight('Clone preflight checks')
      .addDatabase('Remote', envName, env.dbUrl)
      .addInfo('Local DB', localDbName)
      .addInfo('Local URL', dim(redactUrls(localDbUrl)))
      .addInfo('Schema only', String(flags['schema-only']))

    if (flags['start-local']) {
      pre.addCheck('Local PostgreSQL', async () => ({
        detail: `auto-started via --start-local`,
      }))
    } else {
      pre.addDatabase('Local', 'local', localBaseUrl)
    }

    pre.addCheck('pg_dump compatibility', async () => {
      try {
        const compat = await checkPgDumpCompat(env.dbUrl)
        if (compat.compatible) {
          const pathNote = compat.pgDumpPath === 'pg_dump' ? '' : ` (${compat.pgDumpPath})`
          return { detail: `v${compat.localMajor} ↔ server v${compat.serverMajor}${pathNote}` }
        }
        return { error: compat.message }
      } catch (err) {
        return { error: `pg_dump check failed: ${(err as Error).message}` }
      }
    })

    pre.addCheck('Target database', async () => {
      try {
        const client = newPgClient(localBaseUrl)
        await client.connect()
        const { rows } = await client.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [localDbName],
        )
        await client.end()
        if (rows.length > 0) {
          if (flags.force) {
            return { detail: `"${localDbName}" exists — will be dropped (--force)` }
          }
          return {
            error: `"${localDbName}" already exists on local server`,
            hints: [`Use ${cmd('--force')} to drop and recreate it.`],
          }
        }
        return { detail: `"${localDbName}" does not exist yet` }
      } catch {
        return {} // Can't check — let the apply step handle it
      }
    })

    const report = await pre.run()

    if (!flags.apply) {
      if (flags.json) {
        this.json({ dryRun: true, passed: report.passed, localDb: localDbName })
        if (!report.passed) this.exit(1)
        return
      }
      if (report.passed) {
        this.log(`    Steps that will be performed:`)
        this.log('      1. Create local database via pg_dump | pg_restore')
        this.log('      2. Capture full snapshot of remote environment')
        this.log('      3. Store snapshot as baseline migration')
        this.log('      4. Update supaforge.config.json with local + remote environments')
        this.log('')
        this.log(`    → Add ${cmd('--apply')} to execute the clone.\n`)
        this.log(renderTip({ command: 'clone', cloneApplied: false, schemaOnly: flags['schema-only'] }))
      }
      return
    }

    if (!report.passed) {
      this.error('Clone aborted — fix the issues above first.', { exit: 1 })
    }

    // Execute clone
    this.log(`\n  ${bold(`Cloning "${envName}" to local database "${localDbName}"...`)}\n`)
    // The transfer meter, like every other line here, stays off stdout under --json.
    const progressOut = flags.json ? process.stderr : process.stdout

    this.log('    [1/4] Creating local database...')
    let cloned: CloneResult
    try {
      cloned = await cloneRemoteToLocal({
        remoteUrl: env.dbUrl,
        localBaseUrl,
        localDbName,
        schemaOnly: flags['schema-only'],
        force: flags.force,
        excludeSchemas: CLONE_EXCLUDE_SCHEMAS,
        onProgress: (p) => {
          const mb = (p.bytesTransferred / 1024 / 1024).toFixed(1)
          const sec = Math.round(p.elapsedMs / 1000)
          progressOut.write(`\r      ${dim(`pg_dump → pg_restore: ${mb} MB transferred (${sec}s)`)}    `)
        },
      })
      progressOut.write('\n')
      this.log(`      ${ok('✓')} Database created: ${bold(localDbName)}`)
      if (cloned.extensionsInstalled.length > 0) {
        this.log(`      ${dim(`Installed first, in the schema the source keeps them in: ${cloned.extensionsInstalled.join(', ')}`)}`)
      }
      for (const line of formatUnavailable(cloned.unavailable)) this.log(line)
      for (const line of formatRestoreFailures(cloned.failures)) this.log(line)
    } catch (err) {
      progressOut.write('\n')
      const msg = errMsg(err)
      this.log(`      ${warn('✗')} Failed: ${msg}`)
      this.error('Clone aborted at step 1/4.', { exit: 1 })
    }

    this.log('    [2/4] Capturing remote snapshot...')
    const snapshot = await captureSnapshot({ envName, env, config })
    const capturedCount = Object.values(snapshot.manifest.layers).filter(l => l.captured).length
    this.log(`      ${ok('✓')} Snapshot captured: ${capturedCount} layer(s)`)
    // Show exactly what was captured / skipped / errored per layer (like supaforge diff),
    // so the user can see at a glance what made it into the baseline.
    for (const line of formatSnapshotLayers(snapshot.manifest)) {
      this.log(`        ${line}`)
    }

    this.log('    [3/4] Storing baseline migration...')
    const migrationsDir = resolve(SUPAFORGE_DIR, MIGRATIONS_SUBDIR)
    await mkdir(migrationsDir, { recursive: true })
    const migrationFile = resolve(migrationsDir, `${snapshot.timestamp}_clone-baseline.json`)
    const migration = {
      version: snapshot.timestamp,
      description: `clone-baseline from ${envName}`,
      parent: null,
      layers: Object.entries(snapshot.manifest.layers)
        .filter(([, v]) => v.captured)
        .map(([k]) => k),
      up: { sql: [], api: [] },
      down: { sql: [], api: [] },
    }
    await writeFile(migrationFile, JSON.stringify(migration, null, 2) + '\n')
    this.log(`      ${ok('✓')} Baseline stored: ${migrationFile}`)

    this.log('    [4/4] Updating config...')
    const newConfig = configAfterClone(config, envName, localDbUrl)
    const configPath = resolve('supaforge.config.json')
    await writeFile(configPath, JSON.stringify(newConfig, null, 2) + '\n')
    this.log(`      ${ok('✓')} Config updated: ${configPath}`)

    // Say what moved. Overwriting these silently is the other half of #89:
    // whatever the project was pointed at before is gone, with no record of it
    // in the output.
    const wasSource = config.source
    const wasTarget = config.target
    if (wasSource !== envName || wasTarget !== 'local') {
      this.log(`      ${dim('source:')} ${wasSource ?? dim('(unset)')} ${dim('→')} ${envName}`)
      this.log(`      ${dim('target:')} ${wasTarget ?? dim('(unset)')} ${dim('→')} local ${dim('(the clone)')}`)
      this.log(`      ${dim('A bare')} ${cmd('supaforge diff --apply')} ${dim('now writes into the clone, not into')} "${envName}".`)
    }

    // Register clone in .supaforge/branches.json so `clone --list` works
    const branchMeta: BranchMeta = {
      name: localDbName,
      dbName: localDbName,
      dbUrl: localDbUrl,
      createdFrom: envName,
      createdAt: new Date().toISOString(),
      schemaOnly: flags['schema-only'],
    }
    await addBranchToManifest(branchMeta)

    const missing = cloned.failures.length
    if (flags.json) {
      this.json({
        snapshot: snapshot.manifest, config: newConfig,
        restoreFailures: cloned.failures, unavailable: cloned.unavailable,
      })
      if (missing > 0) this.exit(1)
      return
    }

    this.log(missing > 0
      ? `\n  ${warn(`Clone complete, but ${missing} statement(s) could not be restored`)} ${dim('— listed under step 1.')}\n`
      : `\n  ${ok('Clone complete!')}\n`)

    // ── What was NOT cloned (Issue: set expectations before the first diff) ───
    // The pg_dump pipeline deliberately excludes Supabase-managed schemas and
    // can't carry platform-managed state (storage objects, edge functions, auth
    // config, vault secrets). Spelling this out up front explains why the first
    // diff against the remote is large — it is expected, not a tool failure.
    this.log(`  ${bold('Not included in this clone')} ${dim('(expected drift on the first diff):')}`)
    this.log(`    ${dim('•')} Supabase-managed schemas, excluded from the dump so they restore cleanly`)
    this.log(`      on vanilla Postgres: ${dim(CLONE_EXCLUDE_SCHEMAS.join(', '))}`)
    this.log(`    ${dim('•')} Platform state that lives outside the SQL dump: storage objects &`)
    this.log(`      policies, edge functions, auth config, and vault secrets.`)
    // Roles arrived as Layer 14, after this list was written for 13 layers, and
    // is the second-largest source of clone noise — 227 findings on the diff in
    // issue #47. Left unmentioned, they read as unexplained drift.
    this.log(`    ${dim('•')} Postgres roles & grants — Supabase's service roles do not exist`)
    this.log(`      on vanilla Postgres, so every grant that references one reads as drift.`)
    if (flags['schema-only']) {
      this.log(`    ${dim('•')} Table data — you passed ${cmd('--schema-only')} (structure only).`)
    }
    this.log(`    ${dim('These appear as drift below but are managed by Supabase, not your migrations.')}`)
    this.log('')

    // ── Contextual next steps (Issue: give the exact commands for THIS clone) ─
    const skipFlags = CLONE_SKIP_FLAGS
    this.log(`  ${bold('Your workflow is now:')}`)
    this.log(`    1. Develop against the local database ${dim(`(${localDbName})`)}`)
    this.log(`    2. Verify the clone matches "${envName}":  ${cmd('supaforge diff --detail')}`)
    this.log(`       ${dim('Add')} ${cmd(skipFlags)} ${dim('to hide the Supabase-managed noise above.')}`)
    this.log(`    3. See what drifted as you work:  ${cmd('supaforge diff')}`)
    this.log(`    4. Capture the current state:     ${cmd('supaforge snapshot --apply')}`)
    this.log('')
    // Named in full rather than as a bare `--apply`. This is the direction that
    // writes to a hosted database, and from a clone it carries the absences the
    // warning above is about — so it should not be reachable by habit.
    this.log(`  ${bold(`Pushing local changes back to "${envName}"`)} ${dim('writes to that database:')}`)
    this.log(`    ${cmd(`supaforge diff --source=local --target=${envName} --dry-run`)} ${dim('← review first')}`)
    this.log(`    ${cmd(`supaforge diff --source=local --target=${envName} --apply`)}`)
    this.log(`    ${dim('A clone is vanilla PostgreSQL, so')} ${cmd(skipFlags)} ${dim('belongs on those too.')}`)
    this.log('')
    this.log(renderTip({ command: 'clone', cloneApplied: true, schemaOnly: flags['schema-only'] }))
    // The clone is usable, but it is not a copy of the source, and a script
    // relying on it should not carry on as though it were.
    if (missing > 0) this.exit(1)
  }
}

/**
 * What this server cannot have, in one line: extensions it does not ship and
 * the platform's own event triggers. Every Supabase project has some, so they
 * are stated rather than counted as the clone failing — see restoreFailures.
 */
export function formatUnavailable(items: readonly RestoreFailure[]): string[] {
  if (items.length === 0) return []
  const extensions = items.filter(i => i.object.startsWith('extension ')).map(i => i.object.slice('extension '.length))
  const others = items.length - extensions.length
  const parts = [
    ...(extensions.length ? [`extension${extensions.length > 1 ? 's' : ''} ${extensions.join(', ')}`] : []),
    ...(others ? [`${others} event trigger(s) of the platform's`] : []),
  ]
  return [`      ${dim(`Not available on this server, as expected for a Supabase project: ${parts.join('; ')}`)}`]
}

/** Shown at most, before "…and N more". */
const RESTORE_FAILURES_SHOWN = 15

/**
 * What pg_restore could not reproduce, for step 1 of the output.
 *
 * pg_restore exits 1 and carries on when a statement fails, which used to be
 * read as success: the step printed a tick and the objects were simply not in
 * the clone.
 */
export function formatRestoreFailures(failures: readonly RestoreFailure[]): string[] {
  if (failures.length === 0) return []
  const lines = [`      ${warn('⚠')} ${failures.length} statement(s) failed, so these are not in the clone:`]
  for (const f of failures.slice(0, RESTORE_FAILURES_SHOWN)) {
    lines.push(`        ${dim('•')} ${f.object} ${dim(`— ${f.error}`)}`)
  }
  const rest = failures.length - RESTORE_FAILURES_SHOWN
  if (rest > 0) lines.push(`        ${dim(`…and ${rest} more`)}`)
  return lines
}

/**
 * The config a clone leaves behind.
 *
 * The clone becomes the **target**, so a bare `supaforge diff --apply` in this
 * directory writes into the local copy.
 *
 * It used to be the source, with the cloned-from environment as the target —
 * and the closing guidance recommended a bare `diff --apply`. Together those
 * pointed the next unqualified apply at the hosted database the clone had just
 * been taken from, carrying with it exactly the roles-and-grants drift the same
 * screen warns about (issue #89). Pushing that way is still available and is
 * now spelled out in full, which is the direction that deserves to be explicit.
 *
 * Everything else about the config is preserved, including any environment
 * already called `local`, which is replaced rather than merged: it names a
 * database, and the clone is the database it now names.
 */
export function configAfterClone(
  config: SupaForgeConfig,
  envName: string,
  localDbUrl: string,
): SupaForgeConfig {
  return {
    ...config,
    environments: {
      ...config.environments,
      local: { ...config.environments.local, dbUrl: localDbUrl },
    },
    source: envName,
    target: 'local',
  }
}
