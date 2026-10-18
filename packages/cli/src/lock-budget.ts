/**
 * Whether one transaction can hold the locks a restore or an apply takes.
 *
 * Every relation a transaction creates, alters, drops or reads stays locked
 * until it commits, and PostgreSQL keeps those locks in one table shared by
 * the whole server: `max_locks_per_transaction` for each of its backend
 * slots — connections, autovacuum and background workers, WAL senders — and
 * prepared transactions, less what other sessions hold. A large
 * restore in one transaction can run out part way, after minutes of work,
 * and roll everything back with "out of shared memory".
 *
 * So the statements are counted first, and the run warns before it starts
 * when they look likely to need more than the server has. It only warns: the
 * table can grow into spare shared memory, so a count over the nominal size
 * may still fit.
 */
import type pg from 'pg'
import { parseStatements } from './sql-ast.js'

/** Constraints that build an index of their own. */
const INDEXED = new Set(['CONSTR_PRIMARY', 'CONSTR_UNIQUE', 'CONSTR_EXCLUSION'])

/**
 * About how many lock-table slots running `statements` in one transaction
 * holds: one per distinct relation named, one per index or identity
 * sequence made along the way, and two per new table for its TOAST table
 * and index. Generous on purpose; a statement that does not parse counts one.
 */
export function estimateLocks(statements: string[]): number {
  const relations = new Set<string>()
  let made = 0
  for (const sql of statements) {
    const parsed = parseStatements(sql)
    if (!parsed) {
      made += 1
      continue
    }
    for (const { kind, node } of parsed) {
      if (kind === 'CreateStmt') made += 2
      if (kind === 'IndexStmt') made += 1
      walk(node, (key, value) => {
        // A relation: wrapped as `RangeVar` in a list, bare in a field of its own.
        if (typeof value.relname === 'string') relations.add(`${value.schemaname ?? ''}.${value.relname}`.toLowerCase())
        if (key === 'Constraint' && (INDEXED.has(value.contype) || value.contype === 'CONSTR_IDENTITY')) made += 1
      })
    }
  }
  return relations.size + made
}

function walk(node: unknown, visit: (key: string, value: any) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) visit(key, value)
      walk(value, visit)
    }
  }
}

export interface LockBudget {
  /** The server's lock table, in slots. */
  capacity: number
  /** Slots other sessions hold now. */
  inUse: number
}

/** The target's lock table, and how much of it is taken. Undefined when it cannot be read. */
export async function readLockBudget(client: Pick<pg.Client, 'query'>): Promise<LockBudget | undefined> {
  try {
    const { rows: [row] } = await client.query<{ capacity: string; in_use: string }>(`
      SELECT current_setting('max_locks_per_transaction')::bigint
               * (current_setting('max_connections')::bigint
                  + coalesce(current_setting('autovacuum_worker_slots', true), current_setting('autovacuum_max_workers'))::bigint + 1
                  + current_setting('max_worker_processes')::bigint
                  + current_setting('max_wal_senders')::bigint
                  + current_setting('max_prepared_transactions')::bigint) AS capacity,
             (SELECT count(*) FROM pg_locks WHERE NOT fastpath) AS in_use`)
    return { capacity: Number(row.capacity), inUse: Number(row.in_use) }
  } catch {
    return undefined
  }
}

/**
 * A warning when `needed` slots look like more than the target has free,
 * keeping a tenth of the table for everyone else; undefined when they fit.
 */
export function lockBudgetWarning(needed: number, budget: LockBudget | undefined, what: string): string | undefined {
  if (!budget) return undefined
  const free = budget.capacity - budget.inUse - Math.ceil(budget.capacity / 10)
  if (needed <= free) return undefined
  return `${what} takes about ${needed} locks in one transaction, and the target has room for about ${Math.max(free, 0)} `
    + `(max_locks_per_transaction for each connection slot, less what other sessions hold). It may fail with `
    + `"out of shared memory" and roll back. Raising max_locks_per_transaction on the target (a restart) makes room; `
    + `--no-transaction commits as it goes instead.`
}
