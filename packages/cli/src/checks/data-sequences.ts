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

/** A column that draws its ids from a sequence, by its table's position in the list asked about. */
interface ColumnSequence {
  t: number
  col: string
}

/**
 * The sequence each column of `table` draws its ids from: one a serial or
 * identity column owns (what pg_get_serial_sequence() reads, without its
 * error for a table that isn't there — a table the sync is about to create is
 * the usual case on the target), or one its default calls, `DEFAULT
 * nextval('order_no')`, which no column owns and was left behind the synced
 * rows. A sequence several columns share is moved past each one's rows in
 * turn, only ever forward, so it ends past them all.
 */
const OWNED = (table: string) => `(SELECT d.objid AS seqrelid, d.refobjid AS relid, d.refobjsubid AS attnum FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
          UNION
          SELECT d.refobjid, ad.adrelid, ad.adnum FROM pg_depend d JOIN pg_attrdef ad ON ad.oid = d.objid
           WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'n') s
    JOIN pg_sequence q ON q.seqrelid = s.seqrelid
    JOIN pg_attribute a ON a.attrelid = s.relid AND a.attnum = s.attnum AND NOT a.attisdropped
   WHERE s.relid = to_regclass(${table})`

/**
 * Each sequence-backed column of each table in $1, by the table's position.
 * One query for every table: this check was one per table and two per
 * column, each a round trip.
 */
const SOURCE_SQL = `
  SELECT t.ord::int - 1 AS t, a.col FROM unnest($1::text[]) WITH ORDINALITY t(name, ord)
   CROSS JOIN LATERAL (SELECT DISTINCT a.attname AS col, a.attnum FROM ${OWNED('t.name')}) a
   ORDER BY t.ord, a.attnum`

/**
 * For each (table $1[i], column $2[i]), the next value the target's sequence
 * would hand out; no row for one the target has no such table or sequence for
 * yet (a schema fix will create it). A sequence counting down is left alone.
 */
const TARGET_SQL = `
  SELECT p.ord::int - 1 AS i, q.seqincrement > 0 AS ascending,
         (coalesce(pg_sequence_last_value(q.seqrelid) + q.seqincrement, q.seqstart))::text AS next
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY p(name, col, ord)
   CROSS JOIN LATERAL (SELECT q.seqrelid, q.seqincrement, q.seqstart FROM ${OWNED('p.name')} AND a.attname = p.col LIMIT 1) q`

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

/**
 * One finding per table with a sequence the synced rows would run into.
 * Three queries however many tables: the columns, every column's largest
 * value on the source, and every sequence's next value on the target.
 */
export async function sequenceIssues(
  sourceUrl: string,
  targetUrl: string,
  tables: string[],
  queryFn: QueryFn,
): Promise<DriftIssue[]> {
  if (tables.length === 0) return []
  const columns = ((await queryFn(sourceUrl, SOURCE_SQL, [tables.map(quoteIdent)])) ?? []) as unknown as ColumnSequence[]
  if (columns.length === 0) return []
  const maxSql = columns
    .map((c, i) => `SELECT ${i} AS i, max(${quoteName(c.col)})::text AS max FROM ${quoteIdent(tables[c.t])}`)
    .join('\nUNION ALL\n')
  const maxima = new Map(((await queryFn(sourceUrl, maxSql)) as unknown as Array<{ i: number; max: string | null }>)
    .map(r => [Number(r.i), r.max]))
  const targets = new Map(((await queryFn(targetUrl, TARGET_SQL,
    [columns.map(c => quoteIdent(tables[c.t])), columns.map(c => c.col)])) as unknown as
    Array<{ i: number; ascending: boolean; next: string }>).map(r => [Number(r.i), r]))

  const issues: DriftIssue[] = []
  tables.forEach((table, t) => {
    const behind: string[] = []
    const fixes: string[] = []
    columns.forEach((column, i) => {
      if (column.t !== t) return
      const max = maxima.get(i)
      if (max === null || max === undefined) return
      const target = targets.get(i)
      if (target && (!target.ascending || BigInt(target.next) > BigInt(max))) return
      behind.push(target
        ? `${column.col} (next ${target.next}, rows up to ${max})`
        : `${column.col} (rows up to ${max}, on a sequence the sync creates)`)
      fixes.push(sequenceFixSql(table, column.col))
    })
    if (fixes.length === 0) return
    issues.push({
      id: `data-sequence-${table}`,
      check: 'data',
      severity: 'warning',
      title: `Sequence behind the rows in ${table}`,
      description: `The ids synced into ${table} reach past what its sequence would hand out next: ${behind.join(', ')}. `
        + 'The next insert would fail with a duplicate key, so the sequence is moved past them after the rows are written.',
      sql: { up: fixes.join('\n'), down: '' },
    })
  })
  return issues
}

/**
 * Sequences of their own: no column owns one or draws its default from it,
 * and no extension does. An invoice or ticket number is the usual case, kept
 * by the app calling nextval() itself, so no row says where it should be.
 */
const COUNTERS_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, pg_sequence_last_value(c.oid)::text AS last,
         (coalesce(pg_sequence_last_value(c.oid) + q.seqincrement, q.seqstart))::text AS next,
         q.seqincrement > 0 AS ascending
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_sequence q ON q.seqrelid = c.oid
   WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_attrdef'::regclass AND d.refobjid = c.oid)`

interface Counter { schema: string; name: string; last: string | null; next: string; ascending: boolean }

/** Moves the target's counter to the source's last value, if that is at or past what it would hand out next. */
export function counterFixSql(qualified: string, last: string): string {
  return `SELECT setval(q.seqrelid, ${BigInt(last)}) FROM pg_sequence q WHERE q.seqrelid = to_regclass(${quoteLiteral(qualified)})`
    + ` AND q.seqincrement > 0 AND ${BigInt(last)} >= coalesce(pg_sequence_last_value(q.seqrelid) + q.seqincrement, q.seqstart);`
}

/**
 * Sequences of their own that the source has counted past the target.
 * Nothing in the rows says where one belongs, and moving a counter takes
 * numbers the target will never hand out — an invoice series gets a gap — so
 * it moves only when `checks.data.sequences` names it; otherwise it is
 * reported. Only ever forward.
 */
export async function counterIssues(
  sourceUrl: string,
  targetUrl: string,
  configured: string[],
  ignoreSchemas: string[],
  queryFn: QueryFn,
  matches: (name: string, pattern: string) => boolean,
): Promise<DriftIssue[]> {
  const [source, target] = await Promise.all([
    queryFn(sourceUrl, COUNTERS_SQL) as unknown as Promise<Counter[]>,
    queryFn(targetUrl, COUNTERS_SQL) as unknown as Promise<Counter[]>,
  ])
  const onTarget = new Map(target.map(t => [`${t.schema}.${t.name}`, t]))
  const issues: DriftIssue[] = []
  for (const s of source) {
    if (ignoreSchemas.some(p => matches(s.schema, p)) || !s.ascending || s.last === null) continue
    const qualified = `${s.schema}.${s.name}`
    const t = onTarget.get(qualified)
    // One the target lacks is the schema check's to create, with the source's state.
    if (!t || !t.ascending || BigInt(t.next) > BigInt(s.last)) continue
    const named = configured.some(p => matches(qualified, p) || (s.schema === 'public' && matches(s.name, p)))
    issues.push({
      id: `data-counter-${qualified}`,
      check: 'data',
      severity: named ? 'warning' : 'info',
      title: `Sequence ${qualified} behind the source's`,
      description: `The source's ${qualified} has reached ${s.last}; the target's would hand out ${t.next} next. `
        + 'No column takes its ids from it, so the rows say nothing about where it belongs.',
      ...(named
        ? { sql: { up: counterFixSql(qualified, s.last), down: '' } }
        : { manualOnly: `A sequence of its own, moved only when named: add "${qualified}" to checks.data.sequences to move the target's forward to the source's.` }),
    })
  }
  return issues
}
