/**
 * Convergence proof from a PostgreSQL 17 source onto a PostgreSQL 18 target.
 *
 * PostgreSQL 18 gives each NOT NULL a named constraint, made up from the
 * table's name when the table is created, and a rename keeps it. A 17 source
 * has no such names at all. So a migration renaming a table on an 18 target
 * left `widgets_label_not_null`, while the source copied onto 18 for the
 * comparison had `gadgets_label_not_null`, and a correct migration was refused.
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'
import { proveConvergence } from '../../src/prove.js'

const describeE2E = describeWithContainers()

describeE2E('convergence proof, PostgreSQL 17 source onto 18', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({
      verbose: !!process.env.E2E_VERBOSE,
      images: { source: 'docker.io/library/postgres:17-alpine', target: 'docker.io/library/postgres:18-alpine' },
    })
    await h.up()
  }, 300_000)

  afterAll(async () => { await h?.down() }, 60_000)

  const prove = (migrationSql: string) => proveConvergence({
    sourceUrl: h.connectionString('source'),
    targetUrl: h.connectionString('target'),
    migrationSql,
  })

  it('accepts a table renamed on the target, which keeps its NOT NULL names', async () => {
    await h.applySql('source', 'DROP TABLE IF EXISTS widgets, gadgets; CREATE TABLE gadgets (id int PRIMARY KEY, label text NOT NULL);')
    await h.applySql('target', 'DROP TABLE IF EXISTS widgets, gadgets; CREATE TABLE widgets (id int PRIMARY KEY, label text NOT NULL);')
    const proof = await prove('ALTER TABLE widgets RENAME TO gadgets; ALTER INDEX widgets_pkey RENAME TO gadgets_pkey;')

    expect(proof.skipped).toBeUndefined()
    expect(proof.residual).toEqual([])
    expect(proof.converged).toBe(true)
  }, 300_000)

  it('still refuses a column the migration leaves nullable', async () => {
    await h.applySql('source', 'DROP TABLE IF EXISTS widgets, gadgets; CREATE TABLE gadgets (id int PRIMARY KEY, label text NOT NULL);')
    await h.applySql('target', 'DROP TABLE IF EXISTS widgets, gadgets; CREATE TABLE widgets (id int PRIMARY KEY, label text);')
    const proof = await prove('ALTER TABLE widgets RENAME TO gadgets; ALTER INDEX widgets_pkey RENAME TO gadgets_pkey;')

    expect(proof.skipped).toBeUndefined()
    expect(proof.converged).toBe(false)
  }, 300_000)
})
