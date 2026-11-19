/**
 * Passwords stay off child processes' command lines, and what SupaForge
 * writes about a database is readable by its own user only.
 *
 * A process's arguments are readable by every user on the machine; its
 * environment only by its own user. The pg tools are given the password as
 * PGPASSWORD. Each call site is exercised with a stand-in tool that records
 * what it was given.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, readFile, chmod, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pgToolConnection } from '../src/utils/pg-env.js'
import { runSql } from '../src/prove.js'
import { restorePrivileges } from '../src/clone-privileges.js'
import { appendRunLog } from '../src/run-log.js'
import { runDbDiff } from '../src/dbdiff.js'

const PASSWORD = 'Zq@x:9/k%2#Lm'
const URL_WITH = `postgresql://app:${encodeURIComponent(PASSWORD)}@db.example:5432/main?sslmode=require`

describe('pgToolConnection', () => {
  it('moves the password into PGPASSWORD, decoded, and keeps the rest of the URL', () => {
    const { url, env } = pgToolConnection(URL_WITH, {})
    expect(url).toBe('postgresql://app@db.example:5432/main?sslmode=require')
    expect(env.PGPASSWORD).toBe(PASSWORD)
  })

  it('takes a password given as a query parameter too', () => {
    const { url, env } = pgToolConnection('postgres://app@db.example/main?password=s3cret&sslmode=disable', {})
    expect(url).toBe('postgres://app@db.example/main?sslmode=disable')
    expect(env.PGPASSWORD).toBe('s3cret')
  })

  it('leaves the rest of the query string as written', () => {
    const { url } = pgToolConnection('postgresql://app:pw@db.example/main?options=-c%20search_path%3Dapp&sslmode=require', {})
    expect(url).toBe('postgresql://app@db.example/main?options=-c%20search_path%3Dapp&sslmode=require')
  })

  it('leaves a URL without a password, or not a URL, as it is', () => {
    const base = { PGPASSWORD: 'from-the-user' }
    expect(pgToolConnection('postgresql://app@db.example/main', base)).toEqual({ url: 'postgresql://app@db.example/main', env: base })
    expect(pgToolConnection('host=db.example dbname=main', base)).toEqual({ url: 'host=db.example dbname=main', env: base })
  })
})

describe('the pg tools SupaForge runs', () => {
  let dir: string
  const tool = async (name: string, body = '') => {
    const path = join(dir, name)
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/${name}.args"\nprintf '%s' "$PGPASSWORD" > "${dir}/${name}.pw"\n${body}\nexit 0\n`)
    await chmod(path, 0o755)
    return path
  }

  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'supaforge-argv-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('psql: the convergence proof\'s replay', async () => {
    await runSql(await tool('psql', 'cat > /dev/null'), URL_WITH, 'SELECT 1;')
    expect(await readFile(join(dir, 'psql.args'), 'utf8')).not.toContain(encodeURIComponent(PASSWORD))
    expect(await readFile(join(dir, 'psql.args'), 'utf8')).toContain('postgresql://app@db.example:5432/main')
    expect(await readFile(join(dir, 'psql.pw'), 'utf8')).toBe(PASSWORD)
  })

  it('pg_dump: the clone\'s privileges', async () => {
    const result = await restorePrivileges({
      pgDumpPath: await tool('pg_dump'),
      pgRestorePath: await tool('pg_restore'),
      remoteUrl: URL_WITH,
      localDbUrl: 'postgresql://app@127.0.0.1:1/unused',
    })
    expect(result.granted).toBe(0)
    expect(await readFile(join(dir, 'pg_dump.args'), 'utf8')).not.toContain(encodeURIComponent(PASSWORD))
    expect(await readFile(join(dir, 'pg_dump.pw'), 'utf8')).toBe(PASSWORD)
  })
})

describe('the run log', () => {
  let home: string
  const saved = process.env.HOME
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'supaforge-home-')); process.env.HOME = home })
  afterAll(async () => { process.env.HOME = saved; await rm(home, { recursive: true, force: true }) })

  it('is readable by this user only', async () => {
    await appendRunLog({ timestamp: new Date().toISOString(), command: 'diff', args: [], durationMs: 1, exitStatus: 'success' })
    expect((await stat(join(home, '.supaforge'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(home, '.supaforge', 'run-log.jsonl'))).mode & 0o777).toBe(0o600)
  })
})

// DBDiff reads its connection URLs from DBDIFF_SERVER1_URL / DBDIFF_SERVER2_URL
// (3.0.0-rc.38+); one older asks for its servers, and is given the flags.
describe('the DBDiff SupaForge runs', () => {
  let dir: string
  const saved = process.env.SUPAFORGE_DBDIFF_BIN
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'supaforge-dbdiff-argv-')) })
  afterAll(async () => {
    if (saved === undefined) delete process.env.SUPAFORGE_DBDIFF_BIN
    else process.env.SUPAFORGE_DBDIFF_BIN = saved
    await rm(dir, { recursive: true, force: true })
  })

  const dbdiff = async (name: string, legacy: boolean) => {
    const path = join(dir, name)
    await writeFile(path, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" >> "${dir}/${name}.args"`,
      `printf '%s' "$DBDIFF_SERVER1_URL" > "${dir}/${name}.env"`,
      ...(legacy ? ['case "$*" in *--server1-url=*) ;; *) echo "Missing input argument. Provide server1.db:server2.db" >&2; exit 1;; esac'] : []),
      'for a in "$@"; do case $a in --output=*) : > "${a#--output=}";; esac; done',
      'exit 0',
    ].join('\n'))
    await chmod(path, 0o755)
    process.env.SUPAFORGE_DBDIFF_BIN = path
    return path
  }

  it('passes the URLs in its environment, not its arguments', async () => {
    await dbdiff('dbdiff', false)
    await runDbDiff({ sourceUrl: URL_WITH, targetUrl: URL_WITH, type: 'data', include: 'both' })
    expect(await readFile(join(dir, 'dbdiff.args'), 'utf8')).not.toContain(PASSWORD)
    expect(await readFile(join(dir, 'dbdiff.env'), 'utf8')).toBe(URL_WITH)
  })

  it('gives one older than those variables the flags', async () => {
    await dbdiff('old-dbdiff', true)
    await runDbDiff({ sourceUrl: URL_WITH, targetUrl: URL_WITH, type: 'data', include: 'both' })
    expect(await readFile(join(dir, 'old-dbdiff.args'), 'utf8')).toContain(`--server1-url=${URL_WITH}`)
  })
})
