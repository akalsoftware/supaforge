import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pgQuery, type QueryFn, newPgClient } from './db.js'
import { captureSnapshot, type SnapshotResult } from './snapshot'
import type { EnvironmentConfig, SupaForgeConfig } from './types/config'
import { checkPgDumpCompat } from './pg-tools'
import { BRANCHES_FILE, PG_PIPELINE_TIMEOUT_MS, CLONE_PROGRESS_INTERVAL_MS } from './constants'
import { CLONE_STUBS_SQL } from './stubs'
import { quoteIdent, quoteName } from './utils/sql'
import { SUPABASE_PLATFORM_SCHEMAS } from './defaults'

/** Prefix for branch database names created by SupaForge. */
export const BRANCH_DB_PREFIX = 'supaforge_branch_'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BranchMeta {
  name: string
  dbName: string
  dbUrl: string
  createdFrom: string
  createdAt: string
  schemaOnly: boolean
  /** Directory containing the layer snapshot taken at branch creation time. */
  snapshotDir?: string
}

export interface BranchesManifest {
  branches: BranchMeta[]
}

export interface CreateBranchOptions {
  /** Branch name (must be unique). Converted to a safe DB identifier. */
  name: string
  /** Connection URL of the database to branch from. */
  sourceUrl: string
  /** Human-readable label for where we branched from (e.g. "production"). */
  sourceLabel: string
  /** If true, copy schema only (no data). */
  schemaOnly?: boolean
  /** Working directory for .supaforge/ metadata. */
  cwd?: string
  /** Capture a full snapshot alongside the DB clone. */
  env?: EnvironmentConfig
  /** Config needed for snapshot (ignore schemas, data tables, etc.). */
  config?: SupaForgeConfig
}

export interface BranchDiffSummary {
  branch: string
  against: string
  tables: number
  added: string[]
  removed: string[]
  modified: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Sanitise a branch name into a valid Postgres identifier. */
export function branchDbName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (!safe) throw new Error(`Invalid branch name: "${name}"`)
  return `${BRANCH_DB_PREFIX}${safe}`
}

/** Build a connection URL pointing at a different database on the same server. */
export function replaceDbName(sourceUrl: string, dbName: string): string {
  const u = new URL(sourceUrl)
  u.pathname = `/${dbName}`
  return u.toString()
}

/** Parse connection URL to extract components. */
function parseUrl(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: u.username,
    password: u.password,
    database: u.pathname.replace(/^\//, ''),
  }
}

// ─── Manifest I/O ────────────────────────────────────────────────────────────

async function manifestPath(cwd: string): Promise<string> {
  return resolve(cwd, BRANCHES_FILE)
}

export async function loadManifest(cwd = process.cwd()): Promise<BranchesManifest> {
  try {
    const raw = await readFile(await manifestPath(cwd), 'utf-8')
    return JSON.parse(raw) as BranchesManifest
  } catch {
    return { branches: [] }
  }
}

async function saveManifest(manifest: BranchesManifest, cwd: string): Promise<void> {
  const p = await manifestPath(cwd)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(manifest, null, 2) + '\n')
}

// ─── Branch Operations ───────────────────────────────────────────────────────

/**
 * Create a branch by copying the source database.
 *
 * Strategy:
 *  1. Try `CREATE DATABASE ... TEMPLATE` (instant, requires no other connections).
 *  2. Fall back to `pg_dump | pg_restore` (works for remote / busy databases).
 */
export async function createBranch(opts: CreateBranchOptions): Promise<BranchMeta> {
  const cwd = opts.cwd ?? process.cwd()
  const dbName = branchDbName(opts.name)
  const branchUrl = replaceDbName(opts.sourceUrl, dbName)

  // Check for duplicate
  const manifest = await loadManifest(cwd)
  if (manifest.branches.some(b => b.name === opts.name)) {
    throw new Error(`Branch "${opts.name}" already exists.`)
  }

  const created = await tryTemplateCopy(opts.sourceUrl, dbName)
  let pgDumpPath = 'pg_dump'
  let pgRestorePath = 'pg_restore'
  if (!created) {
    // Template copy failed — need pg_dump pipeline. Check compatibility first.
    const compat = await checkPgDumpCompat(opts.sourceUrl)
    if (!compat.compatible) {
      throw new Error(compat.message)
    }
    pgDumpPath = compat.pgDumpPath
    pgRestorePath = compat.pgRestorePath
  }

  const dumpCreated = created || await tryDumpRestore(opts.sourceUrl, dbName, opts.schemaOnly ?? false, pgDumpPath, pgRestorePath)

  if (!dumpCreated) {
    throw new Error(
      'Failed to create branch. Ensure you have CREATE DATABASE privileges and ' +
      'that pg_dump + pg_restore are available in your PATH.',
    )
  }

  const meta: BranchMeta = {
    name: opts.name,
    dbName,
    dbUrl: branchUrl,
    createdFrom: opts.sourceLabel,
    createdAt: new Date().toISOString(),
    schemaOnly: opts.schemaOnly ?? false,
  }

  // Capture a layer snapshot if environment + config provided
  if (opts.env && opts.config) {
    try {
      const snapshot = await captureSnapshot({
        envName: opts.sourceLabel,
        env: opts.env,
        config: opts.config,
        cwd,
      })
      meta.snapshotDir = snapshot.dir
    } catch {
      // Non-fatal: branch still works without snapshot
    }
  }

  manifest.branches.push(meta)
  await saveManifest(manifest, cwd)
  return meta
}

/** Strategy 1: `CREATE DATABASE ... TEMPLATE source` (fast but exclusive). */
async function tryTemplateCopy(sourceUrl: string, newDb: string): Promise<boolean> {
  const { database } = parseUrl(sourceUrl)
  const maintenanceUrl = replaceDbName(sourceUrl, 'postgres')
  const client = newPgClient(maintenanceUrl)
  try {
    await client.connect()
    await client.query(`CREATE DATABASE ${quoteName(newDb)} TEMPLATE ${quoteName(database)}`)
    return true
  } catch {
    return false
  } finally {
    await client.end()
  }
}

/** Strategy 2: `pg_dump | pg_restore` (works for busy / remote databases). */
async function tryDumpRestore(
  sourceUrl: string,
  newDb: string,
  schemaOnly: boolean,
  pgDumpPath = 'pg_dump',
  pgRestorePath = 'pg_restore',
): Promise<boolean> {
  const maintenanceUrl = replaceDbName(sourceUrl, 'postgres')

  // Create the empty target database
  const client = newPgClient(maintenanceUrl)
  try {
    await client.connect()
    await client.query(`CREATE DATABASE ${quoteName(newDb)}`)
  } catch {
    return false
  } finally {
    await client.end()
  }

  const dumpArgs = ['--format=custom', '--no-owner', '--no-acl', sourceUrl]
  if (schemaOnly) dumpArgs.unshift('--schema-only')

  const targetUrl = replaceDbName(sourceUrl, newDb)
  const restoreArgs = [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    `--dbname=${targetUrl}`,
  ]

  try {
    await new Promise<void>((resolve, reject) => {
      const dump = spawn(pgDumpPath, dumpArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      const restore = spawn(pgRestorePath, restoreArgs, { stdio: [dump.stdout, 'pipe', 'pipe'] })

      let restoreStderr = ''
      restore.stderr?.on('data', (chunk: Buffer) => { restoreStderr += chunk.toString() })

      let dumpError = ''
      dump.stderr?.on('data', (chunk: Buffer) => { dumpError += chunk.toString() })

      let dumpExit: number | null = null
      let restoreExit: number | null = null
      let settled = false

      function tryResolve() {
        if (settled || dumpExit === null || restoreExit === null) return
        settled = true
        // pg_dump exit 0 required; pg_restore exit 0 or 1 (warnings) acceptable
        if (dumpExit !== 0) {
          reject(new Error(`pg_dump failed (exit ${dumpExit}): ${dumpError}`))
        } else if (restoreExit !== 0 && restoreExit !== 1) {
          reject(new Error(`pg_restore failed (exit ${restoreExit}): ${restoreStderr}`))
        } else {
          resolve()
        }
      }

      dump.on('close', (code) => { dumpExit = code ?? 1; tryResolve() })
      restore.on('close', (code) => { restoreExit = code ?? 1; tryResolve() })
      dump.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
      restore.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
    })
    return true
  } catch {
    // Clean up on hard failure
    const cleanup = newPgClient(maintenanceUrl)
    try {
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS ${quoteName(newDb)}`)
    } finally {
      await cleanup.end()
    }
    return false
  }
}

/** List all tracked branches. */
export async function listBranches(cwd = process.cwd()): Promise<BranchMeta[]> {
  const manifest = await loadManifest(cwd)
  return manifest.branches
}

/** A clone entry reconciled against the databases that actually exist on the server. */
export interface ReconciledClone extends BranchMeta {
  /** Database backing this clone no longer exists on the server. */
  missing?: boolean
  /** Found on the server but not previously tracked in branches.json. */
  discovered?: boolean
}

/** List database names present on a server (connects to the maintenance `postgres` db). */
async function listServerDatabases(serverUrl: string): Promise<Set<string>> {
  const maintenanceUrl = replaceDbName(serverUrl, 'postgres')
  const client = newPgClient(maintenanceUrl)
  try {
    await client.connect()
    const { rows } = await client.query(
      'SELECT datname FROM pg_database WHERE datistemplate = false',
    )
    return new Set(rows.map(r => String(r.datname)))
  } finally {
    await client.end()
  }
}

/**
 * Reconcile the branches manifest against databases that actually exist on the
 * local server.
 *
 * The manifest (`.supaforge/branches.json`) is gitignored and lives only on the
 * machine that created the clone, so `clone --list` previously went blind to
 * clones created in another checkout, by an older version, or after the manifest
 * was cleaned — it "worked for new clones but not existing ones". This walks the
 * server and surfaces those existing clone databases as `discovered`, while
 * flagging tracked entries whose database is gone as `missing`. Discovered
 * clones are backfilled into the manifest so later commands can act on them.
 *
 * Best-effort: when `localServerUrl` is omitted or unreachable, returns the
 * manifest unchanged.
 */
export async function reconcileClones(opts: {
  localServerUrl?: string
  /** db name of the configured `local` environment — treated as a clone if present. */
  configuredLocalDb?: string
  cwd?: string
}): Promise<ReconciledClone[]> {
  const cwd = opts.cwd ?? process.cwd()
  const manifest = await loadManifest(cwd)
  const tracked: ReconciledClone[] = manifest.branches.map(b => ({ ...b }))

  if (!opts.localServerUrl) return tracked

  let existing: Set<string>
  try {
    existing = await listServerDatabases(opts.localServerUrl)
  } catch {
    return tracked // can't reach the server — fall back to manifest as-is
  }

  // Flag tracked entries whose database has been dropped out from under us.
  for (const clone of tracked) {
    if (!existing.has(clone.dbName)) clone.missing = true
  }

  // Discover clone databases on the server that the manifest doesn't know about.
  const trackedNames = new Set(tracked.map(c => c.dbName))
  const discovered: ReconciledClone[] = [...existing]
    .filter(db =>
      !trackedNames.has(db) &&
      (db.startsWith(BRANCH_DB_PREFIX) || db === opts.configuredLocalDb),
    )
    .map(db => ({
      name: db,
      dbName: db,
      dbUrl: replaceDbName(opts.localServerUrl!, db),
      createdFrom: 'unknown',
      createdAt: new Date().toISOString(),
      schemaOnly: false,
      discovered: true,
    }))

  // Backfill so future operations (clone --delete, etc.) can see them too.
  if (discovered.length > 0) {
    manifest.branches.push(
      ...discovered.map(({ missing: _m, discovered: _d, ...meta }) => meta),
    )
    await saveManifest(manifest, cwd).catch(() => {})
  }

  return [...tracked, ...discovered]
}

/**
 * Add a branch entry to the manifest.
 * Used by clone.ts which manages its own DB creation pipeline.
 * Overwrites an existing entry with the same name to avoid duplicates.
 */
export async function addBranchToManifest(meta: BranchMeta, cwd = process.cwd()): Promise<void> {
  const manifest = await loadManifest(cwd)
  const existing = manifest.branches.findIndex(b => b.name === meta.name)
  if (existing >= 0) {
    manifest.branches[existing] = meta
  } else {
    manifest.branches.push(meta)
  }
  await saveManifest(manifest, cwd)
}

/** Delete a branch: drop the database and remove from manifest. */
export async function deleteBranch(
  name: string,
  sourceUrl: string,
  cwd = process.cwd(),
): Promise<void> {
  const manifest = await loadManifest(cwd)
  const idx = manifest.branches.findIndex(b => b.name === name)
  if (idx === -1) throw new Error(`Branch "${name}" not found.`)

  const branch = manifest.branches[idx]

  // Terminate connections and drop
  const maintenanceUrl = replaceDbName(sourceUrl, 'postgres')
  const client = newPgClient(maintenanceUrl)
  try {
    await client.connect()
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [branch.dbName],
    )
    await client.query(`DROP DATABASE IF EXISTS ${quoteName(branch.dbName)}`)
  } finally {
    await client.end()
  }

  manifest.branches.splice(idx, 1)
  await saveManifest(manifest, cwd)
}

// ─── Remote → Local Clone ────────────────────────────────────────────────────

export interface CloneProgress {
  /** Bytes transferred through the pg_dump → pg_restore pipe. */
  bytesTransferred: number
  /** Milliseconds elapsed since the pipeline started. */
  elapsedMs: number
  /** Most recent pg_restore status message (if any). */
  lastRestoreMessage?: string
}

export interface CloneRemoteOptions {
  /** Remote (source) database connection URL. */
  remoteUrl: string
  /** Local PostgreSQL base URL (e.g. postgres://postgres:postgres@localhost:5432/postgres). */
  localBaseUrl: string
  /** Database name to create locally. */
  localDbName: string
  /** Copy schema only (no data). */
  schemaOnly?: boolean
  /** Drop and recreate the target database if it already exists. */
  force?: boolean
  /** Called periodically with pipeline progress. */
  onProgress?: (info: CloneProgress) => void
  /** Schemas to exclude from pg_dump (e.g. Supabase internals). */
  excludeSchemas?: string[]
}

/**
 * Clone a remote database to a local PostgreSQL server via `pg_dump | pg_restore`.
 *
 * Unlike `createBranch` (which works on a single server), this dumps from one
 * server and restores to another — the typical remote → local workflow.
 *
 * Returns the local database URL, and what pg_restore could not reproduce.
 */
export async function cloneRemoteToLocal(opts: CloneRemoteOptions): Promise<CloneResult> {
  const compat = await checkPgDumpCompat(opts.remoteUrl)
  if (!compat.compatible) {
    throw new Error(compat.message)
  }

  const localMaintenanceUrl = opts.localBaseUrl
  const localDbUrl = replaceDbName(opts.localBaseUrl, opts.localDbName)

  // Create the empty target database on the local server
  const client = newPgClient(localMaintenanceUrl)
  try {
    await client.connect()

    // If --force, drop the existing database first
    if (opts.force) {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [opts.localDbName],
      )
      await client.query(`DROP DATABASE IF EXISTS ${quoteName(opts.localDbName)}`)
    }

    await client.query(`CREATE DATABASE ${quoteName(opts.localDbName)}`)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('already exists')) {
      throw new Error(
        `Database "${opts.localDbName}" already exists on the local server. ` +
        `Drop it first with: psql "${localMaintenanceUrl}" -c 'DROP DATABASE "${opts.localDbName}"'`,
      )
    }
    throw new Error(`Failed to create local database: ${msg}`)
  } finally {
    await client.end()
  }

  // Create Supabase auth + storage stubs BEFORE pg_restore.
  // Without these, pg_restore silently skips FK constraints referencing
  // auth.users and RLS policies referencing auth.uid() — causing false
  // drift on the very first `supaforge diff` after clone.
  if (opts.excludeSchemas?.length) {
    const stubClient = newPgClient(localDbUrl)
    try {
      await stubClient.connect()
      await stubClient.query(CLONE_STUBS_SQL)
    } finally {
      await stubClient.end()
    }
  }

  const extensions = await installRemoteExtensions(opts.remoteUrl, localDbUrl, opts.excludeSchemas ?? [])

  // pg_dump from remote | pg_restore to local
  const dumpArgs = ['--format=custom', '--no-owner', '--no-acl']
  if (opts.schemaOnly) dumpArgs.push('--schema-only')

  // Exclude Supabase-internal schemas that reference extensions unavailable on vanilla Postgres
  if (opts.excludeSchemas?.length) {
    for (const schema of opts.excludeSchemas) {
      dumpArgs.push(`--exclude-schema=${schema}`)
    }
  }

  dumpArgs.push(opts.remoteUrl)

  const restoreArgs = [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    `--dbname=${localDbUrl}`,
  ]

  let restoreLog = ''
  try {
    restoreLog = await new Promise<string>((resolve, reject) => {
      const dump = spawn(compat.pgDumpPath, dumpArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      const restore = spawn(compat.pgRestorePath, restoreArgs, { stdio: ['pipe', 'pipe', 'pipe'] })

      // Manual pipe so we can count bytes flowing through
      let bytesTransferred = 0
      dump.stdout.on('data', (chunk: Buffer) => { bytesTransferred += chunk.length })
      dump.stdout.pipe(restore.stdin)

      let restoreStderr = ''
      let lastRestoreMessage = ''
      restore.stderr?.on('data', (chunk: Buffer) => {
        restoreStderr += chunk.toString()
        // Extract last meaningful line for progress display
        const lines = chunk.toString().split('\n').filter(Boolean)
        if (lines.length > 0) {
          lastRestoreMessage = lines[lines.length - 1].trim().slice(0, 120)
        }
      })

      let dumpError = ''
      dump.stderr?.on('data', (chunk: Buffer) => { dumpError += chunk.toString() })

      // Progress reporting
      const startTime = Date.now()
      const progressInterval = opts.onProgress
        ? setInterval(() => {
            opts.onProgress!({
              bytesTransferred,
              elapsedMs: Date.now() - startTime,
              lastRestoreMessage: lastRestoreMessage || undefined,
            })
          }, CLONE_PROGRESS_INTERVAL_MS)
        : null

      let dumpExit: number | null = null
      let restoreExit: number | null = null
      let settled = false

      const cleanup = () => {
        if (progressInterval) clearInterval(progressInterval)
        clearTimeout(timeout)
      }

      const trySettle = () => {
        if (settled || dumpExit === null || restoreExit === null) return
        settled = true
        cleanup()
        // Final progress update
        opts.onProgress?.({
          bytesTransferred,
          elapsedMs: Date.now() - startTime,
          lastRestoreMessage: undefined,
        })
        if (dumpExit !== 0) {
          reject(new Error(`pg_dump failed (exit ${dumpExit}): ${dumpError}`))
        } else if (restoreExit !== 0 && restoreExit !== 1) {
          reject(new Error(`pg_restore failed (exit ${restoreExit}): ${restoreStderr}`))
        } else {
          // Exit 1 is pg_restore carrying on past statements that failed.
          // The clone exists, but what failed is not in it: see restoreFailures.
          resolve(restoreStderr)
        }
      }

      dump.on('close', (code) => { dumpExit = code ?? 1; trySettle() })
      restore.on('close', (code) => { restoreExit = code ?? 1; trySettle() })
      dump.on('error', (err) => { if (!settled) { settled = true; cleanup(); reject(err) } })
      restore.on('error', (err) => { if (!settled) { settled = true; cleanup(); reject(err) } })

      // Safety timeout — 30 minutes for large databases
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          cleanup()
          dump.kill()
          restore.kill()
          reject(new Error(
            'pg_dump | pg_restore timed out after 30 minutes.\n' +
            (dumpError ? `  pg_dump stderr: ${dumpError.slice(0, 500)}\n` : '') +
            (restoreStderr ? `  pg_restore stderr: ${restoreStderr.slice(0, 500)}` : ''),
          ))
        }
      }, PG_PIPELINE_TIMEOUT_MS)
    })
  } catch (err) {
    // Clean up the empty database on failure
    const cleanup = newPgClient(localMaintenanceUrl)
    try {
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS ${quoteName(opts.localDbName)}`)
    } catch { /* best effort */ } finally {
      await cleanup.end()
    }
    throw err
  }

  const { failures, unavailable } = restoreFailures(restoreLog)
  return {
    url: localDbUrl,
    failures,
    unavailable,
    extensionsInstalled: extensions.installed,
  }
}

/** What a clone produced, and what of the source it could not reproduce. */
export interface CloneResult {
  /** The local database URL. */
  url: string
  /**
   * Statements pg_restore could not run. pg_restore carries on past them and
   * exits 1, which used to be read as success — so a table typed by an
   * extension the local server lacks was simply not in the clone, and the
   * clone said nothing.
   */
  failures: RestoreFailure[]
  /**
   * What this server cannot have: extensions it does not ship, the platform's
   * own event triggers. Context rather than failures — see restoreFailures.
   */
  unavailable: RestoreFailure[]
  /** Extensions installed locally ahead of the restore — see installRemoteExtensions. */
  extensionsInstalled: string[]
}

export interface RestoreFailure {
  /** The statement, summarised: `CREATE TABLE public.docs`, `extension vector`. */
  object: string
  /** PostgreSQL's error message. */
  error: string
}

/**
 * The statements pg_restore reported failing, from its stderr, split into
 * what the clone lacks and what this server cannot have.
 *
 * Each failure is an `error: could not execute query: ERROR: …` line followed,
 * a few lines later, by `Command was: …`.
 *
 * - `failures`: objects of the project's that are not in the clone — a table,
 *   its rows, an index, a function. These make the clone incomplete.
 * - `unavailable`: an extension this server does not ship, and an event trigger
 *   of the platform's whose function lives in one of its schemas. Every
 *   Supabase project has pg_net, pg_graphql, pgjwt, supabase_vault and the
 *   event triggers granting access to them, none of which plain PostgreSQL can
 *   hold. Counting them as failures made every clone of a Supabase project
 *   "incomplete". They are context: anything of the project's that needed one
 *   of them fails on its own account and is listed under `failures`.
 *
 * Left out entirely: `… already exists` (the object is there, as with `public`
 * on PostgreSQL 15+), the comment on an extension that is not available, and
 * a session setting a newer pg_dump writes that this server does not know.
 */
export function restoreFailures(
  stderr: string,
  platformSchemas: readonly string[] = SUPABASE_PLATFORM_SCHEMAS,
): { failures: RestoreFailure[]; unavailable: RestoreFailure[] } {
  const entries: Array<{ error: string; command: string }> = []
  for (const block of stderr.split(/^pg_restore: (?:error|warning): /m).slice(1)) {
    const error = /could not execute query: ERROR:\s+(.*)/.exec(block)?.[1]?.trim()
    const command = /^Command was: ([\s\S]*?)(?:\n\s*\n|$)/m.exec(block)?.[1]?.trim()
    if (error && command) entries.push({ error, command })
  }

  const notShipped = new Set(entries
    .filter(e => / is not available$/.test(e.error) && /^CREATE\s+EXTENSION\b/i.test(e.command))
    .map(e => extensionName(e.command)))
  const inPlatformSchema = new RegExp(`\\b(?:${platformSchemas.map(escapeRegExp).join('|')})\\.`)

  const failures: RestoreFailure[] = []
  const unavailable: RestoreFailure[] = []
  for (const { error, command } of entries) {
    if (/ already exists$/.test(error)) continue
    // A newer pg_dump's session setting (`SET transaction_timeout = 0`, from
    // 17) that an older server has no such parameter for: nothing of the
    // project's is missing because of it.
    if (/^SET\s+/i.test(command) && /^unrecognized configuration parameter/.test(error)) continue
    if (/^CREATE\s+EXTENSION\b/i.test(command)) {
      const entry = { object: `extension ${extensionName(command)}`, error }
      ;(notShipped.has(extensionName(command)) ? unavailable : failures).push(entry)
      continue
    }
    const ext = /^COMMENT\s+ON\s+EXTENSION\s+("[^"]+"|[\w$]+)/i.exec(command)?.[1]
    if (ext && notShipped.has(ext.replace(/"/g, ''))) continue
    const entry = { object: summariseCommand(command), error }
    if (/^CREATE\s+EVENT\s+TRIGGER\b/i.test(command) && inPlatformSchema.test(error)) {
      unavailable.push(entry)
      continue
    }
    failures.push(entry)
  }
  return { failures, unavailable }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function extensionName(command: string): string {
  const m = /^CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w$]+)/i.exec(command)
  return (m?.[1] ?? '?').replace(/"/g, '')
}

/** `CREATE TABLE public.docs`, `COPY public.docs`, `ALTER TABLE ONLY public.docs`. */
function summariseCommand(command: string): string {
  const firstLine = command.split('\n')[0].replace(/\s*\($/, '').replace(/;$/, '')
  if (/^COPY\s/i.test(firstLine)) return `data for ${firstLine.split(/\s+/)[1]}`
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine
}

/**
 * Install, on the local database, the source's extensions that live in a
 * schema the dump leaves out — Supabase puts them in `extensions`.
 *
 * pg_dump still emits `CREATE EXTENSION … WITH SCHEMA extensions` for them,
 * but with the schema excluded nothing creates it, so every one failed, and so
 * did every table with a column typed by one or a default calling one:
 * `uuid_generate_v4()` is enough to lose a table. The schema is created only
 * for an extension this server ships, so one that is unavailable leaves no
 * empty schema behind to be mistaken for it being installed.
 *
 * Best effort: whatever cannot be installed here fails in the restore and is
 * reported there, with the objects that needed it.
 */
async function installRemoteExtensions(
  remoteUrl: string,
  localDbUrl: string,
  excludeSchemas: readonly string[],
): Promise<{ installed: string[] }> {
  const installed: string[] = []
  if (excludeSchemas.length === 0) return { installed }

  const remote = newPgClient(remoteUrl)
  let wanted: Array<{ extname: string; schema: string }> = []
  try {
    await remote.connect()
    const { rows } = await remote.query<{ extname: string; schema: string }>(
      `SELECT e.extname, n.nspname AS schema
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE n.nspname = ANY($1::text[])
         AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
       ORDER BY e.extname`,
      [excludeSchemas],
    )
    wanted = rows
  } catch {
    return { installed }
  } finally {
    await remote.end()
  }

  const local = newPgClient(localDbUrl)
  try {
    await local.connect()
    const { rows } = await local.query<{ name: string }>('SELECT name FROM pg_available_extensions')
    const available = new Set(rows.map(r => r.name))
    for (const { extname, schema } of wanted) {
      if (!available.has(extname)) continue
      try {
        await local.query(`CREATE SCHEMA IF NOT EXISTS ${quoteName(schema)}`)
        await local.query(`CREATE EXTENSION IF NOT EXISTS ${quoteName(extname)} WITH SCHEMA ${quoteName(schema)} CASCADE`)
        installed.push(extname)
      } catch { /* reported by the restore, with what needed it */ }
    }
  } finally {
    await local.end()
  }
  return { installed }
}

/**
 * Is this environment a local clone SupaForge made?
 *
 * Matched against the clone manifest by database name, with the
 * `supaforge_branch_` prefix as a fallback for a clone whose manifest entry
 * was never written or has since been lost (the manifest is gitignored and
 * lives only on the machine that created it).
 *
 * Best-effort by design: a malformed or missing manifest answers "no" rather
 * than throwing, because the only caller uses this to word a hint.
 */
export async function isCloneDatabase(dbUrl: string | undefined, cwd = process.cwd()): Promise<boolean> {
  if (!dbUrl) return false

  let dbName: string
  try {
    dbName = new URL(dbUrl).pathname.replace(/^\//, '')
  } catch {
    return false
  }
  if (!dbName) return false
  if (dbName.startsWith(BRANCH_DB_PREFIX)) return true

  try {
    const manifest = await loadManifest(cwd)
    return manifest.branches.some(b => b.dbName === dbName)
  } catch {
    return false
  }
}

/**
 * Schemas every Supabase project has and a vanilla-PostgreSQL copy of one does
 * not. `auth` is the safest single signal: it exists on every Supabase project
 * including a bare one, and `supaforge clone` only stubs the few tables that
 * FKs point at rather than recreating the schema.
 */
const SUPABASE_SUBSTRATE_SCHEMAS = ['auth', 'storage'] as const

/**
 * Does the source look like a vanilla-PostgreSQL copy of the target?
 *
 * The manifest answer above is the reliable one when it applies, but it is
 * local, gitignored, and keyed on an exact database name — so a clone made in
 * another checkout, renamed, or diffed from a different working directory reads
 * as an ordinary environment, and the advice reverts to recommending `--apply`
 * in the one direction where it is most destructive (issue #71).
 *
 * This asks the databases instead of the bookkeeping: if the target carries
 * Supabase's own schemas and the source carries none of them, then whatever the
 * source is, pushing it onto the target would drop everything Supabase put
 * there. That is the property the warning is actually about, so it is the
 * property worth testing.
 *
 * Best-effort: any failure answers "no", because this only words a hint.
 */
export async function sourceLooksLikeCloneOf(
  sourceUrl: string | undefined, targetUrl: string | undefined,
  queryFn: QueryFn = pgQuery,
): Promise<boolean> {
  if (!sourceUrl || !targetUrl) return false

  const query = `SELECT count(*)::int AS n FROM information_schema.schemata
                  WHERE schema_name = ANY($1::text[])`
  try {
    const [source, target] = await Promise.all([
      queryFn(sourceUrl, query, [[...SUPABASE_SUBSTRATE_SCHEMAS]]),
      queryFn(targetUrl, query, [[...SUPABASE_SUBSTRATE_SCHEMAS]]),
    ]) as unknown as Array<Array<{ n: number }>>

    const sourceHas = source[0]?.n ?? 0
    const targetHas = target[0]?.n ?? 0
    return targetHas > 0 && sourceHas === 0
  } catch {
    return false
  }
}
