import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base-command.js'
import { writeMigrationFile } from '../../migration-file.js'
import { ok, warn, dim, bold, cmd } from '../../ui.js'
import { truncateSql } from './run.js'

/**
 * Generate a new migration file from the current schema drift.
 *
 * Runs a schema diff between source and target, then writes the UP SQL
 * into a timestamped migration file in supabase/migrations/.
 *
 * Replaces `supabase db diff` for self-hosted Supabase instances.
 */
export default class MigrateCreate extends BaseCommand {
  static override description = 'Generate a new migration file from schema drift between environments'

  static override examples = [
    '<%= config.bin %> migrate create --name="add_user_roles"',
    '<%= config.bin %> migrate create --name="update_rls" --source=staging --target=production',
  ]

  static override flags = {
    name: Flags.string({
      char: 'n',
      description: 'Name for the migration (used in filename)',
      required: true,
    }),
    source: Flags.string({ char: 's', description: 'Source environment name' }),
    target: Flags.string({ char: 't', description: 'Target environment name' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateCreate)

    const config = await this.loadConfigOrFail()
    this.validateDualEnvConfig(config, flags.source, flags.target)

    const sourceEnv = config.environments[config.source!]
    const targetEnv = config.environments[config.target!]
    const dir = this.resolveMigrationsDir(config)

    // Preflight: verify both databases are reachable
    const pre = this.createPreflight('Migrate create preflight checks')
      .addDatabase('Source', config.source!, sourceEnv.dbUrl)
      .addDatabase('Target', config.target!, targetEnv.dbUrl)
    await this.runPreflight(pre, 'Migrate create')

    this.log(`${bold('migrate create')} — diffing ${dim(config.source!)} → ${dim(config.target!)}\n`)

    const { filePath, destructive } = await writeMigrationFile({ config, name: flags.name, dir })
    if (!filePath) {
      this.log(`${ok('No schema drift detected.')} Nothing to write. ✓`)
      return
    }

    this.log(`${ok('Created migration:')} ${cmd(filePath)}`)
    if (destructive.length > 0) {
      this.log(`\n${warn(`${destructive.length} destructive statement(s) in it`)} ${dim('— they drop or delete data:')}`)
      for (const sql of destructive) this.log(`  ${warn('✗')} ${dim(truncateSql(sql))}`)
      this.log(`  ${dim('Review them; migrate run applies them only with --allow-destructive.')}`)
    }
    this.log(`\n  ${dim('To preview:')} ${cmd(`supaforge migrate run --env=${config.target!}`)}`)
    this.log(`  ${dim('To apply:')} ${cmd(`supaforge migrate run --env=${config.target!} --apply`)}`)
    this.log(`  ${dim('To baseline:')} ${cmd(`supaforge migrate baseline --env=${config.target!}`)}`)
  }
}

export { generateTimestamp } from '../../migration-file.js'

/** Re-export for backward-compat — uses shared slugify with underscore separator. */
export { slugify } from '../../utils/strings.js'
