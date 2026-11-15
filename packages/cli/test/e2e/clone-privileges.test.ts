/**
 * A clone carries the source's privileges, as far as this server's roles go.
 *
 * The restore runs with --no-acl, so the clone used to have none: Pagila's
 * GRANT ALL ON SCHEMA public TO PUBLIC was simply missing. Now each privilege
 * is granted on its own, and one for a role this server lacks is reported
 * rather than taking the others down with it.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { cloneRemoteToLocal } from '../../src/branch.js'

const describeE2E = describeWithContainers()

describeE2E('clone: the source\'s privileges', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    await h.applySql('source', `
      CREATE ROLE only_on_source NOLOGIN;
      CREATE ROLE on_both NOLOGIN;
      CREATE TABLE film (id int PRIMARY KEY, title text);
      GRANT ALL ON SCHEMA public TO PUBLIC;
      GRANT SELECT ON film TO only_on_source, on_both;
      GRANT INSERT ON film TO PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO only_on_source;`)
    await h.applySql('target', 'CREATE ROLE on_both NOLOGIN;')
  }, 300_000)

  afterAll(async () => { await h?.down() }, 60_000)

  it('grants what this server has roles for, and names what it could not', async () => {
    const result = await cloneRemoteToLocal({
      remoteUrl: h.connectionString('source'),
      localBaseUrl: h.connectionString('target'),
      localDbName: 'cloned',
      force: true,
    })

    expect(result.failures).toEqual([])
    expect(new Set(result.notGranted.map(n => n.role))).toEqual(new Set(['only_on_source']))
    expect(result.notGranted.length).toBeGreaterThanOrEqual(2)

    const check = (sql: string) => h.sqlIn('target', 'cloned', sql)
    expect(await check("SELECT has_schema_privilege('public', 'public', 'CREATE')")).toBe('t')
    expect(await check("SELECT has_table_privilege('public', 'public.film', 'INSERT')")).toBe('t')
    expect(await check("SELECT has_table_privilege('on_both', 'public.film', 'SELECT')")).toBe('t')
  }, 300_000)
})
