/**
 * E2E: Reference data drift detection and promotion (powered by @dbdiff/cli).
 *
 * Tests against real Supabase instances with:
 *   - Missing row: Enterprise plan (exists in source, not in target)
 *   - Modified row: Pro plan has different price (2900 in source, 1900 in target)
 *
 * @dbdiff/cli is a pinned dependency, so it is always there. These tests used
 * to skip when the check found no drift, on the theory that dbdiff was
 * missing — but `it.skipIf` is evaluated when the file is collected, before
 * beforeAll ran the scan, so they skipped every time and data drift was never
 * asserted in CI.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { scan } from '../../../src/scanner'
import { promote } from '../../../src/promote'
import { createDefaultRegistry } from '../../../src/checks/index'
import type { SupaForgeConfig } from '../../../src/types/config'
import type { ScanResult, CheckResult } from '../../../src/types/drift'
import { shouldSkip, buildConfig } from './helpers'

describe('e2e: data layer', () => {
  let config: SupaForgeConfig
  let initialScan: ScanResult
  let dataResult: CheckResult | undefined

  beforeAll(async () => {
    if (shouldSkip()) return
    config = buildConfig({ dataTables: ['plans'] })

    const registry = createDefaultRegistry()
    initialScan = await scan(registry, { config, checks: ['data'] })
    dataResult = initialScan.checks.find(l => l.check === 'data')
  })

  it.skipIf(shouldSkip())('should scan data layer without errors', () => {
    expect(dataResult).toBeDefined()
    expect(dataResult!.status).not.toBe('error')
  })

  it.skipIf(shouldSkip())('should detect data drift in plans table', () => {
    expect(dataResult!.status).toBe('drifted')
    // The fixtures: Enterprise only in the source, Pro priced differently —
    // and the target's sequence, which has handed out ids 1 and 2, would give
    // the next new plan the id the synced Enterprise row takes.
    expect(dataResult!.issues.map(i => i.title).sort())
      .toEqual(['Missing row in plans', 'Modified row in plans', 'Sequence behind the rows in plans'])
  })

  it.skipIf(shouldSkip())('should have SQL fixes for data drift', () => {
    const withSql = dataResult!.issues.filter(i => i.sql?.up)
    expect(withSql.length).toBeGreaterThanOrEqual(1)

    // Should contain INSERT or UPDATE statements for the plans table
    const allUpSql = withSql.map(i => i.sql!.up).join('\n').toUpperCase()
    expect(allUpSql).toMatch(/INSERT|UPDATE/)
  })

  it.skipIf(shouldSkip())('dry-run should list SQL without applying', async () => {
    const result = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['data'],
      dryRun: true,
    })

    expect(result.applied.length).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)

    // Verify nothing changed
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['data'] })
    expect(rescan.checks[0].issues.length).toBe(initialScan.checks[0].issues.length)
  })

  it.skipIf(shouldSkip())('should promote data fixes and resolve drift', async () => {
    const promoteResult = await promote({
      dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
      scanResult: initialScan,
      checks: ['data'],
    })

    expect(promoteResult.errors, JSON.stringify(promoteResult.errors)).toHaveLength(0)
    expect(promoteResult.applied.length).toBeGreaterThanOrEqual(1)

    // Re-scan: data drift should be resolved
    const registry = createDefaultRegistry()
    const rescan = await scan(registry, { config, checks: ['data'] })
    const dataRescan = rescan.checks.find(l => l.check === 'data')!

    expect(dataRescan.issues).toHaveLength(0)
  })
})
