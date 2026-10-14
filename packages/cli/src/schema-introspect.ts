import type pg from 'pg'
import { pgClientConfig, newPgPool } from './db.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
  default: string | null
  identity: string | null
  generated: string | null
}

export interface SchemaIndex {
  name: string
  definition: string
  unique: boolean
}

export interface SchemaConstraint {
  name: string
  type: string
  definition: string
}

export interface SchemaTable {
  schema: string
  name: string
  columns: SchemaColumn[]
  indexes: SchemaIndex[]
  constraints: SchemaConstraint[]
}

export interface SchemaView {
  schema: string
  name: string
  definition: string
}

export interface SchemaFunction {
  schema: string
  name: string
  args: string
  returnType: string
  language: string
  definition: string
}

export interface SchemaTrigger {
  schema: string
  table: string
  name: string
  definition: string
}

export interface SchemaSequence {
  schema: string
  name: string
  dataType: string
  startValue: string
  increment: string
  minValue: string
  maxValue: string
}

export interface SchemaEnum {
  schema: string
  name: string
  labels: string[]
}

export interface SchemaSnapshot {
  tables: SchemaTable[]
  views: SchemaView[]
  functions: SchemaFunction[]
  triggers: SchemaTrigger[]
  sequences: SchemaSequence[]
  enums: SchemaEnum[]
}

// ─── Query type for testability ──────────────────────────────────────────────

type ClientQueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

// ─── Schema Introspection ────────────────────────────────────────────────────

/**
 * Introspect a database schema using pg_catalog queries.
 * Returns structured JSON suitable for diffing between environments.
 *
 * Uses a connection pool to support parallel queries safely.
 */
export async function introspectSchema(
  dbUrl: string,
  ignoreSchemas: string[],
  clientQueryFn?: ClientQueryFn,
): Promise<SchemaSnapshot> {
  let queryFn: ClientQueryFn
  let pool: pg.Pool | undefined

  if (clientQueryFn) {
    queryFn = clientQueryFn
  } else {
    pool = newPgPool({ ...pgClientConfig(dbUrl), max: 6 })
    queryFn = async (sql, params) => {
      const { rows } = await pool!.query(sql, params)
      return rows
    }
  }

  try {
    const schemaFilter = buildSchemaFilter(ignoreSchemas)

    const [tables, views, functions, triggers, sequences, enums] = await Promise.all([
      fetchTables(queryFn, schemaFilter),
      fetchViews(queryFn, schemaFilter),
      fetchFunctions(queryFn, schemaFilter),
      fetchTriggers(queryFn, schemaFilter),
      fetchSequences(queryFn, schemaFilter),
      fetchEnums(queryFn, schemaFilter),
    ])

    return { tables, views, functions, triggers, sequences, enums }
  } finally {
    await pool?.end()
  }
}

// ─── Schema filter helper ────────────────────────────────────────────────────

interface SchemaFilter {
  clause: string
  params: unknown[]
}

function buildSchemaFilter(ignoreSchemas: string[]): SchemaFilter {
  if (ignoreSchemas.length === 0) {
    return { clause: '', params: [] }
  }
  const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
  return {
    clause: `AND n.nspname NOT IN (${placeholders})`,
    params: [...ignoreSchemas],
  }
}

// ─── Tables ──────────────────────────────────────────────────────────────────

async function fetchTables(query: ClientQueryFn, sf: SchemaFilter): Promise<SchemaTable[]> {
  const tableRows = await query(`
    SELECT c.oid, n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ${sf.clause}
    ORDER BY n.nspname, c.relname
  `, sf.params) as unknown as { oid: number; schema: string; name: string }[]

  if (tableRows.length === 0) return []

  const oids = tableRows.map(t => t.oid)

  // Fetch columns, indexes, constraints in parallel for all tables
  const [allColumns, allIndexes, allConstraints] = await Promise.all([
    fetchColumns(query, oids),
    fetchIndexes(query, oids),
    fetchConstraints(query, oids),
  ])

  return tableRows.map(t => ({
    schema: t.schema,
    name: t.name,
    columns: allColumns.get(t.oid) ?? [],
    indexes: allIndexes.get(t.oid) ?? [],
    constraints: allConstraints.get(t.oid) ?? [],
  }))
}

async function fetchColumns(query: ClientQueryFn, oids: number[]): Promise<Map<number, SchemaColumn[]>> {
  const rows = await query(`
    SELECT
      a.attrelid AS oid,
      a.attname AS name,
      pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
      NOT a.attnotnull AS nullable,
      pg_get_expr(d.adbin, d.adrelid) AS "default",
      CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by default' ELSE NULL END AS identity,
      CASE a.attgenerated WHEN 's' THEN pg_get_expr(d.adbin, d.adrelid) ELSE NULL END AS generated
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ANY($1)
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum
  `, [oids]) as unknown as (SchemaColumn & { oid: number })[]

  const map = new Map<number, SchemaColumn[]>()
  for (const r of rows) {
    const list = map.get(r.oid) ?? []
    list.push({ name: r.name, type: r.type, nullable: r.nullable, default: r.default, identity: r.identity, generated: r.generated })
    map.set(r.oid, list)
  }
  return map
}

async function fetchIndexes(query: ClientQueryFn, oids: number[]): Promise<Map<number, SchemaIndex[]>> {
  const rows = await query(`
    SELECT
      i.indrelid AS oid,
      c.relname AS name,
      pg_get_indexdef(i.indexrelid) AS definition,
      i.indisunique AS unique
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = ANY($1)
      AND NOT i.indisprimary
    ORDER BY i.indrelid, c.relname
  `, [oids]) as unknown as (SchemaIndex & { oid: number })[]

  const map = new Map<number, SchemaIndex[]>()
  for (const r of rows) {
    const list = map.get(r.oid) ?? []
    list.push({ name: r.name, definition: r.definition, unique: r.unique })
    map.set(r.oid, list)
  }
  return map
}

async function fetchConstraints(query: ClientQueryFn, oids: number[]): Promise<Map<number, SchemaConstraint[]>> {
  const rows = await query(`
    SELECT
      con.conrelid AS oid,
      con.conname AS name,
      CASE con.contype
        WHEN 'p' THEN 'PRIMARY KEY'
        WHEN 'u' THEN 'UNIQUE'
        WHEN 'f' THEN 'FOREIGN KEY'
        WHEN 'c' THEN 'CHECK'
        WHEN 'x' THEN 'EXCLUDE'
        ELSE con.contype::text
      END AS type,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    WHERE con.conrelid = ANY($1)
    ORDER BY con.conrelid, con.conname
  `, [oids]) as unknown as (SchemaConstraint & { oid: number })[]

  const map = new Map<number, SchemaConstraint[]>()
  for (const r of rows) {
    const list = map.get(r.oid) ?? []
    list.push({ name: r.name, type: r.type, definition: r.definition })
    map.set(r.oid, list)
  }
  return map
}

// ─── Views ───────────────────────────────────────────────────────────────────

async function fetchViews(query: ClientQueryFn, sf: SchemaFilter): Promise<SchemaView[]> {
  return await query(`
    SELECT n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ${sf.clause}
    ORDER BY n.nspname, c.relname
  `, sf.params) as unknown as SchemaView[]
}

// ─── Functions ───────────────────────────────────────────────────────────────

async function fetchFunctions(query: ClientQueryFn, sf: SchemaFilter): Promise<SchemaFunction[]> {
  return await query(`
    SELECT
      n.nspname AS schema,
      p.proname AS name,
      pg_get_function_arguments(p.oid) AS args,
      pg_get_function_result(p.oid) AS "returnType",
      l.lanname AS language,
      pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ${sf.clause}
      AND p.prokind IN ('f', 'p')
    ORDER BY n.nspname, p.proname, pg_get_function_arguments(p.oid)
  `, sf.params) as unknown as SchemaFunction[]
}

// ─── Triggers ────────────────────────────────────────────────────────────────

async function fetchTriggers(query: ClientQueryFn, sf: SchemaFilter): Promise<SchemaTrigger[]> {
  return await query(`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      t.tgname AS name,
      pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ${sf.clause}
    ORDER BY n.nspname, c.relname, t.tgname
  `, sf.params) as unknown as SchemaTrigger[]
}

// ─── Sequences ───────────────────────────────────────────────────────────────

async function fetchSequences(query: ClientQueryFn, sf: SchemaFilter): Promise<SchemaSequence[]> {
  return await query(`
    SELECT
      n.nspname AS schema,
      c.relname AS name,
      format_type(s.seqtypid, NULL) AS "dataType",
      s.seqstart::text AS "startValue",
      s.seqincrement::text AS increment,
      s.seqmin::text AS "minValue",
      s.seqmax::text AS "maxValue"
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ${sf.clause}
    ORDER BY n.nspname, c.relname
  `, sf.params) as unknown as SchemaSequence[]
}

// ─── Enums ───────────────────────────────────────────────────────────────────

async function fetchEnums(query: ClientQueryFn, sf: SchemaFilter): Promise<SchemaEnum[]> {
  const rows = await query(`
    SELECT
      n.nspname AS schema,
      t.typname AS name,
      array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typtype = 'e'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ${sf.clause}
    GROUP BY n.nspname, t.typname
    ORDER BY n.nspname, t.typname
  `, sf.params) as unknown as SchemaEnum[]

  return rows
}
