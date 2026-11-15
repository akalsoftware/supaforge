import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { newPgClient } from './db.js'
import { splitSqlStatements } from './utils/sql-split.js'

const run = promisify(execFile)

/** A privilege the clone could not grant, because its role is not on this server. */
export interface NotGranted {
  role: string
  /** The statement, summarised: `GRANT SELECT ON TABLE public.film TO reader`. */
  statement: string
}

/** What the privilege pass did. */
export interface PrivilegesResult {
  /** Statements run. */
  granted: number
  /** Statements naming a role this server does not have. */
  notGranted: NotGranted[]
  /** Statements that failed for any other reason. */
  failures: Array<{ object: string; error: string }>
}

/**
 * The privilege entries of a `pg_restore -l` listing: `ACL` (GRANT and REVOKE
 * on an object) and `DEFAULT ACL` (ALTER DEFAULT PRIVILEGES).
 *
 * A listing line is `<dumpId>; <tableoid> <oid> <desc> <schema> <name> <owner>`;
 * a schema's own entry has `-` for its schema and `SCHEMA <name>` after it.
 *
 * Entries on a schema the clone leaves out are dropped, along with the schema's
 * own: pg_dump still lists some of them (an extension's members, the schema an
 * extension creates), and they can only fail, as nothing they name is here.
 */
export function privilegeEntries(listing: string, excludeSchemas: readonly string[] = []): string[] {
  const excluded = new Set(excludeSchemas)
  return listing.split('\n').filter(line => {
    const m = /^\d+;\s+\d+\s+\d+\s+(?:DEFAULT\s+)?ACL\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) return false
    const [, schema, rest] = m
    const subject = schema === '-' ? /^SCHEMA\s+(\S+)/.exec(rest)?.[1] : schema
    return subject === undefined || !excluded.has(subject)
  })
}

/**
 * The statements of the SQL pg_restore writes for those entries, one each.
 *
 * Its header (`SET …`, `set_config('search_path', …)`) is kept; psql
 * meta-commands (`\restrict`, from pg_dump 18) are not SQL and are dropped,
 * as are comments.
 */
export function privilegeStatements(sql: string): string[] {
  const body = sql.split('\n').filter(line => !line.startsWith('\\')).join('\n')
  return splitSqlStatements(body)
    .map(s => s.split('\n').filter(line => !/^\s*--/.test(line)).join('\n').trim())
    .filter(Boolean)
}

/** The role a "role does not exist" error names. */
function missingRole(err: unknown): string | undefined {
  const e = err as { code?: string; message?: string }
  if (e.code !== '42704') return undefined
  return /^role "((?:[^"]|"")+)" does not exist$/.exec(e.message ?? '')?.[1]
}

const isSessionSetting = (sql: string) => /^SET\s/i.test(sql) || /^SELECT\s+pg_catalog\.set_config\(/i.test(sql)

/**
 * Run the source's privilege statements on the clone, each on its own.
 *
 * pg_restore sends an object's privileges as one query, and one GRANT to a
 * role this server lacks — `anon` on plain PostgreSQL, a source's own
 * application role — undid the others in it. So the clone is given every
 * privilege whose role is here, and told which it could not be given.
 */
export async function applyPrivileges(dbUrl: string, statements: readonly string[]): Promise<PrivilegesResult> {
  const result: PrivilegesResult = { granted: 0, notGranted: [], failures: [] }
  const client = newPgClient(dbUrl)
  await client.connect()
  try {
    for (const sql of statements) {
      try {
        await client.query(sql)
        if (!isSessionSetting(sql)) result.granted++
      } catch (err) {
        // A setting a newer pg_dump writes that this server does not know.
        if (isSessionSetting(sql)) continue
        const summary = sql.replace(/\s+/g, ' ').replace(/;$/, '')
        const role = missingRole(err)
        if (role) result.notGranted.push({ role, statement: summary })
        else result.failures.push({ object: summary, error: (err as Error).message })
      }
    }
  } finally {
    await client.end()
  }
  return result
}

/**
 * Give the clone the source's privileges: the restore itself runs with
 * --no-acl, so this is the only place they come from.
 *
 * A schema-only dump is listed, its privilege entries rendered as SQL, and
 * that SQL run statement by statement (see applyPrivileges).
 */
export async function restorePrivileges(opts: {
  pgDumpPath: string
  pgRestorePath: string
  remoteUrl: string
  localDbUrl: string
  excludeSchemas?: readonly string[]
}): Promise<PrivilegesResult> {
  const dir = await mkdtemp(join(tmpdir(), 'supaforge-acl-'))
  try {
    const archive = join(dir, 'schema.dump')
    const list = join(dir, 'acl.list')
    await run(opts.pgDumpPath, [
      '--format=custom', '--schema-only', '--no-owner',
      ...(opts.excludeSchemas ?? []).map(s => `--exclude-schema=${s}`),
      '--file', archive, opts.remoteUrl,
    ], { maxBuffer: 64 * 1024 * 1024 })
    const { stdout: listing } = await run(opts.pgRestorePath, ['--list', archive], { maxBuffer: 256 * 1024 * 1024 })
    const entries = privilegeEntries(listing, opts.excludeSchemas)
    if (entries.length === 0) return { granted: 0, notGranted: [], failures: [] }
    await writeFile(list, entries.join('\n') + '\n')
    const { stdout: sql } = await run(opts.pgRestorePath, ['--use-list', list, '--file', '-', archive], { maxBuffer: 256 * 1024 * 1024 })
    return await applyPrivileges(opts.localDbUrl, privilegeStatements(sql))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
