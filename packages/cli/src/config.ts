import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SupaForgeConfig, EnvironmentConfig } from './types/config'
import { DEFAULT_IGNORE_SCHEMAS } from './defaults'
import { loadEnvFiles } from './env-loader'
import { errMsg } from './utils/error.js'

const CONFIG_FILENAME = 'supaforge.config.json'

/** Match $VAR or ${VAR} references. */
const ENV_VAR_RE = /\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi

/**
 * Expand $VAR and ${VAR} references in a string using process.env.
 * Returns the original token unchanged if the env var is not set.
 */
export function expandEnvVars(value: string): string {
  return value.replace(ENV_VAR_RE, (match, braced, bare) => {
    const name = braced ?? bare
    return process.env[name] ?? match
  })
}

/**
 * Extract the project ref from a Supabase Project URL or return the value as-is
 * if it's already a bare ref.
 *
 * Accepted formats:
 *   - https://abcdef123456.supabase.co
 *   - https://abcdef123456.supabase.co/
 *   - abcdef123456  (bare ref, returned unchanged)
 */
export function parseProjectRef(value: string): string {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    const match = url.hostname.match(/^([^.]+)\.supabase\.co$/)
    if (match) return match[1]
  } catch {
    // Not a URL — treat as bare ref
  }
  return trimmed
}

/**
 * Expand env var references in all sensitive environment fields (dbUrl, accessToken).
 * Also normalises projectRef from full URL to bare ref.
 */
function expandEnvironments(
  environments: Record<string, EnvironmentConfig>,
): Record<string, EnvironmentConfig> {
  const result: Record<string, EnvironmentConfig> = {}
  for (const [name, env] of Object.entries(environments)) {
    result[name] = {
      ...env,
      dbUrl: expandEnvVars(env.dbUrl),
      ...(env.accessToken ? { accessToken: expandEnvVars(env.accessToken) } : {}),
      ...(env.projectRef ? { projectRef: parseProjectRef(env.projectRef) } : {}),
    }
  }
  return result
}

export async function loadConfig(cwd = process.cwd()): Promise<SupaForgeConfig> {
  await loadEnvFiles(cwd)
  const configPath = resolve(cwd, CONFIG_FILENAME)
  const raw = await readFile(configPath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${errMsg(err)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILENAME} must hold a JSON object, with an "environments" object inside`)
  }
  return resolveConfig(parsed as SupaForgeConfig)
}

export function resolveConfig(config: SupaForgeConfig): SupaForgeConfig {
  return {
    ...config,
    // Missing, it is validateConfig's to report, not a crash here.
    environments: expandEnvironments(config.environments ?? {}),
    ignoreSchemas: config.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS,
  }
}

export function validateConfig(config: SupaForgeConfig): string[] {
  const errors: string[] = []

  if (!config.environments || typeof config.environments !== 'object') {
    errors.push('environments is required and must be an object')
    return errors
  }

  if (Object.keys(config.environments).length < 2) {
    errors.push('At least two environments are required')
  }

  if (!config.source) errors.push('"source" environment name is required')
  if (!config.target) errors.push('"target" environment name is required')

  if (config.source && !config.environments[config.source]) {
    errors.push(`Source environment "${config.source}" not found in environments`)
  }
  if (config.target && !config.environments[config.target]) {
    errors.push(`Target environment "${config.target}" not found in environments`)
  }

  if (config.source && config.target && config.source === config.target) {
    errors.push('Source and target must be different environments')
  }

  for (const [name, env] of Object.entries(config.environments)) {
    if (!env.dbUrl) errors.push(`Environment "${name}" is missing dbUrl`)
  }

  return errors
}

/**
 * Validate config for single-environment operations (snapshot, clone, backup, restore).
 * Only requires that the specified environment exists and has a dbUrl.
 */
export function validateSingleEnvConfig(config: SupaForgeConfig, envName: string): string[] {
  const errors: string[] = []

  if (!config.environments || typeof config.environments !== 'object') {
    errors.push('environments is required and must be an object')
    return errors
  }

  if (!config.environments[envName]) {
    errors.push(`Environment "${envName}" not found in environments`)
    return errors
  }

  if (!config.environments[envName].dbUrl) {
    errors.push(`Environment "${envName}" is missing dbUrl`)
  }

  return errors
}
