import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, unlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DriftIssue } from './types/drift'
import { errMsg, friendlyDbError, DiagnosticError } from './utils/error'
import { DBDIFF_EXEC_TIMEOUT_MS, DBDIFF_MAX_BUFFER } from './constants'
import { schemaDiffIgnores } from './defaults'
import { PLATFORM_ROLES } from './checks/roles'
import { parseStatements, names, relationName, type Statement } from './sql-ast.js'
import { sqlSkeleton, policiesRemoved } from './sql-deps'
import { escapeRegex } from './utils/strings'
import { pairUnits, parseUnits, REPLACING_KINDS, type DbDiffUnit } from './dbdiff-units'
import { splitSqlStatements } from './utils/sql-split.js'

const execFileAsync = promisify(execFile)

export interface DbDiffOptions {
  sourceUrl: string
  targetUrl: string
  type: 'schema' | 'data' | 'all'
  include: 'up' | 'down' | 'both'
  tables?: string[]
  ignoreTables?: string[]
  /** Schemas to exclude — converted to --ignore-tables=schema.* glob patterns. */
  ignoreSchemas?: string[]
  /**
   * Seconds before the diff is abandoned, from the target environment's
   * checks.schema.timeout. SUPAFORGE_DBDIFF_TIMEOUT still wins over this.
   */
  timeoutSeconds?: number
  /**
   * Called as dbdiff reports progress on individual tables, so a long schema
   * diff reads as working rather than hung (issue #29).
   */
  onProgress?: (progress: { table: string; tablesSeen: number }) => void
  /**
   * Ask a schema diff for `--units` (the default). Set false for a dbdiff
   * that predates the flag — runDbDiff does so itself when one refuses it.
   */
  units?: boolean
}

export interface DbDiffResult {
  up: string
  down: string
  /**
   * What dbdiff warned about without changing anything: kinds of object it
   * does not compare, columns or tables it would not take for renames.
   */
  notices?: string[]
}

/** dbdiff's warnings (`⚠ ...` lines), colour codes stripped. */
export function dbdiffNotices(stdout: string): string[] {
  return stdout
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('⚠'))
    .map(line => line.replace(/^⚠\s*/, ''))
}

/**
 * Whether a failed run means @dbdiff/cli is missing, rather than that it ran
 * and failed.
 *
 * Read from the spawn's error code and the process's stderr only. The error
 * message starts with the whole command line, connection URLs included, so a
 * bare `404` matched a port like 40425: a real DBDiff failure was reported as
 * "not installed" and the schema check skipped.
 */
export function dbdiffNotInstalled(code: unknown, stderr: string): boolean {
  if (code === 'ENOENT') return true
  return /ERR_MODULE_NOT_FOUND|could not determine executable|npm (?:ERR!|error) (?:code E404|404)|\bE404\b|command not found|: not found\s*$/m.test(stderr)
}

/**
 * Resolve the @dbdiff/cli binary path from node_modules.
 *
 * Uses createRequire to locate the installed package, then returns
 * the path to `bin/dbdiff.js`. Falls back to 'npx' if the package
 * is not installed locally (e.g. global install).
 *
 * `SUPAFORGE_DBDIFF_BIN` overrides both with an executable of your own — a
 * DBDiff checkout's `dbdiff` script, say. That is how DBDiff's CI runs
 * SupaForge's scenarios against an unreleased change, and how a fix can be
 * tried through SupaForge before it ships, without touching node_modules.
 */
export function resolveDbDiffBin(): { command: string; prefixArgs: string[] } {
  const override = process.env.SUPAFORGE_DBDIFF_BIN?.trim()
  if (override) return { command: override, prefixArgs: [] }
  try {
    const require = createRequire(import.meta.url)
    const binPath = require.resolve('@dbdiff/cli/bin/dbdiff.js')
    return { command: process.execPath, prefixArgs: [binPath] }
  } catch {
    // Fallback: try npx for global installs
    return { command: 'npx', prefixArgs: ['@dbdiff/cli'] }
  }
}

/**
 * Run @dbdiff/cli and parse UP/DOWN SQL output.
 *
 * Writes to a temp file via --output, reads it back, then parses
 * the `-- ==================== UP ====================` /
 * `-- ==================== DOWN ====================` markers.
 *
 * When @dbdiff/cli is not installed, throws with a clear message.
 */
/**
 * Resolve the effective dbdiff timeout (ms).
 *
 * Honours the SUPAFORGE_DBDIFF_TIMEOUT environment variable (in seconds) so
 * users with very large schemas can raise the ceiling without a code change.
 * Falls back to DBDIFF_EXEC_TIMEOUT_MS.
 */
export function resolveDbDiffTimeoutMs(configuredSeconds?: number): number {
  // Precedence: env var > per-environment config > default. The env var is the
  // runtime escape hatch, so it has to beat a committed config value.
  const raw = process.env.SUPAFORGE_DBDIFF_TIMEOUT
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000)
  }
  if (Number.isFinite(configuredSeconds) && (configuredSeconds as number) > 0) {
    return Math.round((configuredSeconds as number) * 1000)
  }
  return DBDIFF_EXEC_TIMEOUT_MS
}

/**
 * dbdiff logs a line per table as it works. Recognising them turns a silent
 * multi-minute spinner into visible progress.
 *
 * Matches both the per-table diff line and the batch pre-scan summary, and is
 * tolerant of the ANSI colour codes dbdiff emits.
 */
const DBDIFF_TABLE_LINE = /calculating schema diff for table [`"']?([\w.$]+)/i

export function parseDbDiffProgress(line: string): string | null {
  return DBDIFF_TABLE_LINE.exec(line)?.[1] ?? null
}

/**
 * Resolve the PHP memory limit to hand to @dbdiff/cli, if any.
 *
 * @dbdiff/cli caps itself at 1G by default, which is ample for most Supabase
 * projects but can be exceeded by a very large schema or a wide data diff.
 * SUPAFORGE_DBDIFF_MEMORY passes straight through to `--memory-limit`, taking
 * the same values dbdiff accepts: "512M", "2G", or "-1" for unlimited.
 *
 * Returns undefined when unset or malformed, leaving dbdiff on its own default
 * rather than forwarding a value it would reject.
 */
export function resolveDbDiffMemoryLimit(): string | undefined {
  const raw = process.env.SUPAFORGE_DBDIFF_MEMORY?.trim()
  if (!raw) return undefined
  return /^-?\d+[KMG]?$/i.test(raw) ? raw : undefined
}

/**
 * Strip @dbdiff/cli progress / spinner noise from captured output.
 *
 * dbdiff logs informational lines such as "ℹ Now generating UP migration"
 * to stdout while it works. When the process is killed (e.g. on timeout)
 * that last progress line is the only thing in the buffer — surfacing it as
 * the "error" is misleading. Drop any line that begins with a known
 * info/spinner glyph and keep only genuine error-looking content.
 */
const DBDIFF_NOISE_LINE = /^\s*[ℹ✔✓⚠⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u

export function stripDbDiffNoise(text: string): string {
  return text
    .split('\n')
    .filter(line => line.trim() !== '' && !DBDIFF_NOISE_LINE.test(line))
    .join('\n')
    .trim()
}

/**
 * Build the full @dbdiff/cli argument list for a diff run.
 *
 * Split out of runDbDiff() so the flag surface is one readable unit and can be
 * asserted directly in tests, rather than only through a spawned process.
 */
export function buildDbDiffArgs(options: DbDiffOptions, outputFile: string): string[] {
  const args = [
    'diff',
    `--server1-url=${options.sourceUrl}`,
    `--server2-url=${options.targetUrl}`,
    `--type=${options.type}`,
    // Was hardcoded to 'both', silently ignoring options.include. Every caller
    // passes 'both' (sqlToIssues pairs each UP statement with its DOWN
    // counterpart, so it needs both directions), but the option was part of the
    // public interface and did nothing.
    `--include=${options.include}`,
    '--nocomments',
    // @dbdiff/cli >= 3.0.0-rc.3 refuses to emit a migration containing
    // DROP TABLE or DROP COLUMN unless this is passed, exiting non-zero and
    // writing no output file. SupaForge is a *detection* tool: an extra table
    // or column on the target is the single most common form of drift, and it
    // has to be reported rather than turned into a hard failure. The safety
    // gate belongs at apply time instead — see isDestructiveSql()/promote(),
    // which skip these statements unless the user opts in explicitly.
    '--allow-destructive',
    `--output=${outputFile}`,
  ]

  // Each schema change marked as one unit, so a change of several statements
  // is one finding and its DOWN is found by name — see dbdiff-units.ts. Data
  // diffs stay statement by statement: a unit there is a table's rows, and
  // rows are reviewed and applied one at a time.
  if (options.type === 'schema' && options.units !== false) {
    args.push('--units')
  }

  const memoryLimit = resolveDbDiffMemoryLimit()
  if (memoryLimit) {
    args.push(`--memory-limit=${memoryLimit}`)
  }

  // A schema diff compares every schema but the ignored ones. dbdiff named
  // tables without their schema, so these were once passed as table globs
  // (auth.*) that matched nothing: dbdiff read `public` alone. Data diffs
  // name their tables in checks.data.tables, which are in `public`.
  if (options.type === 'schema' && options.ignoreSchemas) {
    args.push(`--ignore-schemas=${schemaDiffIgnores(options.ignoreSchemas).join(',')}`)
  }
  const ignore = options.ignoreTables ?? []

  if (options.tables?.length) {
    args.push(`--tables=${options.tables.join(',')}`)
  }
  if (ignore.length) {
    args.push(`--ignore-tables=${ignore.join(',')}`)
  }

  return args
}

/**
 * Forward dbdiff's per-table log lines to a progress callback.
 *
 * Entirely best-effort: any failure here must never affect the diff itself,
 * so every step is guarded. A missing stdout (possible if the process dies
 * immediately) simply means no progress is reported.
 */
function attachProgress(
  running: { child?: { stdout?: NodeJS.ReadableStream | null } },
  onProgress?: (progress: { table: string; tablesSeen: number }) => void,
): void {
  if (!onProgress) return
  try {
    const stdout = running.child?.stdout
    if (!stdout) return

    let buffer = ''
    let tablesSeen = 0
    stdout.on('data', (chunk: Buffer | string) => {
      try {
        buffer += String(chunk)
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const table = parseDbDiffProgress(line)
          if (table) {
            tablesSeen++
            onProgress({ table, tablesSeen })
          }
        }
      } catch {
        // Progress reporting is cosmetic — never let it break the run.
      }
    })
    stdout.on('error', () => {})
  } catch {
    // Same: cosmetic only.
  }
}

export async function runDbDiff(options: DbDiffOptions): Promise<DbDiffResult> {
  const { command, prefixArgs } = resolveDbDiffBin()
  const outputFile = join(tmpdir(), `supaforge-dbdiff-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`)

  const args = [...prefixArgs, ...buildDbDiffArgs(options, outputFile)]

  const timeoutMs = resolveDbDiffTimeoutMs(options.timeoutSeconds)

  try {
    const running = execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: DBDIFF_MAX_BUFFER,
    })

    // Attach to the child's stdout for progress without changing how it is
    // executed — promisified execFile exposes the ChildProcess as `.child`,
    // so timeout, maxBuffer and every error path stay exactly as they were.
    attachProgress(running, options.onProgress)

    const { stdout } = await running
    const notices = dbdiffNotices(String(stdout ?? ''))

    // When schemas are identical, dbdiff exits 0 but doesn't write the file
    const fileExists = await access(outputFile).then(() => true, () => false)
    if (!fileExists) {
      return { up: '', down: '', notices }
    }

    const output = await readFile(outputFile, 'utf8')
    return { ...parseDbDiffOutput(output), notices }
  } catch (err: unknown) {
    const errObj = (err ?? {}) as Record<string, unknown>
    const message = errMsg(err)
    const stderr = String(errObj.stderr ?? '').trim()
    const stdout = String(errObj.stdout ?? '').trim()
    const combined = `${message} ${stderr}`

    // A dbdiff older than --units (3.0.0-rc.17) refuses the flag; its output
    // is read statement by statement instead.
    if (options.units !== false && /"--units" option does not exist/.test(`${combined} ${stdout}`)) {
      return runDbDiff({ ...options, units: false })
    }

    if (dbdiffNotInstalled(errObj.code, stderr)) {
      throw new DiagnosticError(
        '@dbdiff/cli is not installed. Install it with: npm install @dbdiff/cli',
      )
    }

    // @dbdiff/cli exits 1 when differences are found (standard diff convention).
    // The output file is written before exit — read it if it has real content.
    const fileExists = await access(outputFile).then(() => true, () => false)
    if (fileExists) {
      const output = await readFile(outputFile, 'utf8')
      const parsed = parseDbDiffOutput(output)
      if (parsed.up || parsed.down) return parsed
    }

    // Timeout / killed process. execFileAsync sets `killed: true` and a SIGTERM
    // signal when it kills the child on timeout. Previously this fell through and
    // surfaced dbdiff's last progress line ("ℹ Now generating UP migration") as
    // the error — hiding the real cause. Report it clearly instead.
    const timedOut =
      errObj.killed === true ||
      errObj.signal === 'SIGTERM' ||
      errObj.code === 'ETIMEDOUT' ||
      /ETIMEDOUT|timed out/i.test(combined)
    if (timedOut) {
      const secs = Math.round(timeoutMs / 1000)
      throw new DiagnosticError(
        `Schema diff timed out after ${secs}s — the schema is very large or the ` +
        `database connection is slow.\n` +
        `  Remediations:\n` +
        `    • Raise the limit: set SUPAFORGE_DBDIFF_TIMEOUT=600 (seconds) and re-run.\n` +
        `    • Narrow the scan: diff one layer at a time with --check=schema.\n` +
        `    • Exclude large internal schemas via "ignoreSchemas" in supaforge.config.json.`,
      )
    }

    // No usable output file → genuine error (connection refused, auth, etc.).
    // Prefer stderr; otherwise fall back to stdout with dbdiff's progress/spinner
    // noise stripped so an info line never masquerades as the error. Strip the raw
    // "Command failed: /path/to/node ..." prefix which leaks connection URLs.
    const realError = stderr || stripDbDiffNoise(stdout)
    const cleanMessage = realError
      ? realError
      : message.replace(/^Command failed:[^\n]*/m, '').trim() || 'dbdiff failed with no error output'
    throw new Error(friendlyDbError(cleanMessage, options.sourceUrl))
  } finally {
    await unlink(outputFile).catch(() => {})
  }
}

const UP_MARKER = '-- ==================== UP ===================='
const DOWN_MARKER = '-- ==================== DOWN ===================='

const CREATE_FUNCTION = 'create-function'
const DROP_FUNCTION = 'drop-function'

const DROP_TYPES = ['drop', 'drop-view', DROP_FUNCTION, 'drop-trigger', 'drop-type', 'drop-sequence', 'drop-collation']

/**
 * Does this statement destroy data, or weaken access control, if executed?
 *
 * Still narrower than DROP_TYPES: dropping a view, function, trigger or type
 * loses a definition the migration can recreate. What is gated is losing rows
 * or losing a policy.
 *
 * It used to cover `DROP TABLE` and `ALTER TABLE … DROP COLUMN` only, so two
 * things went through `--apply` that the flag exists to hold back (issue #88):
 *
 *   - `DELETE FROM`, which is how the data check removes rows the source does
 *     not have. Rows are exactly what `--allow-destructive` is about.
 *   - `DROP POLICY`, which is not recoverable from the schema and, for a
 *     RESTRICTIVE policy, *grants* access by removing it. The RLS check renders
 *     a *modified* policy as a drop and a create of the same name, and that is
 *     a replacement rather than a removal — so only a policy left dropped
 *     counts.
 *
 * Matching runs over `sqlSkeleton`, so the words appearing inside a string
 * literal or a routine body cannot trigger it — and matching is no longer
 * anchored to the start, since a merged replacement pair puts the second
 * statement mid-string.
 */
export function isDestructiveSql(sql: string): boolean {
  return destructiveReason(sql) !== undefined
}

/**
 * Why this statement is gated, in the words the skip line should use.
 *
 * `recreatedElsewhere` holds the policies (`schema.table.policy`, as createdPolicies
 * keys them) that other fixes applied alongside this one create.
 *
 * "Destructive (drops data)" was printed for every case once policies joined
 * the list, which is wrong for a policy — nothing is lost from a table, and
 * saying so obscures the part that matters, that removing a RESTRICTIVE policy
 * opens access up.
 */
export function destructiveReason(
  sql: string,
  recreatedElsewhere: ReadonlySet<string> = new Set(),
): string | undefined {
  // A queue's messages are rows, and pgmq.drop_queue drops its tables. A
  // function call, so neither reading below would see it as a DROP.
  if (/\bPGMQ\s*\.\s*"?DROP_QUEUE"?\s*\(/.test(sqlSkeleton(sql).toUpperCase())) {
    return 'drops a queue and the messages in it'
  }
  const statements = parseStatements(sql)
  return statements
    ? destructiveInTree(statements, recreatedElsewhere)
    : destructiveInText(sql, recreatedElsewhere)
}

/**
 * destructiveReason() read from PostgreSQL's parse tree — see sql-ast.ts.
 *
 * The tree says what each statement is, so none of the cases the text
 * version guards against can arise: `GRANT TRUNCATE` is a GrantStmt, not a
 * TruncateStmt, and a function body mentioning `DROP TABLE` is a string.
 */
function destructiveInTree(statements: Statement[], recreatedElsewhere: ReadonlySet<string>): string | undefined {
  const dropped = (type: string) => statements.some(s => s.kind === 'DropStmt' && s.node.removeType === type)
  if (dropped('OBJECT_SCHEMA')) return 'drops a schema and everything in it'
  if (dropped('OBJECT_TABLE')) return 'drops a table and its rows'
  if (statements.some(s => s.kind === 'TruncateStmt')) return 'deletes every row in a table'
  if (columnsDroppedForGoodInTree(statements).length > 0) return 'drops a column and its values'
  if (statements.some(s => s.kind === 'DeleteStmt')) return 'deletes rows'
  if (statements.some(s => s.kind === 'DropRoleStmt')) return 'drops a role, and every login and grant it holds'

  // A policy the same SQL creates again is being replaced, not removed — as
  // is one another fix in the apply recreates (recreatedElsewhere).
  // Keyed `schema.table.policy`, as createdPolicies keys them: `public` where
  // the table names no schema.
  const key = (schema: string | undefined, table: string, policy: string) =>
    `${(schema || 'public').toLowerCase()}.${table.toLowerCase()}.${policy.toLowerCase()}`
  const created = new Set(statements.filter(s => s.kind === 'CreatePolicyStmt')
    .map(s => key(s.node.table?.schemaname, relationName(s.node.table), s.node.policy_name)))
  const policies = statements
    .filter(s => s.kind === 'DropStmt' && s.node.removeType === 'OBJECT_POLICY')
    .flatMap(s => (s.node.objects as Array<Record<string, any>>).map(o => names(o.List?.items)))
    .map(parts => key(parts.at(-3), parts.at(-2) ?? '', parts.at(-1) ?? ''))
    .filter(k => !created.has(k) && !recreatedElsewhere.has(k))
  if (policies.length > 0) {
    return policies.length === 1
      ? `removes the policy ${policies[0]}, which may widen access`
      : `removes ${policies.length} policies, which may widen access`
  }
  return undefined
}

/** Columns an ALTER TABLE drops, unless a later command in the same SQL adds them back. */
function columnsDroppedForGoodInTree(statements: Statement[]): string[] {
  const commands = statements
    .filter(s => s.kind === 'AlterTableStmt')
    .flatMap(s => (s.node.cmds as Array<Record<string, any>>).map(c => ({ table: relationName(s.node.relation), cmd: c.AlterTableCmd })))
  return commands.flatMap(({ table, cmd }, i) => {
    if (cmd?.subtype !== 'AT_DropColumn') return []
    const readded = commands.slice(i + 1).some(later =>
      later.table === table && later.cmd?.subtype === 'AT_AddColumn' && later.cmd.def?.ColumnDef?.colname === cmd.name)
    return readded ? [] : [cmd.name as string]
  })
}

/**
 * destructiveReason() read from the text, for SQL PostgreSQL's parser does not
 * accept — a fragment, or a dialect it does not speak. What it did before the
 * parse tree was used.
 */
function destructiveInText(sql: string, recreatedElsewhere: ReadonlySet<string>): string | undefined {
  const skeleton = sqlSkeleton(sql).toUpperCase()

  if (/\bDROP\s+SCHEMA\b/.test(skeleton)) return 'drops a schema and everything in it'
  if (/\bDROP\s+TABLE\b/.test(skeleton)) return 'drops a table and its rows'
  // At the start of a statement only. TRUNCATE is also a privilege and a
  // trigger event, so `GRANT TRUNCATE ON t TO anon` and `BEFORE TRUNCATE ON t`
  // were held back as though they emptied the table — and Supabase's default
  // `GRANT ALL` includes TRUNCATE, so every grant fix for a new table tripped it.
  if (/(?:^|;)\s*TRUNCATE\b/.test(skeleton)) return 'deletes every row in a table'
  if (columnsDroppedForGood(skeleton).length > 0) return 'drops a column and its values'
  if (/\bDELETE\s+FROM\b/.test(skeleton)) return 'deletes rows'
  // A role is not schema: it is who can log in. The roles check offered
  // `DROP ROLE` for every role only the target had, including the one the
  // apply was connected as, and nothing held it back.
  if (/(?:^|;)\s*DROP\s+(?:ROLE|USER|GROUP)\b/.test(skeleton)) return 'drops a role, and every login and grant it holds'

  // A policy another fix in the same apply creates again is being replaced,
  // not removed: a column type change drops the policies reading the column
  // and the policy's own fix puts the new one back once the type has changed.
  const policies = policiesRemoved(sql).filter(key => !recreatedElsewhere.has(key))
  if (policies.length > 0) {
    return policies.length === 1
      ? `removes the policy ${policies[0]}, which may widen access`
      : `removes ${policies.length} policies, which may widen access`
  }

  return undefined
}

/**
 * Columns a statement drops and does not add back.
 *
 * A stored generated column whose expression changes, or that reads a column
 * being retyped, is dropped and re-added in the same change — recomputed from
 * its expression, so nothing is lost — and was held back as though its values
 * were. Matched on the upper-cased skeleton, so names compare as written.
 */
function columnsDroppedForGood(skeleton: string): string[] {
  const ident = String.raw`("(?:[^"]|"")+"|[\w$]+)`
  const dropped = [...skeleton.matchAll(new RegExp(String.raw`\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?` + ident, 'g'))]
  return dropped
    .filter(m => !new RegExp(String.raw`\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?` + escapeRegex(m[1]) + String.raw`(?![\w$"])`)
      .test(skeleton.slice((m.index ?? 0) + m[0].length)))
    .map(m => m[1])
}

export function parseDbDiffOutput(output: string): DbDiffResult {
  const upIdx = output.indexOf(UP_MARKER)
  const downIdx = output.indexOf(DOWN_MARKER)

  if (upIdx === -1 && downIdx === -1) {
    // Might be UP-only output without markers
    return { up: output.trim(), down: '' }
  }

  let up = ''
  let down = ''

  if (upIdx !== -1) {
    const upStart = upIdx + UP_MARKER.length
    const upEnd = downIdx !== -1 ? downIdx : output.length
    up = output.slice(upStart, upEnd).trim()
  }

  if (downIdx !== -1) {
    const downStart = downIdx + DOWN_MARKER.length
    down = output.slice(downStart).trim()
  }

  return { up, down }
}

/**
 * Convert @dbdiff/cli SQL output into DriftIssues.
 *
 * Each SQL statement (separated by `;`) becomes its own issue
 * with the appropriate severity and layer.
 *
 * When `ignoreSchemas` is provided, FK constraint statements that
 * reference tables in ignored schemas are filtered out — these are
 * false positives caused by dbdiff seeing stub tables.
 *
 * `ignoredSchemaTables` is an optional pre-queried set of table names
 * (lowercase) that exist inside ignored schemas. When provided it lets the
 * filter catch unqualified REFERENCES like `REFERENCES "users"` where
 * "users" lives in the ignored "auth" schema but dbdiff omitted the prefix.
 */
export function sqlToIssues(
  result: DbDiffResult,
  check: 'schema' | 'data',
  ignoreSchemas?: string[],
  ignoredSchemaTables?: Set<string>,
): DriftIssue[] {
  const issues = unfoldedIssues(result, check, ignoreSchemas, ignoredSchemaTables)
  return check === 'schema' ? foldCommentsIntoCreates(issues) : issues
}

/** Kinds dbdiff does not compare that another check does: publications, the Realtime check. */
const COMPARED_ELSEWHERE = /^Publication objects are not compared/

/**
 * dbdiff's warnings, as said beside the schema check's findings: what it
 * did not compare, or would not take for a rename, is worth knowing before
 * an apply rather than after. `Operator objects are not compared (…) — check
 * them by hand` reads `Not compared: Operator (…) — check them by hand.`
 */
export function schemaNotices(notices: string[]): string[] {
  return notices
    .filter(n => !COMPARED_ELSEWHERE.test(n))
    .map(notice => {
      const [what, advice] = notice.split(' — ')
      const title = /not compared/.test(what) ? `Not compared: ${what.replace(/ objects are not compared/, '')}` : what
      return advice ? `${title} — ${advice}.` : `${title}.`
    })
}

/** What a comment title names: `public.orders.total (column)` → the name and kind. */
const COMMENT_TITLE = /^(?:Comment changed|Comment missing): (?:schema (.+)|(.+) \(([a-z ]+)\))$/
/**
 * A finding that creates an object, `Table missing: public.orders`, or
 * recreates one, `View modified: public.v`: dbdiff sets a recreated object's
 * comments again, and apart those read as "Comment changed" on a comment that
 * had not.
 */
const CREATE_TITLE = /^(Schema|Table|View|Function|Procedure|Type|Domain|Sequence|Index|Policy|Trigger|Extension) (?:missing|modified): (.+)$/
/** Kinds named after the table (or domain) they belong to. */
const ON_A_TABLE = new Set(['column', 'constraint', 'trigger', 'policy', 'rule'])

/**
 * A comment on an object the target does not have yet goes with the finding
 * that creates it.
 *
 * DBDiff emits each comment on its own, so a missing table with three
 * commented columns was four findings, three of them titled "Comment changed"
 * on an object that was not there to change. Folded, the comment runs right
 * after its object is made; dropping the object takes the comment with it, so
 * nothing is added to the DOWN.
 */
export function foldCommentsIntoCreates(issues: DriftIssue[]): DriftIssue[] {
  const creates = new Map<string, DriftIssue>()
  /** New routines by name alone, for a comment whose signature is spelled differently. */
  const routines = new Map<string, DriftIssue[]>()
  for (const issue of issues) {
    const m = CREATE_TITLE.exec(issue.title)
    if (!m) continue
    creates.set(`${m[1] === 'Schema' ? 'schema' : 'object'}:${m[2]}`, issue)
    if (m[1] === 'Function' || m[1] === 'Procedure') {
      const base = routineBaseName(m[2])
      routines.set(base, [...(routines.get(base) ?? []), issue])
    }
  }

  return issues.filter(issue => {
    const up = issue.sql?.up
    if (!up) return true
    const owner = commentOwner(issue, up, creates, routines) ?? rlsFlagsOwner(issue, up, creates)
    if (!owner?.sql) return true

    owner.sql = { ...owner.sql, up: `${owner.sql.up.trimEnd()}\n${up.trim()}` }
    return false
  })
}

/**
 * The finding creating the object a comment is on. dbdiff names a routine by
 * its argument types in a comment (`f2(integer,pg_catalog.text)`) and by its
 * parameter list in the create (`f2(p_x integer, p_y text DEFAULT 'a')`), so a
 * routine is matched by name when only one new routine has it.
 */
function commentOwner(
  issue: DriftIssue, up: string, creates: Map<string, DriftIssue>, routines: Map<string, DriftIssue[]>,
): DriftIssue | undefined {
  const m = COMMENT_TITLE.exec(issue.title)
  if (!m || splitStatements(up).length !== 1) return undefined
  const [, schema, name, kind] = m
  const candidates = schema !== undefined
    ? [`schema:${schema}`]
    : [`object:${name}`, ...(ON_A_TABLE.has(kind) ? [`object:${name.slice(0, name.lastIndexOf('.'))}`] : [])]
  const exact = candidates.map(c => creates.get(c)).find(Boolean)
  if (exact || (kind !== 'function' && kind !== 'procedure')) return exact
  const sameName = routines.get(routineBaseName(name)) ?? []
  return sameName.length === 1 ? sameName[0] : undefined
}

/** A routine's name without its argument list. */
const routineBaseName = (name: string) => name.includes('(') ? name.slice(0, name.indexOf('(')) : name

/** `ALTER TABLE t ENABLE ROW LEVEL SECURITY` and the like, the whole of a finding. */
const RLS_FLAG = /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?\S+\s+(?:ENABLE|DISABLE|(?:NO\s+)?FORCE)\s+ROW\s+LEVEL\s+SECURITY\s*;?\s*$/i

/**
 * The finding creating a table whose RLS flags a finding sets: a table that
 * does not exist yet had them as a separate "Table altered".
 */
function rlsFlagsOwner(issue: DriftIssue, up: string, creates: Map<string, DriftIssue>): DriftIssue | undefined {
  const m = /^Table altered: (.+)$/.exec(issue.title)
  if (!m || !splitStatements(up).every(sql => RLS_FLAG.test(sql))) return undefined
  return creates.get(`object:${m[1]}`)
}

function unfoldedIssues(
  result: DbDiffResult,
  check: 'schema' | 'data',
  ignoreSchemas?: string[],
  ignoredSchemaTables?: Set<string>,
): DriftIssue[] {
  if (!result.up && !result.down) return []

  const upUnits = parseUnits(result.up)
  if (upUnits) {
    return issuesFromUnits(upUnits, parseUnits(result.down) ?? [], check, ignoreSchemas, ignoredSchemaTables)
  }

  let upStatements = splitStatements(result.up)
  let downStatements = splitStatements(result.down)

  // Filter out FK constraints that reference tables in ignored schemas.
  // These arise because dbdiff compares stub tables vs real Supabase tables.
  // We check both UP and DOWN statements — dbdiff generates broken REFERENCES "" ("")
  // in the DOWN when the referenced table is in an ignored schema.
  // `ignoredSchemaTables` additionally catches unqualified refs like
  // REFERENCES "users" where "users" lives in the ignored "auth" schema.
  if (ignoreSchemas?.length && check === 'schema') {
    const keep = filterCrossSchemaFks(upStatements, downStatements, ignoreSchemas, ignoredSchemaTables)
    upStatements = upStatements.filter((_, i) => keep[i])
    downStatements = downStatements.filter((_, i) => keep[i])
  }

  if (upStatements.length === 0) return []

  upStatements = groupColumnTypeChanges(upStatements)
  downStatements = groupColumnTypeChanges(downStatements)

  const merged = mergeReplacements(upStatements, downStatements)

  // Generate one issue per UP statement, paired with its DOWN counterpart
  return merged.map(({ up: upSql, down: downSql, modified }, i) => {
    // A grouped column type change is named by its ALTER, not by the DROP
    // that opens the group.
    const lead = columnTypeChangeOf(upSql) ?? upSql
    const type = classifyStatement(lead)

    if (modified) {
      const report = REPLACEABLE_REPORT[modified.kind]
      return {
        id: `${check}-alter-${report.idPart}-${i + 1}`,
        check,
        severity: 'warning' as const,
        title: `${report.label}: ${qualifySchemaName(modified.name)}`,
        description: `${report.what} differs between source and target.`,
        sql: { up: upSql, down: downSql },
      }
    }

    return {
      id: `${check}-${type}-${i + 1}`,
      check,
      severity: DROP_TYPES.includes(type) ? 'critical' : 'warning',
      // The DOWN counterpart is passed so a title can recover a schema the UP
      // statement does not carry — see routineLabel (issue #47).
      title: summariseStatement(lead, check, downSql),
      description: `${check === 'schema' ? 'Schema' : 'Data'} difference detected by @dbdiff/cli.`,
      sql: { up: upSql, down: downSql },
    }
  })
}

/**
 * One finding per dbdiff unit (see dbdiff-units.ts), paired with the DOWN
 * unit for the same change.
 *
 * Named as the statement-by-statement path names them: a unit replacing one
 * object — a changed routine, policy, or enum whose labels were removed — is
 * "<Kind> modified"; anything else by its leading statement, which for a
 * table change is its first ALTER TABLE rather than a view it stands aside.
 */
/**
 * Default privileges for a role the platform owns — supabase_admin's, the
 * auth and storage admins' — are Supabase's, like their grants: they differ
 * between a Supabase project and plain PostgreSQL or between Supabase
 * versions, and `postgres` cannot change them, so offering to failed the
 * whole apply. `postgres`'s own are the project's.
 */
function platformDefaultPrivileges(sql: string): boolean {
  const role = /^\s*ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+("(?:[^"]|"")+"|[\w$]+)/i.exec(sql)?.[1]
  if (!role) return false
  const name = role.startsWith('"') ? role.slice(1, -1).replace(/""/g, '"') : role.toLowerCase()
  return name !== 'postgres' && PLATFORM_ROLES.includes(name)
}

function issuesFromUnits(
  upUnits: DbDiffUnit[],
  downUnits: DbDiffUnit[],
  check: 'schema' | 'data',
  ignoreSchemas?: string[],
  ignoredSchemaTables?: Set<string>,
): DriftIssue[] {
  const pairs = pairUnits(upUnits, downUnits).filter(({ up, down }) =>
    !(ignoreSchemas?.length && isCrossSchemaFkUnit(up, down, ignoreSchemas, ignoredSchemaTables))
    && !platformDefaultPrivileges(up.sql))

  return pairs.map(({ up, down }, i) => {
    const upSql = up.sql
    const downSql = down?.sql ?? ''
    const statements = splitStatements(upSql)
    const replaced = replacedObject(up, statements)
    const manualOnly = manualEnumChange(up)
    const manual = manualOnly ? { manualOnly } : {}

    if (replaced) {
      const report = REPLACEABLE_REPORT[replaced.kind]
      return {
        id: `${check}-alter-${report.idPart}-${i + 1}`,
        check,
        severity: 'warning' as const,
        title: `${report.label}: ${qualifySchemaName(replaced.name)}`,
        description: `${report.what} differs between source and target.`,
        sql: { up: upSql, down: downSql },
        ...manual,
      }
    }

    const modified = modifiedTitle(up, statements)
    if (modified) {
      return {
        id: `${check}-alter-${up.kind.replace(/^Alter/, '').toLowerCase()}-${i + 1}`,
        check,
        severity: 'warning' as const,
        title: modified,
        description: 'Definition differs between source and target.',
        sql: { up: upSql, down: downSql },
        ...manual,
      }
    }

    const lead = leadStatement(up, statements)
    const type = classifyStatement(lead)
    return {
      id: `${check}-${type}-${i + 1}`,
      check,
      severity: DROP_TYPES.includes(type) ? 'critical' : 'warning',
      title: summariseStatement(lead, check, downSql),
      description: `${check === 'schema' ? 'Schema' : 'Data'} difference detected by @dbdiff/cli.`,
      sql: { up: upSql, down: downSql },
      ...manual,
    }
  })
}

/**
 * Why an enum change cannot be applied automatically, when dbdiff says so.
 *
 * Removing or reordering labels moves everything using the type to a new one;
 * what a move cannot carry — a routine taking the type, a domain over it — dbdiff
 * names in a comment and falls back to replacing the type, which PostgreSQL
 * refuses. Applied, that one refusal rolled back every other fix with it, so
 * it is reported as a manual step instead, naming what is in the way.
 */
function manualEnumChange(unit: DbDiffUnit): string | undefined {
  if (unit.kind !== 'AlterEnum' || !/^--.*\benum labels\b/im.test(unit.sql)) return undefined
  const blockers = [...unit.sql.matchAll(/^--\s{3}(.+)$/gm)].map(m => m[1].trim())
  return 'removing or reordering these enum labels needs the type replaced'
    + (blockers.length > 0 ? `, and these use it in ways that cannot be moved automatically: ${blockers.join(', ')}` : '')
    + '. Migrate them first, then re-run, or apply the change by hand.'
}

/**
 * A constraint change about a foreign key into an ignored schema — a false
 * positive from dbdiff seeing that schema's tables as stubs. The reference is
 * in the ADD, which is the UP of an added key and the DOWN of a dropped one.
 */
function isCrossSchemaFkUnit(
  up: DbDiffUnit,
  down: DbDiffUnit | undefined,
  schemas: string[],
  ignoredSchemaTables?: Set<string>,
): boolean {
  if (!/Constraint$/.test(up.kind)) return false
  return [up.sql, down?.sql ?? ''].some(sql =>
    /\bFOREIGN\s+KEY\b/i.test(sql)
    && (hasCrossSchemaRef(sql, schemas, ignoredSchemaTables) || hasBrokenRef(sql)))
}

/** The object a unit drops and recreates, when that is what it does. */
function replacedObject(
  unit: DbDiffUnit,
  statements: string[],
): { kind: ReplaceableKind; name: string } | undefined {
  const kind = REPLACING_KINDS[unit.kind]
  if (!kind) return undefined
  if (kind === 'view') return replacedView(unit, statements)
  const drop = statements.find(sql => replaceablePart(sql)?.drop)
  if (!drop) return undefined

  if (kind === 'type') return { kind, name: unit.object }
  const create = [...statements].reverse().find(sql => replaceablePart(sql)?.drop === false) ?? drop
  return {
    kind,
    name: kind === 'routine'
      ? extractRoutineName(create) + extractRoutineArgs(drop)
      : REPLACEABLE_NAME[kind](create),
  }
}

/**
 * The view a view's unit replaces. Besides its own statements the unit can
 * drop and put back the views and policies reading it, so the view is the
 * one dbdiff names; and replaced in place, it has no DROP at all.
 */
function replacedView(unit: DbDiffUnit, statements: string[]): { kind: ReplaceableKind; name: string } | undefined {
  const views = statements.filter(sql => replaceablePart(sql)?.kind === 'view')
  const own = (sql: string) => bareName(REPLACEABLE_NAME.view(sql)) === bareName(unit.object)
  const create = views.find(sql => replaceablePart(sql)?.drop === false && own(sql))
    ?? views.filter(sql => replaceablePart(sql)?.drop === false).pop()
  const drop = views.find(sql => replaceablePart(sql)?.drop && own(sql)) ?? views.find(sql => replaceablePart(sql)?.drop)
  const named = create ?? drop
  return named ? { kind: 'view', name: REPLACEABLE_NAME.view(named) } : undefined
}

/** A name without its schema or quotes, for matching one to dbdiff's unit object. */
const bareName = (name: string) => name.slice(name.lastIndexOf('.') + 1).replace(/"/g, '').toLowerCase()

/** Changed objects dbdiff replaces, or changes where they stand, by unit kind. */
const MODIFIED_KINDS: Record<string, string> = {
  AlterRangeType: 'Type modified',
  AlterAggregate: 'Aggregate modified',
  AlterRule: 'Rule modified',
  AlterStatistics: 'Statistics modified',
  AlterEventTrigger: 'Event trigger modified',
  AlterCast: 'Cast modified',
  AlterTextSearchConfiguration: 'Text search configuration modified',
  AlterTextSearchDictionary: 'Text search dictionary modified',
  AlterForeignServer: 'Foreign server modified',
  AlterUserMapping: 'User mapping modified',
  AlterForeignTable: 'Foreign table modified',
  AlterDefaultPrivileges: 'Default privileges differ',
}

/**
 * "<Kind> modified: <name>" for a changed object of the kinds above, named
 * from the statement that makes it — its DROP would read as the object
 * being removed.
 */
function modifiedTitle(unit: DbDiffUnit, statements: string[]): string | undefined {
  const label = MODIFIED_KINDS[unit.kind]
  if (!label) return undefined
  const making = statements.find(sql => !/^\s*DROP\b/i.test(sql)) ?? statements[0]
  const summary = making ? summariseStatement(making, 'schema') : ''
  const name = summary.slice(summary.indexOf(': ') + 2)
  return `${label}: ${name || unit.object}`
}

/**
 * The statement a unit is named by: for a table change, its first ALTER
 * TABLE (a column type change opens by standing views aside; a serial column
 * by creating its sequence); otherwise its first statement.
 */
function leadStatement(unit: DbDiffUnit, statements: string[]): string {
  if (unit.kind.startsWith('AlterTable')) {
    const alter = statements.find(sql => /^\s*ALTER\s+TABLE\b/i.test(sql))
    if (alter) return alter
  }
  return statements[0] ?? unit.sql
}

/** `ALTER TABLE t ALTER COLUMN c TYPE ...`, capturing the table and column. */
const ALTER_COLUMN_TYPE = /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s+ALTER\s+COLUMN\s+("[^"]+"|[\w$]+)\s+(?:SET\s+DATA\s+)?TYPE\b/i

/** The ALTER ... TYPE statement inside a grouped column change, if this is one. */
function columnTypeChangeOf(sql: string): string | undefined {
  if (!/^\s*DROP\s+/i.test(sql)) return undefined
  return splitStatements(sql).find(s => ALTER_COLUMN_TYPE.test(s))
}

/** An identifier without quotes or a `public.` qualifier, for comparing names. */
function plainName(identifier: string): string {
  return identifier.replace(/"/g, '').replace(/^public\./i, '').trim()
}

/**
 * Keep a column type change together with the dependants dbdiff drops and
 * recreates around it.
 *
 * PostgreSQL refuses `ALTER COLUMN ... TYPE` while a view, policy or trigger
 * condition reads the column, so @dbdiff/cli brackets the change: drop them,
 * retype, recreate them with their grants and comments. As separate issues
 * that bracket came apart — the DROP POLICY was held back by the destructive
 * gate as a removal while the ALTER went ahead and failed, and two column
 * changes under one view each became a CREATE VIEW, the second of which
 * failed on the first. One change, one issue.
 *
 * Recognised by shape: the DROP ... IF EXISTS statements immediately before
 * the ALTER, and after it the rest of that column's change and the statements
 * that recreate, grant, comment on or index what was dropped. A plain type
 * change with nothing around it is left exactly as it was.
 */
export function groupColumnTypeChanges(statements: string[]): string[] {
  const out: string[] = []
  let i = 0

  while (i < statements.length) {
    const alter = ALTER_COLUMN_TYPE.exec(statements[i])
    if (!alter) {
      out.push(statements[i])
      i++
      continue
    }

    const [, table, column] = alter
    const views = new Set<string>()
    const attached = new Set<string>()    // `name@table` for policies and triggers

    // Walk back over the drops dbdiff emitted for this change.
    const drops: Array<{ index: number; view?: string; attached?: string; table?: string }> = []
    let start = out.length
    while (start > 0) {
      const drop = /^\s*DROP\s+(?:(MATERIALIZED\s+VIEW|VIEW)|(POLICY|TRIGGER))\s+IF\s+EXISTS\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)(?:\s+ON\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?))?\s*;?\s*$/i
        .exec(out[start - 1])
      if (!drop) break
      if (drop[1]) {
        views.add(plainName(drop[3]))
        drops.unshift({ index: start - 1, view: plainName(drop[3]) })
      } else {
        const key = `${plainName(drop[3])}@${plainName(drop[4] ?? '')}`
        attached.add(key)
        drops.unshift({ index: start - 1, attached: key, table: plainName(drop[4] ?? '') })
      }
      start--
    }
    if (drops.length === 0) {
      out.push(statements[i])
      i++
      continue
    }

    const onView = (name: string) => views.has(plainName(name))
    const recreated = new Set<string>()
    const belongs = (sql: string): boolean => {
      const sameColumn = ALTER_COLUMN_TYPE.exec(sql)
        ?? /^\s*ALTER\s+TABLE\s+(?:ONLY\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s+ALTER\s+COLUMN\s+("[^"]+"|[\w$]+)\s+(?:SET|DROP)\b/i.exec(sql)
      if (sameColumn) return plainName(sameColumn[1]) === plainName(table) && plainName(sameColumn[2]) === plainName(column)

      let m = /^\s*CREATE\s+(?:MATERIALIZED\s+)?VIEW\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(sql)
      if (m) return onView(m[1])
      m = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(?:ONLY\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(sql)
      if (m) return onView(m[1])
      m = /^\s*(?:GRANT|REVOKE)\b[\s\S]*?\bON\s+(?:TABLE\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s+(?:TO|FROM)\b/i.exec(sql)
      if (m) return onView(m[1])
      m = /^\s*COMMENT\s+ON\s+(?:MATERIALIZED\s+VIEW|VIEW)\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(sql)
      if (m) return onView(m[1])
      m = /^\s*COMMENT\s+ON\s+COLUMN\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\.(?:"[^"]+"|[\w$]+)\s+IS\b/i.exec(sql)
      if (m) return onView(m[1])
      m = /^\s*CREATE\s+(?:POLICY|(?:CONSTRAINT\s+)?TRIGGER)\s+("[^"]+"|[\w$]+)[\s\S]*?\bON\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/i.exec(sql)
      if (m) {
        const key = `${plainName(m[1])}@${plainName(m[2])}`
        if (attached.has(key)) { recreated.add(key); return true }
        return onView(m[2])
      }
      return false
    }

    let end = i + 1
    while (end < statements.length && belongs(statements[end])) end++

    // A policy or trigger drop that is neither on the altered table nor put
    // back here belongs to another diff that happened to land next to this
    // one — a policy genuinely being removed. Grouping it would put the whole
    // column change behind the destructive gate with it, so the run is
    // trimmed from its far end until only this change's own drops remain.
    const foreign = (d: typeof drops[number]) =>
      d.attached !== undefined && d.table !== plainName(table) && !recreated.has(d.attached)
    while (drops.length > 0 && foreign(drops[0])) {
      drops.shift()
      start++
    }
    if (drops.length === 0) {
      out.push(statements[i])
      i++
      continue
    }

    const group = [...out.splice(start), ...statements.slice(i, end)]
    out.push(group.join('\n'))
    i = end
  }

  return out
}

interface MergedStatement {
  up: string
  down: string
  /** Set when this entry is a DROP+CREATE pair replacing one object. */
  modified?: { kind: ReplaceableKind; name: string }
}

/**
 * The object kinds dbdiff replaces by dropping and recreating.
 *
 * Routines were the first (issue #35). Types, domains and sequences behave the
 * same way — an enum whose values changed arrives as `DROP TYPE` + `CREATE
 * TYPE` — and needed the same treatment for the same two reasons (issue #81).
 */
type ReplaceableKind = 'routine' | 'type' | 'sequence' | 'policy' | 'trigger' | 'view' | 'collation'

/** How each kind's identifier is read out of a statement. */
const REPLACEABLE_NAME: Record<ReplaceableKind, (sql: string) => string> = {
  routine: extractRoutineName,
  type: (sql) => extractQualifiedName(sql, /\b(?:TYPE|DOMAIN)\s+(?:IF\s+EXISTS\s+)?/i),
  sequence: (sql) => extractQualifiedName(sql, /\bSEQUENCE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i),
  // `table.policy`: a policy name is unique only per table.
  policy: (sql) => policyLabel(sql),
  // `schema.table.trigger`, for the same reason.
  trigger: (sql) => triggerLabel(sql),
  view: (sql) => extractQualifiedName(sql, AFTER.view),
  collation: (sql) => extractQualifiedName(sql, AFTER.collation),
}

/** How a merged pair of each kind is reported. */
const REPLACEABLE_REPORT: Record<ReplaceableKind, { idPart: string; label: string; what: string }> = {
  routine:  { idPart: 'function', label: 'Function modified', what: 'Function body' },
  type:     { idPart: 'type',     label: 'Type modified',     what: 'Type definition' },
  sequence: { idPart: 'sequence', label: 'Sequence modified', what: 'Sequence definition' },
  policy:   { idPart: 'policy',   label: 'Policy modified',   what: 'Policy definition' },
  trigger:  { idPart: 'trigger',  label: 'Trigger modified',  what: 'Trigger definition' },
  view:     { idPart: 'view',     label: 'View modified',     what: 'View definition' },
  collation: { idPart: 'collation', label: 'Collation modified', what: 'Collation definition' },
}

/** Whether a statement drops or creates a replaceable object, and of which kind. */
function replaceablePart(sql: string): { kind: ReplaceableKind; drop: boolean } | undefined {
  // dbdiff renders a changed policy as DROP POLICY + CREATE POLICY, adjacent.
  // Apart, the DROP read as a policy *removed* and was held back by the
  // destructive gate (issue #88), leaving the CREATE to fail on the policy
  // still there. Together they are a replacement, which the gate allows.
  if (/^\s*DROP\s+POLICY\b/i.test(sql)) return { kind: 'policy', drop: true }
  if (/^\s*CREATE\s+POLICY\b/i.test(sql)) return { kind: 'policy', drop: false }
  // A changed trigger is dropped and recreated the same way, and read apart
  // was a critical "Extra trigger" for a trigger that is still wanted.
  if (/^\s*DROP\s+TRIGGER\b/i.test(sql)) return { kind: 'trigger', drop: true }
  // A changed view too: dbdiff can only replace one, and a PostgreSQL 15
  // and 16+ pair printed every view differently.
  if (/^\s*DROP\s+(?:MATERIALIZED\s+)?VIEW\b/i.test(sql)) return { kind: 'view', drop: true }
  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i.test(sql)) return { kind: 'view', drop: false }
  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i.test(sql)) return { kind: 'trigger', drop: false }
  switch (classifyStatement(sql)) {
    case CREATE_FUNCTION:   return { kind: 'routine',  drop: false }
    case DROP_FUNCTION:     return { kind: 'routine',  drop: true }
    case 'create-type':     return { kind: 'type',     drop: false }
    case 'drop-type':       return { kind: 'type',     drop: true }
    case 'create-sequence': return { kind: 'sequence', drop: false }
    case 'drop-sequence':   return { kind: 'sequence', drop: true }
    case 'create-collation': return { kind: 'collation', drop: false }
    case 'drop-collation':   return { kind: 'collation', drop: true }
    default:                return undefined
  }
}

/** Kind and bare name together, so a function and a type of one name cannot pair. */
function replacementKey(kind: ReplaceableKind, sql: string): string {
  const name = REPLACEABLE_NAME[kind](sql)
  if (kind === 'policy') return `policy:${name.replace(/"/g, '').toLowerCase()}`
  // Table and trigger, without the schema a DROP may leave out.
  if (kind === 'trigger') return `trigger:${name.split('.').slice(-2).join('.').toLowerCase()}`
  return `${kind}:${name.slice(name.lastIndexOf('.') + 1).toLowerCase()}`
}

/**
 * Collapse `DROP FUNCTION` + `CREATE [OR REPLACE] FUNCTION` pairs for the same
 * routine into a single entry.
 *
 * dbdiff replaces a changed function by emitting both statements. Treating them
 * as independent issues reported one modified function twice — once as a
 * CRITICAL "Extra function" and once as a WARNING "Function missing" — when it
 * is neither extra nor missing (issue #35). On a real diff that inflated 105
 * genuine differences into 149 reported issues, and dragged the drift score
 * down via the bogus criticals.
 *
 * Only a DROP followed by a CREATE for the same routine is merged; an
 * unpaired DROP is still a genuine "Extra function".
 *
 * Postgres allows overloading, so one name can own several DROP+CREATE pairs
 * whose argument types differ. They cannot be told apart by name, and the
 * statements do not agree on a signature to match them by (see `replacementKey`),
 * so pairing goes by position:
 *
 * - Adjacent DROP+CREATE always merge. dbdiff renders a changed routine from a
 *   single diff object, so the two statements come out together — adjacency is
 *   what a replacement actually looks like.
 * - A non-adjacent pair merges only when that name has exactly one DROP and one
 *   CREATE in the batch, where there is nothing to confuse it with. This is
 *   the case issue #35 was about.
 *
 * Anything else stays unmerged and is reported as a genuine extra or missing
 * routine, which is the safe direction: over-reporting is noise, whereas a
 * wrong pairing writes a migration that drops an overload and recreates a
 * different one in its place.
 */
export function mergeReplacements(
  upStatements: string[],
  downStatements: string[],
): MergedStatement[] {
  // Per key, the indices of the CREATEs still up for grabs, in source order.
  const unclaimedCreates = new Map<string, number[]>()
  const dropCounts = new Map<string, number>()
  upStatements.forEach((sql, i) => {
    const part = replaceablePart(sql)
    if (!part) return

    const key = replacementKey(part.kind, sql)
    if (part.drop) {
      dropCounts.set(key, (dropCounts.get(key) ?? 0) + 1)
    } else {
      unclaimedCreates.set(key, [...(unclaimedCreates.get(key) ?? []), i])
    }
  })

  const absorbed = new Set<number>()
  const out: MergedStatement[] = []

  upStatements.forEach((upSql, i) => {
    if (absorbed.has(i)) return

    const down = downStatements[i] ?? ''
    const part = replaceablePart(upSql)
    if (!part?.drop) {
      out.push({ up: upSql, down })
      return
    }

    const key = replacementKey(part.kind, upSql)
    const unambiguous = dropCounts.get(key) === 1 && unclaimedCreates.get(key)?.length === 1
    const createIdx = claimCreateFor(unclaimedCreates, key, i, unambiguous)
    if (createIdx === undefined) {
      out.push({ up: upSql, down })
      return
    }

    const createSql = upStatements[createIdx]
    absorbed.add(createIdx)
    out.push({
      // Drop first, create second, in one statement. Kept together rather than
      // ordered apart because `orderStatements` sends drops to the last phase
      // and creates to an early one, which put the CREATE before the DROP it
      // was replacing — `type "order_state" already exists`, and the whole
      // apply rolled back (issue #81). Phasing reads the CREATE in a merged
      // pair, so the pair runs where the object it leaves behind belongs.
      up: `${upSql}\n${createSql}`,
      down: [down, downStatements[createIdx] ?? ''].filter(Boolean).join('\n'),
      modified: {
        kind: part.kind,
        // A routine's name is qualified by its argument types, since overloads
        // share a name; nothing else can be overloaded.
        name: part.kind === 'routine'
          ? extractRoutineName(createSql) + extractRoutineArgs(upSql)
          : REPLACEABLE_NAME[part.kind](createSql),
      },
    })
  })

  return out
}

/**
 * Claim the CREATE that replaces the DROP at `dropIdx`, removing it so a later
 * DROP of the same name cannot claim it too.
 *
 * Normally that is the immediately following statement. When `unambiguous` —
 * one DROP and one CREATE for this name in the whole batch — any later CREATE
 * will do, since there is no second candidate to get it wrong.
 */
function claimCreateFor(
  unclaimed: Map<string, number[]>,
  key: string,
  dropIdx: number,
  unambiguous: boolean,
): number | undefined {
  const queue = unclaimed.get(key)
  if (!queue) return undefined

  const at = queue.findIndex((idx) => (unambiguous ? idx > dropIdx : idx === dropIdx + 1))
  if (at === -1) return undefined

  return queue.splice(at, 1)[0]
}

/**
 * Identify which UP statements to keep after filtering cross-schema FK false positives.
 *
 * Two-pass approach:
 * 1. Mark ADD CONSTRAINT ... FOREIGN KEY statements where the UP references an
 *    ignored schema or the DOWN counterpart has broken `REFERENCES "" ("")`,
 *    or the referenced table (even unqualified) is in `ignoredSchemaTables`.
 * 2. Mark paired DROP CONSTRAINT statements that share the same constraint name.
 */
function filterCrossSchemaFks(
  upStmts: string[],
  downStmts: string[],
  schemas: string[],
  ignoredSchemaTables?: Set<string>,
): boolean[] {
  const keep = new Array<boolean>(upStmts.length).fill(true)

  // Collect constraint names that are cross-schema FKs
  const crossSchemaConstraints = new Set<string>()

  // Pass 1: detect ADD CONSTRAINT ... FOREIGN KEY with cross-schema refs
  for (let i = 0; i < upStmts.length; i++) {
    const upper = upStmts[i].toUpperCase()
    if (!upper.includes('ADD CONSTRAINT') || !upper.includes('FOREIGN KEY')) continue

    const isCrossSchema =
      hasCrossSchemaRef(upStmts[i], schemas, ignoredSchemaTables) ||
      (downStmts[i] != null && hasBrokenRef(downStmts[i]))

    if (isCrossSchema) {
      keep[i] = false
      const name = upStmts[i].match(/CONSTRAINT\s+"([^"]+)"/i)?.[1]
      if (name) crossSchemaConstraints.add(name)
    }
  }

  // Pass 2: filter paired DROP CONSTRAINT for the same FK names
  for (let i = 0; i < upStmts.length; i++) {
    if (!keep[i]) continue
    const upper = upStmts[i].toUpperCase()
    if (!upper.includes('DROP CONSTRAINT')) continue
    const name = upStmts[i].match(/DROP\s+CONSTRAINT\s+"([^"]+)"/i)?.[1]
    if (name && crossSchemaConstraints.has(name)) {
      keep[i] = false
    }
  }

  return keep
}

/**
 * Check if a REFERENCES clause points to an ignored schema, is empty/broken,
 * or is unqualified but the referenced table exists in an ignored schema.
 *
 * Handles three forms:
 *   REFERENCES "" ("")              — broken ref from dbdiff, always filtered
 *   REFERENCES "auth"."users" ("id") — schema-qualified into an ignored schema: kept
 *                                       when the target has that table, else filtered
 *   REFERENCES "users" ("id")        — unqualified, filtered if "users" is in
 *                                       ignoredSchemaTables (queried from target DB)
 */
function hasCrossSchemaRef(sql: string, schemas: string[], ignoredSchemaTables?: Set<string>): boolean {
  const refsMatch = sql.match(/REFERENCES\s+"([^"]*)"(?:\s*\.\s*"([^"]*)")?\s*\(\s*"([^"]*)"\s*\)/i)
  if (!refsMatch) return false
  const [, first, second] = refsMatch
  // Broken: REFERENCES "" ("")
  if (first === '') return true
  // Schema-qualified: REFERENCES "auth"."users" ("id"). A key from the user's
  // own schema onto an ignored one — every Supabase table referencing
  // auth.users — is real drift, kept when the target has the table it
  // references. Filtered only when that is not known, as before: dbdiff
  // before 3.0.0-rc.18 rendered these without the schema, which is why they
  // were all dropped, and so they were never synced.
  if (second !== undefined) {
    if (!schemas.some(s => s.toLowerCase() === first.toLowerCase())) return false
    return !ignoredSchemaTables?.has(`${first}.${second}`.toLowerCase())
  }
  // Unqualified: REFERENCES "users" ("id") — filter if the table lives in an ignored schema.
  // This catches the case where pg_dump or dbdiff drops the schema prefix due to
  // search_path, so the reference appears unqualified even though it targets e.g. auth.users.
  return ignoredSchemaTables ? ignoredSchemaTables.has(first.toLowerCase()) : false
}

/** Check if SQL contains a broken REFERENCES "" ("") from dbdiff. */
function hasBrokenRef(sql: string): boolean {
  return /REFERENCES\s+""\s*\(\s*""\s*\)/i.test(sql)
}

/**
 * dbdiff's SQL as statements, each ending in `;`, without the comment lines
 * in front of it.
 *
 * The shared splitter (utils/sql-split.ts) does the scanning: quotes, dollar
 * quotes, comments and `BEGIN ATOMIC` bodies. This one split at a `;` that
 * ended a line, so a string value holding one — a data diff's INSERT of
 * `'a;\nb'` — or a SQL-standard function body, which pg_get_functiondef
 * writes a statement per line, came apart.
 */
function splitStatements(sql: string): string[] {
  if (!sql) return []
  return splitSqlStatements(sql)
    .map(statement => withoutLeadingComments(statement))
    .filter(statement => statement.length > 0)
    .map(statement => `${statement};`)
}

/**
 * A statement without the `--` lines in front of it.
 *
 * A statement opening with a comment used to be dropped whole — and dbdiff
 * puts notes in front of statements: the DROP TYPE replacing an enum whose
 * labels it could not move came after three lines saying why, so it never
 * reached a finding.
 */
function withoutLeadingComments(chunk: string): string {
  return chunk.trim().replace(/^(?:--[^\n]*(?:\n|$)\s*)+/, '').trim()
}

export function classifyStatement(sql: string): string {
  const upper = sql.toUpperCase().trimStart()
  // Views
  if (upper.startsWith('CREATE VIEW') || upper.startsWith('CREATE OR REPLACE VIEW')) return 'create-view'
  if (upper.startsWith('ALTER VIEW')) return 'alter-view'
  if (upper.startsWith('DROP VIEW')) return 'drop-view'
  // Functions / procedures
  if (upper.startsWith('CREATE FUNCTION') || upper.startsWith('CREATE OR REPLACE FUNCTION')) return CREATE_FUNCTION
  if (upper.startsWith('ALTER FUNCTION')) return 'alter-function'
  if (upper.startsWith('DROP FUNCTION')) return DROP_FUNCTION
  if (upper.startsWith('CREATE PROCEDURE') || upper.startsWith('CREATE OR REPLACE PROCEDURE')) return CREATE_FUNCTION
  if (upper.startsWith('DROP PROCEDURE')) return DROP_FUNCTION
  // Triggers
  if (upper.startsWith('CREATE TRIGGER') || upper.startsWith('CREATE OR REPLACE TRIGGER')) return 'create-trigger'
  if (upper.startsWith('ALTER TRIGGER')) return 'alter-trigger'
  if (upper.startsWith('DROP TRIGGER')) return 'drop-trigger'
  // Types / enums / domains
  if (upper.startsWith('CREATE TYPE')) return 'create-type'
  if (upper.startsWith('ALTER TYPE')) return 'alter-type'
  if (upper.startsWith('DROP TYPE')) return 'drop-type'
  if (upper.startsWith('CREATE DOMAIN')) return 'create-type'
  if (upper.startsWith('ALTER DOMAIN')) return 'alter-type'
  if (upper.startsWith('DROP DOMAIN')) return 'drop-type'
  // Tables
  if (upper.startsWith('ALTER TABLE')) return 'alter'
  if (upper.startsWith('CREATE TABLE')) return 'create-table'
  if (upper.startsWith('DROP TABLE')) return 'drop'
  // Indexes
  if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) return 'create-index'
  if (upper.startsWith('DROP INDEX')) return 'drop'
  // Collations
  if (upper.startsWith('CREATE COLLATION')) return 'create-collation'
  if (upper.startsWith('ALTER COLLATION')) return 'alter-collation'
  if (upper.startsWith('DROP COLLATION')) return 'drop-collation'
  // Sequences
  if (upper.startsWith('CREATE SEQUENCE')) return 'create-sequence'
  if (upper.startsWith('ALTER SEQUENCE')) return 'alter-sequence'
  if (upper.startsWith('DROP SEQUENCE')) return 'drop-sequence'
  // Data
  if (upper.startsWith('INSERT')) return 'insert'
  if (upper.startsWith('UPDATE')) return 'update'
  if (upper.startsWith('DELETE')) return 'delete'
  return 'change'
}

/**
 * One title format for every schema finding: `<Finding>: <schema>.<name>`.
 *
 * Each kind used to carry its own ad-hoc regex, and two of them read the wrong
 * capture group: `/INDEX\s+.../` never reached the index name at all, so
 * `CREATE INDEX idx_orders_status ON public.orders` was titled "Index missing on
 * public" — the schema, in the name's place (issue #47). The rules below all
 * go through one schema-aware identifier parser instead.
 *
 * Matched in order and anchored at the start of the statement, so a trigger
 * that executes a function is a trigger, not a function.
 */
interface SummaryRule {
  match: RegExp
  label: string
  name: (sql: string, downSql?: string) => string
  /** The name is not a schema object's — a role's privileges, a cast — so no schema is added. */
  unqualified?: boolean
}

/** Head patterns for the identifier that follows each keyword. */
const AFTER = {
  view: /\bVIEW\s+(?:IF\s+EXISTS\s+)?/i,
  trigger: /\bTRIGGER\s+(?:IF\s+EXISTS\s+)?/i,
  type: /\bTYPE\s+(?:IF\s+EXISTS\s+)?/i,
  domain: /\bDOMAIN\s+(?:IF\s+EXISTS\s+)?/i,
  sequence: /\bSEQUENCE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  table: /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?/i,
  index: /\bINDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  policy: /\bPOLICY\s+(?:IF\s+EXISTS\s+)?/i,
  collation: /\bCOLLATION\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  eventTrigger: /\bEVENT\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?/i,
  aggregate: /\bAGGREGATE\s+(?:IF\s+EXISTS\s+)?/i,
  statistics: /\bSTATISTICS\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  textSearch: /\bTEXT\s+SEARCH\s+(?:CONFIGURATION|DICTIONARY)\s+(?:IF\s+EXISTS\s+)?/i,
  server: /\bSERVER\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  foreignTable: /\bFOREIGN\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?/i,
  on: /\bON\s+(?:ONLY\s+)?/i,
}

/** Name an object by the identifier following `head`. */
const named = (head: RegExp) => (sql: string) => extractQualifiedName(sql, head)

/**
 * `public.people.name → full_name`, `public.clients → customers`: what a
 * rename statement renames, and to what.
 */
function renameLabel(sql: string): string {
  const table = extractQualifiedName(sql, /\b(?:TABLE|INDEX)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?/i)
  const to = /\bTO\s+("(?:[^"]|"")*"|[\w$]+)\s*;?\s*$/i.exec(sql.trim())?.[1]
  const from = /\bRENAME\s+(?:COLUMN|CONSTRAINT)\s+("(?:[^"]|"")*"|[\w$]+)/i.exec(sql)?.[1]
  return `${qualifySchemaName(table)}${from ? '.' + unquoted(from) : ''} → ${to ? unquoted(to) : UNKNOWN_NAME}`
}

/** `role in schema on tables` for an ALTER DEFAULT PRIVILEGES. */
function defaultPrivilegesLabel(sql: string): string {
  const role = /\bFOR\s+ROLE\s+("(?:[^"]|"")*"|\S+)/i.exec(sql)?.[1]
  const schema = /\bIN\s+SCHEMA\s+("(?:[^"]|"")*"|\S+)/i.exec(sql)?.[1]
  const kind = /\bON\s+(TABLES|SEQUENCES|FUNCTIONS|ROUTINES|TYPES|SCHEMAS)\b/i.exec(sql)?.[1]
  return [role && unquoted(role), schema ? `in ${unquoted(schema)}` : 'in every schema', kind && `on ${kind.toLowerCase()}`]
    .filter(Boolean).join(' ')
}

/** `table.rule` for a rule statement. */
function ruleLabel(sql: string): string {
  const rule = extractQualifiedName(sql, /\bRULE\s+(?:IF\s+EXISTS\s+)?/i)
  const table = /\bTO\s+((?:"(?:[^"]|"")*"|[\w$]+)(?:\.(?:"(?:[^"]|"")*"|[\w$]+))?)/i.exec(sql)?.[1]
    ?? /\bON\s+((?:"(?:[^"]|"")*"|[\w$]+)(?:\.(?:"(?:[^"]|"")*"|[\w$]+))?)/i.exec(sql)?.[1]
  return table ? `${unquoted(table.split('.').pop() ?? table)}.${rule.split('.').pop()}` : rule
}

/** `(a AS b)` for a cast statement. */
function castLabel(sql: string): string {
  return /\(([^()]+?\s+AS\s+[^()]+?)\)/i.exec(sql)?.[1] ?? UNKNOWN_NAME
}

/** `user@server` for a user mapping statement. */
function userMappingLabel(sql: string): string {
  const user = /\bFOR\s+("(?:[^"]|"")*"|\S+)/i.exec(sql)?.[1] ?? 'unknown'
  const server = /\bSERVER\s+("(?:[^"]|"")*"|[^\s;]+)/i.exec(sql)?.[1] ?? 'unknown'
  return `${unquoted(user)}@${unquoted(server)}`
}

/**
 * `table.policy` for a policy statement.
 *
 * A policy name is unique only per table, so the table is part of its
 * identity — the same keying the RLS check uses, which means the two checks
 * now name the same policy the same way.
 */
function policyLabel(sql: string): string {
  const policy = extractQualifiedName(sql, AFTER.policy)
  const table = extractQualifiedName(sql, AFTER.on)

  if (policy === UNKNOWN_NAME) return UNKNOWN_NAME
  if (table === UNKNOWN_NAME) return policy

  // The table is qualified here rather than by the caller: the caller only
  // qualifies a name with no dot in it, and `orders.p` already has one.
  return `${qualifySchemaName(table)}.${policy}`
}

/**
 * `schema.table.trigger` for a trigger statement.
 *
 * A trigger name is unique only per table, like a policy's, and one name is
 * commonly reused on every table (`set_updated_at`): titled by the name alone,
 * three findings about three tables read as the same one three times. dbdiff
 * leaves the table of a DROP unqualified, so its schema is read off the
 * counterpart CREATE when that is on the same table.
 */
function triggerLabel(sql: string, downSql?: string): string {
  const trigger = extractQualifiedName(sql, AFTER.trigger)
  let table = extractQualifiedName(sql, AFTER.on)
  if (trigger === UNKNOWN_NAME) return UNKNOWN_NAME
  if (table === UNKNOWN_NAME) return trigger

  if (!table.includes('.') && downSql) {
    const counterpart = extractQualifiedName(downSql, AFTER.on)
    if (counterpart.includes('.') && unqualify(counterpart) === table.toLowerCase()) table = counterpart
  }
  return `${qualifySchemaName(table)}.${trigger}`
}

/**
 * The schema @dbdiff/cli compares.
 *
 * Its Postgres adapter is scoped to `public` throughout — every catalogue query
 * filters on `schemaname = 'public'` — so a name it emits without a qualifier is
 * a `public` object, not an object of unknown schema. Restoring the qualifier is
 * recovering information the SQL dropped, not guessing at it.
 */
const DBDIFF_SCHEMA = 'public'

/**
 * Put every schema finding's name in the same form: `schema.name`.
 *
 * Whether a name arrived qualified depended on which statement dbdiff happened
 * to emit — `CREATE INDEX ... ON public.orders` carries a schema, `DROP TABLE
 * "legacy_notes"` does not — so titles for one run were a mix of both, split by
 * object type rather than by anything a reader could predict, and the mix did
 * not even hold within a type (issue #70). A long list then neither sorted nor
 * aligned.
 *
 * Splits at the first `(` so a routine's argument list cannot be mistaken for a
 * qualifier: `dist(numeric(10,2))` contains dots that are not schema separators.
 */
function qualifySchemaName(name: string): string {
  if (name === UNKNOWN_NAME) return name
  const paren = name.indexOf('(')
  const head = paren === -1 ? name : name.slice(0, paren)
  if (head.includes('.')) return name
  return `${DBDIFF_SCHEMA}.${name}`
}

/**
 * Qualify an index with the schema of the table it is on.
 *
 * Postgres puts an index in its table's schema and its grammar does not let
 * the CREATE qualify the index name, so the `ON` clause is where the schema
 * actually is. Left bare when the table is unqualified too — the schema is
 * then genuinely unknown, and inventing `public` would be a guess.
 */
function indexLabel(sql: string): string {
  const name = extractQualifiedName(sql, AFTER.index)
  if (name === UNKNOWN_NAME || name.includes('.')) return name

  const table = extractQualifiedName(sql, AFTER.on)
  const dot = table.lastIndexOf('.')
  return dot === -1 ? name : `${table.slice(0, dot)}.${name}`
}

const SCHEMA_RULES: SummaryRule[] = [
  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i, label: 'View missing', name: named(AFTER.view) },
  { match: /^\s*ALTER\s+(?:MATERIALIZED\s+)?VIEW\b/i, label: 'View altered', name: named(AFTER.view) },
  { match: /^\s*DROP\s+(?:MATERIALIZED\s+)?VIEW\b/i, label: 'Extra view', name: named(AFTER.view) },

  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i, label: 'Function missing', name: routineLabel },
  { match: /^\s*ALTER\s+FUNCTION\b/i, label: 'Function altered', name: routineLabel },
  { match: /^\s*DROP\s+FUNCTION\b/i, label: 'Extra function', name: routineLabel },
  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/i, label: 'Procedure missing', name: routineLabel },
  { match: /^\s*DROP\s+PROCEDURE\b/i, label: 'Extra procedure', name: routineLabel },

  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i, label: 'Trigger missing', name: triggerLabel },
  { match: /^\s*ALTER\s+TRIGGER\b/i, label: 'Trigger altered', name: triggerLabel },
  { match: /^\s*DROP\s+TRIGGER\b/i, label: 'Extra trigger', name: triggerLabel },

  { match: /^\s*CREATE\s+TYPE\b/i, label: 'Type missing', name: named(AFTER.type) },
  { match: /^\s*ALTER\s+TYPE\b/i, label: 'Type altered', name: named(AFTER.type) },
  { match: /^\s*DROP\s+TYPE\b/i, label: 'Extra type', name: named(AFTER.type) },
  { match: /^\s*CREATE\s+DOMAIN\b/i, label: 'Domain missing', name: named(AFTER.domain) },
  { match: /^\s*ALTER\s+DOMAIN\b/i, label: 'Domain altered', name: named(AFTER.domain) },
  { match: /^\s*DROP\s+DOMAIN\b/i, label: 'Extra domain', name: named(AFTER.domain) },

  { match: /^\s*ALTER\s+TABLE\b[^;]*\bRENAME\s+COLUMN\b/is, label: 'Column renamed', name: renameLabel, unqualified: true },
  { match: /^\s*ALTER\s+TABLE\b[^;]*\bRENAME\s+CONSTRAINT\b/is, label: 'Constraint renamed', name: renameLabel, unqualified: true },
  { match: /^\s*ALTER\s+TABLE\b[^;]*\bRENAME\s+TO\b/is, label: 'Table renamed', name: renameLabel, unqualified: true },
  { match: /^\s*ALTER\s+INDEX\b[^;]*\bRENAME\s+TO\b/is, label: 'Index renamed', name: renameLabel, unqualified: true },
  { match: /^\s*ALTER\s+TABLE\b/i, label: 'Table altered', name: named(AFTER.table) },
  { match: /^\s*CREATE\s+TABLE\b/i, label: 'Table missing', name: named(AFTER.table) },
  { match: /^\s*DROP\s+TABLE\b/i, label: 'Extra table', name: named(AFTER.table) },

  { match: /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i, label: 'Index missing', name: indexLabel },
  { match: /^\s*DROP\s+INDEX\b/i, label: 'Extra index', name: named(AFTER.index) },

  // Policies. Without these, dbdiff's own CREATE/DROP POLICY statements fell
  // through to the catch-all and were titled "Schema change: unknown" — the
  // one finding in a report that named no object at all (issue #97). Keyed
  // `table.policy`, which is how a policy is identified and how the RLS check
  // names the same one.
  { match: /^\s*CREATE\s+POLICY\b/i, label: 'Policy missing', name: policyLabel },
  { match: /^\s*ALTER\s+POLICY\b/i, label: 'Policy altered', name: policyLabel },
  { match: /^\s*DROP\s+POLICY\b/i, label: 'Extra policy', name: policyLabel },

  // Comments (rc.21) and extensions (rc.22), named like everything else, and
  // a comment by the object it is on and that object's kind.
  { match: /^\s*COMMENT\s+ON\b/i, label: 'Comment changed', name: commentLabel },
  { match: /^\s*CREATE\s+EXTENSION\b/i, label: 'Extension missing', name: extensionLabel },
  { match: /^\s*DROP\s+EXTENSION\b/i, label: 'Extra extension', name: extensionLabel },

  { match: /^\s*CREATE\s+COLLATION\b/i, label: 'Collation missing', name: named(AFTER.collation) },
  { match: /^\s*ALTER\s+COLLATION\b/i, label: 'Collation altered', name: named(AFTER.collation) },
  { match: /^\s*DROP\s+COLLATION\b/i, label: 'Extra collation', name: named(AFTER.collation) },

  { match: /^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b/i, label: 'Default privileges differ', name: defaultPrivilegesLabel, unqualified: true },
  { match: /^\s*CREATE\s+EVENT\s+TRIGGER\b/i, label: 'Event trigger missing', name: named(AFTER.eventTrigger) },
  { match: /^\s*DROP\s+EVENT\s+TRIGGER\b/i, label: 'Extra event trigger', name: named(AFTER.eventTrigger) },
  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?RULE\b/i, label: 'Rule missing', name: ruleLabel },
  { match: /^\s*DROP\s+RULE\b/i, label: 'Extra rule', name: ruleLabel },
  { match: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?AGGREGATE\b/i, label: 'Aggregate missing', name: named(AFTER.aggregate) },
  { match: /^\s*DROP\s+AGGREGATE\b/i, label: 'Extra aggregate', name: named(AFTER.aggregate) },
  { match: /^\s*CREATE\s+STATISTICS\b/i, label: 'Statistics missing', name: named(AFTER.statistics) },
  { match: /^\s*DROP\s+STATISTICS\b/i, label: 'Extra statistics', name: named(AFTER.statistics) },
  { match: /^\s*(?:CREATE|ALTER)\s+TEXT\s+SEARCH\s+CONFIGURATION\b/i, label: 'Text search configuration missing', name: named(AFTER.textSearch) },
  { match: /^\s*DROP\s+TEXT\s+SEARCH\s+CONFIGURATION\b/i, label: 'Extra text search configuration', name: named(AFTER.textSearch) },
  { match: /^\s*CREATE\s+TEXT\s+SEARCH\s+DICTIONARY\b/i, label: 'Text search dictionary missing', name: named(AFTER.textSearch) },
  { match: /^\s*DROP\s+TEXT\s+SEARCH\s+DICTIONARY\b/i, label: 'Extra text search dictionary', name: named(AFTER.textSearch) },
  { match: /^\s*CREATE\s+CAST\b/i, label: 'Cast missing', name: castLabel, unqualified: true },
  { match: /^\s*DROP\s+CAST\b/i, label: 'Extra cast', name: castLabel, unqualified: true },
  { match: /^\s*CREATE\s+SERVER\b/i, label: 'Foreign server missing', name: named(AFTER.server) },
  { match: /^\s*ALTER\s+SERVER\b/i, label: 'Foreign server altered', name: named(AFTER.server) },
  { match: /^\s*DROP\s+SERVER\b/i, label: 'Extra foreign server', name: named(AFTER.server) },
  { match: /^\s*(?:CREATE|ALTER)\s+USER\s+MAPPING\b/i, label: 'User mapping missing', name: userMappingLabel, unqualified: true },
  { match: /^\s*DROP\s+USER\s+MAPPING\b/i, label: 'Extra user mapping', name: userMappingLabel, unqualified: true },
  { match: /^\s*CREATE\s+FOREIGN\s+TABLE\b/i, label: 'Foreign table missing', name: named(AFTER.foreignTable) },
  { match: /^\s*DROP\s+FOREIGN\s+TABLE\b/i, label: 'Extra foreign table', name: named(AFTER.foreignTable) },

  { match: /^\s*CREATE\s+SEQUENCE\b/i, label: 'Sequence missing', name: named(AFTER.sequence) },
  { match: /^\s*ALTER\s+SEQUENCE\b/i, label: 'Sequence altered', name: named(AFTER.sequence) },
  { match: /^\s*DROP\s+SEQUENCE\b/i, label: 'Extra sequence', name: named(AFTER.sequence) },
]

/** An identifier as written, unquoted: `"App Data"` → `App Data`. */
const unquoted = (part: string) => part.replace(/^"|"$/g, '').replace(/""/g, '"')

/**
 * `public.orders.own (policy)` for `COMMENT ON POLICY "own" ON "public"."orders"`:
 * the object, qualified as written, and its kind. A constraint, trigger or
 * policy is named after the table (or domain) it is on.
 */
function commentLabel(sql: string): string {
  const m = /^\s*COMMENT\s+ON\s+(MATERIALIZED\s+VIEW|FOREIGN\s+TABLE|[A-Z]+)\s+([\s\S]*?)\s+IS\s/i.exec(sql)
  if (!m) return UNKNOWN_NAME
  const kind = m[1].toLowerCase().replace(/\s+/g, ' ')
  const on = /^("(?:[^"]|"")+"|\S+)\s+ON\s+(?:DOMAIN\s+)?([\s\S]+)$/i.exec(m[2].trim())
  const object = on ? `${on[2].trim()}.${on[1]}` : m[2].trim()
  const name = object.split(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(unquoted).join('.')
  return `${name} (${kind})`
}

/** `schema.extension` for CREATE EXTENSION ... WITH SCHEMA, or the bare name. */
function extensionLabel(sql: string): string {
  const name = /\bEXTENSION\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?("[^"]+"|[\w$-]+)/i.exec(sql)?.[1]
  const schema = /\bSCHEMA\s+("[^"]+"|[\w$]+)/i.exec(sql)?.[1]
  if (!name) return UNKNOWN_NAME
  return schema ? `${unquoted(schema)}.${unquoted(name)}` : unquoted(name)
}

/** Titles for a schema made, dropped or commented on, which have no schema of their own. */
function schemaTitle(sql: string, downSql?: string): string | undefined {
  const m = /^\s*(CREATE|DROP|COMMENT\s+ON)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?("[^"]+"|[\w$]+)/i.exec(sql)
  if (!m) return undefined
  const label = { CREATE: 'Schema missing', DROP: 'Extra schema' }[m[1].toUpperCase() as 'CREATE' | 'DROP']
  return label ? `${label}: ${unquoted(m[2])}` : `${commentChange(sql, downSql)}: schema ${unquoted(m[2])}`
}

const CLEARS_COMMENT = /\bIS\s+NULL\s*;?\s*$/i

/**
 * What a comment finding does. "Comment changed" was the title for all three,
 * including a comment on an object the target does not have yet, where there
 * is nothing to change: the DOWN of a comment only the source has clears it,
 * and the UP of one only the target has does.
 */
function commentChange(sql: string, downSql?: string): string {
  if (CLEARS_COMMENT.test(sql)) return 'Extra comment'
  if (downSql && CLEARS_COMMENT.test(downSql)) return 'Comment missing'
  return 'Comment changed'
}

/** Titles for the row-level findings of the data check. */
function summariseDataStatement(sql: string): string {
  const table = extractQualifiedName(sql, /\b(?:INTO|FROM|UPDATE)\s+(?:ONLY\s+)?/i)
  const upper = sql.toUpperCase().trimStart()
  if (upper.startsWith('INSERT')) return `Missing row in ${table}`
  if (upper.startsWith('DELETE')) return `Extra row in ${table}`
  if (upper.startsWith('UPDATE')) return `Modified row in ${table}`
  return `Data change in ${table}`
}

/**
 * Title one finding.
 *
 * `downSql` is the paired counterpart statement, used only to recover a schema
 * the UP statement does not carry — see `routineLabel`.
 */
export function summariseStatement(sql: string, check: 'schema' | 'data', downSql?: string): string {
  if (check === 'data') return summariseDataStatement(sql)

  const schema = schemaTitle(sql, downSql)
  if (schema) return schema

  for (const rule of SCHEMA_RULES) {
    if (rule.match.test(sql)) {
      const label = rule.name === commentLabel ? commentChange(sql, downSql) : rule.label
      const name = rule.name(sql, downSql)
      return `${label}: ${rule.unqualified ? name : qualifySchemaName(name)}`
    }
  }

  // Same `<finding>: <schema>.<name>` shape as every rule above, so an
  // unclassified change lines up with the rest of the list too.
  return `Schema change: ${qualifySchemaName(
    extractQualifiedName(sql, /\b(?:TABLE|INTO|FROM|UPDATE)\s+(?:ONLY\s+)?/i),
  )}`
}

/**
 * Name a routine in an issue title, schema-qualified, with its argument
 * signature.
 *
 * The detection has been signature-aware since overloads were fixed, but only
 * the "Function modified" title carried the signature through — "Extra
 * function" printed the bare name (issue #40). For an overloaded routine that
 * left the title unable to say which overload was being dropped, and two
 * target-only overloads of one name produced two identical titles.
 *
 * The schema is still never invented, but it no longer has to be missing.
 * dbdiff emits a DROP unqualified (`DROP FUNCTION IF EXISTS "example_fn"(uuid)`)
 * while the DOWN statement that restores the same routine comes from
 * `pg_get_functiondef` and *is* qualified. So when the UP has no schema, it is
 * read off that counterpart — a schema dbdiff itself reported, not a guess —
 * which is what left "Extra function" the one unqualified schema title
 * (issue #47).
 *
 * The counterpart is only trusted when it names the same routine; a mismatched
 * pair would otherwise attach one routine's schema to another's name.
 */
export function routineLabel(sql: string, downSql?: string): string {
  const name = extractRoutineName(sql)
  const args = extractRoutineArgs(sql)
  if (!downSql || name === UNKNOWN_NAME || name.includes('.')) return name + args

  const counterpart = extractRoutineName(downSql)
  const sameRoutine = unqualify(counterpart) === unqualify(name)
  return (counterpart.includes('.') && sameRoutine ? counterpart : name) + args
}

/** The last segment of a possibly schema-qualified name, lowercased. */
function unqualify(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}

/**
 * Extract a routine name from a FUNCTION or PROCEDURE statement.
 *
 * A bare `/FUNCTION\s+"?(\w+)"?/` gets this wrong in both directions
 * (issue #35): it returns "IF" for `DROP FUNCTION IF EXISTS "f"`, and the
 * schema qualifier "public" for `CREATE OR REPLACE FUNCTION public.f(...)`.
 * Neither title named the routine at all.
 *
 * Skips an optional IF EXISTS, then takes the optionally schema-qualified,
 * optionally quoted identifier, normalising `"public" . "f"` to `public.f`.
 */
export function extractRoutineName(sql: string): string {
  return extractQualifiedName(sql, /\b(?:FUNCTION|PROCEDURE)\s+(?:IF\s+EXISTS\s+)?/i)
}

/** What a title shows when the identifier cannot be read out of the SQL. */
export const UNKNOWN_NAME = 'unknown'

/**
 * Read the optionally schema-qualified, optionally quoted identifier that
 * follows `head`, normalising `"public" . "f"` to `public.f`.
 *
 * The one identifier parser behind every schema title. Before it, each kind
 * carried its own `/KEYWORD\s+["'`]?(\w+)/`, and those got it wrong in both
 * directions (issues #35, #47): "IF" for `DROP FUNCTION IF EXISTS "f"`, and the
 * schema qualifier "public" for anything written `public.name` — which is how
 * an index came to be titled by its schema instead of its name.
 *
 * Matched piecewise rather than as one expression. A combined pattern needs an
 * optional quote on both sides of each identifier ("?[\w$]+"?), and that
 * ambiguity backtracks super-linearly on adversarial input — a real concern for
 * SQL arriving from an external process.
 */
export function extractQualifiedName(sql: string, head: RegExp): string {
  const found = head.exec(sql)
  if (!found) return UNKNOWN_NAME

  let rest = sql.slice(found.index + found[0].length)
  const parts: string[] = []

  for (let depth = 0; depth < 2; depth++) {
    // A quoted name doubles any quote inside it: "say ""hi"" there".
    const ident = /^(?:"((?:[^"]|"")*)"|([\w$]+))/.exec(rest)
    if (!ident) break
    parts.push(ident[1] !== undefined ? ident[1].replace(/""/g, '"') : ident[2])
    rest = rest.slice(ident[0].length)

    const dot = /^\s*\.\s*/.exec(rest)
    if (!dot) break
    rest = rest.slice(dot[0].length)
  }

  return parts.length > 0 ? parts.join('.') : UNKNOWN_NAME
}

/**
 * Extract the argument list of a `DROP FUNCTION`, parens included.
 *
 * @dbdiff/cli >= 3.0.0-rc.7 qualifies the DROP with the argument types so an
 * overloaded routine can be dropped unambiguously — `DROP FUNCTION IF EXISTS
 * "dist"(bigint,bigint)`. Earlier versions emitted a bare name, and MySQL has
 * no overloading, so both return ''.
 *
 * Scanned rather than matched. The types can themselves contain parens
 * (`numeric(10,2)`), so this counts depth instead of taking the first `)`.
 */
export function extractRoutineArgs(sql: string): string {
  const open = sql.indexOf('(')
  if (open === -1) return ''

  let depth = 0
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')' && --depth === 0) return sql.slice(open, i + 1)
  }
  return ''
}
