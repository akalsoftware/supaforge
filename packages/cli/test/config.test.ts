import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig, resolveConfig, validateConfig, expandEnvVars, parseProjectRef } from '../src/config.js'
import { loadEnvFiles } from '../src/env-loader.js'
import { DEFAULT_IGNORE_SCHEMAS } from '../src/defaults.js'
import type { SupaForgeConfig } from '../src/types/config.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const validConfig: SupaForgeConfig = {
  environments: {
    dev: { dbUrl: 'postgres://localhost:5432/dev' },
    prod: { dbUrl: 'postgres://localhost:5432/prod' },
  },
  source: 'dev',
  target: 'prod',
}

describe('resolveConfig', () => {
  it('adds default ignore schemas when none specified', () => {
    const resolved = resolveConfig(validConfig)
    expect(resolved.ignoreSchemas).toEqual(DEFAULT_IGNORE_SCHEMAS)
  })

  it('preserves custom ignore schemas', () => {
    const custom = { ...validConfig, ignoreSchemas: ['custom'] }
    const resolved = resolveConfig(custom)
    expect(resolved.ignoreSchemas).toEqual(['custom'])
  })
})

describe('validateConfig', () => {
  it('returns no errors for valid config', () => {
    expect(validateConfig(validConfig)).toEqual([])
  })

  it('requires at least two environments', () => {
    const errors = validateConfig({
      ...validConfig,
      environments: { dev: { dbUrl: 'postgres://localhost/dev' } },
    })
    expect(errors).toContain('At least two environments are required')
  })

  it('requires source', () => {
    const errors = validateConfig({ ...validConfig, source: '' })
    expect(errors.some(e => e.includes('source'))).toBe(true)
  })

  it('requires target', () => {
    const errors = validateConfig({ ...validConfig, target: '' })
    expect(errors.some(e => e.includes('target'))).toBe(true)
  })

  it('validates source exists in environments', () => {
    const errors = validateConfig({ ...validConfig, source: 'staging' })
    expect(errors.some(e => e.includes('staging'))).toBe(true)
  })

  it('validates target exists in environments', () => {
    const errors = validateConfig({ ...validConfig, target: 'staging' })
    expect(errors.some(e => e.includes('staging'))).toBe(true)
  })

  it('rejects same source and target', () => {
    const errors = validateConfig({ ...validConfig, target: 'dev' })
    expect(errors.some(e => e.includes('different'))).toBe(true)
  })

  it('requires dbUrl for each environment', () => {
    const config: SupaForgeConfig = {
      ...validConfig,
      environments: {
        dev: { dbUrl: '' },
        prod: { dbUrl: 'postgres://localhost/prod' },
      },
    }
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('dbUrl'))).toBe(true)
  })

  it('rejects missing environments object', () => {
    const config = { source: 'dev', target: 'prod' } as SupaForgeConfig
    const errors = validateConfig(config)
    expect(errors.some(e => e.includes('environments'))).toBe(true)
  })
})

describe('expandEnvVars', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.TEST_DB_URL = process.env.TEST_DB_URL
    saved.TEST_API_KEY = process.env.TEST_API_KEY
    process.env.TEST_DB_URL = 'postgres://user:secret@host:5432/db'
    process.env.TEST_API_KEY = 'my-service-role-key'
  })

  afterEach(() => {
    if (saved.TEST_DB_URL === undefined) delete process.env.TEST_DB_URL
    else process.env.TEST_DB_URL = saved.TEST_DB_URL
    if (saved.TEST_API_KEY === undefined) delete process.env.TEST_API_KEY
    else process.env.TEST_API_KEY = saved.TEST_API_KEY
  })

  it('expands $VAR syntax', () => {
    expect(expandEnvVars('$TEST_DB_URL')).toBe('postgres://user:secret@host:5432/db')
  })

  it('expands ${VAR} syntax', () => {
    expect(expandEnvVars('${TEST_DB_URL}')).toBe('postgres://user:secret@host:5432/db')
  })

  it('leaves unknown vars unchanged', () => {
    expect(expandEnvVars('$NONEXISTENT_VAR_12345')).toBe('$NONEXISTENT_VAR_12345')
  })

  it('expands vars embedded in a string', () => {
    expect(expandEnvVars('prefix_${TEST_API_KEY}_suffix')).toBe('prefix_my-service-role-key_suffix')
  })

  it('returns plain strings unchanged', () => {
    expect(expandEnvVars('postgres://localhost:5432/db')).toBe('postgres://localhost:5432/db')
  })
})

describe('resolveConfig with env vars', () => {
  beforeEach(() => {
    process.env.DEV_DATABASE_URL = 'postgres://localhost:5432/dev'
    process.env.PROD_DATABASE_URL = 'postgres://localhost:5432/prod'
    process.env.PROD_ACCESS_TOKEN = 'secret-token'
  })

  afterEach(() => {
    delete process.env.DEV_DATABASE_URL
    delete process.env.PROD_DATABASE_URL
    delete process.env.PROD_ACCESS_TOKEN
  })

  it('expands env vars in dbUrl and accessToken during resolve', () => {
    const config: SupaForgeConfig = {
      environments: {
        dev: { dbUrl: '$DEV_DATABASE_URL' },
        prod: { dbUrl: '$PROD_DATABASE_URL', accessToken: '$PROD_ACCESS_TOKEN' },
      },
      source: 'dev',
      target: 'prod',
    }

    const resolved = resolveConfig(config)

    expect(resolved.environments.dev.dbUrl).toBe('postgres://localhost:5432/dev')
    expect(resolved.environments.prod.dbUrl).toBe('postgres://localhost:5432/prod')
    expect(resolved.environments.prod.accessToken).toBe('secret-token')
  })
})

describe('parseProjectRef', () => {
  it('extracts ref from full Project URL', () => {
    expect(parseProjectRef('https://zfjldiglmcwojzdtxbky.supabase.co')).toBe('zfjldiglmcwojzdtxbky')
  })

  it('extracts ref from Project URL with trailing slash', () => {
    expect(parseProjectRef('https://abcdef123456.supabase.co/')).toBe('abcdef123456')
  })

  it('returns bare ref unchanged', () => {
    expect(parseProjectRef('abcdef123456')).toBe('abcdef123456')
  })

  it('trims whitespace', () => {
    expect(parseProjectRef('  abcdef123456  ')).toBe('abcdef123456')
  })

  it('handles non-supabase URLs by returning full hostname', () => {
    // Not a supabase.co URL — returns trimmed input as-is
    expect(parseProjectRef('https://example.com')).toBe('https://example.com')
  })
})

describe('resolveConfig normalises projectRef', () => {
  it('extracts ref from full Project URL in config', () => {
    const config: SupaForgeConfig = {
      environments: {
        dev: { dbUrl: 'postgres://localhost/dev', projectRef: 'https://abc123.supabase.co' },
        prod: { dbUrl: 'postgres://localhost/prod', projectRef: 'xyz789' },
      },
      source: 'dev',
      target: 'prod',
    }

    const resolved = resolveConfig(config)

    expect(resolved.environments.dev.projectRef).toBe('abc123')
    expect(resolved.environments.prod.projectRef).toBe('xyz789')
  })
})

describe('loadEnvFiles', () => {
  let tempDir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-env-'))
    saved.LOAD_ENV_TEST_A = process.env.LOAD_ENV_TEST_A
    saved.LOAD_ENV_TEST_B = process.env.LOAD_ENV_TEST_B
    saved.LOAD_ENV_TEST_EXISTING = process.env.LOAD_ENV_TEST_EXISTING
    saved.NODE_ENV = process.env.NODE_ENV
    delete process.env.LOAD_ENV_TEST_A
    delete process.env.LOAD_ENV_TEST_B
    delete process.env.LOAD_ENV_TEST_EXISTING
    delete process.env.NODE_ENV
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it('loads KEY=value pairs into process.env', async () => {
    await writeFile(join(tempDir, '.env'), 'LOAD_ENV_TEST_A=hello\nLOAD_ENV_TEST_B=world\n')
    const result = await loadEnvFiles(tempDir)
    expect(process.env.LOAD_ENV_TEST_A).toBe('hello')
    expect(process.env.LOAD_ENV_TEST_B).toBe('world')
    expect(result.loaded).toContain('.env')
    expect(result.injected).toBe(2)
  })

  it('strips surrounding quotes', async () => {
    await writeFile(join(tempDir, '.env'), 'LOAD_ENV_TEST_A="quoted"\nLOAD_ENV_TEST_B=\'single\'\n')
    await loadEnvFiles(tempDir)
    expect(process.env.LOAD_ENV_TEST_A).toBe('quoted')
    expect(process.env.LOAD_ENV_TEST_B).toBe('single')
  })

  it('does not overwrite existing env vars', async () => {
    process.env.LOAD_ENV_TEST_EXISTING = 'original'
    await writeFile(join(tempDir, '.env'), 'LOAD_ENV_TEST_EXISTING=overwritten\n')
    await loadEnvFiles(tempDir)
    expect(process.env.LOAD_ENV_TEST_EXISTING).toBe('original')
  })

  it('skips comments and blank lines', async () => {
    await writeFile(join(tempDir, '.env'), '# comment\n\nLOAD_ENV_TEST_A=ok\n')
    await loadEnvFiles(tempDir)
    expect(process.env.LOAD_ENV_TEST_A).toBe('ok')
  })

  it('returns empty result when no .env files exist', async () => {
    const result = await loadEnvFiles(tempDir)
    expect(result.loaded).toEqual([])
    expect(result.injected).toBe(0)
  })

  it('.env.local takes priority over .env', async () => {
    await writeFile(join(tempDir, '.env'), 'LOAD_ENV_TEST_A=base\n')
    await writeFile(join(tempDir, '.env.local'), 'LOAD_ENV_TEST_A=local\n')
    await loadEnvFiles(tempDir)
    expect(process.env.LOAD_ENV_TEST_A).toBe('local')
  })

  it('loads NODE_ENV-specific files when NODE_ENV is set', async () => {
    process.env.NODE_ENV = 'production'
    await writeFile(join(tempDir, '.env'), 'LOAD_ENV_TEST_A=base\n')
    await writeFile(join(tempDir, '.env.production'), 'LOAD_ENV_TEST_A=prod\n')
    await loadEnvFiles(tempDir)
    expect(process.env.LOAD_ENV_TEST_A).toBe('prod')
  })
})

describe('loadConfig: a config it cannot use says why', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'supaforge-cfg-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('names a syntax error', async () => {
    await writeFile(join(dir, 'supaforge.config.json'), '{ "environments": { , }')
    await expect(loadConfig(dir)).rejects.toThrow(/supaforge\.config\.json is not valid JSON/)
  })

  it('refuses something other than an object', async () => {
    await writeFile(join(dir, 'supaforge.config.json'), '[]')
    await expect(loadConfig(dir)).rejects.toThrow(/must hold a JSON object/)
  })

  it('leaves missing environments to validation rather than crashing', async () => {
    await writeFile(join(dir, 'supaforge.config.json'), '{}')
    const config = await loadConfig(dir)
    expect(validateConfig(config).length).toBeGreaterThan(0)
  })
})
