import { holdSnapshot, releaseSnapshots, setSnapshotsOff } from './db.js'
import { policyOnlyKeys, sqlSkeleton } from './sql-deps.js'
import { splitSqlStatements } from './utils/sql-split.js'
import type { HookBus } from './hooks'
import type { CheckRegistry } from './checks/registry'
import type { SupaForgeConfig } from './types/config'
import type { CheckName, CheckResult, ScanResult } from './types/drift'
import type { TableFilter } from './utils/table-filter'
import { resolveTableFilter } from './utils/table-filter'
import { CHECK_NAMES } from './types/drift'
import { computeScore, computePostureScore, summarize } from './scoring'
import type { Check, CheckContext } from './checks/base'
import { isCheckSkipped } from './checks/base'
import { friendlyDbError } from './utils/error'
import { hazardsOf } from './hazards.js'
import type { DriftIssue } from './types/drift.js'

export type ScanProgressEvent =
  | { phase: 'check:start'; check: CheckName; index: number; total: number }
  | { phase: 'check:done'; check: CheckName; index: number; total: number; status: CheckResult['status']; issueCount: number; durationMs: number; skipReason?: string }

export interface ScanOptions {
  config: SupaForgeConfig
  /** Whitelist: only run these checks. Defaults to all checks. */
  checks?: CheckName[]
  /** Blacklist: skip these checks (CLI --skip flag). Merged with config.checks.exclude. */
  skip?: CheckName[]
  onProgress?: (event: ScanProgressEvent) => void
  /** Fine-grained progress from within a single check, e.g. "42 tables · users". */
  onDetail?: (check: CheckName, detail: string) => void
  /**
   * Scope the schema and data comparisons to a subset of tables (issue #43).
   * Merged with the config's own `checks.tables` / `checks.excludeTables`.
   */
  tableFilter?: TableFilter
  /**
   * Read each database as of one instant (see holdSnapshot). On by default;
   * what the scan reads stays locked until it ends, as with pg_dump.
   */
  snapshot?: boolean
}

/**
 * Checks to skip: the top-level `checks.exclude` unioned with the target
 * environment's own `checks.exclude`.
 *
 * Per-environment because a check can be fine against a fast local clone and
 * hopeless against a remote environment (issue #29). Keyed on the *target*,
 * which is the environment every check reads from.
 *
 * Tolerates a malformed config — a non-array or an unknown environment name
 * yields no extra exclusions rather than throwing, so a bad config narrows
 * nothing instead of taking the scan down.
 */
export function resolveExcludedChecks(config: SupaForgeConfig): CheckName[] {
  const lists = [config?.checks?.exclude, config?.environments?.[config?.target ?? '']?.checks?.exclude]
  const out: CheckName[] = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const name of list) {
      if (typeof name === 'string' && (CHECK_NAMES as readonly string[]).includes(name)) {
        out.push(name as CheckName)
      }
    }
  }
  return out
}

/**
 * Run one check and classify the outcome.
 *
 * Three outcomes, not two: a check can compare and find nothing, or decline to
 * run. Collapsing the second into the first is what made a layer that never
 * opened a connection render as a green pass (issue #42).
 */
/**
 * How many checks may run at once.
 *
 * Four by default: enough to hide the latency of the light checks behind each
 * other, few enough that two dbdiff subprocesses and a connection pool per
 * database stay reasonable. `SUPAFORGE_CHECK_CONCURRENCY=1` restores the old
 * one-at-a-time behaviour, which is also the way to get strictly ordered
 * progress output.
 */
function checkConcurrency(): number {
  const raw = process.env.SUPAFORGE_CHECK_CONCURRENCY
  if (raw) {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0) return n
  }
  return 4
}

/** Each fix with what applying it does to a live database — see hazards.ts. */
function withHazards(issues: DriftIssue[]): DriftIssue[] {
  return issues.map(issue => {
    if (!issue.sql?.up) return issue
    const hazards = hazardsOf(issue.sql.up)
    return hazards.length > 0 ? { ...issue, hazards } : issue
  })
}

async function runCheck(
  check: Check,
  ctx: CheckContext,
  name: CheckName,
  sourceDbUrl: string,
): Promise<CheckResult> {
  const start = performance.now()
  const notices: string[] = []
  try {
    const issues = withHazards(await check.scan({ ...ctx, onNotice: n => notices.push(n) }))
    return {
      check: name,
      status: issues.length > 0 ? 'drifted' : 'clean',
      issues,
      ...(notices.length > 0 ? { notices } : {}),
      durationMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    const durationMs = Math.round(performance.now() - start)

    // A skip is a normal outcome, not a failure — the layer declined to run
    // for a reason the user can act on, rather than breaking (issue #42).
    if (isCheckSkipped(err)) {
      return { check: name, status: 'skipped', issues: [], skipReason: err.message, durationMs }
    }
    return {
      check: name,
      status: 'error',
      issues: [],
      error: friendlyDbError(err, sourceDbUrl),
      durationMs,
    }
  }
}

export async function scan(
  registry: CheckRegistry,
  options: ScanOptions,
  bus?: HookBus,
): Promise<ScanResult> {
  const { config } = options
  const skipSet = new Set([...(options.skip ?? []), ...resolveExcludedChecks(config)])
  const checksToScan = (options.checks ?? [...CHECK_NAMES]).filter(n => !skipSet.has(n))

  const source = config.environments[config.source!]
  const target = config.environments[config.target!]
  const tableFilter = options.tableFilter ?? resolveTableFilter(config)
  const ctx = { source, target, config, tableFilter }

  await bus?.emit('supaforge.scan.before', ctx)

  // Independent checks, run a few at a time rather than one after another.
  //
  // They share nothing and each is mostly waiting on a database, so the run was
  // paying the sum of their latencies for no reason: the 13 non-schema checks
  // took about 9 s of a 48 s diff over a 100 ms link (issue #78). The limit is
  // deliberate rather than unbounded — the schema and data checks each spawn
  // @dbdiff/cli, and a Supabase pooler counts every connection.
  //
  // Results are collected by position, so the report stays in check order
  // however they finish. Progress events fire as each one does, which is the
  // honest thing to show for concurrent work.
  const results: CheckResult[] = new Array(checksToScan.length)
  const total = checksToScan.length
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= total) return

      const name = checksToScan[i]
      const check = registry.get(name)

      options.onProgress?.({ phase: 'check:start', check: name, index: i, total })

      // Sub-check progress (e.g. the schema diff's table counter) is reported
      // through the same channel, tagged with the owning check.
      const checkCtx = {
        ...ctx,
        onDetail: options.onDetail ? (detail: string) => options.onDetail?.(name, detail) : undefined,
      }

      if (!check) {
        const skipReason = 'not registered'
        results[i] = { check: name, status: 'skipped', issues: [], skipReason, durationMs: 0 }
        options.onProgress?.({ phase: 'check:done', check: name, index: i, total, status: 'skipped', issueCount: 0, durationMs: 0, skipReason })
        continue
      }

      await bus?.emit('supaforge.check.before', { check: name })

      const result = await runCheck(check, checkCtx, name, source.dbUrl)
      results[i] = result
      options.onProgress?.({
        phase: 'check:done',
        check: name,
        index: i,
        total,
        status: result.status,
        issueCount: result.issues.length,
        durationMs: result.durationMs,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
      })

      await bus?.emit('supaforge.check.after', { check: name, result })
    }
  }

  // Each side read as of one instant, and let go before anything is applied.
  setSnapshotsOff(options.snapshot === false)
  if (options.snapshot !== false) {
    await Promise.all([source?.dbUrl, target?.dbUrl].filter(Boolean).map(url => holdSnapshot(url as string)))
  }
  try {
    await Promise.all(
      Array.from({ length: Math.min(checkConcurrency(), total) }, () => worker()),
    )
  } finally {
    if (options.snapshot !== false) await releaseSnapshots()
  }

  foldDuplicatePolicyFindings(results)
  foldDuplicateExtensionFindings(results)

  const summary = summarize(results)
  const score = computeScore(results)
  const postureScore = computePostureScore(results)

  const scanResult: ScanResult = {
    timestamp: new Date().toISOString(),
    source: config.source!,
    target: config.target!,
    checks: results,
    score,
    postureScore,
    summary,
  }

  await bus?.emit('supaforge.scan.after', scanResult)

  return scanResult
}

/**
 * Leave out the schema check's policy findings that the RLS check reports too.
 *
 * @dbdiff/cli diffs RLS policies as part of the schema, and the RLS check
 * diffs the same policies itself, so a policy missing from the target was
 * reported twice — counted twice in the issue total and the score, once as a
 * critical "Missing RLS policy" and once as a "Policy missing" (issue #97).
 * `--apply` already applied only one of them. The RLS check's finding is the
 * one kept: it is the one that names the policy's risk, and it is there
 * whenever that check runs. A schema finding that does anything besides the
 * policies — the table the policy sits on, say — is kept whole.
 *
 * Keyed with their schema: @dbdiff/cli diffs every schema the project owns
 * (rc.20), and `storage.objects` may have a policy named like one on a table
 * of the project's.
 */
export function foldDuplicatePolicyFindings(results: CheckResult[]): void {
  foldInto(results, 'rls', policyOnlyKeys)
}

/**
 * Leave out the schema check's extension findings that the extensions check
 * reports too: @dbdiff/cli creates and drops the extensions installed in the
 * schemas it compares (rc.22), and the extensions check reports every
 * extension, with what this server can offer and the version. Its finding is
 * kept; a schema finding doing anything besides is kept whole.
 */
export function foldDuplicateExtensionFindings(results: CheckResult[]): void {
  foldInto(results, 'extensions', extensionOnlyKeys)
}

/** The extensions a fix creates or drops, when that is all it does; otherwise null. */
export function extensionOnlyKeys(sql: string | undefined): string[] | null {
  const statements = splitSqlStatements(sql ?? '').map(s => sqlSkeleton(s).trim()).filter(Boolean)
  const keys = statements.map(s =>
    /^(?:CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?|DROP\s+EXTENSION\s+(?:IF\s+EXISTS\s+)?)("[^"]+"|[\w$-]+)/i.exec(s)?.[1])
  if (keys.length === 0 || keys.some(k => k === undefined)) return null
  return [...new Set(keys.map(k => (k as string).replace(/^"|"$/g, '').toLowerCase()))]
}

/**
 * Leave out each schema finding whose fix only touches what `into` reports
 * too, keyed by `keysOf`, and count them on the schema result.
 */
function foldInto(results: CheckResult[], into: CheckName, keysOf: (sql: string | undefined) => string[] | null): void {
  const owner = results.find(r => r?.check === into && (r.status === 'drifted' || r.status === 'clean'))
  const schema = results.find(r => r?.check === 'schema' && r.status === 'drifted')
  if (!owner || !schema) return

  const covered = new Set<string>()
  for (const issue of owner.issues) {
    for (const key of keysOf(issue.sql?.up) ?? []) covered.add(key)
  }

  const before = schema.issues.length
  schema.issues = schema.issues.filter(issue => {
    const keys = keysOf(issue.sql?.up)
    return !(keys && keys.length > 0 && keys.every(k => covered.has(k)))
  })
  const folded = before - schema.issues.length
  if (folded === 0) return

  schema.folded = [...(schema.folded ?? []), { count: folded, into }]
  if (schema.issues.length === 0) schema.status = 'clean'
}
