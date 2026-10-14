import { Command, Flags } from '@oclif/core'
import { createInterface } from 'node:readline'
import { writeFile, readFile, appendFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateConfig, validateSingleEnvConfig, expandEnvVars, parseProjectRef } from '../config'
import { INIT_HINTS } from '../defaults'
import { UserCancelledError, isUserCancelled } from '../errors'
import { printBanner, printHints, ok, warn, dim, cmd, bold } from '../ui'
import { SUPAFORGE_DIR } from '../constants'
import type { SupaForgeConfig, EnvironmentConfig } from '../types/config'
import { installProcessGuard } from '../process-guard.js'

const CONFIG_FILENAME = 'supaforge.config.json'

/** Entries that supaforge init ensures are present in .gitignore. */
const GITIGNORE_ENTRIES = [CONFIG_FILENAME, `${SUPAFORGE_DIR}/`]

export type AskFn = ((question: string) => Promise<string>) & { close: () => void }

/**
 * Convert an environment name to an uppercase env var prefix.
 * e.g. "staging" → "STAGING", "my-prod" → "MY_PROD"
 */
export function envPrefix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

export function createPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): AskFn {
  const rl = createInterface({ input, output })
  let closed = false
  let rejectPending: ((err: Error) => void) | null = null

  rl.on('close', () => {
    closed = true
    if (rejectPending) {
      rejectPending(new UserCancelledError())
      rejectPending = null
    }
  })

  const ask = (question: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new UserCancelledError())
        return
      }
      rejectPending = reject
      rl.question(question, (answer) => {
        rejectPending = null
        resolve(answer.trim())
      })
    })
  ask.close = () => rl.close()
  return ask as AskFn
}

/**
 * Prompt until the user enters a value that matches one of the options.
 * Accepts exact match, single-char shortcut, or unambiguous prefix.
 * Returns the full option string.
 */
export async function fuzzySelect(
  ask: (question: string) => Promise<string>,
  log: (msg: string) => void,
  prompt: string,
  options: string[],
  defaultOption?: string,
): Promise<string> {
  while (true) {
    const raw = await ask(prompt)
    const input = raw.toLowerCase()

    // Empty → default
    if (!input && defaultOption) return defaultOption

    // Exact match (case-insensitive)
    const exact = options.find((o) => o.toLowerCase() === input)
    if (exact) return exact

    // Prefix match — must be unambiguous
    const prefixMatches = options.filter((o) => o.toLowerCase().startsWith(input))
    if (prefixMatches.length === 1) return prefixMatches[0]

    if (prefixMatches.length > 1) {
      log(warn(`  \u26a0 "${raw}" is ambiguous \u2014 could be: ${prefixMatches.join(', ')}`))
    } else {
      log(warn(`  \u26a0 "${raw}" is not recognised. Options: ${options.join(', ')}`))
    }
  }
}

/**
 * Prompt until the user enters a non-empty value.
 * Re-prompts with a warning on empty input; Ctrl+C propagates as UserCancelledError.
 */
export async function askRequired(
  ask: (question: string) => Promise<string>,
  log: (msg: string) => void,
  prompt: string,
  fieldName: string,
): Promise<string> {
  while (true) {
    const value = await ask(prompt)
    if (value) return value
    log(warn(`  ⚠ ${fieldName} is required.`))
  }
}

/**
 * Interactively collect config from the user.
 * Extracted so it can be tested without oclif scaffolding.
 */
export async function collectConfig(
  ask: (question: string) => Promise<string>,
  log: (msg: string) => void = console.log,
): Promise<{ config: SupaForgeConfig; envVars: Record<string, string> }> {
  const environments: Record<string, EnvironmentConfig> = {}
  const envVars: Record<string, string> = {}

  let singleEnv: boolean | null = null
  while (singleEnv === null) {
    const selected = await fuzzySelect(
      ask, log,
      'Setup mode \u2014 compare two environments or single database? [multi/single]: ',
      ['multi', 'single'],
      'multi',
    )
    singleEnv = selected === 'single'
  }
  log(ok(`  ✓ Mode: ${singleEnv ? 'single' : 'multi'}\n`))

  if (singleEnv) {
    log(bold('Set up your Supabase database.'))
    log(dim('Sensitive values (DB URL, API key) will be stored as $ENV_VAR references.\n'))
  } else {
    log(bold('Add your Supabase environments (at least 2).'))
    log(dim('Sensitive values (DB URL, API key) will be stored as $ENV_VAR references.\n'))
  }

  if (singleEnv) {
    const defaultName = 'prod'
    let name = await ask(`Environment name [${defaultName}]: `)
    if (!name) name = defaultName
    log(ok(`  ✓ Environment: ${name}`))

    const prefix = envPrefix(name)
    const dbUrlVar = `${prefix}_DATABASE_URL`

    INIT_HINTS.DB_URL.forEach((l) => log(dim(l)))
    const dbUrl = await askRequired(ask, log, `  Database URL for "${name}": `, 'Database URL')
    envVars[dbUrlVar] = dbUrl

    log('')
    printHints(INIT_HINTS.PROJECT_URL, log)
    const projectUrl = await ask(`  Supabase Project URL or Project ID for "${name}" (e.g. https://xyz.supabase.co, optional): `)
    const projectRef = projectUrl ? parseProjectRef(projectUrl) : ''

    let accessToken = ''
    if (projectRef) {
      log('')
      printHints(INIT_HINTS.ACCESS_TOKEN, log)
      accessToken = await ask(`  Supabase access token for "${name}" (optional): `)
    }

    const accessTokenVar = `${prefix}_ACCESS_TOKEN`
    if (accessToken) {
      envVars[accessTokenVar] = accessToken
    }

    const env: EnvironmentConfig = { dbUrl: `$${dbUrlVar}` }
    if (projectRef) env.projectRef = projectRef
    if (accessToken) env.accessToken = `$${accessTokenVar}`

    environments[name] = env

    log('')
    printHints(INIT_HINTS.DATA_TABLES, log)
    const dataTables = await ask('Reference-data tables to track (comma-separated, or Enter to skip): ')
    const checks = dataTables
      ? { data: { tables: dataTables.split(',').map((t) => t.trim()).filter(Boolean) } }
      : undefined

    const config: SupaForgeConfig = { environments }
    if (checks) config.checks = checks

    return { config, envVars }
  }

  let envCount = 0
  const defaults = ['staging', 'production']

  while (envCount < 2 || await confirm(ask, 'Add another environment?', false)) {
    const defaultName = defaults[envCount] ?? ''
    const prompt = defaultName
      ? `Environment name [${defaultName}]: `
      : 'Environment name: '

    let name = await ask(prompt)
    if (!name && defaultName) name = defaultName

    if (!name) {
      log(warn('  \u26a0 Name cannot be empty, try again.'))
      continue
    }

    if (environments[name]) {
      log(warn(`  \u26a0 "${name}" already exists, try again.`))
      continue
    }

    const prefix = envPrefix(name)
    const dbUrlVar = `${prefix}_DATABASE_URL`

    if (envCount === 0) {
      printHints(INIT_HINTS.DB_URL, log)
    }
    const dbUrl = await askRequired(ask, log, `  Database URL for "${name}": `, 'Database URL')

    envVars[dbUrlVar] = dbUrl

    if (envCount === 0) {
      log('')
      printHints(INIT_HINTS.PROJECT_URL, log)
    }
    const projectUrl = await ask(`  Supabase Project URL or Project ID for "${name}" (e.g. https://xyz.supabase.co, optional): `)
    const projectRef = projectUrl ? parseProjectRef(projectUrl) : ''

    let accessToken = ''
    if (projectRef) {
      if (envCount === 0) {
        log('')
        printHints(INIT_HINTS.ACCESS_TOKEN, log)
      }
      accessToken = await ask(`  Supabase access token for "${name}" (optional): `)
    }

    const accessTokenVar = `${prefix}_ACCESS_TOKEN`
    if (accessToken) {
      envVars[accessTokenVar] = accessToken
    }

    const env: EnvironmentConfig = { dbUrl: `$${dbUrlVar}` }
    if (projectRef) env.projectRef = projectRef
    if (accessToken) env.accessToken = `$${accessTokenVar}`

    environments[name] = env
    envCount++
    log(ok(`  ✓ Environment "${name}" added`))
    log('')
  }

  const envNames = Object.keys(environments)

  const source = await selectOne(ask, log, 'Source environment (truth)', envNames, envNames[0])
  log(ok(`  ✓ Source: ${source}`))
  const remaining = envNames.filter((n) => n !== source)
  const target = await selectOne(ask, log, 'Target environment (to sync)', remaining, remaining[0])
  log(ok(`  ✓ Target: ${target}`))

  log('')
  printHints(INIT_HINTS.DATA_TABLES, log)
  const dataTables = await ask('Reference-data tables to track (comma-separated, or Enter to skip): ')
  const checks = dataTables
    ? { data: { tables: dataTables.split(',').map((t) => t.trim()).filter(Boolean) } }
    : undefined

  const config: SupaForgeConfig = { environments, source, target }
  if (checks) config.checks = checks

  return { config, envVars }
}

async function confirm(
  ask: (question: string) => Promise<string>,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await ask(`${question} ${hint}: `)
  if (!answer) return defaultYes
  return answer.toLowerCase().startsWith('y')
}

async function selectOne(
  ask: (question: string) => Promise<string>,
  log: (msg: string) => void,
  label: string,
  options: string[],
  defaultOption: string,
): Promise<string> {
  const optList = options.map((o) => (o === defaultOption ? `[${o}]` : o)).join(' / ')
  return fuzzySelect(ask, log, `${label} (${optList}): `, options, defaultOption)
}

/**
 * Ensure required entries are present in .gitignore.
 * Creates the file if it doesn't exist. Returns the list of entries that were added.
 */
export async function ensureGitignore(
  entries: string[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const gitignorePath = resolve(cwd, '.gitignore')
  let existing = ''
  try {
    existing = await readFile(gitignorePath, 'utf-8')
  } catch {
    // file does not exist
  }

  const lines = existing.split('\n').map((l) => l.trim())
  const missing = entries.filter((e) => !lines.includes(e))
  if (missing.length === 0) return []

  const block = '\n# Added by supaforge init\n' + missing.join('\n') + '\n'
  if (existing) {
    await appendFile(gitignorePath, block)
  } else {
    await writeFile(gitignorePath, block.trimStart(), 'utf-8')
  }
  return missing
}

export default class Init extends Command {
  static override description = 'Create a supaforge.config.json file interactively'

  static override examples = [
    '<%= config.bin %> init',
    '<%= config.bin %> init --force',
  ]

  static override flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Overwrite existing config file',
      default: false,
    }),
  }

  async run(): Promise<void> {
    installProcessGuard(this.argv)
    const { flags } = await this.parse(Init)
    const configPath = resolve(process.cwd(), CONFIG_FILENAME)

    if (!flags.force) {
      let configExists = false
      try {
        await access(configPath)
        configExists = true
      } catch {
        // File does not exist — proceed
      }

      if (configExists) {
        this.error(
          `${CONFIG_FILENAME} already exists. Use --force to overwrite.`,
        )
      }
    }

    printBanner((msg) => this.log(msg))
    this.log(bold('  🔧 Init — create your config file\n'))

    const ask = createPrompt()

    try {
      const { config, envVars } = await collectConfig(ask, (msg) => this.log(msg))

      const isSingleEnv = !config.source

      // Validate with env vars expanded (to catch structural issues)
      // but write the unexpanded $VAR references to the config file
      const expandedConfig = {
        ...config,
        environments: Object.fromEntries(
          Object.entries(config.environments).map(([name, env]) => [
            name,
            {
              ...env,
              dbUrl: expandEnvVars(env.dbUrl),
              ...(env.accessToken ? { accessToken: expandEnvVars(env.accessToken) } : {}),
            },
          ]),
        ),
      }

      if (isSingleEnv) {
        const envName = Object.keys(expandedConfig.environments)[0]
        const errors = validateSingleEnvConfig(expandedConfig, envName)
        if (errors.length > 0) {
          this.error(`Generated config is invalid:\n  ${errors.join('\n  ')}`)
        }
      } else {
        const errors = validateConfig(expandedConfig)
        if (errors.length > 0) {
          this.error(`Generated config is invalid:\n  ${errors.join('\n  ')}`)
        }
      }

      const json = JSON.stringify(config, null, 2) + '\n'
      await writeFile(configPath, json, 'utf-8')
      this.log(`\n${ok('✅ Wrote')} ${bold(CONFIG_FILENAME)}`)

      // Ensure supaforge paths are in .gitignore
      const added = await ensureGitignore(GITIGNORE_ENTRIES)
      if (added.length > 0) {
        this.log(`${ok('✅ Added to .gitignore:')} ${added.join(', ')}`)
      }

      // Write .env file with the actual secrets
      if (Object.keys(envVars).length > 0) {
        const envPath = resolve(process.cwd(), '.env')
        const envContent = Object.entries(envVars)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') + '\n'

        let envExists = false
        try {
          await access(envPath)
          envExists = true
        } catch {
          // does not exist
        }

        if (envExists) {
          await appendFile(envPath, '\n# Added by supaforge init\n' + envContent)
          this.log(`${ok('📎 Appended env vars to')} ${bold('.env')}`)
        } else {
          await writeFile(envPath, envContent, 'utf-8')
          this.log(`${ok('📎 Wrote .env')} with database credentials`)
        }

        // Check .gitignore and offer to add .env if missing
        const gitignorePath = resolve(process.cwd(), '.gitignore')
        let gitignoreHasEnv = false
        try {
          const gitignore = await readFile(gitignorePath, 'utf-8')
          gitignoreHasEnv = gitignore.split('\n').some((line) => {
            const trimmed = line.trim()
            return trimmed === '.env' || trimmed === '.env*' || trimmed === '.env.*'
          })
        } catch {
          // .gitignore does not exist
        }

        if (!gitignoreHasEnv) {
          const addIt = await confirm(ask, `${warn('⚠️  .env is not in .gitignore.')} Add it now?`, true)
          if (addIt) {
            let gitignoreExists = false
            try {
              await access(gitignorePath)
              gitignoreExists = true
            } catch {
              // does not exist
            }

            if (gitignoreExists) {
              await appendFile(gitignorePath, '\n# Secrets — added by supaforge init\n.env\n')
            } else {
              await writeFile(gitignorePath, '# Secrets — added by supaforge init\n.env\n', 'utf-8')
            }
            this.log(`${ok('✅ Added .env to .gitignore')}`)
          } else {
            this.log(`${warn('⚠️  Remember to add .env to .gitignore')} — never commit secrets to git.`)
          }
        }
      }

      this.log(`\n${bold('Next steps:')}`)
      if (isSingleEnv) {
        const envName = Object.keys(config.environments)[0]
        this.log(`  ${cmd(`supaforge snapshot --env=${envName}`)}   ${dim('— capture current state')}`)
        this.log(`  ${cmd(`supaforge clone --env=${envName} --apply`)}      ${dim('— clone to local')}`)
        this.log(`  ${cmd(`supaforge snapshot --env=${envName} --migration`)}   ${dim('— incremental backup')}\n`)
      } else {
        this.log(`  ${cmd('supaforge diff')}            ${dim('— check for drift')}`)
        this.log(`  ${cmd('supaforge diff --detail')}    ${dim('— see detailed SQL diffs')}`)
        this.log(`  ${cmd('supaforge diff --apply')}     ${dim('— fix the drift')}\n`)
      }
    } catch (error) {
      if (isUserCancelled(error)) {
        this.log(`\n${dim('Cancelled.')}`)
        return
      }
      throw error
    } finally {
      ask.close()
    }
  }
}
