import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Both servers report this version; a test sets it to make one unreachable.
let serverVersion: string | Error = '17.6'
vi.mock('../src/db.js', async (original) => ({
  ...(await original<typeof import('../src/db.js')>()),
  newPgClient: () => ({
    connect: async () => { if (serverVersion instanceof Error) throw serverVersion },
    query: async () => ({ rows: [{ server_version: serverVersion }] }),
    end: async () => {},
  }),
}))

const { runDbDiff } = await import('../src/dbdiff.js')
const { dbdiffPgToolsEnv } = await import('../src/pg-tools.js')

async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}

/** A directory of client tools that report this major version. */
async function pgBin(major: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pgbin-'))
  await script(dir, 'pg_dump', `echo "pg_dump (PostgreSQL) ${major}.1"`)
  await script(dir, 'pg_restore', `echo "pg_restore (PostgreSQL) ${major}.1"`)
  return dir
}

const urls = ['postgres://a@localhost/src', 'postgres://a@localhost/tgt']
const saved = { ...process.env }

beforeEach(() => {
  serverVersion = '17.6'
  for (const k of ['SUPAFORGE_PG_BIN', 'DBDIFF_PG_DUMP', 'DBDIFF_PG_RESTORE', 'SUPAFORGE_DBDIFF_BIN']) delete process.env[k]
})
afterEach(() => { process.env = { ...saved } })

// DBDiff looked for pg_dump on PATH by itself. Where Debian's wrapper resolved
// an older client there than the one SupaForge was given, DBDiff declined it
// and used its own renderer, so a diff came out differently per machine.
describe('the pg_dump DBDiff renders tables with', () => {
  it('is the one SupaForge resolved', async () => {
    const dir = await pgBin(18)
    process.env.SUPAFORGE_PG_BIN = dir
    expect(await dbdiffPgToolsEnv(urls)).toEqual({
      DBDIFF_PG_DUMP: join(dir, 'pg_dump'),
      DBDIFF_PG_RESTORE: join(dir, 'pg_restore'),
    })
  })

  it('is left to the user when they named one', async () => {
    process.env.SUPAFORGE_PG_BIN = await pgBin(18)
    process.env.DBDIFF_PG_DUMP = '/opt/pg/bin/pg_dump'
    expect(await dbdiffPgToolsEnv(urls)).toEqual({})
  })

  it('is left to DBDiff when the servers cannot be asked', async () => {
    process.env.SUPAFORGE_PG_BIN = await pgBin(18)
    serverVersion = new Error('connection refused')
    expect(await dbdiffPgToolsEnv(urls)).toEqual({})
  })

  it('reaches the DBDiff process of a schema diff', async () => {
    const dir = await pgBin(18)
    process.env.SUPAFORGE_PG_BIN = dir
    const seen = join(await mkdtemp(join(tmpdir(), 'seen-')), 'env')
    // A stand-in DBDiff that records what it was given and writes an empty diff.
    process.env.SUPAFORGE_DBDIFF_BIN = await script(dir, 'dbdiff', [
      `echo "$DBDIFF_PG_DUMP" > ${seen}`,
      'for a in "$@"; do case $a in --output=*) : > "${a#--output=}";; esac; done',
    ].join('\n'))

    await runDbDiff({ sourceUrl: urls[0], targetUrl: urls[1], type: 'schema', include: 'both' })

    expect((await readFile(seen, 'utf8')).trim()).toBe(join(dir, 'pg_dump'))
  })
})
