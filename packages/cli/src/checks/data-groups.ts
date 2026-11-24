import type { DriftIssue } from '../types/drift'
import { writtenTable } from '../data-sync.js'

/**
 * The data check's findings: the rows of one table to insert, update or
 * delete, in batches.
 *
 * Each row was a finding of its own, with a fix of its own. A sync of
 * 100,000 rows was 100,000 findings — some 1.4 KB of JSON each, most of it the
 * same title and description — and 100,000 fixes, each three round trips
 * (savepoint, statement, release): 15 minutes over a 50 ms link for 5,000
 * rows, hours for the 100,000. And `data-insert-17` named a position, so the
 * same id could be a different row in the next scan.
 *
 * Consecutive statements of one kind on one table are now one finding, of up
 * to MAX_ROWS rows and MAX_BYTES of SQL, sent in one round trip. Order is
 * kept: the statements are DBDiff's, in DBDiff's order, and only neighbours
 * are joined. A finding is named by what it is, `data-insert-public.plans`,
 * and a table with more rows than one batch holds goes on in
 * `data-insert-public.plans:2`, `:3`.
 */

export const MAX_ROWS = 1000
export const MAX_BYTES = 4 * 1024 * 1024

type Kind = 'insert' | 'update' | 'delete'

function kindOf(sql: string): Kind | undefined {
  const head = /^\s*(INSERT|UPDATE|DELETE)\b/i.exec(sql)?.[1]?.toUpperCase()
  return head === 'INSERT' ? 'insert' : head === 'UPDATE' ? 'update' : head === 'DELETE' ? 'delete' : undefined
}

/** `"public"."plans"` / `plans` / `"app"."orders"` → `public.plans`, `app.orders`: the name a person reads. */
function tableName(written: string): string {
  const parts = written.match(/"(?:[^"]|"")*"|[^.\s]+/g) ?? [written]
  const names = parts.map(p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase()))
  return names.length === 1 ? `public.${names[0]}` : names.join('.')
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

function titleOf(kind: Kind, table: string, rows: number): string {
  if (kind === 'insert') return `${plural(rows, 'row', 'rows')} missing from ${table}`
  if (kind === 'delete') return `${plural(rows, 'extra row', 'extra rows')} in ${table}`
  return `${plural(rows, 'row', 'rows')} modified in ${table}`
}

function descriptionOf(kind: Kind, rows: number): string {
  const these = rows === 1 ? 'it' : 'them'
  if (kind === 'insert') return `Rows in the source are missing from the target. The fix inserts ${these}.`
  if (kind === 'delete') return `The target has rows the source does not. The fix deletes ${these} from the target.`
  return 'Rows differ between source and target. The fix updates the target\'s rows to match.'
}

/**
 * The findings for DBDiff's data statements, UP and DOWN paired by position
 * as before. A batch's DOWN undoes its rows last first. A statement that is
 * none of the three is a finding on its own, as every statement was.
 */
export function dataIssues(up: string[], down: string[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const batches = new Map<string, number>()
  let i = 0
  while (i < up.length) {
    const kind = kindOf(up[i])
    const written = kind ? writtenTable(up[i]) : undefined
    if (!kind || !written) {
      issues.push({
        id: `data-change-${i + 1}`,
        check: 'data',
        severity: 'warning',
        title: 'Data change',
        description: 'The target\'s rows differ from the source\'s.',
        sql: { up: up[i], down: down[i] ?? '' },
      })
      i++
      continue
    }
    let j = i
    let bytes = 0
    while (j < up.length && j - i < MAX_ROWS && (j === i || bytes + up[j].length <= MAX_BYTES)
      && kindOf(up[j]) === kind && writtenTable(up[j]) === written) {
      bytes += up[j].length
      j++
    }
    const table = tableName(written)
    const base = `data-${kind}-${table}`
    const n = (batches.get(base) ?? 0) + 1
    batches.set(base, n)
    const rows = j - i
    issues.push({
      id: n === 1 ? base : `${base}:${n}`,
      check: 'data',
      // As each row's finding was: a delete waits for --allow-destructive.
      severity: 'warning',
      title: titleOf(kind, table, rows),
      description: descriptionOf(kind, rows),
      rows,
      sql: { up: up.slice(i, j).join('\n'), down: down.slice(i, j).reverse().join('\n') },
    })
    i = j
  }
  return issues
}
