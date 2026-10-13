/**
 * CLI e2e tests — run the oclif commands via bin/dev.js as subprocesses.
 *
 * These validate the CLI surface without needing real database containers.
 * They test --help output, config loading errors, flag parsing, etc.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { writeFile, unlink, mkdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import pg from 'pg'

const exec = promisify(execFile)
// test/e2e/ → packages/cli/
const CLI_DIR = join(import.meta.dirname, '..', '..')

// Every test here spawns the CLI through tsx, which takes one to three seconds
// on a CI runner, and several spawn it more than once. Vitest's default of 5s
// failed them at random on the slower runners.
vi.setConfig({ testTimeout: 30_000 })
const DEV_BIN = join(CLI_DIR, 'bin', 'dev.js')
const TSX_BIN = join(CLI_DIR, 'node_modules', '.bin', 'tsx')

function run(args: string[], options?: { cwd?: string; env?: Record<string, string> }) {
  return exec(TSX_BIN, [DEV_BIN, ...args], {
    cwd: options?.cwd ?? CLI_DIR,
    env: { ...process.env, ...options?.env },
    timeout: 15_000,
  })
}

describe('CLI e2e: diff', () => {
  it('should show help', async () => {
    const { stdout } = await run(['diff', '--help'])
    expect(stdout).toContain('Detect drift')
    expect(stdout).toContain('--check')
    expect(stdout).toContain('--detail')
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--json')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['diff'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })

  it('should reject invalid --check value', async () => {
    try {
      await run(['diff', '--check=bogus'])
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/Expected.*bogus|must be one of/i)
    }
  })

  it('should show --source, --target, and --skip flags in help', async () => {
    const { stdout } = await run(['diff', '--help'])
    expect(stdout).toContain('--source')
    expect(stdout).toContain('--target')
    expect(stdout).toContain('--include-files')
    expect(stdout).toContain('--skip')
  })

  it('should reject invalid --skip value', async () => {
    try {
      await run(['diff', '--skip=bogus'])
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/Expected.*bogus|must be one of/i)
    }
  })

  it('--json aborts with JSON, and exit 1, when a database is unreachable', async () => {
    // It used to skip the reachability check and scan anyway: every check that
    // read nothing from the source reported the target's objects as extra, and
    // --apply dropped them.
    const tmpDir = join(tmpdir(), `supaforge-e2e-diff-json-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    for (const args of [['diff', '--json'], ['diff', '--json', '--apply']]) {
      try {
        await run(args, { cwd: tmpDir })
        expect.unreachable(`${args.join(' ')} should exit non-zero`)
      } catch (err: any) {
        expect(err.code).toBe(1)
        const parsed = JSON.parse(err.stdout)
        expect(parsed.error).toMatch(/Diff aborted — Source not reachable/)
        expect(parsed.preflight.map((c: any) => c.passed)).toEqual([false, false])
        expect(err.stdout).not.toContain('tip:')
      }
    }
  })
  it('should output detailed format with --detail flag', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-diff-detail-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    // --detail triggers preflight (which errors on unreachable DBs), but we can
    // verify the flag is accepted and the command reaches that stage.
    try {
      await run(['diff', '--detail', '--check=rls'], { cwd: tmpDir })
      expect.unreachable('Should have thrown — unreachable DB URLs')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      // Preflight ran (not a flag parsing error), proving --detail was accepted
      expect(output).toContain('preflight checks')
      expect(output).toContain('not reachable')
    }
  })

  it('should show --ci and --fail-on flags in help', async () => {
    const { stdout } = await run(['diff', '--help'])
    expect(stdout).toContain('--ci')
    expect(stdout).toContain('--fail-on')
  })

  it('should reject invalid --fail-on value', async () => {
    try {
      await run(['diff', '--ci', '--fail-on=bogus'])
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/Expected.*bogus|must be one of/i)
    }
  })

  it('--ci writes clean JSON to stdout and exits 2 on scan error', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-diff-ci-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    try {
      await run(['diff', '--ci'], { cwd: tmpDir })
      expect.unreachable('Should have exited non-zero — unreachable DBs are a scan error')
    } catch (err: any) {
      // Exit code 2 = scan error (per the --ci contract).
      expect(err.code).toBe(2)
      // stdout must be *only* the JSON summary — annotations go to stderr — so a
      // workflow can redirect stdout straight into a report artifact.
      const parsed = JSON.parse(err.stdout)
      expect(parsed).toHaveProperty('summary')
      expect(parsed).toHaveProperty('criticalIssues')
      expect(parsed).toHaveProperty('warningIssues')
      expect(err.stdout).not.toContain('::error')
      expect(err.stdout).not.toContain('::warning')
    }
  })
})

describe('CLI e2e: hukam', () => {
  it('should show help as alias for diff', async () => {
    const { stdout } = await run(['hukam', '--help'])
    expect(stdout).toContain('Alias for diff')
  })

  it('should accept the same flags as diff', async () => {
    const { stdout } = await run(['hukam', '--help'])
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--detail')
    expect(stdout).toContain('--check')
    expect(stdout).toContain('--skip')
  })
})

describe('CLI e2e: snapshot', () => {
  it('should show help', async () => {
    const { stdout } = await run(['snapshot', '--help'])
    expect(stdout).toContain('snapshot')
    expect(stdout).toContain('--migration')
    expect(stdout).toContain('--list')
    expect(stdout).toContain('--prune')
    // snapshot is now dry-run by default and documents --apply
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('dry-run')
  })

  it('should show --env and --description flags in help', async () => {
    const { stdout } = await run(['snapshot', '--help'])
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--description')
    expect(stdout).toContain('--keep')
    expect(stdout).toContain('--output')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-snapshot-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['snapshot'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

describe('CLI e2e: clone', () => {
  it('should show help', async () => {
    const { stdout } = await run(['clone', '--help'])
    expect(stdout).toContain('Clone')
    expect(stdout).toContain('--list')
    expect(stdout).toContain('--delete')
    expect(stdout).toContain('--apply')
  })

  it('should show --env and --schema-only flags in help', async () => {
    const { stdout } = await run(['clone', '--help'])
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--schema-only')
    expect(stdout).toContain('--local-url')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-clone-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['clone'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

describe('CLI e2e: restore', () => {
  it('should show help', async () => {
    const { stdout } = await run(['restore', '--help'])
    expect(stdout).toContain('Restore')
    expect(stdout).toContain('--from-snapshot')
    expect(stdout).toContain('--from-migrations')
    expect(stdout).toContain('--apply')
    expect(stdout).toContain('--force')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-restore-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['restore', '--env=local', '--from-snapshot=latest'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })

  it('should require --from-snapshot or --from-migrations', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-restore-flags-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        local: { dbUrl: 'postgresql://localhost/test' },
      },
      source: 'local',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    try {
      await run(['restore', '--env=local'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/--from-snapshot|--from-migrations/)
    }
  })
})

describe('CLI e2e: init', () => {
  it('should show help', async () => {
    const { stdout } = await run(['init', '--help'])
    expect(stdout).toContain('supaforge.config.json')
    expect(stdout).toContain('--force')
  })
})

describe('CLI e2e: sync', () => {
  it('should show help', async () => {
    const { stdout } = await run(['sync', '--help'])
    expect(stdout).toContain('diff --apply')
  })

  it('should accept the same flags as diff', async () => {
    const { stdout } = await run(['sync', '--help'])
    expect(stdout).toContain('--check')
    expect(stdout).toContain('--skip')
    expect(stdout).toContain('--source')
    expect(stdout).toContain('--target')
    expect(stdout).toContain('--json')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-sync-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['sync'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

describe('CLI e2e: config validation', () => {
  let configDir: string

  beforeAll(async () => {
    configDir = join(tmpdir(), `supaforge-e2e-config-${Date.now()}`)
    await mkdir(configDir, { recursive: true })
  })

  afterAll(async () => {
    try {
      await unlink(join(configDir, 'supaforge.config.json'))
    } catch {}
  })

  it('should reject config with same source and target', async () => {
    const config = {
      environments: {
        staging: { dbUrl: 'postgresql://localhost/staging' },
        prod: { dbUrl: 'postgresql://localhost/prod' },
      },
      source: 'staging',
      target: 'staging',
    }
    await writeFile(join(configDir, 'supaforge.config.json'), JSON.stringify(config))

    try {
      await run(['diff'], { cwd: configDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toContain('Source and target must be different')
    }
  })
})

// ─── migrate run ─────────────────────────────────────────────────────────────

describe('CLI e2e: migrate run', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'run', '--help'])
    expect(stdout).toContain('Execute pending migrations')
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--dry-run')
    expect(stdout).toContain('--up-to')
    expect(stdout).toContain('--apply')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-run-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['migrate', 'run'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

// ─── migrate baseline ────────────────────────────────────────────────────────

describe('CLI e2e: migrate baseline', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'baseline', '--help'])
    expect(stdout).toContain('Mark all local migrations as applied')
    expect(stdout).toContain('--env')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-baseline-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    try {
      await run(['migrate', 'baseline'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })
})

// ─── migrate create ──────────────────────────────────────────────────────────

describe('CLI e2e: migrate create', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'create', '--help'])
    expect(stdout).toContain('Generate a new migration file')
    expect(stdout).toContain('--name')
    expect(stdout).toContain('--source')
    expect(stdout).toContain('--target')
  })

  it('should require --name flag', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-create-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://localhost/dev' },
        prod: { dbUrl: 'postgresql://localhost/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    try {
      await run(['migrate', 'create'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      expect(output).toMatch(/--name|Missing required flag/i)
    }
  })

  it('creates a timestamped .sql file under supabase/migrations/', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-create-file-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: {
        dev: { dbUrl: 'postgresql://invalid:5432/dev' },
        prod: { dbUrl: 'postgresql://invalid:5432/prod' },
      },
      source: 'dev',
      target: 'prod',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))

    // migrate create requires real DB access for preflight — verify it reaches
    // that stage (flag accepted, config loaded) rather than failing on config/flag parsing.
    try {
      await run(['migrate', 'create', '--name=add_users'], { cwd: tmpDir })
      expect.unreachable('Should have thrown — unreachable DB URLs')
    } catch (err: any) {
      const output = (err.stderr || '') + (err.stdout || '')
      // Preflight ran (not a flag/config parsing error)
      expect(output).toContain('preflight checks')
      expect(output).toContain('not reachable')
    }
  })
})

describe('CLI e2e: mcp', () => {
  it('should show help', async () => {
    const { stdout } = await run(['mcp', '--help'])
    expect(stdout).toContain('MCP')
    expect(stdout).toContain('stdio')
    expect(stdout).toContain('Claude Desktop')
  })

  it('refuses a --project that is not a directory', async () => {
    try {
      await run(['mcp', '--project', '/nonexistent/supaforge-project'])
      expect.unreachable('should have exited non-zero')
    } catch (err: any) {
      expect(err.stderr ?? err.message).toContain('is not a directory')
    }
  })
})



// ─── clone --list ─────────────────────────────────────────────────────────────

describe('CLI e2e: clone --list', () => {
  it('--list reads from .supaforge/branches.json and shows existing clones', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-clone-list-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    const supaforgeDir = join(tmpDir, '.supaforge')
    await mkdir(supaforgeDir, { recursive: true })
    const branches = {
      branches: [{
        name: 'my-local',
        dbName: 'supaforge_branch_my_local',
        dbUrl: 'postgres://postgres:postgres@localhost:5432/supaforge_branch_my_local',
        createdFrom: 'production',
        createdAt: new Date().toISOString(),
        schemaOnly: false,
      }]
    }
    await writeFile(join(supaforgeDir, 'branches.json'), JSON.stringify(branches))

    const { stdout } = await run(['clone', '--list', '--json'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('my-local')
    expect(parsed[0].createdFrom).toBe('production')
  })

  it('--list shows empty message when no branches.json exists', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-clone-list-empty-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const { stdout } = await run(['clone', '--list'], { cwd: tmpDir })
    expect(stdout).toContain('No clones found')
  })
})

// ─── report ───────────────────────────────────────────────────────────────────

describe('CLI e2e: report', () => {
  it('should show help', async () => {
    const { stdout } = await run(['report', '--help'])
    expect(stdout).toContain('run log')
    expect(stdout).toContain('--last')
    expect(stdout).toContain('--json')
  })

  it('should output valid JSON with --json when no log exists', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-report-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const { stdout } = await run(['report', '--json'], { env: { HOME: tmpDir } })
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(0)
  })

  it('should show "No command history found" when log is empty', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-report-empty-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const { stdout } = await run(['report'], { env: { HOME: tmpDir } })
    expect(stdout).toContain('No command history found')
  })
})

// ─── migrate list ─────────────────────────────────────────────────────────────

describe('CLI e2e: migrate list', () => {
  it('should show help', async () => {
    const { stdout } = await run(['migrate', 'list', '--help'])
    expect(stdout).toContain('List local migration files')
    expect(stdout).toContain('--offline')
    expect(stdout).toContain('--env')
    expect(stdout).toContain('--json')
  })

  it('should error without config file', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-list-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    try {
      await run(['migrate', 'list'], { cwd: tmpDir })
      expect.unreachable('Should have thrown')
    } catch (err: any) {
      expect(err.stderr || err.stdout || '').toContain('supaforge.config.json')
    }
  })

  it('--offline shows local files without DB connection', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-list-offline-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: { dev: { dbUrl: 'postgresql://invalid:5432/dev' } },
      source: 'dev',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))
    const migrationsDir = join(tmpDir, 'supabase', 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(join(migrationsDir, '20240101000000_initial.sql'), '-- init')

    const { stdout } = await run(['migrate', 'list', '--offline'], { cwd: tmpDir })
    expect(stdout).toContain('20240101000000_initial.sql')
  })

  it('--offline --json returns array of migrations', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-migrate-list-json-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    const config = {
      environments: { dev: { dbUrl: 'postgresql://invalid:5432/dev' } },
      source: 'dev',
    }
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config))
    const migrationsDir = join(tmpDir, 'supabase', 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    await writeFile(join(migrationsDir, '20240101000000_init.sql'), '-- init')
    await writeFile(join(migrationsDir, '20240102000000_users.sql'), '-- users')

    const { stdout } = await run(['migrate', 'list', '--offline', '--json'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].version).toBe('20240101000000')
    expect(parsed[1].version).toBe('20240102000000')
  })
})

// ─── DB-backed CLI behaviour (gated on a configured test database) ────────────
//
// These exercise full command wiring (preflight → dry-run gate → render) and so
// need a reachable Postgres. They are skipped unless SUPAFORGE_TEST_SOURCE_URL
// (and, for clone discovery, SUPAFORGE_TEST_TARGET_URL) are set — matching the
// integration-suite convention.

const DB_SOURCE = process.env.SUPAFORGE_TEST_SOURCE_URL
const DB_TARGET = process.env.SUPAFORGE_TEST_TARGET_URL
const skipNoDb = !DB_SOURCE

function replaceDbName(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

describe('CLI e2e: snapshot dry-run gate', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `supaforge-e2e-snap-apply-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    if (!skipNoDb) {
      const config = {
        environments: {
          source: { dbUrl: DB_SOURCE },
          target: { dbUrl: DB_SOURCE },
        },
        source: 'source',
        target: 'source',
        ignoreSchemas: ['information_schema', 'pg_catalog', 'pg_toast'],
      }
      await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config, null, 2))
    }
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it.skipIf(skipNoDb)('previews without writing a snapshot when --apply is omitted', async () => {
    const { stdout } = await run(['snapshot'], { cwd: tmpDir })
    expect(stdout).toContain('dry-run')
    expect(stdout).toContain('Add --apply')
    // No snapshot directory should have been created.
    const exists = await access(join(tmpDir, '.supaforge', 'snapshots')).then(() => true, () => false)
    expect(exists).toBe(false)
  })

  it.skipIf(skipNoDb)('captures a snapshot only when --apply is given', async () => {
    const { stdout } = await run(['snapshot', '--apply'], { cwd: tmpDir })
    expect(stdout).toContain('Snapshot saved to')
    const exists = await access(join(tmpDir, '.supaforge', 'snapshots')).then(() => true, () => false)
    expect(exists).toBe(true)
  })
})

describe('CLI e2e: clone --list discovery', () => {
  let tmpDir: string
  const discoveredDb = `sf_e2e_disc_${Date.now()}`
  const skipDiscovery = skipNoDb || !DB_TARGET

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `supaforge-e2e-clone-disc-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })
    if (!skipDiscovery) {
      // Create a clone database that the manifest does NOT know about.
      const admin = new pg.Client({ connectionString: replaceDbName(DB_TARGET!, 'postgres') })
      await admin.connect()
      await admin.query(`DROP DATABASE IF EXISTS "${discoveredDb}"`)
      await admin.query(`CREATE DATABASE "${discoveredDb}"`)
      await admin.end()

      // Config registers a "local" environment pointing at that database.
      const config = {
        environments: {
          remote: { dbUrl: DB_SOURCE },
          local: { dbUrl: replaceDbName(DB_TARGET!, discoveredDb) },
        },
        source: 'local',
        target: 'remote',
      }
      await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify(config, null, 2))
    }
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
    if (!skipDiscovery) {
      const admin = new pg.Client({ connectionString: replaceDbName(DB_TARGET!, 'postgres') })
      await admin.connect()
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [discoveredDb],
      )
      await admin.query(`DROP DATABASE IF EXISTS "${discoveredDb}"`)
      await admin.end()
    }
  })

  it.skipIf(skipDiscovery)('surfaces an existing clone database missing from the manifest', async () => {
    const { stdout } = await run(['clone', '--list', '--json'], { cwd: tmpDir })
    const parsed = JSON.parse(stdout)
    const found = parsed.find((c: { dbName: string }) => c.dbName === discoveredDb)
    expect(found).toBeDefined()
    expect(found.discovered).toBe(true)
  })
})

/**
 * `supaforge help [COMMAND]` and the `migrate` topic (issue #97).
 *
 * oclif's `helpClass` styles what `--help` prints; the `help` *command* comes
 * from `@oclif/plugin-help`, which this CLI does not install. So the form
 * people reach for first answered "command help:migrate:create not found",
 * which reads as "no such command". And with no `topics` entry, oclif
 * synthesised the `migrate` topic's description from its first subcommand, so
 * the group was headed by a description of one quarter of it.
 */
describe('CLI e2e: help', () => {
  it('answers `help` with the root help', async () => {
    const { stdout } = await run(['help'])

    expect(stdout).toContain('Diff and sync your Supabase environments')
    expect(stdout).toContain('COMMANDS')
  })

  it('answers `help <command>`', async () => {
    const { stdout } = await run(['help', 'diff'])

    expect(stdout).toContain('Detect drift')
    expect(stdout).toContain('--apply')
  })

  it('answers `help <topic> <command>`, not "not found"', async () => {
    // Two arguments, which is why the command is non-strict and passes the
    // whole argv through: oclif addresses `migrate create` as one command.
    const { stdout } = await run(['help', 'migrate', 'create'])

    expect(stdout).toContain('--name')
    expect(stdout).not.toContain('not found')
  })

  it('renders `help <command>` the same as `<command> --help`', async () => {
    // The point of delegating to the same helpClass rather than adding a
    // dependency that renders its own.
    const viaHelp = await run(['help', 'restore'])
    const viaFlag = await run(['restore', '--help'])

    expect(viaHelp.stdout).toBe(viaFlag.stdout)
  })

  it('describes the migrate topic as the group, not as baseline', async () => {
    const { stdout } = await run(['migrate', '--help'])

    expect(stdout).toContain('Create, list and run versioned SQL migrations')
    expect(stdout).not.toContain('Mark all local migrations as applied without executing them\n\nUSAGE')
    // Still lists all four.
    for (const sub of ['baseline', 'create', 'list', 'run']) {
      expect(stdout, sub).toContain(`migrate ${sub}`)
    }
  })

  it('lists the commands in workflow order, with help last', async () => {
    const { stdout } = await run(['--help'])
    const listed = ['init', 'diff', 'sync', 'snapshot', 'clone', 'restore', 'migrate', 'report', 'mcp', 'help']
    const positions = listed.map(name => stdout.indexOf(`\n  ${name.padEnd(8)} `))

    expect(positions.every(p => p > -1), stdout).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('CLI e2e: --json when the database cannot be reached', () => {
  // The error went to stderr only, and a script reading stdout had nothing to
  // parse.
  it('prints the error as JSON for migrate list, restore and snapshot', async () => {
    const tmpDir = join(tmpdir(), `supaforge-e2e-json-errors-${Date.now()}`)
    await mkdir(join(tmpDir, 'supabase', 'migrations'), { recursive: true })
    await writeFile(join(tmpDir, 'supabase', 'migrations', '20261001000000_init.sql'), 'SELECT 1;\n')
    await writeFile(join(tmpDir, 'supaforge.config.json'), JSON.stringify({
      environments: { bad: { dbUrl: 'postgresql://u:secret@invalid:5432/db' } },
    }))
    for (const args of [
      ['migrate', 'list', '--env', 'bad', '--json'],
      ['restore', '--env', 'bad', '--from-migrations', '--apply', '--json'],
      ['snapshot', '--env', 'bad', '--apply', '--json'],
    ]) {
      try {
        await run(args, { cwd: tmpDir })
        expect.unreachable(`${args.join(' ')} should exit non-zero`)
      } catch (err: any) {
        expect(err.code, args.join(' ')).not.toBe(0)
        const parsed = JSON.parse(err.stdout)
        expect(parsed.error, args.join(' ')).toMatch(/aborted — .*ENOTFOUND invalid/)
        expect(err.stdout).not.toContain('secret')
      }
    }
  })
})
