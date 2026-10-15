import { destructiveReason } from './dbdiff.js'
import { parseStatements, relationName, type Statement } from './sql-ast.js'

/**
 * What applying a fix does to a live database, beyond what it changes.
 *
 * A fix can be correct and still take production down: an ALTER TABLE holds
 * a lock that stops every read and write while it runs, a column type change
 * may rewrite the whole table under it, a new CHECK scans every row. None of
 * that showed in a report, so a one-line fix and an hour-long outage looked
 * the same. Read from PostgreSQL's own parse of the fix, per statement, from
 * the lock levels PostgreSQL documents. A table the same fix creates has no
 * one waiting on it, so it is not flagged.
 */
export type HazardKind = 'data-loss' | 'blocks-reads-and-writes' | 'blocks-writes' | 'rewrite' | 'full-scan' | 'not-transactional'

export interface Hazard {
  kind: HazardKind
  /** The table it concerns, where there is one. */
  on?: string
  /** For a person. */
  detail: string
}

/** Defaults whose value differs per row, so adding the column writes every row. */
const VOLATILE = new Set(['random', 'gen_random_uuid', 'uuid_generate_v4', 'uuid_generate_v1', 'clock_timestamp', 'nextval', 'timeofday'])

const table = (rv: Record<string, any> | undefined) =>
  rv ? (rv.schemaname ? `${rv.schemaname}.${relationName(rv)}` : relationName(rv)) : ''

export function hazardsOf(sql: string): Hazard[] {
  const out: Hazard[] = []
  const add = (h: Hazard) => {
    if (!out.some(o => o.kind === h.kind && o.on === h.on)) out.push(h)
  }
  const loss = destructiveReason(sql)
  if (loss) add({ kind: 'data-loss', detail: loss })

  const statements = parseStatements(sql)
  if (!statements) return out
  const created = new Set(statements.filter(s => s.kind === 'CreateStmt').map(s => table(s.node.relation)))
  const existing = (name: string) => name !== '' && !created.has(name)

  for (const s of statements) {
    for (const h of statementHazards(s)) {
      if (h.on === undefined || existing(h.on)) add(h)
    }
  }
  return out
}

function statementHazards(s: Statement): Hazard[] {
  const n = s.node
  switch (s.kind) {
    case 'AlterTableStmt': return alterTableHazards(table(n.relation), n.cmds ?? [])
    case 'IndexStmt':
      return n.concurrent
        ? [{ kind: 'not-transactional', on: table(n.relation), detail: `builds an index concurrently, which cannot run inside a transaction` }]
        : [{ kind: 'blocks-writes', on: table(n.relation), detail: `blocks writes to ${table(n.relation)} while the index builds` }]
    case 'CreateTrigStmt':
      return [{ kind: 'blocks-writes', on: table(n.relation), detail: `blocks writes to ${table(n.relation)} briefly` }]
    case 'CreatePolicyStmt':
    case 'AlterPolicyStmt':
    case 'RuleStmt':
      return [{ kind: 'blocks-reads-and-writes', on: table(n.table ?? n.relation), detail: `blocks reads and writes on ${table(n.table ?? n.relation)} briefly` }]
    case 'RenameStmt':
      return n.relation ? [{ kind: 'blocks-reads-and-writes', on: table(n.relation), detail: `blocks reads and writes on ${table(n.relation)} briefly` }] : []
    case 'RefreshMatViewStmt':
      return n.concurrent ? [] : [{ kind: 'blocks-reads-and-writes', on: table(n.relation), detail: `blocks reads of ${table(n.relation)} while it refreshes` }]
    case 'VacuumStmt':
      return [{ kind: 'not-transactional', detail: 'VACUUM cannot run inside a transaction' }]
    case 'ReindexStmt':
      return (n.params ?? []).some((p: any) => p.DefElem?.defname === 'concurrently')
        ? [{ kind: 'not-transactional', detail: 'REINDEX CONCURRENTLY cannot run inside a transaction' }] : []
    default:
      return []
  }
}

function alterTableHazards(name: string, cmds: Array<Record<string, any>>): Hazard[] {
  const out: Hazard[] = []
  let exclusive = false
  let writesOnly = false
  for (const { AlterTableCmd: cmd } of cmds) {
    if (!cmd) continue
    switch (cmd.subtype) {
      // Lighter locks: other DDL waits, reads and writes go on.
      case 'AT_SetStatistics': case 'AT_SetOptions': case 'AT_ResetOptions': case 'AT_SetRelOptions':
      case 'AT_ResetRelOptions': case 'AT_ValidateConstraint': case 'AT_ClusterOn': case 'AT_DropCluster':
        continue
      case 'AT_AlterColumnType':
        out.push({ kind: 'rewrite', on: name, detail: `may rewrite ${name}: a column's type changes, unless the new type is binary-compatible` })
        break
      case 'AT_SetLogged': case 'AT_SetUnLogged':
        out.push({ kind: 'rewrite', on: name, detail: `rewrites ${name}: LOGGED and UNLOGGED tables are stored differently` })
        break
      case 'AT_AddColumn': {
        const def = cmd.def?.ColumnDef
        const constraints: any[] = def?.constraints ?? []
        const generated = constraints.some(c => c.Constraint?.contype === 'CONSTR_GENERATED')
        const volatile = constraints.some(c => c.Constraint?.contype === 'CONSTR_DEFAULT'
          && VOLATILE.has(String(c.Constraint.raw_expr?.FuncCall?.funcname?.at(-1)?.String?.sval ?? '')))
        if (generated || volatile) {
          out.push({ kind: 'rewrite', on: name, detail: `rewrites ${name}: the new column's ${generated ? 'generated value' : 'default'} is computed for every row` })
        }
        break
      }
      case 'AT_AddConstraint': {
        const c = cmd.def?.Constraint
        if (c && !c.skip_validation && (c.contype === 'CONSTR_CHECK' || c.contype === 'CONSTR_FOREIGN')) {
          out.push({ kind: 'full-scan', on: name, detail: `scans every row of ${name} to check the new constraint (NOT VALID, then VALIDATE, avoids holding the lock)` })
        }
        if (c?.contype === 'CONSTR_FOREIGN') {
          writesOnly = true
          continue
        }
        break
      }
      case 'AT_SetNotNull':
        out.push({ kind: 'full-scan', on: name, detail: `scans every row of ${name} to check for NULLs` })
        break
    }
    exclusive = true
  }
  if (exclusive) {
    out.unshift({ kind: 'blocks-reads-and-writes', on: name, detail: `blocks reads and writes on ${name} while it runs` })
  } else if (writesOnly) {
    out.unshift({ kind: 'blocks-writes', on: name, detail: `blocks writes to ${name} while the key is checked` })
  }
  return out
}
