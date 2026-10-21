/**
 * A scan reads each database as of one instant, against a real server.
 *
 * A table made while the database is held is not seen by any read until it
 * is let go; a read that fails, and a definition rendered with a temporary
 * object, leave the reads after them working.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { holdSnapshot, heldSnapshot, inRolledBackTransaction, pgQuery, releaseSnapshots } from '../../src/db.js'
import { buildDbDiffArgs } from '../../src/dbdiff.js'

const describeE2E = describeWithContainers()

describeE2E('e2e: reads as of one instant', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE })
    await h.up()
  }, 300_000)

  afterEach(async () => { await releaseSnapshots() })
  afterAll(async () => { await h?.down() }, 120_000)

  const count = async (url: string, name: string) =>
    Number((await pgQuery(url, 'SELECT count(*) AS n FROM pg_class WHERE relname = $1', [name]))[0].n)

  it('does not see a table made while the database is held, until it is let go', async () => {
    const url = h.connectionString('source')
    expect(await holdSnapshot(url)).toBe(true)
    expect(heldSnapshot(url)).toBeTruthy()
    // @dbdiff/cli reads as of the same instant.
    expect(buildDbDiffArgs({ sourceUrl: url, targetUrl: 'postgres://elsewhere', type: 'schema', include: 'both' }, '/tmp/o.sql'))
      .toContain(`--source-snapshot=${heldSnapshot(url)}`)
    await count(url, 'made_meanwhile')

    await h.applySql('source', 'CREATE TABLE public.made_meanwhile (id int);')

    // Several reads, on several pooled connections, all as of the instant held.
    expect(await Promise.all([1, 2, 3, 4, 5, 6].map(() => count(url, 'made_meanwhile')))).toEqual([0, 0, 0, 0, 0, 0])

    await releaseSnapshots()
    expect(heldSnapshot(url)).toBeUndefined()
    expect(await count(url, 'made_meanwhile')).toBe(1)
  }, 120_000)

  it('keeps reading after a read that fails and a rendering with a temporary object', async () => {
    const url = h.connectionString('target')
    await h.applySql('target', 'CREATE TABLE public.kept (id int);')
    expect(await holdSnapshot(url)).toBe(true)
    await h.applySql('target', 'CREATE TABLE public.later (id int);')

    await expect(pgQuery(url, 'SELECT * FROM no_such_table')).rejects.toThrow(/no_such_table/)
    const rendered = await inRolledBackTransaction(url, async client => {
      await client.query('CREATE TEMP TABLE sf_probe (x int CHECK (x > 0))')
      return (await client.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'sf_probe'::regclass`)).rows[0].def
    })
    expect(rendered).toBe('CHECK ((x > 0))')

    expect(await count(url, 'kept')).toBe(1)
    expect(await count(url, 'later')).toBe(0)
    expect(await count(url, 'sf_probe')).toBe(0)
  }, 120_000)
})
