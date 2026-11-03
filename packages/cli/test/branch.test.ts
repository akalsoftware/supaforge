import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  branchDbName,
  replaceDbName,
  loadManifest,
  reconcileClones,
  isCloneDatabase,
  BRANCH_DB_PREFIX,
  type BranchesManifest,
} from '../src/branch.js'

describe('branchDbName', () => {
  it('converts name to safe DB identifier', () => {
    expect(branchDbName('feature-x')).toBe(`${BRANCH_DB_PREFIX}feature_x`)
  })

  it('lowercases the name', () => {
    expect(branchDbName('FEATURE-X')).toBe(`${BRANCH_DB_PREFIX}feature_x`)
  })

  it('collapses multiple underscores', () => {
    expect(branchDbName('my--long---name')).toBe(`${BRANCH_DB_PREFIX}my_long_name`)
  })

  it('strips leading/trailing underscores from safe name', () => {
    expect(branchDbName('-feature-')).toBe(`${BRANCH_DB_PREFIX}feature`)
  })

  it('throws for empty branch name', () => {
    expect(() => branchDbName('')).toThrow('Invalid branch name')
  })

  it('throws for name with only special characters', () => {
    expect(() => branchDbName('---')).toThrow('Invalid branch name')
  })

  it('handles numeric names', () => {
    expect(branchDbName('123')).toBe(`${BRANCH_DB_PREFIX}123`)
  })
})

describe('replaceDbName', () => {
  it('replaces the database name in a PostgreSQL URL', () => {
    const result = replaceDbName('postgresql://user:pass@host:5432/mydb', 'newdb')
    expect(result).toContain('/newdb')
    expect(result).not.toContain('/mydb')
  })

  it('preserves authentication and host', () => {
    const result = replaceDbName('postgresql://user:pass@host:5432/mydb', 'newdb')
    expect(result).toContain('user:pass@host:5432')
  })

  it('handles URLs with query parameters', () => {
    const result = replaceDbName('postgresql://user:pass@host:5432/mydb?sslmode=require', 'newdb')
    expect(result).toContain('/newdb')
    expect(result).toContain('sslmode=require')
  })
})

describe('loadManifest', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty manifest when no file exists', async () => {
    const manifest = await loadManifest(tempDir)
    expect(manifest).toEqual({ branches: [] })
  })

  it('loads existing manifest file', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(tempDir, '.supaforge')
    await mkdir(dir, { recursive: true })

    const data: BranchesManifest = {
      branches: [
        {
          name: 'feature-x',
          dbName: `${BRANCH_DB_PREFIX}feature_x`,
          dbUrl: 'postgresql://user:pass@host:5432/supaforge_branch_feature_x',
          createdFrom: 'production',
          createdAt: '2025-01-01T00:00:00.000Z',
          schemaOnly: false,
        },
      ],
    }

    await writeFile(join(dir, 'branches.json'), JSON.stringify(data))
    const manifest = await loadManifest(tempDir)
    expect(manifest.branches).toHaveLength(1)
    expect(manifest.branches[0].name).toBe('feature-x')
  })
})

describe('reconcileClones', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns the manifest unchanged when no server URL is provided', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(tempDir, '.supaforge')
    await mkdir(dir, { recursive: true })
    const data: BranchesManifest = {
      branches: [{
        name: 'my-local',
        dbName: 'supaforge_local',
        dbUrl: 'postgres://postgres:postgres@localhost:5432/supaforge_local',
        createdFrom: 'production',
        createdAt: '2025-01-01T00:00:00.000Z',
        schemaOnly: false,
      }],
    }
    await writeFile(join(dir, 'branches.json'), JSON.stringify(data))

    const clones = await reconcileClones({ cwd: tempDir })
    expect(clones).toHaveLength(1)
    expect(clones[0].name).toBe('my-local')
    expect(clones[0].missing).toBeUndefined()
    expect(clones[0].discovered).toBeUndefined()
  })

  it('falls back to the manifest when the server is unreachable', async () => {
    const clones = await reconcileClones({
      // Unroutable port → connection fails fast → manifest fallback (empty here)
      localServerUrl: 'postgres://postgres:postgres@127.0.0.1:1/postgres',
      configuredLocalDb: 'supaforge_local',
      cwd: tempDir,
    })
    expect(clones).toEqual([])
  })
})

/**
 * Issue #48 (4): the closing tip recommends `--apply` generically, and in the
 * clone → remote direction that is advice to reshape a shared remote to match a
 * vanilla-PostgreSQL copy. Recognising the clone is what lets the tip say so.
 */
describe('isCloneDatabase', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function writeManifest(dbName: string): Promise<void> {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const dir = join(tempDir, '.supaforge')
    await mkdir(dir, { recursive: true })
    const data: BranchesManifest = {
      branches: [
        {
          name: dbName,
          dbName,
          dbUrl: `postgresql://postgres@localhost:5432/${dbName}`,
          createdFrom: 'production',
          createdAt: '2025-01-01T00:00:00.000Z',
          schemaOnly: false,
        },
      ],
    }
    await writeFile(join(dir, 'branches.json'), JSON.stringify(data))
  }

  it('recognises a database recorded in the clone manifest', async () => {
    await writeManifest('supaforge_local')
    expect(await isCloneDatabase('postgresql://postgres@localhost:5432/supaforge_local', tempDir)).toBe(true)
  })

  it('recognises a branch database even with no manifest entry', async () => {
    const url = `postgresql://postgres@localhost:5432/${BRANCH_DB_PREFIX}feature_x`
    expect(await isCloneDatabase(url, tempDir)).toBe(true)
  })

  it('says no for a database the manifest has never heard of', async () => {
    await writeManifest('supaforge_local')
    expect(await isCloneDatabase('postgresql://postgres@db.example.com:5432/postgres', tempDir)).toBe(false)
  })

  it('says no rather than throwing for a missing or unparseable url', async () => {
    expect(await isCloneDatabase(undefined, tempDir)).toBe(false)
    expect(await isCloneDatabase('not-a-url', tempDir)).toBe(false)
    expect(await isCloneDatabase('postgresql://postgres@localhost:5432/', tempDir)).toBe(false)
  })
})

describe('clone target from --local-url', () => {
  it('clones into the database the URL names when --local-db is not given', async () => {
    const { cloneTargetName } = await import('../src/branch.js')
    expect(cloneTargetName('postgres://u:p@h:5432/mydb')).toBe('mydb')
    expect(cloneTargetName('postgres://u:p@h:5432/postgres')).toBe('supaforge_local')
    expect(cloneTargetName('postgres://u:p@h:5432')).toBe('supaforge_local')
    expect(cloneTargetName('postgres://u:p@h:5432/mydb', 'other')).toBe('other')
  })

  it('creates and drops a database from postgres, never from inside it', async () => {
    const { maintenanceUrl } = await import('../src/branch.js')
    expect(maintenanceUrl('postgres://u:p@h:5432/mydb', 'mydb')).toBe('postgres://u:p@h:5432/postgres')
    expect(maintenanceUrl('postgres://u:p@h:5432/admin', 'mydb')).toBe('postgres://u:p@h:5432/admin')
  })
})
