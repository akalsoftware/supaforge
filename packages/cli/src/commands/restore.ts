import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { findLatestSnapshot, listSnapshots } from '../snapshot'
import {
  restoreFromSnapshot,
  restoreFromMigrations,
  previewSnapshotRestore,
  previewMigrationRestore,
  getPublicTables,
  summarizeStatement,
} from '../restore'
import { warn, cmd } from '../ui.js'
import { renderTip } from '../tips.js'

export default class Restore extends BaseCommand {
  static override description = 'Restore a Supabase environment from a snapshot or migration history'

  static override examples = [
    '<%= config.bin %> restore --env=local --from-snapshot=latest',
    '<%= config.bin %> restore --env=local --from-snapshot=latest --apply',
    '<%= config.bin %> restore --env=local --from-migrations --apply',
    '<%= config.bin %> restore --env=local --from-migrations --to=20260407T120000Z --apply',
    '<%= config.bin %> restore --env=local --from-snapshot=latest --apply --force',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Target environment to restore into',
      required: true,
    }),
    'from-snapshot': Flags.string({
      description: 'Restore from a snapshot ("latest" or a timestamp)',
      exclusive: ['from-migrations'],
    }),
    'from-migrations': Flags.boolean({
      description: 'Restore by replaying migration files',
      exclusive: ['from-snapshot'],
    }),
    to: Flags.string({
      description: 'Replay migrations up to this version (timestamp)',
    }),
    from: Flags.string({
      description: 'Replay migrations from this version (timestamp)',
    }),
    apply: Flags.boolean({
      description: 'Actually execute the restore (default: dry-run preview)',
      default: false,
    }),
    'no-transaction': Flags.boolean({
      description:
        'Apply each statement on its own, keeping whatever succeeds. Off by default: '
        + 'a snapshot restore runs in one transaction, so a failure leaves the target '
        + 'exactly as it was rather than half-restored. Applies to --from-snapshot.',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Allow restore into a non-empty database (destructive)',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Restore)

    if (!flags['from-snapshot'] && !flags['from-migrations']) {
      this.error('Specify --from-snapshot or --from-migrations')
    }

    const config = await this.loadConfigOrFail()

    const envName = flags.env
    const { env } = this.resolveEnv(config, envName)

    // Preflight: verify database is reachable. Under --json too, where its
    // lines go to stderr and a failure is reported as JSON.
    const pre = this.createPreflight('Restore preflight checks')
      .addDatabase('Target', envName, env.dbUrl)
    await this.runPreflight(pre, 'Restore')

    // Safety: check if target DB has existing tables before destructive restore
    if (flags.apply) {
      const tables = await getPublicTables(env.dbUrl)
      if (tables.length > 0 && !flags.force) {
        if (flags.json) {
          this.json({ error: 'Target database is not empty', tables })
          this.exit(1)
        }
        this.log(`\n${warn('Target database is not empty.')} Found ${tables.length} table(s) in public schema:`)
        for (const t of tables.slice(0, 10)) {
          this.log(`  • ${t}`)
        }
        if (tables.length > 10) {
          this.log(`  ... and ${tables.length - 10} more`)
        }
        this.log(`\n  Restore replays SQL into the target and may conflict with existing data.`)
        this.log(`  → Use ${cmd('supaforge sync')} to apply only the differences instead.`)
        this.log(`  → Add ${cmd('--force')} to drop and replace the schemas this snapshot covers.\n`)
        // --apply was asked for and refused, so this is not success. Returning
        // 0 made `supaforge restore ... --apply && deploy` continue as though
        // the restore had happened, which is the worst possible reading of a
        // safety guard: it protects the data and then lets the pipeline act on
        // the assumption it did not have to.
        this.exit(1)
      }
    }

    if (flags['from-snapshot']) {
      await this.handleSnapshotRestore(flags, env.dbUrl)
    } else {
      await this.handleMigrationRestore(flags, env.dbUrl)
    }
  }

  private async handleSnapshotRestore(
    flags: Record<string, unknown>,
    targetUrl: string,
  ): Promise<void> {
    const snapshotRef = flags['from-snapshot'] as string
    let snapshotDir: string

    if (snapshotRef === 'latest') {
      const latest = await findLatestSnapshot()
      if (!latest) {
        this.error('No snapshots found. Create one with "supaforge snapshot" first.')
      }
      snapshotDir = latest
    } else {
      // Assume it's a timestamp — resolve to path
      const snapshots = await listSnapshots()
      const match = snapshots.find(s => s.manifest.timestamp === snapshotRef)
      if (!match) {
        this.error(`Snapshot "${snapshotRef}" not found. Use --from-snapshot=latest or a valid timestamp.`)
      }
      snapshotDir = match.dir
    }

    if (!flags.apply) {
      const preview = await previewSnapshotRestore(snapshotDir)
      if (flags.json) {
        this.json({ dryRun: true, snapshot: snapshotDir, layers: preview })
        return
      }
      this.log('\nRestore preview (dry-run) -- from snapshot\n')
      if (preview.length === 0) {
        this.log('  No executable SQL found in snapshot.')
        return
      }

      for (const { layer, statements } of preview) {
        this.log(`  Layer: ${layer} (${statements.length} statements)`)
        // `summarizeStatement`, not the first line: a statement carrying a
        // leading comment — which every layer file's first one does, since the
        // header lands in the same chunk — showed the comment instead of the
        // SQL. A preview you cannot read is the one thing a preview must not
        // be. It is also what the apply path prints, so the two now describe
        // the same statement the same way.
        for (const stmt of statements.slice(0, 3)) {
          this.log(`    ${summarizeStatement(stmt)}`)
        }
        if (statements.length > 3) {
          this.log(`    ... and ${statements.length - 3} more`)
        }
        this.log('')
      }
      this.log(`  → Add --apply to execute the restore.\n`)
      return
    }

    if (!flags.json) this.log(`\nRestoring from snapshot...\n`)

    const result = await restoreFromSnapshot({
      targetUrl,
      snapshotDir,
      noTransaction: flags['no-transaction'] as boolean,
      // --force means replace: the schemas the snapshot covers are dropped
      // before it is replayed. It used to only skip the not-empty check, so a
      // restore over an existing database failed on every object already there
      // and replaced nothing (issue #95).
      replace: flags.force as boolean,
    })

    this.renderResult(result, flags.json as boolean)
  }

  private async handleMigrationRestore(
    flags: Record<string, unknown>,
    targetUrl: string,
  ): Promise<void> {
    const toVersion = flags.to as string | undefined
    const fromVersion = flags.from as string | undefined

    if (!flags.apply) {
      const migrations = await previewMigrationRestore(process.cwd(), toVersion, fromVersion)
      if (flags.json) {
        this.json({
          dryRun: true,
          migrations: migrations.map(m => ({
            version: m.version,
            description: m.description,
            layers: m.layers,
            sqlStatements: m.up.sql.length,
            apiActions: m.up.api.length,
          })),
        })
        return
      }
      this.log('\nRestore preview (dry-run) -- from migrations\n')
      if (migrations.length === 0) {
        this.log('  No migrations found.')
        return
      }

      for (const m of migrations) {
        this.log(`  ${m.version}  ${m.description}`)
        this.log(`    Layers: ${m.layers.join(', ')}`)
        this.log(`    SQL:    ${m.up.sql.length} statements`)
        this.log(`    API:    ${m.up.api.length} actions`)
        this.log('')
      }
      this.log(`  → Add --apply to execute the restore.\n`)
      return
    }

    if (!flags.json) this.log(`\nRestoring from migrations...\n`)

    // --no-transaction is deliberately not forwarded: the migration path
    // applies and records one migration at a time, so wrapping the set in a
    // single transaction would roll back migrations that had already been
    // recorded as applied. Per-migration transactions belong with the rest of
    // the migration work in #92 rather than here.
    const result = await restoreFromMigrations({
      targetUrl,
      toVersion,
      fromVersion,
    })

    this.renderResult(result, flags.json as boolean)
  }

  private renderResult(
    result: Awaited<ReturnType<typeof restoreFromSnapshot>>,
    json: boolean,
  ): void {
    if (json) {
      // Only the JSON on stdout, so it parses, and the same exit code as the
      // text report: a restore that failed or left things out is not one a
      // script should read as success.
      this.json(result)
      if (result.errors.length > 0 || result.incomplete) this.exit(1)
      return
    }

    for (const warning of result.warnings ?? []) this.log(`⚠  ${warning}\n`)

    if (result.applied.length > 0) {
      this.log(`✅ Applied ${result.applied.length} operation(s):`)
      for (const op of result.applied.slice(0, 20)) {
        this.log(`  ✓ [${op.type}] ${op.label}`)
      }
      if (result.applied.length > 20) {
        this.log(`  ... and ${result.applied.length - 20} more`)
      }
    }

    if (result.skipped.length > 0) {
      this.log(`\n⏭  Skipped ${result.skipped.length} operation(s):`)
      for (const op of result.skipped) {
        this.log(`  ○ [${op.type}] ${op.label}: ${op.reason}`)
      }
    }

    if (result.rolledBack && result.rolledBack.length > 0) {
      // Reported apart from `applied`, which is empty: a restore that rolled
      // back applied nothing, and saying otherwise would be the most
      // misleading thing this command could print (issue #95).
      this.log(`\n↩  Rolled back ${result.rolledBack.length} operation(s) — the target is unchanged.`)
    }

    if (result.incomplete && result.errors.length === 0) {
      // Restored, but not all of it: what was left out is listed above, each
      // with what it needed. Not a success a script should take as one.
      this.log(`\n⚠  Restored everything this target can hold. What it cannot is listed above as skipped.`)
      process.exitCode = 1
    }

    if (result.errors.length > 0) {
      this.log(`\n❌ ${result.errors.length} error(s):`)
      for (const op of result.errors) {
        this.log(`  ✖ [${op.type}] ${op.label}: ${op.error}`)
      }
      if (result.rolledBack && result.rolledBack.length > 0) {
        this.log(`\n  Nothing was written. Re-run with ${cmd('--no-transaction')} to keep the parts that work.`)
      }
      this.exit(1)
    }

    this.log(renderTip({ command: 'restore' }))
  }
}
