/**
 * Cloning a Supabase database into plain PostgreSQL, through the command.
 *
 * The clone leaves Supabase's own schemas out (auth, storage, extensions,
 * net, …), but pg_dump still lists privileges on some of what is in them: an
 * extension's functions, the schema an extension creates. Granting those can
 * only fail, and did: every Supabase source cloned with "32 statement(s)
 * failed" and exit 1. Every other clone test has a plain source.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const exec = promisify(execFile)
const CLI_DIR = join(import.meta.dirname, '..', '..')
const describeE2E = describeWithContainers()

describeE2E('clone: a Supabase source into plain PostgreSQL', () => {
  let h: PgHarness
  let dir: string

  beforeAll(async () => {
    h = new PgHarness({
      images: { source: 'public.ecr.aws/supabase/postgres:15.8.1.085', target: 'docker.io/library/postgres:15-alpine' },
      readyTimeoutSec: 180,
      verbose: !!process.env.E2E_VERBOSE,
    })
    await h.up()
    await h.applySql('source', `
      CREATE TABLE public.notes (id int PRIMARY KEY, body text);
      GRANT SELECT ON public.notes TO anon;
      INSERT INTO public.notes VALUES (1, 'kept');`)
    await h.applySql('target', 'CREATE ROLE anon NOLOGIN;')
    dir = await mkdtemp(join(tmpdir(), 'supaforge-clone-sb-'))
    await writeFile(join(dir, 'supaforge.config.json'), JSON.stringify({
      environments: { src: { dbUrl: h.connectionString('source') } },
      source: 'src', target: 'src',
    }))
  }, 600_000)

  afterAll(async () => {
    await h?.down()
    if (dir) await rm(dir, { recursive: true, force: true })
  }, 60_000)

  it('clones without failures, and the user\'s privileges come with it', async () => {
    // It exits 1 when anything failed; the JSON still says what.
    const { code, stdout } = await exec(join(CLI_DIR, 'node_modules', '.bin', 'tsx'), [
      join(CLI_DIR, 'bin', 'dev.js'), 'clone', '-e', 'src',
      '--local-url', h.connectionString('target'), '--local-db', 'cloned', '--force', '--apply', '--json',
    ], { cwd: dir, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 })
      .then(r => ({ code: 0, stdout: r.stdout }), (e: { code?: number; stdout?: string }) => ({ code: e.code, stdout: e.stdout ?? '' }))
    const result = JSON.parse(stdout)

    expect(result.restoreFailures).toEqual([])
    expect(code).toBe(0)
    const check = (sql: string) => h.sqlIn('target', 'cloned', sql)
    expect(await check('SELECT body FROM public.notes')).toBe('kept')
    expect(await check("SELECT has_table_privilege('anon', 'public.notes', 'SELECT')")).toBe('t')
  }, 300_000)
})
