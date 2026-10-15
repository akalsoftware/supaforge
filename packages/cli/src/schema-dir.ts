import { randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { pgQuery } from './db'
import { SUPABASE_PLATFORM_SCHEMAS } from './defaults'

import { describeMissingPgDump, getServerMajorVersion, resolvePgDumpPath } from './pg-tools'
import { copyStructure, dropDatabase, psqlBeside, withDatabase } from './prove.js'
import { isCommentOnly, splitSqlStatements } from './utils/sql-split.js'
import { quoteName } from './utils/sql.js'
import { DiagnosticError, errMsg } from './utils/error.js'

/**
 * A directory of schema files — Supabase's `supabase/schemas` — as a
 * database to compare against.
 *
 * Declarative schemas keep the desired state as SQL files. To compare them
 * with a live target they are loaded, in a throwaway database on the
 * target's own server (as `--prove` makes its copy), on top of the target's
 * platform schemas — so a table referencing auth.users, or a policy calling
 * auth.uid(), finds them — and that database is the source. Files load in
 * name order; a statement that fails because something it needs comes later
 * is tried again once the others have run, so the order the files are in
 * matters as little as it can.
 */
export interface SchemaDirSource {
  url: string
  /**
   * The target's extensions the copy could not install (pg_cron lives in one
   * database per server), and the schemas holding their tables: schema files
   * do not declare what the platform owns, so they are not compared.
   */
  unavailable: { extensions: string[]; schemas: string[] }
  /** Statements loaded, and how many files they came from. */
  statements: number
  files: number
  close(): Promise<void>
}

export async function openSchemaDir(dir: string, targetUrl: string): Promise<SchemaDirSource> {
  const files = await sqlFiles(dir)
  if (files.length === 0) throw new DiagnosticError(`--source-dir: no .sql files in ${dir}`)

  const serverMajor = await getServerMajorVersion(targetUrl)
  const resolved = await resolvePgDumpPath(serverMajor)
  if (!resolved) throw new DiagnosticError(`--source-dir needs pg_dump to copy the target's platform schemas: ${await describeMissingPgDump(serverMajor)}`)
  const tools = { pgDump: resolved.path, psql: psqlBeside(resolved.path), clientMajor: resolved.major, serverMajor }

  const name = `supaforge_schema_${randomBytes(4).toString('hex')}`
  const adminUrl = withDatabase(targetUrl, 'postgres')
  const url = withDatabase(targetUrl, name)
  try {
    await pgQuery(adminUrl, `CREATE DATABASE ${quoteName(name)}`)
  } catch (err) {
    throw new DiagnosticError(`--source-dir: could not create a throwaway database on the target's server: ${errMsg(err)}`)
  }
  const close = () => dropDatabase(adminUrl, name)
  try {
    const present = new Set((await pgQuery(targetUrl, 'SELECT nspname FROM pg_namespace') as Array<{ nspname: string }>).map(r => r.nspname))
    const platform = SUPABASE_PLATFORM_SCHEMAS.filter(s => present.has(s) && s !== 'pg_catalog' && s !== 'information_schema')
    if (platform.length > 0) await copyStructure(targetUrl, url, platform, tools)
    const statements = await loadStatements(url, files)
    return { url, statements, files: files.length, close, unavailable: await unavailableExtensions(targetUrl, url) }
  } catch (err) {
    await close()
    throw err
  }
}

/** The directory's .sql files, at any depth, in name order. */
async function sqlFiles(dir: string): Promise<Array<{ path: string; name: string }>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.sql'))
    .map(e => {
      const path = join(e.parentPath ?? (e as unknown as { path: string }).path, e.name)
      return { path, name: relative(dir, path) }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Run every statement, each on its own; what fails is tried again after the
 * rest, as long as each round gets further. What still fails is reported
 * with its file.
 */
async function loadStatements(url: string, files: Array<{ path: string; name: string }>): Promise<number> {
  let pending: Array<{ file: string; sql: string; error?: string }> = []
  for (const f of files) {
    for (const sql of splitSqlStatements(await readFile(f.path, 'utf8'))) {
      if (!isCommentOnly(sql)) pending.push({ file: f.name, sql })
    }
  }
  const total = pending.length
  for (;;) {
    const failed: typeof pending = []
    for (const p of pending) {
      try {
        await pgQuery(url, p.sql)
      } catch (err) {
        failed.push({ ...p, error: errMsg(err) })
      }
    }
    if (failed.length === 0) return total
    if (failed.length === pending.length) {
      const first = failed[0]
      throw new DiagnosticError(
        `--source-dir: ${failed.length} statement(s) could not be loaded. First, in ${first.file}: ${first.error}\n`
        + `  ${first.sql.slice(0, 200).replace(/\s+/g, ' ')}`,
      )
    }
    pending = failed
  }
}

/** The target's extensions the copy lacks, and the schemas their tables are in. */
async function unavailableExtensions(targetUrl: string, copyUrl: string): Promise<{ extensions: string[]; schemas: string[] }> {
  const sql = `SELECT e.extname AS name,
                      ARRAY(SELECT DISTINCT n.nspname FROM pg_depend d JOIN pg_class c ON c.oid = d.objid
                              JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE d.classid = 'pg_class'::regclass AND d.refobjid = e.oid AND d.deptype = 'e')::text[] AS schemas
                 FROM pg_extension e`
  const [target, copy] = await Promise.all([targetUrl, copyUrl].map(url => pgQuery(url, sql))) as Array<Array<{ name: string; schemas: string[] }>>
  const have = new Set(copy.map(e => e.name))
  const missing = target.filter(e => !have.has(e.name))
  return { extensions: missing.map(e => e.name), schemas: [...new Set(missing.flatMap(e => e.schemas))] }
}
