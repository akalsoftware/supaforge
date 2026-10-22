/**
 * Prove a planned apply on a throwaway clone before it touches the target.
 *
 * A migration that executes without error can still leave the database in a
 * state that is not the source: a flattened partition, or an index that never
 * reached its partitions, both apply cleanly. Only replaying it and looking at
 * the result catches that, so a proof that fails blocks the apply rather than
 * warning after the fact.
 *
 * Shared by `diff --apply --prove` and the MCP `sync` tool, which render the
 * same outcome their own way; the decision is made once, here.
 */
import { planWork, type PlanOptions, type PlannedSql } from './promote.js'
import { proveConvergence, residualHeldBack, proofScope, comparedSchemas, type ProofResult } from './prove.js'
import { DEFAULT_IGNORE_SCHEMAS, schemaDiffIgnores } from './defaults.js'
import type { ScanResult } from './types/drift.js'

export interface ProofOutcome {
  /** Whether the apply may go ahead. */
  proceed: boolean
  /**
   * - `converged`: the migration reproduces the source.
   * - `converged-apart-from-held-back`: all that is left is what this run holds back on purpose.
   * - `nothing-to-prove`: no planned fix is one the proof can replay; the apply goes ahead unproved.
   * - `not-proven`: the proof could not run, so nothing is applied.
   * - `diverged`: the migration does not reproduce the source, so nothing is applied.
   */
  verdict: 'converged' | 'converged-apart-from-held-back' | 'nothing-to-prove' | 'not-proven' | 'diverged'
  /** Why it could not prove, for `not-proven` and `nothing-to-prove`. */
  reason?: string
  /** What still differs: held back, for the one verdict; unexplained, for `diverged`. */
  residual: string[]
  /** Already different before, outside what this run compares. */
  outOfScope: string[]
  /** Planned fixes the proof cannot speak for; they are applied all the same. */
  unproved: PlannedSql[]
  /** Left out, as the apply will leave them: this server can't hold them. */
  notApplied: NonNullable<ProofResult['notApplied']>
  data?: ProofResult['data']
}

export async function proveBeforeApply(opts: {
  scanResult: ScanResult
  plan: PlanOptions
  sourceUrl: string
  targetUrl: string
  ignoreSchemas?: readonly string[]
}): Promise<ProofOutcome> {
  const { scanResult, sourceUrl, targetUrl } = opts
  const planned = planWork(scanResult, opts.plan)
  const { replay, unproved } = proofScope(planned.sqlStatements)

  // Nothing left to replay means nothing to prove. Running it anyway compared
  // the whole schema, and refused a cron-only apply over tables it was never
  // going to touch.
  const proof: ProofResult = replay.length === 0
    ? { converged: false, residual: [], cloneName: '', skipped: 'none of the planned fixes is one the proof can replay' }
    : await proveConvergence({
      sourceUrl,
      targetUrl,
      migrationSql: replay.map(s => s.sql).join('\n'),
      fixes: replay,
      // Every schema the schema diff compares, not `public` alone: a migration
      // dropping a schema the source lacks runs against it.
      schemas: await comparedSchemas(sourceUrl, targetUrl, schemaDiffIgnores(opts.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS)),
      // The checks this run compares: without the schema check, what the
      // target already lacks elsewhere is not this migration's to fix.
      checks: scanResult.checks.map(c => c.check),
    })

  const base = {
    outOfScope: proof.outOfScope ?? [],
    unproved,
    notApplied: proof.notApplied ?? [],
    ...(proof.data && !proof.skipped ? { data: proof.data } : {}),
  }

  if (proof.skipped && replay.length === 0) {
    return { ...base, proceed: true, verdict: 'nothing-to-prove', reason: proof.skipped, residual: [] }
  }
  // Could not prove is not the same as failed to converge, but either way
  // nothing is applied: a proof is asked for as a gate.
  if (proof.skipped) return { ...base, proceed: false, verdict: 'not-proven', reason: proof.skipped, residual: [] }
  if (proof.converged) return { ...base, proceed: true, verdict: 'converged', residual: [] }

  // What the replay left out because this server can't hold it, as the apply
  // will: expected to stay different, so it counts as held back.
  const heldBack = [...heldBackSql(scanResult, planned), ...base.notApplied.map(n => n.sql)]
  const { unexplained } = residualHeldBack(proof.residual, heldBack)
  return unexplained.length === 0
    ? { ...base, proceed: true, verdict: 'converged-apart-from-held-back', residual: proof.residual }
    : { ...base, proceed: false, verdict: 'diverged', residual: unexplained }
}

/** The SQL of the fixes this run plans to skip, which the proof did not replay. */
function heldBackSql(scanResult: ScanResult, planned: { skipped: Array<{ issueId: string }> }): string[] {
  const skipped = new Set(planned.skipped.map(s => s.issueId))
  return scanResult.checks.flatMap(c => c.issues)
    .filter(i => skipped.has(i.id) && i.sql?.up)
    .map(i => i.sql!.up)
}
