/**
 * The sequences behind the reference tables' serial and identity columns.
 *
 * A data sync writes the source's ids into the target, and a sequence is not
 * a row: it stayed where it was. The app's next insert then took an id the
 * sync had just written — `duplicate key value violates unique constraint` —
 * on every table whose rows the target had not made itself. Restore moved its
 * sequences past the rows it wrote; sync did not.
 *
 * Read from the state of the two databases, not from what this run will
 * change, so a target synced before this check existed is caught too: a
 * sequence whose next value is at or below the largest id the source holds
 * gets a fix. The fix itself reads the target as the apply leaves it, and only
 * ever moves a sequence forward. `setval` is not undone by a rollback, and
 * forward is the direction that can't hand out an id twice.
 */
import type { DriftIssue } from '../types/drift'
import type { QueryFn } from '../db'
import { quoteIdent, quoteLiteral, quoteName } from '../utils/sql'

interface ColumnSequence {
  col: string
}

/**
 * The sequence a serial or identity column owns, joined from the column:
 * what pg_get_serial_sequence() reads, without its error for a table or
 * column that isn't there — a table the sync is about to create is the usual
 * case on the target, and inside a prepared statement no CASE keeps the
 * function from being called.
 */
const OWNED = (table: string) => `pg_depend d
    JOIN pg_sequence q ON q.seqrelid = d.objid
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid AND NOT a.attisdropped
   WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
     AND d.refobjid = to_regclass(${table})`

/** Each serial or identity column of `table`. */
const SOURCE_SQL = (table: string) => `SELECT a.attname AS col FROM ${OWNED(quoteLiteral(quoteIdent(table)))} ORDER BY a.attnum`

/**
 * The next value the target's sequence for column $2 of table $1 would hand
 * out; no row when the target has no such table or sequence yet (a schema
 * fix will create it). A sequence counting down is left alone.
 */
const TARGET_SQL = `
  SELECT q.seqincrement > 0 AS ascending,
         (coalesce(pg_sequence_last_value(q.seqrelid) + q.seqincrement, q.seqstart))::text AS next
    FROM ${OWNED('$1')} AND a.attname = $2`

/**
 * The fix: run after the rows, on the target as they leave it. Sets the
 * sequence to the largest id in the table when that is at or past the next
 * value it would hand out, and does nothing otherwise.
 */
export function sequenceFixSql(table: string, col: string): string {
  return `SELECT setval(q.seqrelid, top) FROM (SELECT max(${quoteName(col)}) AS top FROM ${quoteIdent(table)}) x,`
    + ` ${OWNED(quoteLiteral(quoteIdent(table))).replace(/\s+/g, ' ')} AND a.attname = ${quoteLiteral(col)}`
    + ` AND top IS NOT NULL AND q.seqincrement > 0`
    + ` AND top >= coalesce(pg_sequence_last_value(q.seqrelid) + q.seqincrement, q.seqstart);`
}

/** One finding per table with a sequence the synced rows would run into. */
export async function sequenceIssues(
  sourceUrl: string,
  targetUrl: string,
  tables: string[],
  queryFn: QueryFn,
): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = []
  for (const table of tables) {
    const columns = await queryFn(sourceUrl, SOURCE_SQL(table)) as unknown as ColumnSequence[]
    const behind: string[] = []
    const fixes: string[] = []
    for (const column of columns) {
      const [{ max }] = await queryFn(sourceUrl,
        `SELECT max(${quoteName(column.col)})::text AS max FROM ${quoteIdent(table)}`) as unknown as [{ max: string | null }]
      if (max === null) continue
      const [target] = await queryFn(targetUrl, TARGET_SQL, [quoteIdent(table), column.col]) as unknown as
        Array<{ ascending: boolean; next: string } | undefined>
      if (target && (!target.ascending || BigInt(target.next) > BigInt(max))) continue
      behind.push(target
        ? `${column.col} (next ${target.next}, rows up to ${max})`
        : `${column.col} (rows up to ${max}, on a sequence the sync creates)`)
      fixes.push(sequenceFixSql(table, column.col))
    }
    if (fixes.length === 0) continue
    issues.push({
      id: `data-sequence-${table}`,
      check: 'data',
      severity: 'warning',
      title: `Sequence behind the rows in ${table}`,
      description: `The ids synced into ${table} reach past what its sequence would hand out next: ${behind.join(', ')}. `
        + 'The next insert would fail with a duplicate key, so the sequence is moved past them after the rows are written.',
      sql: { up: fixes.join('\n'), down: '' },
    })
  }
  return issues
}
