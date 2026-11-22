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
  seq: string
  max: string | null
}

/** Each serial or identity column of `table` with its sequence and the largest value in it. */
const SOURCE_SQL = (table: string) => `
  SELECT a.attname AS col, pg_get_serial_sequence(${quoteLiteral(quoteIdent(table))}, a.attname) AS seq
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass(${quoteLiteral(quoteIdent(table))}) AND a.attnum > 0 AND NOT a.attisdropped
     AND pg_get_serial_sequence(${quoteLiteral(quoteIdent(table))}, a.attname) IS NOT NULL
   ORDER BY a.attnum`

/**
 * The next value the target's sequence for `col` would hand out, or null when
 * the target has no such table or sequence yet (a schema fix will create it).
 * A sequence counting down is left alone.
 */
const TARGET_SQL = `
  SELECT s.seqincrement > 0 AS ascending,
         (coalesce(pg_sequence_last_value(s.seqrelid) + s.seqincrement, s.seqstart))::text AS next
    FROM pg_sequence s
   WHERE s.seqrelid = to_regclass(pg_get_serial_sequence($1, $2))`

/**
 * The fix: run after the rows, on the target as they leave it. Sets the
 * sequence to the largest id in the table when that is at or past the next
 * value it would hand out, and does nothing otherwise.
 */
export function sequenceFixSql(table: string, col: string): string {
  const rel = quoteLiteral(quoteIdent(table))
  return `SELECT setval(seq, top) FROM (SELECT pg_get_serial_sequence(${rel}, ${quoteLiteral(col)})::regclass AS seq,`
    + ` (SELECT max(${quoteName(col)}) FROM ${quoteIdent(table)}) AS top) x`
    + ` JOIN pg_sequence s ON s.seqrelid = x.seq`
    + ` WHERE top IS NOT NULL AND s.seqincrement > 0`
    + ` AND top >= coalesce(pg_sequence_last_value(x.seq) + s.seqincrement, s.seqstart);`
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
