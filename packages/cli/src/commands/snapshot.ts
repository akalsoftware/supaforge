import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { captureSnapshot, listSnapshots, pruneSnapshots, formatSnapshotLayers, unrestorableSchema, DEFAULT_KEEP_COUNT } from '../snapshot.js'
import { backup, listMigrationFiles } from '../migration.js'
import type { SnapshotManifest } from '../types/config.js'
import { ok, warn, dim, cmd, bold } from '../ui.js'
import { renderTip } from '../tips.js'

/** Human-readable layer names captured by a snapshot, shown in the dry-run preview. */
const SNAPSHOT_LAYERS = [
  'schema (tables, columns, indexes, constraints)',
  'rls (row-level security policies)',
  'edge-functions (via Management API)',
  'storage (buckets + policies)',
  'auth (config via Management API)',
  'cron (pg_cron jobs)',
  'data (reference tables from checks.data.tables)',
  'webhooks (database webhook triggers)',
  'extensions (installed Postgres extensions)',
]

/**
 * Capture and manage environment state snapshots.
 *
 * Default:      dry-run preview of what would be captured (requires --apply)
 * --apply:      actually capture the snapshot
 * --migration:  also generate an incremental migration diff (was: backup)
 * --list:       list existing snapshots
 * --prune:      delete old snapshots
 */
export default class Snapshot extends BaseCommand {
  static override description = 'Capture a point-in-time snapshot of a Supabase environment'

  static override examples = [
    '<%= config.bin %> snapshot',
    '<%= config.bin %> snapshot --apply',
    '<%= config.bin %> snapshot --env=production --apply',
    '<%= config.bin %> snapshot --migration --apply',
    '<%= config.bin %> snapshot --migration --apply --description="added profiles table"',
    '<%= config.bin %> snapshot --list',
    '<%= config.bin %> snapshot --prune',
    '<%= config.bin %> snapshot --prune --keep=5 --apply',
    '<%= config.bin %> snapshot --output=./backups --apply',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Environment to snapshot (defaults to config source)',
    }),
    migration: Flags.boolean({
      description: 'Also generate an incremental migration diff against the previous snapshot',
      default: false,
    }),
    description: Flags.string({
      char: 'd',
      description: 'Human-readable description for the migration',
      default: 'auto-backup',
    }),
    list: Flags.boolean({
      description: 'List existing snapshots',
      default: false,
    }),
    prune: Flags.boolean({
      description: `Delete old snapshots, keeping the most recent (default: ${DEFAULT_KEEP_COUNT})`,
      default: false,
    }),
    keep: Flags.integer({
      description: 'Number of snapshots to keep when pruning',
      default: DEFAULT_KEEP_COUNT,
      min: 1,
    }),
    apply: Flags.boolean({
      description: 'Execute the snapshot (default: dry-run preview). Also required for --prune.',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
    'allow-schema-json-only': Flags.boolean({
      description: 'Succeed even when no pg_dump could write schema.sql: the snapshot can still be diffed, '
        + 'but restore cannot recreate its schema. Without this, such a snapshot is kept and the command exits 1.',
      default: false,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Custom output directory for snapshot files (timestamp subfolder is created inside)',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Snapshot)

    const config = await this.loadConfigOrFail()

    // ── List mode ────────────────────────────────────────────────────────────
    if (flags.list) {
      const snapshots = await listSnapshots()
      if (snapshots.length === 0) {
        this.log('No snapshots found.')
        return
      }
      if (flags.json) {
        this.json(snapshots.map(s => s.manifest))
        return
      }
      this.log(`\n${bold(`${snapshots.length} snapshot(s):`)}\n`)
      for (const { manifest } of snapshots) {
        const layerCount = Object.values(manifest.layers).filter(l => l.captured).length
        const itemCount = Object.values(manifest.layers).reduce((sum, l) => sum + l.itemCount, 0)
        this.log(`  ${bold(manifest.timestamp)}  ${dim('env=')}${manifest.environment}  ${dim('layers=')}${layerCount}  ${dim('items=')}${itemCount}`)
      }
      this.log('')
      this.log(renderTip({ command: 'snapshot', snapshotList: true }))
      return
    }

    // ── Prune mode ───────────────────────────────────────────────────────────
    if (flags.prune) {
      const keepCount = flags.keep
      const snapshots = await listSnapshots()
      const deleteCount = Math.max(0, snapshots.length - keepCount)

      if (deleteCount === 0) {
        this.log(`\nNothing to prune — ${snapshots.length} snapshot(s), keeping ${keepCount}.\n`)
        return
      }

      this.log(`\nPrune: ${snapshots.length} snapshot(s) found, keeping ${keepCount}.`)
      this.log(`  ${deleteCount} snapshot(s) would be deleted:\n`)

      const toDelete = snapshots.slice(0, deleteCount)
      for (const { manifest } of toDelete) {
        this.log(`  ${warn('✗')} ${manifest.timestamp}  ${dim('env=')}${manifest.environment}`)
      }
      this.log('')

      if (!flags.apply) {
        this.log(`  → Add ${cmd('--apply')} to delete these snapshots.\n`)
        return
      }

      const result = await pruneSnapshots(keepCount)

      if (flags.json) {
        this.json(result)
        return
      }

      this.log(`  Deleted ${result.deleted.length} snapshot(s), ${result.kept.length} remaining.`)
      if (result.retainedForMigrations && result.retainedForMigrations.length > 0) {
        // Kept past the budget on purpose: a migration names each of these as
        // its parent, and deleting one breaks that migration's chain (#92).
        this.log(`  ${result.retainedForMigrations.length} kept beyond --keep: a migration names each as its parent.`)
      }
      this.log('')
      return
    }

    // ── Capture snapshot (with optional migration) ───────────────────────────
    const { envName, env } = this.resolveEnv(config, flags.env)

    // Preflight: verify database is reachable. Under --json too, where its
    // lines go to stderr and a failure is reported as JSON.
    const pre = this.createPreflight('Snapshot preflight checks')
      .addDatabase('Database', envName, env.dbUrl)
    await this.runPreflight(pre, 'Snapshot')

    // ── Dry-run gate ─────────────────────────────────────────────────────────
    // Like clone / diff / restore, snapshot is a preview unless --apply is given.
    if (!flags.apply) {
      if (flags.json) {
        this.json({ dryRun: true, environment: envName, migration: flags.migration })
        return
      }
      this.log(`\n  ${bold('Snapshot preview')} ${dim('(dry-run)')}\n`)
      this.log(`    Environment: ${envName}`)
      this.log(`    Mode:        ${flags.migration ? 'snapshot + incremental migration' : 'snapshot'}`)
      this.log('')
      this.log('    Layers that will be captured (when present):')
      for (const layer of SNAPSHOT_LAYERS) {
        this.log(`      ${dim('•')} ${layer}`)
      }
      this.log('')
      this.log(`    ${dim('Layers with no data (e.g. no cron, no storage) are skipped automatically.')}`)
      this.log(`\n    → Add ${cmd('--apply')} to capture the snapshot.\n`)
      this.log(renderTip({ command: 'snapshot', snapshotMigration: flags.migration, snapshotList: false }))
      return
    }

    if (flags.migration) {
      // Capture + generate migration (was: backup command)
      this.log(`\nCapturing snapshot of "${envName}" with migration...\n`)

      const result = await backup({
        envName,
        env,
        config,
        description: flags.description,
        outputDir: flags.output,
      })

      if (flags.json) {
        this.json({
          isBaseline: result.isBaseline,
          snapshot: result.snapshot.manifest,
          migration: result.migration,
          migrationFile: result.migrationFile,
        })
        this.failIfUnrestorable(result.snapshot.manifest, result.snapshot.dir, flags['allow-schema-json-only'])
        return
      }

      this.logSnapshotResult(result.snapshot.manifest)
      this.log(`  ${dim('Snapshot:')}  ${result.snapshot.dir}`)

      if (result.isBaseline) {
        this.log(`  ${dim('Type:')}      baseline (first snapshot)`)
      } else {
        this.log(`  ${dim('Type:')}      incremental diff`)
      }

      if (result.migration) {
        this.log(`  ${dim('Migration:')} ${result.migrationFile}`)
        this.log(`  ${dim('Layers:')}    ${result.migration.layers.join(', ')}`)
        this.log(`  ${dim('SQL up:')}    ${result.migration.up.sql.length} statement(s)`)
        this.log(`  ${dim('API up:')}    ${result.migration.up.api.length} action(s)`)
      } else {
        this.log(`  ${dim('Migration:')} none (no changes detected)`)
      }

      this.failIfUnrestorable(result.snapshot.manifest, result.snapshot.dir, flags['allow-schema-json-only'])
      this.log(`\n  ${ok('Snapshot + migration complete.')}\n`)
      this.log(renderTip({ command: 'snapshot', snapshotMigration: true }))
      return
    }

    // Plain snapshot — just capture, no dry-run gate
    this.log(`\nCapturing snapshot of "${envName}"...\n`)

    const snapshot = await captureSnapshot({ envName, env, config, outputDir: flags.output })

    if (flags.json) {
      this.json(snapshot.manifest)
      this.failIfUnrestorable(snapshot.manifest, snapshot.dir, flags['allow-schema-json-only'])
      return
    }

    this.logSnapshotResult(snapshot.manifest)
    this.log(`\n  ${dim('Snapshot saved to:')} ${snapshot.dir}`)
    this.failIfUnrestorable(snapshot.manifest, snapshot.dir, flags['allow-schema-json-only'])

    // Show migration hint
    const existing = await listMigrationFiles()
    if (existing.length > 0) {
      this.log(`  → Run with ${cmd('--migration')} to also generate an incremental diff.`)
    } else {
      this.log(`  → Run with ${cmd('--migration')} to save a baseline migration.`)
    }
    this.log('')
    this.log(renderTip({ command: 'snapshot', snapshotMigration: false, snapshotList: false }))
  }

  /**
   * A snapshot without schema.sql cannot restore its schema, and the time to
   * find that out is not during a restore. It is kept — it can still be
   * diffed — but the command fails unless that was asked for.
   */
  private failIfUnrestorable(manifest: SnapshotManifest, dir: string, allowed: boolean): void {
    const reason = unrestorableSchema(manifest)
    if (!reason) return
    if (allowed) {
      this.warn(`This snapshot cannot restore the schema: ${reason}`)
      return
    }
    this.error(
      `This snapshot cannot restore the schema: ${reason}.\n`
      + `It was kept at ${dir}, and can still be diffed. Install PostgreSQL client tools at least as new `
      + 'as the server (or set SUPAFORGE_PG_BIN to them) and snapshot again, or pass '
      + '--allow-schema-json-only to accept a snapshot whose schema cannot be restored.',
      { exit: 1 },
    )
  }

  private logSnapshotResult(manifest: SnapshotManifest): void {
    for (const line of formatSnapshotLayers(manifest)) {
      this.log(`  ${line}`)
    }
  }
}
