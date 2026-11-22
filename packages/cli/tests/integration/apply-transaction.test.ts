/**
 * Integration tests for the write path's atomicity and ordering, against a
 * real PostgreSQL server.
 *
 * These are the two halves of issue #48 that only a live server can prove:
 * that a failing fix set leaves the target byte-identical to how it started,
 * and that a dependency-ordered set applies in a single pass where the order
 * dbdiff reported it in would not.
 *
 * Everything happens inside a dedicated schema that is dropped afterwards, so
 * the file leaves the shared target exactly as it found it.
 *
 * Requires containers from scripts/test-integration.sh.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import pg from 'pg'
import { promote } from '../../src/promote'
import type { ScanResult, DriftIssue } from '../../src/types/drift'
import { TARGET_URL, skipIfNoContainers } from './helpers'

const SCHEMA = 'sf_apply_test'

async function query(sql: string): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ connectionString: TARGET_URL! })
  await client.connect()
  try {
    const { rows } = await client.query(sql)
    return rows
  } finally {
    await client.end()
  }
}

/** Does an object of this name exist in the test schema? */
async function exists(kind: 'column' | 'function' | 'view', name: string): Promise<boolean> {
  const sql = {
    column: `SELECT 1 FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = 'orders' AND column_name = '${name}'`,
    function: `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${SCHEMA}' AND p.proname = '${name}'`,
    view: `SELECT 1 FROM pg_views WHERE schemaname = '${SCHEMA}' AND viewname = '${name}'`,
  }[kind]
  return (await query(sql)).length > 0
}

/** Wrap SQL fixes into the shape promote() consumes. */
function makeScanResult(fixes: Array<{ id: string; up: string }>): ScanResult {
  const issues: DriftIssue[] = fixes.map(f => ({
    id: f.id,
    check: 'schema',
    severity: 'warning',
    title: f.id,
    description: 'test fixture',
    sql: { up: f.up, down: '' },
  }))

  return {
    timestamp: new Date().toISOString(),
    source: 'source',
    target: 'target',
    checks: [{ check: 'schema', status: 'drifted', issues, durationMs: 1 }],
    score: 0,
    postureScore: null,
    summary: { total: issues.length, critical: 0, warning: issues.length, info: 0 },
  }
}

/**
 * The fix set from issue #48, in the order @dbdiff/cli reported it: the
 * trigger ahead of the function it executes, and the index and view ahead of
 * the column they read.
 */
function issue48Fixes(): Array<{ id: string; up: string }> {
  return [
    { id: 'schema-alter-2', up: `ALTER TABLE ${SCHEMA}.orders ADD COLUMN status text DEFAULT 'pending'` },
    {
      id: 'schema-create-index-4',
      up: `CREATE INDEX idx_orders_status ON ${SCHEMA}.orders USING btree (status)`,
    },
    {
      id: 'schema-create-view-5',
      up: `CREATE VIEW ${SCHEMA}.active_orders AS SELECT id, total FROM ${SCHEMA}.orders WHERE status = 'pending'`,
    },
    {
      id: 'schema-create-trigger-6',
      up: `CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON ${SCHEMA}.orders FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.touch_updated()`,
    },
    {
      id: 'schema-create-function-7',
      up: `CREATE OR REPLACE FUNCTION ${SCHEMA}.touch_updated() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$`,
    },
  ]
}

describe('integration: --apply ordering and atomicity', () => {
  beforeEach(async () => {
    if (skipIfNoContainers()) return
    await query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
                 CREATE TABLE ${SCHEMA}.orders (id serial PRIMARY KEY, total numeric(10,2));`)
  })

  afterAll(async () => {
    if (skipIfNoContainers()) return
    await query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  })

  it.skipIf(skipIfNoContainers())('applies a dependency-tangled fix set in one pass', async () => {
    const result = await promote({ dbUrl: TARGET_URL!, scanResult: makeScanResult(issue48Fixes()) })

    expect(result.errors, `apply errors: ${JSON.stringify(result.errors)}`).toHaveLength(0)
    expect(result.applied).toHaveLength(5)
    expect(result.rolledBack).toBeUndefined()

    // The trigger is the fix that used to fail: it is only creatable once the
    // function it executes exists.
    expect(await exists('function', 'touch_updated')).toBe(true)
    expect(await exists('view', 'active_orders')).toBe(true)
    expect(await exists('column', 'status')).toBe(true)
  })

  it.skipIf(skipIfNoContainers())('rolls the whole batch back when one fix fails', async () => {
    // Occupy the name the view needs, so the view fix fails mid-batch.
    await query(`CREATE TABLE ${SCHEMA}.active_orders (id int)`)

    const result = await promote({ dbUrl: TARGET_URL!, scanResult: makeScanResult(issue48Fixes()) })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].issueId).toBe('schema-create-view-5')
    expect(result.applied).toHaveLength(0)
    expect(result.rolledBack?.length).toBeGreaterThan(0)

    // The target is exactly as it started: nothing from the batch survived.
    expect(await exists('column', 'status')).toBe(false)
    expect(await exists('function', 'touch_updated')).toBe(false)
  })

  // A fix needing something the target cannot have — here a type from an
  // extension it lacks, and the index on that column — used to roll back
  // every unrelated fix with it, so nothing was synced at all.
  it.skipIf(skipIfNoContainers())('leaves out only the fixes whose dependency the target lacks', async () => {
    const fixes = [
      ...issue48Fixes(),
      { id: 'schema-alter-8', up: `ALTER TABLE ${SCHEMA}.orders ADD COLUMN embedding sf_no_such_schema.vector(3)` },
      { id: 'schema-create-index-9', up: `CREATE INDEX idx_orders_embedding ON ${SCHEMA}.orders (embedding)` },
    ]

    const result = await promote({ dbUrl: TARGET_URL!, scanResult: makeScanResult(fixes) })

    expect(result.rolledBack).toBeUndefined()
    expect(result.applied).toHaveLength(5)
    expect(result.errors.map(e => e.issueId).sort()).toEqual(['schema-alter-8', 'schema-create-index-9'])
    expect(result.errors[0].error).toContain('Everything else was applied')
    expect(await exists('column', 'status')).toBe(true)
    expect(await exists('function', 'touch_updated')).toBe(true)
    expect(await exists('column', 'embedding')).toBe(false)
  })

  it.skipIf(skipIfNoContainers())('leaves out an extension the server does not ship', async () => {
    const fixes = [
      { id: 'extensions-create-1', up: 'CREATE EXTENSION IF NOT EXISTS sf_no_such_extension' },
      ...issue48Fixes(),
    ]

    const result = await promote({ dbUrl: TARGET_URL!, scanResult: makeScanResult(fixes) })

    expect(result.rolledBack).toBeUndefined()
    expect(result.applied).toHaveLength(5)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toContain('this server does not ship it')
  })

  it.skipIf(skipIfNoContainers())('keeps partial progress under --no-transaction', async () => {
    await query(`CREATE TABLE ${SCHEMA}.active_orders (id int)`)

    const result = await promote({
      dbUrl: TARGET_URL!,
      scanResult: makeScanResult(issue48Fixes()),
      transactional: false,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.rolledBack).toBeUndefined()
    expect(result.applied.length).toBe(4)
    expect(await exists('column', 'status')).toBe(true)
  })

  it.skipIf(skipIfNoContainers())('writes nothing in a dry run', async () => {
    const result = await promote({
      dbUrl: TARGET_URL!,
      scanResult: makeScanResult(issue48Fixes()),
      dryRun: true,
    })

    expect(result.applied).toHaveLength(5)
    expect(result.errors).toHaveLength(0)
    expect(await exists('column', 'status')).toBe(false)
    expect(await exists('function', 'touch_updated')).toBe(false)
  })

  it.skipIf(skipIfNoContainers())('reports the dry-run plan in execution order', async () => {
    const result = await promote({
      dbUrl: TARGET_URL!,
      scanResult: makeScanResult(issue48Fixes()),
      dryRun: true,
    })

    const ids = result.applied.map(a => a.issueId)
    expect(ids.indexOf('schema-create-function-7')).toBeLessThan(ids.indexOf('schema-create-trigger-6'))
    expect(ids.indexOf('schema-alter-2')).toBeLessThan(ids.indexOf('schema-create-index-4'))
  })
})
