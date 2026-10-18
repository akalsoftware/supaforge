import pg from 'pg'
import { newPgClient } from './db.js'
import type { ScanResult, SyncAction } from './types/drift'
import { errMsg } from './utils/error'
import { ABSENT_ON_TARGET, EXTENSION_UNAVAILABLE, OLDER_SERVER, UNDEFINED_COLUMN, sqlState } from './pg-errors.js'
import { destructiveReason } from './dbdiff'
import { parseStatements } from './sql-ast'
import { estimateLocks, lockBudgetWarning, readLockBudget } from './lock-budget.js'
import {
  orderStatements, referencedTables,
  createdPolicies, createsOnlyPolicies,
  createdTriggers, createsOnlyTriggers,
  sqlSkeleton, bareName, identifierMatcher,
} from './sql-deps.js'
import { splitSqlStatements, isCommentOnly } from './utils/sql-split.js'
import { applyTableFilter, isFiltered, type TableFilter } from './utils/table-filter.js'
import { isComparisonCheck } from './types/drift.js'
import { matchesGlob } from './utils/strings.js'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface PromoteOptions {
  /** Target database connection string */
  dbUrl: string
  /**
   * The source's connection string. Its PostgreSQL version tells a fix an
   * older target cannot parse — a feature it does not have — from any other
   * failure: that fix is left out, as one needing a missing extension is.
   */
  sourceUrl?: string
  /** The scan result with SQL fixes to apply */
  scanResult: ScanResult
  /** Only promote specific checks */
  checks?: string[]
  /** Also apply posture fixes; off by default — see planWork */
  applyPosture?: boolean
  /** Dry-run mode — print SQL without executing */
  dryRun?: boolean
  /**
   * Permit statements that destroy data (DROP TABLE, DROP COLUMN).
   *
   * Off by default: those are reported as drift but skipped at apply time, so
   * `supaforge diff --apply` can never drop a table or column without the user
   * asking for it. Set by the `--allow-destructive` flag.
   */
  allowDestructive?: boolean
  /**
   * The table scope the diff ran under.
   *
   * Needed at apply time as well as scan time. `--tables` reaches dbdiff, which
   * scopes *tables* only, so a narrowed fix set still arrives carrying the
   * views, triggers and indexes that hang off the tables it excluded. Applying
   * those fails, because the column or table they need was deliberately not
   * added (issue #48).
   */
  tableFilter?: TableFilter
  /**
   * Apply only these issues, by id. Globs allowed. Undefined means all.
   *
   * Every issue in `--json` already carries a stable id, so a review step can
   * pick a subset out of one diff and apply exactly that, with no new matching
   * syntax to learn.
   */
  only?: string[]
  /**
   * Run every SQL fix in one transaction, rolling the whole set back if any
   * statement fails. On by default — see `executeSql`.
   */
  transactional?: boolean
  /** Fetch function for API-based sync actions (defaults to globalThis.fetch) */
  fetchFn?: FetchFn
}

/** Where a fix came from: which check reported it, and under which issue id. */
interface FixOrigin {
  check: string
  issueId: string
}

export type PlannedSql = FixOrigin & { sql: string }
type PlannedAction = FixOrigin & { action: SyncAction }
type PlannedSkip = FixOrigin & { reason: string }

export interface PromoteResult {
  /** `note`: why a fix that did nothing still counts — see revokesFromAbsent. */
  applied: (FixOrigin & { sql?: string; action?: string; note?: string })[]
  skipped: PlannedSkip[]
  errors: (FixOrigin & { error: string })[]
  /**
   * Fixes that ran and were then undone because a later statement in the same
   * transaction failed. Reported separately from `applied`, which only ever
   * lists what is actually in the target now.
   */
  rolledBack?: (FixOrigin & { sql?: string })[]
  /** Said before the fixes ran: they may need more locks than the target has — see lock-budget. */
  warnings?: string[]
}

interface PlannedWork {
  sqlStatements: PlannedSql[]
  apiActions: PlannedAction[]
  skipped: PlannedSkip[]
}

/** What `planWork` needs to know beyond the scan result itself. */
export interface PlanOptions {
  checks?: string[]
  /**
   * Also apply fixes from the checks that judge the target on its own rather
   * than comparing it to the source. Off by default — see planWork.
   */
  applyPosture?: boolean
  allowDestructive?: boolean
  tableFilter?: TableFilter
  only?: string[]
}

/**
 * Why a fix cannot be applied under the current scope, or null when it can.
 *
 * A fix set narrowed by `--tables` is internally inconsistent by construction:
 * dbdiff's `--tables` covers tables, so the views, triggers and indexes
 * belonging to an excluded table survive the filter while the table change they
 * need does not. Naming the excluded table is the difference between a fix a
 * user can reason about and an error they cannot (issue #48).
 */
export function outOfScopeReason(sql: string, filter: TableFilter | undefined): string | null {
  if (!isFiltered(filter)) return null

  const referenced = referencedTables(sql)
  if (referenced.length === 0) return null

  const excluded = referenced.filter(t => applyTableFilter([t], filter).length === 0)
  if (excluded.length === 0) return null

  const names = excluded.map(t => `'${t}'`).join(', ')
  const flag = filter?.tables?.length ? '--tables' : '--exclude-tables'
  const noun = excluded.length === 1 ? 'table' : 'tables'
  return `Depends on ${noun} ${names}, excluded by ${flag}`
}

/** Does this issue id match any of the `--only` selectors? */
function isSelected(issueId: string, only: string[] | undefined): boolean {
  if (!only?.length) return true
  return only.some(pattern => matchesGlob(issueId, pattern))
}

/**
 * `--only` plus the "default grants to take back" of every table, view or
 * routine the selection creates.
 *
 * A new table picks up the target's default privileges — on Supabase,
 * everything to anon and authenticated — and the roles check's
 * `roles-grant-default-<role>.<schema>.<table>` fixes take back what the
 * source doesn't grant. Selecting the table without them left it open to the
 * Data API, so they come along with it.
 */
function withDefaultGrantRevokes(scanResult: ScanResult, only: string[] | undefined): string[] | undefined {
  if (!only?.length) return only
  const issues = scanResult.checks.flatMap(c => c.issues)
  const created = new Set(issues
    .filter(i => i.sql?.up && isSelected(i.id, only))
    .flatMap(i => relationsCreatedBy(i.sql!.up)))
  if (created.size === 0) return only
  const companions = issues
    .filter(i => i.id.startsWith('roles-grant-default-')
      && [...created].some(rel => rel.endsWith('(')
        // A routine, by schema and name: the fix spells its arguments as
        // written (`p integer DEFAULT 1`), the finding as PostgreSQL
        // identifies them (`p integer`).
        ? i.id.toLowerCase().includes(`.${rel}`)
        : i.id.toLowerCase().endsWith(`.${rel}`)))
    .map(i => i.id)
  return [...only, ...companions]
}

/** `schema.name` (lower case, `public` when unqualified) of each table and view the SQL creates, and `schema.name(` of each routine. */
function relationsCreatedBy(sql: string): string[] {
  const statements = parseStatements(sql)
  if (!statements) return []
  return statements.flatMap(({ kind, node }) => {
    if (kind === 'CreateFunctionStmt') {
      // `schema.name(`, matched against routine ids by prefix.
      const parts = (node.funcname as Array<{ String?: { sval: string } }> ?? []).map(n => n.String?.sval ?? '')
      const name = parts.at(-1)
      return name ? [`${(parts.length > 1 ? parts.at(-2)! : 'public').toLowerCase()}.${name.toLowerCase()}(`] : []
    }
    const rel = kind === 'CreateStmt' ? node.relation
      : kind === 'ViewStmt' ? node.view
        : kind === 'CreateTableAsStmt' ? node.into?.rel
          : undefined
    return rel?.relname ? [`${(rel.schemaname || 'public').toLowerCase()}.${String(rel.relname).toLowerCase()}`] : []
  })
}

/**
 * Decide what happens to one issue: run its SQL, call its API, or skip it.
 *
 * Split out of planWork so each reason a fix is withheld is one readable
 * branch, and so the decision can be asserted directly in tests.
 */
function classifyIssue(
  issue: { id: string; sql?: { up: string }; action?: SyncAction; manualOnly?: string; destructive?: string },
  options: PlanOptions,
  recreatedPolicies: ReadonlySet<string> = new Set(),
): { kind: 'sql'; sql: string } | { kind: 'api'; action: SyncAction } | { kind: 'skip'; reason: string } {
  if (!isSelected(issue.id, options.only)) {
    return { kind: 'skip', reason: 'Not selected by --only' }
  }

  // Real, but not for an automatic apply: the finding says what to do.
  if (issue.manualOnly) return { kind: 'skip', reason: issue.manualOnly }

  if (!issue.sql?.up) {
    // A DELETE removes a bucket or an Edge Function as surely as DROP TABLE
    // removes a table, so it waits for the same flag.
    if (issue.action?.method === 'DELETE' && !options.allowDestructive) {
      return { kind: 'skip', reason: `Destructive — ${issue.action.label}; re-run with --allow-destructive to apply` }
    }
    if (issue.action) return { kind: 'api', action: issue.action }
    // A check that knows why it cannot offer a fix says so; "nothing
    // available" on its own leaves the user with no next step.
    return { kind: 'skip', reason: issue.manualOnly ?? 'No SQL fix or API action available' }
  }

  if (!options.allowDestructive) {
    const why = issue.destructive ?? destructiveReason(issue.sql.up, recreatedPolicies)
    if (why) {
      return { kind: 'skip', reason: `Destructive — ${why}; re-run with --allow-destructive to apply` }
    }
  }

  const outOfScope = outOfScopeReason(issue.sql.up, options.tableFilter)
  if (outOfScope) return { kind: 'skip', reason: outOfScope }

  return { kind: 'sql', sql: issue.sql.up }
}

/**
 * Policies that fixes in this apply create — the ones that will actually run.
 *
 * Lets the destructive gate tell a policy being removed from one being
 * replaced across two fixes: a column type change drops the policies reading
 * the column, and the policy's own fix creates the new definition once the
 * type has changed (they cannot be one statement, because the new definition
 * is not valid until then). Counted only from fixes that are selected and not
 * held back themselves, so `--only` a column change without its policy fix is
 * still gated as the removal it would be.
 */
function policiesCreatedBySelectedFixes(checks: ScanResult['checks'], options: PlanOptions): Set<string> {
  const created = new Set<string>()
  for (const check of checks) {
    // Posture fixes do not run unless asked for (see planWork), so what they
    // would create cannot stand in for a policy another fix drops.
    const askedForExplicitly = options.checks?.includes(check.check) ?? false
    if (!isComparisonCheck(check.check) && !options.applyPosture && !askedForExplicitly) continue
    for (const issue of check.issues) {
      const sql = issue.sql?.up
      if (!sql || !isSelected(issue.id, options.only)) continue
      if (!options.allowDestructive && destructiveReason(sql)) continue
      if (outOfScopeReason(sql, options.tableFilter)) continue
      for (const key of createdPolicies(sql)) created.add(key)
    }
  }
  return created
}

/**
 * Sort a scan result's issues into what can be run as SQL, what needs an API
 * call, and what has to be skipped.
 *
 * Kept separate from promote() so the decision of *what* to apply is one
 * self-contained, directly testable pass, and promote() is left to the
 * execution.
 *
 * The SQL comes back in dependency order rather than the order the checks
 * reported it — see `orderStatements`.
 */
export function planWork(scanResult: ScanResult, options: PlanOptions = {}): PlannedWork {
  options = { ...options, only: withDefaultGrantRevokes(scanResult, options.only) }
  const plan: PlannedWork = { sqlStatements: [], apiActions: [], skipped: [] }

  const relevant = scanResult.checks.filter(
    c => c.status === 'drifted' && (!options.checks || options.checks.includes(c.check)),
  )
  const recreatedPolicies = policiesCreatedBySelectedFixes(relevant, options)
  // What the destructive gate keeps, as the definitions that would put it
  // back — the objects still there after the apply.
  const keptBack: Array<{ issueId: string; definition: string }> = []

  for (const checkResult of relevant) {
    // A posture check judges the target on its own and fires identically
    // whichever pair you diff, so its fix is not a reconciliation — applying it
    // changes the target away from the source and *creates* drift. Enabling RLS
    // on a table the source leaves open is the clear case: the next diff reports
    // "RLS enabled unexpectedly", the next sync switches it back off, and the
    // coverage check flags it again, forever. Worse, RLS enabled without the
    // policies to go with it denies every row to non-owners, so a posture fix
    // applied to a working table can take it offline.
    //
    // Naming the check explicitly (--check=rls-coverage) or passing
    // --apply-posture is taken as asking for it on purpose.
    const askedForExplicitly = options.checks?.includes(checkResult.check) ?? false
    if (!isComparisonCheck(checkResult.check) && !options.applyPosture && !askedForExplicitly) {
      for (const issue of checkResult.issues) {
        plan.skipped.push({
          check: checkResult.check,
          issueId: issue.id,
          reason: 'Posture finding about the target, not drift from the source — '
            + 'applying it would create drift. Use --apply-posture to apply anyway.',
        })
      }
      continue
    }

    for (const issue of checkResult.issues) {
      const at = { check: checkResult.check, issueId: issue.id }
      const outcome = classifyIssue(issue, options, recreatedPolicies)

      if (outcome.kind === 'sql') plan.sqlStatements.push({ ...at, sql: outcome.sql })
      else if (outcome.kind === 'api') plan.apiActions.push({ ...at, action: outcome.action })
      else {
        plan.skipped.push({ ...at, reason: outcome.reason })
        if (outcome.reason.startsWith('Destructive') && issue.sql?.down) {
          keptBack.push({ issueId: issue.id, definition: issue.sql.down })
        }
      }
    }
  }

  plan.sqlStatements = holdBackDropsStillInUse(plan.sqlStatements, keptBack, plan.skipped, downsOf(relevant))
  // DBDiff's fixes keep the order DBDiff wrote them in, which it took from
  // the catalog; the others are placed around them — see orderStatements().
  const dbdiffOrder = new Map(plan.sqlStatements.filter(s => s.check === 'schema').map((s, i) => [s, i]))
  plan.sqlStatements = orderStatements(plan.sqlStatements, s => s.sql, s => dbdiffOrder.get(s))
  plan.sqlStatements = dropDuplicateObjectFixes(plan.sqlStatements, plan.skipped)
  return plan
}

/** `DROP TYPE|DOMAIN|FUNCTION|PROCEDURE|SEQUENCE [IF EXISTS] <name>`, capturing the name. */
const DROPS_SUPPORTING_OBJECT = /^\s*DROP\s+(?:TYPE|DOMAIN|FUNCTION|PROCEDURE|ROUTINE|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/i

/**
 * Hold back the drop of a type, domain, routine or sequence that something
 * the destructive gate keeps still uses.
 *
 * The source no longer has a table and the enum its column was typed by; the
 * table's DROP is held back without --allow-destructive, and the enum's DROP
 * then fails — `cannot drop type ... because other objects depend on it` —
 * taking every other fix in the transaction with it. A kept object's own
 * definition (its fix's DOWN) says what it uses. Only a fix that does nothing
 * but drop such objects is held back; holding back more is the safe side.
 */
function holdBackDropsStillInUse(
  statements: PlannedSql[],
  keptBack: Array<{ issueId: string; definition: string }>,
  skipped: PlannedWork['skipped'],
  downs: ReadonlyMap<string, string> = new Map(),
): PlannedSql[] {
  const kept = keptBack.map(k => ({ issueId: k.issueId, skeleton: sqlSkeleton(k.definition) }))
  let remaining = statements

  // Until nothing more is held back: what one held-back drop keeps can keep
  // something else — a column kept keeps its composite type, and the
  // composite keeps the enum it holds.
  for (let changed = kept.length > 0; changed;) {
    changed = false
    remaining = remaining.filter((statement) => {
      const names = droppedSupportingObjects(statement.sql)
      if (names.length === 0) return true

      const user = kept.find(k => names.some(n => identifierMatcher(bareName(n)).test(k.skeleton)))
      if (!user) return true
      skipped.push({
        check: statement.check,
        issueId: statement.issueId,
        reason: `Still used by what ${user.issueId} keeps, which is held back as destructive; `
          + 're-run with --allow-destructive to apply both',
      })
      const definition = downs.get(statement.issueId)
      if (definition) kept.push({ issueId: user.issueId, skeleton: sqlSkeleton(definition) })
      changed = true
      return false
    })
  }
  return remaining
}

/** The names a fix drops, when all it does is drop types, domains, routines or sequences. */
function droppedSupportingObjects(sql: string): string[] {
  const parts = splitSqlStatements(sql).filter(s => !isCommentOnly(s))
  const names = parts.map(s => DROPS_SUPPORTING_OBJECT.exec(sqlSkeleton(s))?.[1])
  return names.length > 0 && names.every(n => n !== undefined) ? names as string[] : []
}

/** Each issue's DOWN — the definition of what it would drop — by issue id. */
function downsOf(checks: ScanResult['checks']): Map<string, string> {
  const downs = new Map<string, string>()
  for (const check of checks) {
    for (const issue of check.issues) {
      if (issue.sql?.down) downs.set(issue.id, issue.sql.down)
    }
  }
  return downs
}

/**
 * Remove a fix that an earlier statement in the same set already performs.
 *
 * Two layers can legitimately produce the same object. The schema check's SQL
 * comes from `@dbdiff/cli`, which models RLS policies as of 3.0.0-rc.10 and has
 * always modelled triggers; the rls check writes its own policies, and since
 * issue #77 the webhooks check writes its own triggers. Applied together the
 * second fails — `policy ... already exists`, `trigger ... already exists` —
 * and because the apply is transactional that single collision discards every
 * other fix with it. Reported twice now: a new policy that could not be synced
 * at all (#67), and a full apply rolling back six correct schema fixes (#77).
 *
 * Run over the statements in execution order, after `orderStatements`, so
 * "already created" means created by something that genuinely runs first rather
 * than merely reported first.
 *
 * Only a statement that does nothing else is dropped. The schema check bundles
 * its policy with the table and the ENABLE ROW LEVEL SECURITY beside it, and its
 * trigger with the function the trigger calls; losing either would be far worse
 * than the collision.
 */
function dropDuplicateObjectFixes(
  statements: PlannedSql[],
  skipped: PlannedWork['skipped'],
): PlannedSql[] {
  const kinds = [
    { what: 'policy',  created: createdPolicies, onlyThis: createsOnlyPolicies, seen: new Set<string>() },
    { what: 'trigger', created: createdTriggers, onlyThis: createsOnlyTriggers, seen: new Set<string>() },
  ]
  const kept: PlannedSql[] = []

  for (const statement of statements) {
    const duplicate = kinds.find((kind) => {
      const names = kind.created(statement.sql)
      return names.length > 0
        && names.every(n => kind.seen.has(n))
        && kind.onlyThis(statement.sql)
    })

    if (duplicate) {
      skipped.push({
        check: statement.check,
        issueId: statement.issueId,
        reason: `Already created by the schema fix for the same ${duplicate.what}`,
      })
      continue
    }

    for (const kind of kinds) {
      for (const name of kind.created(statement.sql)) kind.seen.add(name)
    }
    kept.push(statement)
  }

  return kept
}

/**
 * Run the planned SQL against the target on a single connection.
 *
 * Transactional by default. PostgreSQL supports transactional DDL, so a fix set
 * either lands whole or not at all, and a failure leaves the target exactly as
 * it was. The alternative — the behaviour before issue #48 — left a shared
 * environment matching neither the source nor its own previous state, and the
 * person running it having to work out which fixes had landed before retrying.
 *
 * `transactional: false` restores the statement-at-a-time behaviour, for the
 * cases where partial progress is genuinely wanted.
 */
async function executeSql(
  dbUrl: string,
  statements: PlannedSql[],
  result: PromoteResult,
  transactional: boolean,
  sourceMajor?: number,
): Promise<void> {
  if (statements.length === 0) return

  const client = newPgClient(dbUrl)
  await client.connect()
  try {
    const olderTarget = sourceMajor !== undefined && (await majorOf(client)) < sourceMajor
    if (transactional) await runInTransaction(client, statements, result, olderTarget)
    else await runIndependently(client, statements, result)
  } finally {
    await client.end()
  }
}

/**
 * Run fixes exactly as a transactional apply would — dependency-order input,
 * one savepoint per fix, a fix whose extension or object is missing left out
 * and the rest kept — against any database. The proof replays a migration
 * this way, so it rehearses what the apply will do rather than a stricter
 * script that stopped at the first fix the server could not hold.
 */
export async function runLikeApply(dbUrl: string, statements: PlannedSql[], sourceMajor?: number): Promise<PromoteResult> {
  const result: PromoteResult = { applied: [], skipped: [], errors: [] }
  await executeSql(dbUrl, statements, result, true, sourceMajor)
  return result
}

/** A server's major version, from a client or a connection string. */
async function majorOf(client: Pick<pg.Client, 'query'>): Promise<number> {
  const { rows: [row] } = await client.query<{ v: string }>(`SELECT current_setting('server_version_num') AS v`)
  return Math.floor(Number(row?.v ?? 0) / 10000)
}

export async function serverMajor(dbUrl: string): Promise<number | undefined> {
  const client = newPgClient(dbUrl)
  try {
    await client.connect()
    return await majorOf(client)
  } catch {
    return undefined
  } finally {
    await client.end().catch(() => {})
  }
}

/** One statement at a time: a failure is recorded and the rest still run. */
async function runIndependently(
  client: pg.Client,
  statements: PlannedSql[],
  result: PromoteResult,
): Promise<void> {
  for (const stmt of statements) {
    try {
      await client.query(stmt.sql)
      result.applied.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
    } catch (err) {
      result.errors.push({ check: stmt.check, issueId: stmt.issueId, error: errMsg(err) })
    }
  }
}

/**
 * Does this fix consist only of `ALTER TYPE ... ADD VALUE`?
 *
 * PostgreSQL lets that run inside a transaction but not the new label be
 * *used* there until it commits:
 *
 *     ERROR:  unsafe use of new value "refunded" of enum type order_state
 *     HINT:  New enum values must be committed before they can be used.
 *
 * and the same apply often uses it straight away — a column default, or a
 * reference-data row the data check inserts.
 */
export function isEnumValueAddition(sql: string): boolean {
  const statements = splitSqlStatements(sql).filter(s => !isCommentOnly(s))
  return statements.length > 0
    && statements.every(s => /^\s*ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE\b/i.test(sqlSkeleton(s)))
}

/**
 * All statements in one transaction, each fix under a savepoint of its own.
 *
 * A fix that fails because the target lacks something it needs — an extension
 * the server does not ship, the type or schema that extension would have
 * created, a table or column an earlier such fix would have added — is undone
 * on its own and reported as an error, and the rest still commit. One column
 * typed `extensions.vector` on a target without pgvector used to roll back
 * every unrelated fix in the apply, which left nothing synced at all.
 *
 * Every other failure still rolls back everything. What ran before it moves to
 * `rolledBack` rather than `applied`, because none of it is in the target any
 * more.
 *
 * Enum label additions go first, in a transaction of their own that commits,
 * so the rest can use the new labels — see isEnumValueAddition. They are
 * additive and idempotent (`IF NOT EXISTS`), so keeping them when the rest
 * rolls back leaves nothing half-done; they are reported as applied because
 * they are.
 */
async function runInTransaction(
  client: pg.Client,
  statements: PlannedSql[],
  result: PromoteResult,
  olderTarget = false,
): Promise<void> {
  const additions = statements.filter(s => isEnumValueAddition(s.sql))
  const rest = statements.filter(s => !isEnumValueAddition(s.sql))

  const warning = lockBudgetWarning(estimateLocks(rest.map(s => s.sql)), await readLockBudget(client), 'This apply')
  if (warning) result.warnings = [...(result.warnings ?? []), warning]

  if (additions.length > 0 && !(await runBatch(client, additions, result, olderTarget))) return
  await runBatch(client, rest, result, olderTarget)
}

/**
 * Why a fix cannot apply to this target at all, or undefined when the failure
 * is something else.
 *
 * Only "does not exist" failures qualify, and for `CREATE EXTENSION`, an
 * extension the server does not ship.
 */
export function unmetDependency(sql: string, err: unknown, olderTarget = false): string | undefined {
  const code = sqlState(err)
  if (!code) return undefined
  if (olderTarget && OLDER_SERVER.has(code)) {
    return "the target's PostgreSQL is older than the source's and does not support it"
  }
  if (/^\s*CREATE\s+EXTENSION\b/i.test(sqlSkeleton(sql))) {
    return EXTENSION_UNAVAILABLE.has(code) ? 'this server does not ship it' : undefined
  }
  if (ABSENT_ON_TARGET.has(code) || code === UNDEFINED_COLUMN) {
    return 'it needs something the target does not have'
  }
  return undefined
}

/**
 * Whether `sql` only revokes privileges on one object, so that object being
 * absent leaves nothing to do. Asked only of a fix that failed because
 * something does not exist, once retrying it after the others no longer
 * helps — a view dropped and created again by the same apply takes its
 * revoke after the creation.
 */
export function revokesFromAbsent(sql: string): boolean {
  const statements = parseStatements(sql)
  if (!statements?.length) return false
  const targets = new Set<string>()
  for (const { kind, node } of statements) {
    if (kind !== 'GrantStmt' || node.is_grant || node.targtype !== 'ACL_TARGET_OBJECT') return false
    if ((node.objects ?? []).length !== 1) return false
    // Where in the text each was written is not which object it is.
    targets.add(JSON.stringify([node.objtype, node.objects[0]], (key, value) => key === 'location' ? undefined : value))
  }
  return targets.size === 1
}


/** One transaction; true when it committed. */
async function runBatch(
  client: pg.Client,
  statements: PlannedSql[],
  result: PromoteResult,
  olderTarget = false,
): Promise<boolean> {
  if (statements.length === 0) return true
  const done: PromoteResult['applied'] = []
  await client.query('BEGIN')

  // Fixes whose dependency is missing are tried again once the others have
  // run, in case what they need comes later in the batch. Only the ones still
  // failing when a pass makes no progress are left out.
  let pending = statements
  let unmet: Array<{ stmt: PlannedSql; err: unknown; why: string }> = []
  while (pending.length > 0) {
    unmet = []
    for (const stmt of pending) {
      await client.query('SAVEPOINT sf_fix')
      try {
        await client.query(stmt.sql)
        await client.query('RELEASE SAVEPOINT sf_fix')
        done.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
      } catch (err) {
        const why = unmetDependency(stmt.sql, err, olderTarget)
        if (why && await client.query('ROLLBACK TO SAVEPOINT sf_fix').then(() => true, () => false)) {
          unmet.push({ stmt, err, why })
          continue
        }
        await client.query('ROLLBACK').catch(() => {})
        result.errors.push({ check: stmt.check, issueId: stmt.issueId, error: errMsg(err) })
        result.rolledBack = [...(result.rolledBack ?? []), ...done]
        return false
      }
    }
    if (unmet.length === pending.length) break
    pending = unmet.map(u => u.stmt)
  }

  // A revoke on an object the target no longer has — another fix in this
  // apply dropped it — has nothing left to take away: done, not left out.
  const gone = unmet.filter(u => revokesFromAbsent(u.stmt.sql))
  unmet = unmet.filter(u => !gone.includes(u))
  for (const { stmt } of gone) {
    done.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql, note: 'nothing to revoke: the object is not on the target' })
  }

  await client.query('COMMIT')
  result.applied.push(...done)
  for (const { stmt, err, why } of unmet) {
    result.errors.push({
      check: stmt.check,
      issueId: stmt.issueId,
      error: `${errMsg(err)} — not applied: ${why}. The other fixes were.`,
    })
  }
  return true
}

/** Run the planned API-based sync actions, recording per-action failures. */
async function executeApiActions(
  actions: PlannedAction[],
  fetchFn: FetchFn,
  result: PromoteResult,
): Promise<void> {
  for (const act of actions) {
    try {
      const init: RequestInit = {
        method: act.action.method,
        headers: { 'Content-Type': 'application/json', ...act.action.headers },
      }
      if (act.action.body !== undefined) {
        init.body = JSON.stringify(act.action.body)
      }

      const res = await fetchFn(act.action.url, init)
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(`${act.action.method} ${act.action.url} → ${res.status}: ${text}`)
      }

      result.applied.push({ check: act.check, issueId: act.issueId, action: act.action.label })
    } catch (err) {
      result.errors.push({ check: act.check, issueId: act.issueId, error: errMsg(err) })
    }
  }
}

export async function promote(options: PromoteOptions): Promise<PromoteResult> {
  const {
    dbUrl,
    scanResult,
    checks,
    dryRun = false,
    allowDestructive = false,
    tableFilter,
    only,
    applyPosture = false,
    transactional = true,
    fetchFn = globalThis.fetch.bind(globalThis),
  } = options

  // applyPosture was accepted by PromoteOptions and then dropped on the floor
  // here, so `--apply-posture` was a no-op through this path — the only caller
  // that honoured it was `--prove`, which calls planWork directly. The unit
  // tests covering the flag tested planWork rather than promote, which is
  // exactly why the gap survived them.
  const { sqlStatements, apiActions, skipped } = planWork(scanResult, {
    checks,
    allowDestructive,
    tableFilter,
    only,
    applyPosture,
  })
  const result: PromoteResult = { applied: [], skipped, errors: [] }

  if (dryRun) {
    for (const stmt of sqlStatements) {
      result.applied.push({ check: stmt.check, issueId: stmt.issueId, sql: stmt.sql })
    }
    for (const act of apiActions) {
      result.applied.push({ check: act.check, issueId: act.issueId, action: act.action.label })
    }
    return result
  }

  await executeSql(dbUrl, sqlStatements, result, transactional,
    options.sourceUrl ? await serverMajor(options.sourceUrl) : undefined)

  // A rolled-back batch leaves the target untouched, so the API calls that
  // would have gone with it must not fire either — they are not transactional
  // and could not be undone.
  if (result.rolledBack) {
    for (const act of apiActions) {
      result.skipped.push({
        check: act.check,
        issueId: act.issueId,
        reason: 'Not attempted — the SQL fixes were rolled back',
      })
    }
    return result
  }

  await executeApiActions(apiActions, fetchFn, result)

  return result
}
