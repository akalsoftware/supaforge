/**
 * A table created by the same apply as the default privileges it takes.
 *
 * The source's ALTER DEFAULT PRIVILEGES grants anon every new table, and one
 * table had it taken back. On a fresh target the schema fix copies the
 * defaults first and then creates the table, which so took anon's grant the
 * source does not have; the scan had seen no defaults on the target to
 * revoke against, and only a second sync took it back. One apply must leave
 * no grant wider than the source's.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: default privileges copied by the same apply as the tables they cover', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    const ROLES = `DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
    await h.applySql('target', ROLES)
    await h.applySql('source', ROLES + `
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
      CREATE TABLE public.open_notes (id int PRIMARY KEY);
      CREATE TABLE public.secrets (id int PRIMARY KEY, token text);
      REVOKE ALL ON public.secrets FROM anon;`)
  }, 600_000)

  afterAll(async () => { await h?.down() }, 120_000)

  it('leaves the table the source keeps from anon kept from anon, in one apply', async () => {
    // The fixture is what it claims: the source's defaults grant anon, and
    // the one table has had it revoked.
    expect(await h.sql('source', `SELECT has_table_privilege('anon', 'public.open_notes', 'SELECT')`)).toBe('t')
    expect(await h.sql('source', `SELECT has_table_privilege('anon', 'public.secrets', 'SELECT')`)).toBe('f')
    expect(await h.sql('target', `SELECT count(*) FROM pg_default_acl`)).toBe('0')

    const ws = await h.workspace()
    const run = await h.cli(['diff', '--apply', '--json'], { cwd: ws })
    const result = JSON.parse(run.stdout)
    expect(result.errors).toEqual([])

    expect(await h.sql('target', `SELECT has_table_privilege('anon', 'public.secrets', 'SELECT')`)).toBe('f')
    expect(await h.sql('target', `SELECT has_table_privilege('anon', 'public.open_notes', 'SELECT')`)).toBe('t')

    const again = JSON.parse((await h.cli(['diff', '--check', 'roles', '--json'], { cwd: ws })).stdout)
    const ids = again.checks.flatMap((c: { issues: Array<{ id: string }> }) => c.issues.map(i => i.id))
    expect(ids.filter((id: string) => id.startsWith('roles-grant-'))).toEqual([])
  }, 300_000)
})
