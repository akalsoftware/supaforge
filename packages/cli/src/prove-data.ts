import { spawn } from 'node:child_process'
import { pgQuery } from './db'
import { parseStatements, relationName } from './sql-ast.js'
import { quoteIdent, quoteLiteral } from './utils/sql.js'

/**
 * The data half of a proof: that the rows survive the fixes.
 *
 * A schema can converge and the data not: a column dropped and added again
 * under a new name, a table recreated, a type changed with a lossy cast. The
 * proof's copy held no rows, so none of that showed. Now a bounded sample of
 * the target's rows — the first `rows` of each table — is copied into it
 * first. After the fixes, a table they keep must hold as many rows, and the
 * same ones where its columns are unchanged — unless a fix deletes from or
 * truncates it. A table rewritten on the copy (its storage replaced) is said
 * so too: on the real target that is a long lock.
 */
export interface TableSnapshot {
  rows: number
  /** Per column, by name: its type and a hash of its values (as a multiset). */
  columns: Record<string, { type: string; hash: string }>
  filenode: string
}

export interface DataProof {
  /** Tables sampled, and those whose sample could not be loaded (left unchecked). */
  sampled: string[]
  unchecked: string[]
  /** Kept tables that lost rows or whose rows changed, and how. */
  lost: string[]
  /** Tables whose storage the fixes replaced on the copy. */
  rewritten: string[]
}

export const DEFAULT_SAMPLE_ROWS = 1000

/** How many rows of each table to sample, from SUPAFORGE_PROVE_ROWS; 0 turns it off. */
export function sampleRows(): number {
  const raw = process.env.SUPAFORGE_PROVE_ROWS
  const n = raw === undefined ? DEFAULT_SAMPLE_ROWS : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SAMPLE_ROWS
}

const TABLES_SQL = `
  SELECT n.nspname || '.' || c.relname AS name, quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS ident,
         (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '') AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r' AND NOT c.relispartition AND n.nspname = ANY($1::text[])
   ORDER BY 1`

/** Copy up to `limit` rows of each table from `fromUrl` into the same tables at `intoUrl`. */
export async function sampleInto(psql: string, fromUrl: string, intoUrl: string, schemas: string[], limit: number): Promise<{ sampled: string[]; unchecked: string[] }> {
  const tables = await pgQuery(fromUrl, TABLES_SQL, [schemas]) as Array<{ name: string; ident: string; columns: string | null }>
  const sampled: string[] = []
  const unchecked: string[] = []
  for (const t of tables) {
    if (!t.columns) continue
    try {
      await pipeCopy(psql, fromUrl, intoUrl,
        `\\copy (SELECT ${t.columns} FROM ${t.ident} LIMIT ${limit}) TO STDOUT`,
        `\\copy ${t.ident} (${t.columns}) FROM STDIN`)
      sampled.push(t.name)
    } catch {
      // A sample that will not load — a row whose foreign key points at one
      // not sampled, where triggers cannot be set aside — is left unchecked.
      unchecked.push(t.name)
    }
  }
  return { sampled, unchecked }
}

function pipeCopy(psql: string, fromUrl: string, intoUrl: string, out: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = spawn(psql, [fromUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', out], { stdio: ['ignore', 'pipe', 'pipe'] })
    const writer = spawn(psql, [intoUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    reader.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    writer.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    reader.on('error', reject)
    writer.on('error', reject)
    writer.stdin.on('error', () => undefined)
    // Foreign keys and triggers set aside where the role may (a superuser),
    // so a sampled row need not find its parent sampled too; then the COPY,
    // whose rows follow on the same stream until it ends.
    writer.stdin.write(`\\set ON_ERROR_STOP 0\nSET session_replication_role = replica;\n\\set ON_ERROR_STOP 1\n${into}\n`)
    reader.stdout.pipe(writer.stdin)
    let done = 0
    let failed = false
    const finish = (code: number | null) => {
      if (code !== 0) failed = true
      if (++done === 2) failed ? reject(new Error(stderr.trim() || 'copy failed')) : resolve()
    }
    reader.on('close', finish)
    writer.on('close', finish)
  })
}

/**
 * Each table's row count, a hash of each column's values, and its storage.
 * A generated column is left out: its values follow its expression, which a
 * fix may mean to change.
 */
export async function snapshotTables(dbUrl: string, schemas: string[]): Promise<Map<string, TableSnapshot>> {
  const rows = await pgQuery(dbUrl, `
    SELECT n.nspname || '.' || c.relname AS name, quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS ident,
           json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     WHERE c.relkind = 'r' AND NOT c.relispartition AND n.nspname = ANY($1::text[])
     GROUP BY 1, 2 ORDER BY 1`, [schemas]) as Array<{ name: string; ident: string; columns: Array<[string, string]> }>
  const out = new Map<string, TableSnapshot>()
  for (const t of rows) {
    // Each value hashed, a NULL as 'n' (no hash is one letter long).
    const hashes = t.columns.map(([col], i) => {
      const value = `coalesce(md5(x.${quoteIdent(col)}::text), 'n')`
      return `coalesce(md5(string_agg(${value}, '' ORDER BY ${value})), '') AS h${i}`
    })
    const [row] = await pgQuery(dbUrl,
      `SELECT count(*)::text AS rows, pg_relation_filenode(${quoteLiteral(t.ident)}::regclass)::text AS filenode${hashes.length ? ', ' + hashes.join(', ') : ''}
         FROM ${t.ident} x`) as Array<Record<string, string>>
    out.set(t.name, {
      rows: Number(row.rows),
      filenode: row.filenode,
      columns: Object.fromEntries(t.columns.map(([col, type], i) => [col, { type, hash: row[`h${i}`] }])),
    })
  }
  return out
}

/** The tables a fix deletes from or empties, whose rows are meant to go. */
export function emptiedTables(sql: string): Set<string> {
  const out = new Set<string>()
  for (const s of parseStatements(sql) ?? []) {
    if (s.kind === 'DeleteStmt') out.add(relationName(s.node.relation))
    if (s.kind === 'TruncateStmt') for (const r of s.node.relations ?? []) out.add(relationName(r.RangeVar))
  }
  return out
}

/**
 * What became of the sampled rows: fewer of them in a table the fixes keep,
 * or, in a column that is there before and after with the same type,
 * different values.
 */
export function compareTables(before: Map<string, TableSnapshot>, after: Map<string, TableSnapshot>, sampled: string[], migrationSql: string): Pick<DataProof, 'lost' | 'rewritten'> {
  const emptied = emptiedTables(migrationSql)
  const lost: string[] = []
  const rewritten: string[] = []
  for (const name of sampled) {
    const b = before.get(name)
    const a = after.get(name)
    if (!b || !a) continue
    if (b.filenode !== a.filenode) rewritten.push(name)
    if (emptied.has(name.slice(name.indexOf('.') + 1))) continue
    if (a.rows < b.rows) {
      lost.push(`${name}: ${b.rows} row(s) before, ${a.rows} after`)
      continue
    }
    if (a.rows !== b.rows) continue
    const changed = Object.entries(b.columns)
      .filter(([col, c]) => a.columns[col] && a.columns[col].type === c.type && a.columns[col].hash !== c.hash)
      .map(([col]) => col)
    if (changed.length > 0) {
      lost.push(`${name}: values changed in ${changed.join(', ')}`)
    }
  }
  return { lost, rewritten }
}

