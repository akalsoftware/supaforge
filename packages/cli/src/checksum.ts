import type { QueryFn } from './db'
import { pgQuery } from './db'
import { quoteIdent } from './utils/sql'

/**
 * Table-level checksums, used to skip the expensive row-by-row diff.
 *
 * This was a row count plus `pg_total_relation_size`, both catalog reads that
 * never touch the rows — and never noticed a change either (issue #90). An
 * update, an insert and a delete together leave the count where it was; any
 * same-length value change leaves both numbers identical. In the report three
 * data changes went unreported and the drift score stayed at 100.
 *
 * So the fingerprint is now a digest of the contents. It costs a sequential
 * scan per table per side, which is the right trade for this check: it compares
 * *reference* tables the user names in `checks.data.tables`, not the whole
 * database.
 */

export interface TableFingerprint {
  table: string
  rowCount: number
  /**
   * A digest of every row, order-independent.
   *
   * Two databases can hold the same rows in different physical order, so the
   * per-row digests are combined by summing rather than in scan order —
   * otherwise an identical table would fingerprint differently after a
   * VACUUM FULL.
   */
  content: string
}

/**
 * Compute a content fingerprint for a single table.
 *
 * `ROW(t.*)::text` renders a whole row, so the digest covers every column
 * without naming any — which keeps this working when the two sides disagree
 * about column order or one has a column the other does not. It was `t::text`,
 * which names a column instead when the table has one called `t`: the digest
 * covered that column alone, and a change anywhere else skipped the table as
 * unchanged.
 *
 * Its rendering can depend on server settings for a few types, so two identical
 * tables can in principle digest differently. That direction is safe: the table
 * is then handed to dbdiff, which compares it properly and reports nothing. The
 * direction that must not happen is a difference the fingerprint cannot see —
 * which `extra_float_digits = 0`, Supabase's default, caused: both sides print
 * 0.30000000000000004 and 0.3 alike. The pooled connections pin it (db.ts).
 */
export async function getTableFingerprint(
  dbUrl: string,
  table: string,
  queryFn: QueryFn = pgQuery,
): Promise<TableFingerprint> {
  // Two running sums over the halves of each row's md5, rather than one md5
  // over every row's digest concatenated in order. Both are order-independent
  // and count a duplicated row twice; the sums need constant memory, where the
  // concatenation built a 32-byte-per-row string and failed at PostgreSQL's
  // 1 GB limit — about 33 million rows.
  const sql = `
    SELECT count(*)::int AS row_count,
           coalesce(sum(('x' || substr(d, 1, 16))::bit(64)::bigint::numeric), 0)::text
             || ':' ||
           coalesce(sum(('x' || substr(d, 17, 16))::bit(64)::bigint::numeric), 0)::text AS content
    FROM (SELECT md5(ROW(t.*)::text) AS d FROM ${quoteIdent(table)} t) s
  `
  const [row] = await queryFn(dbUrl, sql) as unknown as [{ row_count: number; content: string }]
  return {
    table,
    rowCount: row.row_count,
    content: row.content,
  }
}

/**
 * Compare two tables across environments by fingerprint.
 *
 * True means the contents match and the full diff can be skipped.
 */
export async function tablesMatch(
  sourceUrl: string,
  targetUrl: string,
  table: string,
  queryFn: QueryFn = pgQuery,
): Promise<boolean> {
  const [source, target] = await Promise.all([
    getTableFingerprint(sourceUrl, table, queryFn),
    getTableFingerprint(targetUrl, table, queryFn),
  ])
  return source.rowCount === target.rowCount && source.content === target.content
}

/**
 * Filter a list of tables to only those that differ between environments.
 * Tables that match on fingerprint are skipped — saving expensive row-by-row diffs.
 */
export async function filterChangedTables(
  sourceUrl: string,
  targetUrl: string,
  tables: string[],
  queryFn: QueryFn = pgQuery,
): Promise<{ changed: string[]; skipped: string[] }> {
  const changed: string[] = []
  const skipped: string[] = []

  // Check tables in parallel for speed
  const results = await Promise.all(
    tables.map(async table => {
      try {
        const match = await tablesMatch(sourceUrl, targetUrl, table, queryFn)
        return { table, match }
      } catch {
        // If fingerprint fails (table doesn't exist, etc.), include it in the diff
        return { table, match: false }
      }
    }),
  )

  for (const { table, match } of results) {
    if (match) {
      skipped.push(table)
    } else {
      changed.push(table)
    }
  }

  return { changed, skipped }
}
