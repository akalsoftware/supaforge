import { redactUrls, describeFailure } from './utils/error.js'
import { formatWithOptions } from 'node:util'
import { Command } from '@oclif/core'
import { loadConfig, validateConfig, validateSingleEnvConfig } from './config.js'
import { Preflight } from './preflight.js'
import { DEFAULT_MIGRATIONS_DIR } from './checks/migrations.js'
import type { SupaForgeConfig, EnvironmentConfig } from './types/config.js'
import type { PreflightReport } from './preflight.js'
import { appendRunLog, redactArgs, type RunLogCheckSummary } from './run-log.js'
import { installProcessGuard, noteJsonWritten } from './process-guard.js'

/**
 * Shared base for all supaforge commands.
 * Extracts config loading, env resolution, URL redaction, and run logging.
 */
export abstract class BaseCommand extends Command {

  private _startTime = 0
  private _logWritten = false
  private _checkSummaries?: RunLogCheckSummary[]

  /**
   * Under --json, stdout carries the JSON and nothing else: every other line a
   * command prints — preflight checks, progress — goes to stderr. Before, the
   * text came first and the output did not parse.
   */
  override log(message = '', ...args: unknown[]): void {
    if (this.argv.includes('--json')) {
      process.stderr.write(formatWithOptions({ colors: false }, message, ...args) + '\n')
      return
    }
    super.log(message, ...args)
  }

  private _jsonWritten = false

  /** The command's result as JSON, on stdout. */
  protected json(value: unknown): void {
    this._jsonWritten = true
    noteJsonWritten()
    process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  }

  /** Call after scan() to attach per-check metadata to the run log entry. */
  protected setCheckSummaries(summaries: RunLogCheckSummary[]): void {
    this._checkSummaries = summaries
  }

  override async init(): Promise<void> {
    await super.init()
    this._startTime = Date.now()
    installProcessGuard(this.argv)
  }

  override async catch(err: Error): Promise<void> {
    this._logWritten = true
    await this._writeRunLog('error', err.message)
    // --json promises JSON on stdout. A connection error that ended the
    // command before it produced any reached stderr only, and a script reading
    // stdout got nothing to parse. A deliberate exit (this.exit) is not an
    // error to report: its JSON, if any, is already written.
    if (this.argv?.includes('--json') && !this._jsonWritten && !isExitRequest(err)) {
      this.json({ error: redactUrls(describeFailure(err)) })
    }
    return super.catch(err)
  }

  override async finally(err: Error | undefined): Promise<void> {
    if (!this._logWritten) {
      await this._writeRunLog(err ? 'error' : 'success', err?.message)
    }
    return super.finally(err)
  }

  private async _writeRunLog(exitStatus: 'success' | 'error', error?: string): Promise<void> {
    try {
      const version = this.config?.version
      const argv = this.argv ?? []
      await appendRunLog({
        timestamp: new Date().toISOString(),
        command: this.id ?? 'unknown',
        args: redactArgs(argv),
        durationMs: Date.now() - this._startTime,
        exitStatus,
        error,
        version,
        checkSummaries: this._checkSummaries,
      })
    } catch {
      // Never let logging failures surface to users
    }
  }

  /** Load config or exit with a helpful error. */
  protected async loadConfigOrFail(): Promise<SupaForgeConfig> {
    try {
      return await loadConfig()
    } catch (err) {
      // Only a missing file means "run init"; a broken one says what is wrong.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.error('Could not load supaforge.config.json. Run "supaforge init" first.')
      }
      this.error(`Could not load supaforge.config.json: ${redactUrls(describeFailure(err))}`)
    }
  }

  /**
   * Resolve a single environment by name.
   * Accepts an explicit flag value or falls back to config.source.
   */
  protected resolveEnv(
    config: SupaForgeConfig,
    envFlag?: string,
  ): { envName: string; env: EnvironmentConfig } {
    const envName = envFlag ?? config.source
    if (!envName) {
      this.error('No environment specified. Use --env=<name> or set "source" in your config.')
    }

    const errors = validateSingleEnvConfig(config, envName)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    return { envName, env: config.environments[envName] }
  }

  /**
   * Validate a two-env (source + target) config.
   * Applies flag overrides before validation.
   */
  protected validateDualEnvConfig(
    config: SupaForgeConfig,
    sourceFlag?: string,
    targetFlag?: string,
  ): void {
    if (sourceFlag) config.source = sourceFlag
    if (targetFlag) config.target = targetFlag

    const errors = validateConfig(config)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }
  }

  /** Redact password from a database URL for display. */
  protected redactUrl(url: string): string {
    return url.replace(/:([^@/]{1,})@/, ':***@')
  }

  /** Resolve the migrations directory from config (with default fallback). */
  protected resolveMigrationsDir(config: SupaForgeConfig): string {
    return config.checks?.migrations?.dir ?? DEFAULT_MIGRATIONS_DIR
  }

  /**
   * Create, run, and enforce a preflight check.
   * Returns the Preflight instance for commands that need to add custom checks.
   * When `abortMessage` is provided, exits with an error if checks fail.
   */
  protected createPreflight(title: string): Preflight {
    return new Preflight(title, (m) => this.log(m))
  }

  /**
   * Run a preflight and abort with a user-friendly message if it fails.
   * Returns the report for commands that inspect individual check results.
   */
  protected async runPreflight(preflight: Preflight, commandName: string): Promise<PreflightReport> {
    const report = await preflight.run()
    if (!report.passed) {
      // Under --json the checks above went to stderr, so the JSON error names
      // what failed rather than pointing at lines a script never sees.
      const reasons = report.checks.filter(c => !c.passed).map(c => `${c.label}: ${redactUrls(c.error ?? 'failed')}`)
      this.error(this.argv.includes('--json')
        ? `${commandName} aborted — ${reasons.join('; ')}`
        : `${commandName} aborted — fix the issues above first.`, { exit: 1 })
    }
    return report
  }
}

/** oclif's this.exit() throws an ExitError; it carries `oclif.exit`. */
function isExitRequest(err: unknown): boolean {
  const oclif = (err as { oclif?: { exit?: unknown } } | null)?.oclif
  return typeof oclif?.exit === 'number' && (err as Error).message?.startsWith('EEXIT')
}
