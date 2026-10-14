import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { QueryFn } from './db'
import { pgQuery } from './db'
import { quoteIdent, quoteLiteral, quoteName } from './utils/sql'
import type { EnvironmentConfig, SupaForgeConfig, SnapshotManifest, SnapshotLayerInfo } from './types/config'
import { DEFAULT_IGNORE_SCHEMAS, RELATION_NOT_FOUND } from './defaults'
import { introspectSchema } from './schema-introspect'
import { createPolicySql, dropPolicySql, schemaPolicySql, type SchemaPolicy } from './utils/schema-policies'
import { PUBLICATION_SQL } from './checks/realtime'
import type { SchemaSnapshot } from './schema-introspect'
import { assertPgBinUsable, describeMissingPgDump, getServerMajorVersion, resolvePgDumpPath } from './pg-tools'
import { errMsg } from './utils/error'
import { ok, warn, dim } from './ui'
import { SUPABASE_PLATFORM_SCHEMAS } from './defaults'
import { SUPABASE_MGMT_API, SUPAFORGE_DIR, SNAPSHOTS_SUBDIR, MIGRATIONS_SUBDIR } from './constants'
import { httpStatus, readJsonArray, readJsonObject } from './utils/http.js'

const execFile = promisify(execFileCb)

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface SnapshotOptions {
  envName: string
  env: EnvironmentConfig
  config: SupaForgeConfig
  /** Base output directory (defaults to cwd) */
  cwd?: string
  /** Custom output directory — snapshot files are written here directly (with timestamp subfolder). */
  outputDir?: string
  queryFn?: QueryFn
  fetchFn?: FetchFn
}

export interface SnapshotResult {
  manifest: SnapshotManifest
  dir: string
  timestamp: string
}

// ─── Timestamp Helpers ───────────────────────────────────────────────────────

export function generateTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function snapshotsBaseDir(cwd: string): string {
  return resolve(cwd, SUPAFORGE_DIR, SNAPSHOTS_SUBDIR)
}

export function snapshotDir(cwd: string, timestamp: string): string {
  return join(snapshotsBaseDir(cwd), timestamp)
}

// ─── Main Snapshot Function ──────────────────────────────────────────────────

/**
 * Capture a full snapshot of a single Supabase environment.
 * Each layer is exported independently; failures in one layer don't block others.
 */
export async function captureSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  assertPgBinUsable()
  const cwd = options.cwd ?? process.cwd()
  const timestamp = generateTimestamp()
  const dir = options.outputDir
    ? join(resolve(options.outputDir), timestamp)
    : snapshotDir(cwd, timestamp)
  await mkdir(dir, { recursive: true })

  const queryFn = options.queryFn ?? pgQuery
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const ignoreSchemas = options.config.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS

  const layers: Record<string, SnapshotLayerInfo> = {}

  // Layer 1: Schema (SQL introspection → JSON)
  layers.schema = await captureSchema(dir, options.env.dbUrl, ignoreSchemas, queryFn)

  // Layer 2: RLS Policies
  layers.rls = await captureRlsPolicies(dir, options.env.dbUrl, ignoreSchemas, queryFn)

  // Layer 3: Edge Functions (API)
  layers['edge-functions'] = await captureEdgeFunctions(dir, options.env, fetchFn)

  // Layer 4: Storage (DB)
  layers.storage = await captureStorage(dir, options.env, queryFn)

  // Layer 5: Auth Config (API)
  layers.auth = await captureAuthConfig(dir, options.env, fetchFn)

  // Layer 6: Cron Jobs
  layers.cron = await captureCronJobs(dir, options.env.dbUrl, queryFn)

  // Layer 7: Reference Data
  const dataTables = options.config.checks?.data?.tables ?? []
  layers.data = await captureData(dir, options.env.dbUrl, dataTables, queryFn)

  // Layer 8: Webhooks
  layers.webhooks = await captureWebhooks(dir, options.env.dbUrl, queryFn)

  // Layer 9: Extensions
  layers.extensions = await captureExtensions(dir, options.env.dbUrl, queryFn)

  // Layers 10-12: Realtime, Vault and roles.
  //
  // `diff` checks all three and a snapshot captured none of them, so a
  // snapshot was not a record of what `diff` compares (issue #92). Realtime
  // publications and role grants are ordinary DDL. Vault records the secrets'
  // *names* only — the values cannot be read out of Vault across
  // environments, which is the same reason the vault check offers no fix
  // (issue #91) — so the file is a checklist rather than something to replay.
  layers.realtime = await captureRealtime(dir, options.env.dbUrl, queryFn)
  layers.vault = await captureVaultSecrets(dir, options.env.dbUrl, queryFn)
  layers.roles = await captureRoleGrants(dir, options.env.dbUrl, queryFn)

  const manifest: SnapshotManifest = {
    version: 1,
    timestamp,
    environment: options.envName,
    projectRef: options.env.projectRef,
    layers,
  }

  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  return { manifest, dir, timestamp }
}

// ─── Layer Rendering ─────────────────────────────────────────────────────────

/**
 * Why a snapshot cannot restore its schema, or undefined when it can — no
 * schema.sql, which needs a pg_dump at least as new as the server.
 */
export function unrestorableSchema(manifest: SnapshotManifest): string | undefined {
  const schema = (manifest.layers as Record<string, SnapshotLayerInfo>).schema
  return schema?.captured && schema.sqlSkipReason ? schema.sqlSkipReason : undefined
}

/**
 * Format a snapshot manifest's layers into per-line status strings.
 *
 * Shared by `supaforge snapshot` and `supaforge clone` so both surface exactly
 * what was captured / skipped / errored — instead of a bare "N layers" count.
 * Lines are returned without leading indentation; callers add their own.
 */
export function formatSnapshotLayers(manifest: SnapshotManifest): string[] {
  const layers = manifest.layers as Record<string, SnapshotLayerInfo>
  const lines: string[] = []
  for (const [name, info] of Object.entries(layers)) {
    if (info.captured && info.sqlSkipReason) {
      // Captured for diffing, but not as DDL restore can replay.
      lines.push(`${warn('⚠')} ${name.padEnd(16)} ${info.itemCount} item(s) ${warn(`— no schema.sql, so restore cannot recreate the schema: ${info.sqlSkipReason}`)}`)
    } else if (info.captured) {
      lines.push(`${ok('✓')} ${name.padEnd(16)} ${info.itemCount} item(s)`)
    } else if (info.error) {
      lines.push(`${warn('✗')} ${name.padEnd(16)} ${warn(`error: ${info.error}`)}`)
    } else {
      const skipSuffix = info.skipReason ? ` — ${info.skipReason}` : ''
      lines.push(`${dim('○')} ${name.padEnd(16)} ${dim(`skipped${skipSuffix}`)}`)
    }
  }
  return lines
}

// ─── Layer Capture Functions ─────────────────────────────────────────────────

async function captureSchema(
  dir: string,
  dbUrl: string,
  ignoreSchemas: string[],
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'schema.json'
  try {
    const schema = await introspectSchema(dbUrl, ignoreSchemas)
    await writeFile(join(dir, file), JSON.stringify(schema, null, 2) + '\n')

    return {
      captured: true,
      file,
      itemCount: schema.tables.length,
      ...await captureSchemaSql(dir, dbUrl, [
        ...new Set([...schemasIn(schema), ...await projectSchemas(dbUrl, ignoreSchemas, queryFn)]),
      ].sort()),
    }
  } catch (err) {
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

/**
 * Every schema the project made, whatever it holds.
 *
 * `schemasIn` sees only the kinds introspection reports, so a schema holding
 * nothing but domains or composite types — or nothing yet — was left out of
 * the dump, and a table typed by one of those domains failed the whole
 * restore with `schema "billing" does not exist`. Schemas an extension owns
 * are its to create, and the platform's are excluded as everywhere else.
 */
async function projectSchemas(dbUrl: string, ignoreSchemas: string[], queryFn: QueryFn): Promise<string[]> {
  const rows = await queryFn(dbUrl, `SELECT n.nspname AS name FROM pg_namespace n
     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
       AND n.nspname <> ALL($1::text[])
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass
                         AND d.objid = n.oid AND d.deptype = 'e')`, [ignoreSchemas]) as Array<{ name: string }>
  return rows.map(r => r.name)
}

/** The schemas this snapshot describes, across every object kind it holds. */
function schemasIn(schema: SchemaSnapshot): string[] {
  const names = new Set<string>()
  for (const group of [
    schema.tables, schema.views, schema.functions,
    schema.triggers, schema.sequences, schema.enums,
  ]) {
    for (const item of group as Array<{ schema?: string }>) {
      if (item.schema) names.add(item.schema)
    }
  }
  return names.size > 0 ? [...names].sort() : ['public']
}

/**
 * The same schema again, as DDL `restore` can replay.
 *
 * `schema.json` above is introspection output: the right shape for diffing two
 * snapshots, and not executable. `restore` looked for a `schema.sql` that
 * nothing ever wrote, reported the layer as skipped with "File not readable",
 * and carried on — so restoring a snapshot into an empty database produced no
 * tables at all, and the only error was the RLS layer failing against tables
 * that were never created (issue #80).
 *
 * pg_dump writes it, scoped to the schemas the snapshot describes so the two
 * files agree about what is covered. A snapshot is still captured when pg_dump
 * is missing or too old — the JSON is what the diffing path needs, and losing
 * the whole snapshot over a missing client would be the worse trade. The reason
 * is recorded instead, so `restore` can say why rather than guessing.
 */
async function captureSchemaSql(
  dir: string,
  dbUrl: string,
  schemas: string[],
): Promise<Pick<SnapshotLayerInfo, 'sqlFile' | 'sqlSkipReason'>> {
  const sqlFile = 'schema.sql'
  try {
    const serverMajor = await getServerMajorVersion(dbUrl)
    const resolved = await resolvePgDumpPath(serverMajor)
    if (!resolved) {
      return {
        sqlSkipReason: `${await describeMissingPgDump(serverMajor)} — `
          + 'schema.json was still captured, but restore cannot replay the schema',
      }
    }

    const { stdout } = await execFile(resolved.path, [
      dbUrl, '--schema-only', '--no-owner', '--no-privileges',
      // Quoted: pg_dump reads --schema as a pattern, folding `App Data` to lower case.
      ...schemas.map(s => `--schema=${quoteName(s)}`),
    ], { maxBuffer: 256 * 1024 * 1024, timeout: 300_000 })

    if (stdout.trim().length === 0) {
      return { sqlSkipReason: 'pg_dump produced an empty schema dump' }
    }

    await writeFile(join(dir, sqlFile), stdout)
    return { sqlFile }
  } catch (err) {
    return { sqlSkipReason: errMsg(err) }
  }
}

/**
 * A policy's comment, which pg_policies does not carry. Restored with the
 * policy: the layer drops and recreates it, which took the comment the schema
 * dump had set before it.
 */
const POLICY_COMMENT = `(SELECT obj_description(p.oid, 'pg_policy') FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = pg_policies.schemaname AND c.relname = pg_policies.tablename
            AND p.polname = pg_policies.policyname) AS comment`

async function captureRlsPolicies(
  dir: string,
  dbUrl: string,
  ignoreSchemas: string[],
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'rls.sql'
  try {
    const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
    const sql = ignoreSchemas.length > 0
      ? `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check, ${POLICY_COMMENT}
         FROM pg_policies WHERE schemaname NOT IN (${placeholders})
         ORDER BY schemaname, tablename, policyname`
      : `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check, ${POLICY_COMMENT}
         FROM pg_policies ORDER BY schemaname, tablename, policyname`

    const rows = await queryFn(dbUrl, sql, ignoreSchemas.length > 0 ? ignoreSchemas : undefined) as unknown as RlsRow[]
    const statements = rows.map(p => generateCreatePolicySql(p))
    const output = statements.length > 0
      ? `-- SupaForge RLS Policy Snapshot\n-- ${rows.length} policies\n\n${statements.join('\n\n')}\n`
      : '-- No RLS policies found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch (err) {
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

async function captureEdgeFunctions(
  dir: string,
  env: EnvironmentConfig,
  fetchFn: FetchFn,
): Promise<SnapshotLayerInfo> {
  const file = 'edge-functions.json'
  const token = env.accessToken
  if (!env.projectRef || !token) {
    return { captured: false, file, itemCount: 0, skipReason: 'no projectRef or accessToken configured' }
  }

  try {
    const url = `${SUPABASE_MGMT_API}/${encodeURIComponent(env.projectRef)}/functions`
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${httpStatus(res)}`)
    const functions = await readJsonArray<unknown>(res, 'The Edge Function list')
    await writeFile(join(dir, file), JSON.stringify(functions, null, 2) + '\n')
    return { captured: true, file, itemCount: functions.length }
  } catch (err) {
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

async function captureStorage(
  dir: string,
  env: EnvironmentConfig,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  let bucketCount = 0
  let policyCount = 0
  let storageError: string | undefined

  // Buckets via direct DB query
  const bucketsFile = 'storage-buckets.json'
  try {
    const buckets = await queryFn(env.dbUrl, `
      SELECT id, name, public, file_size_limit, allowed_mime_types,
             avif_autodetection, created_at, updated_at
      FROM storage.buckets
      ORDER BY name
    `)
    await writeFile(join(dir, bucketsFile), JSON.stringify(buckets, null, 2) + '\n')
    bucketCount = buckets.length
  } catch { /* storage schema may not exist — fall through to policies */ }

  // Storage policies via DB
  const policiesFile = 'storage-policies.sql'
  try {
    // The storage check's own query and SQL, so a snapshot keeps what the
    // check compares — each policy's comment included.
    const rows = await queryFn(env.dbUrl, schemaPolicySql('storage'))
    const statements = (rows as unknown as SchemaPolicy[]).map(p =>
      // Dropped first so a snapshot can be restored twice, as below.
      `${dropPolicySql('storage', p)}\n${createPolicySql('storage', p)}`)
    const output = statements.length > 0
      ? `-- SupaForge Storage Policy Snapshot\n-- ${rows.length} policies\n\n${statements.join('\n\n')}\n`
      : '-- No storage policies found\n'
    await writeFile(join(dir, policiesFile), output)
    policyCount = rows.length
  } catch (err) {
    storageError = errMsg(err)
  }

  const captured = bucketCount > 0 || policyCount > 0
  return {
    captured,
    file: bucketsFile,
    itemCount: bucketCount + policyCount,
    ...(storageError && !policyCount ? { error: storageError } : {}),
    ...(!captured && !storageError ? { skipReason: 'no storage buckets or policies found' } : {}),
  }
}

async function captureAuthConfig(
  dir: string,
  env: EnvironmentConfig,
  fetchFn: FetchFn,
): Promise<SnapshotLayerInfo> {
  const file = 'auth.json'
  const token = env.accessToken
  if (!env.projectRef || !token) {
    return { captured: false, file, itemCount: 0, skipReason: 'no projectRef or accessToken configured' }
  }

  try {
    const url = `${SUPABASE_MGMT_API}/${encodeURIComponent(env.projectRef)}/config/auth`
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`HTTP ${httpStatus(res)}`)
    const config = await readJsonObject(res, 'The auth config')
    await writeFile(join(dir, file), JSON.stringify(config, null, 2) + '\n')
    return { captured: true, file, itemCount: Object.keys(config).length }
  } catch (err) {
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

async function captureCronJobs(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'cron.sql'
  try {
    const rows = await queryFn(dbUrl, `
      SELECT jobid, schedule, command, nodename, nodeport, database, username, active, jobname
      FROM cron.job ORDER BY jobname, jobid
    `)
    const statements = (rows as unknown as CronRow[]).map(job => {
      const name = job.jobname ?? `job-${job.jobid}`
      return `SELECT cron.schedule('${name}', '${job.schedule}', $$${job.command}$$);`
    })
    const output = statements.length > 0
      ? `-- SupaForge Cron Job Snapshot\n-- ${rows.length} jobs\n\n${statements.join('\n\n')}\n`
      : '-- No cron jobs found (pg_cron may not be installed)\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch (err) {
    const msg = errMsg(err)
    await writeFile(join(dir, file), '-- pg_cron extension not available\n').catch(() => {})
    if (msg.includes(RELATION_NOT_FOUND)) {
      return { captured: false, file, itemCount: 0, skipReason: 'pg_cron extension not installed' }
    }
    return { captured: false, file, itemCount: 0, error: msg }
  }
}

async function captureData(
  dir: string,
  dbUrl: string,
  tables: string[],
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  if (tables.length === 0) {
    return { captured: false, file: 'data/', itemCount: 0, skipReason: 'no tables configured in checks.data.tables' }
  }

  const dataDir = join(dir, 'data')
  await mkdir(dataDir, { recursive: true })
  let captured = 0
  const errors: string[] = []

  for (const table of tables) {
    try {
      await writeFile(join(dataDir, `${table}.json`), await capturedRows(dbUrl, table, queryFn) + '\n')
      captured++
    } catch (err) {
      errors.push(`${table}: ${errMsg(err)}`)
    }
  }

  return {
    captured: captured > 0,
    file: 'data/',
    itemCount: captured,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  }
}


/**
 * A table's rows, each column as PostgreSQL's own text for it — the text its
 * input function reads back exactly, as pg_dump relies on. A bigint past 2^53,
 * a long numeric, a timestamp's zone, bytea and arrays come back as they were;
 * so does a json value's text, spacing and duplicate keys included, and a JSON
 * null stays distinct from an SQL NULL. Captured as JSON values instead, json
 * was re-rendered and a JSON null read back as NULL.
 */
async function capturedRows(dbUrl: string, table: string, queryFn: QueryFn): Promise<string> {
  const columns = (await queryFn(dbUrl, `SELECT attname AS name FROM pg_attribute
    WHERE attrelid = ${quoteLiteral(quoteIdent(table))}::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`) as unknown as Array<{ name: string }>)
    .map(c => c.name)
  const keys = columns.map(quoteLiteral).join(', ')
  const values = columns.map(c => `t.${quoteName(c)}::text`).join(', ')
  const [{ rows }] = await queryFn(dbUrl, `SELECT jsonb_pretty(jsonb_build_object('format', 'text', 'rows',
      coalesce(jsonb_agg(json_object(ARRAY[${keys}]::text[], ARRAY[${values}]::text[])::jsonb), '[]'::jsonb))) AS rows
    FROM (SELECT * FROM ${quoteIdent(table)} ORDER BY 1) t`) as unknown as Array<{ rows: string }>
  return rows
}

async function captureWebhooks(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'webhooks.sql'
  try {
    // The triggers themselves, exactly as the check reads them (issue #77).
    // This used to start from supabase_functions.hooks — the log of webhook
    // *invocations* — and rebuild each trigger by hand, which got the same
    // things wrong here as it did there: a webhook that had never fired had no
    // log rows and was left out of the snapshot; a deleted one still had rows
    // and was written into it; the join was on trigger name alone, so two
    // webhooks of one name on different tables collapsed; every trigger was
    // emitted as AFTER whatever its real timing; and the arguments carrying the
    // URL, method, headers, params and timeout were dropped entirely, so
    // restoring a snapshot produced webhooks that failed every write with
    // `url argument is missing`. It also re-emitted Supabase's own
    // http_request via pg_get_functiondef, so a restore replaced it.
    const rows = await queryFn(dbUrl, `
      SELECT n.nspname || '.' || c.relname AS table_name,
             t.tgname                      AS name,
             pg_get_triggerdef(t.oid)      AS definition
      FROM pg_trigger t
      JOIN pg_class c      ON c.oid = t.tgrelid
      JOIN pg_namespace n  ON n.oid = c.relnamespace
      JOIN pg_proc p       ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE NOT t.tgisinternal
        AND pn.nspname = 'supabase_functions'
        AND p.proname  = 'http_request'
      ORDER BY 1, 2
    `)

    const statements = (rows as unknown as WebhookRow[])
      .filter(h => h.definition)
      .map(hook => [
        `-- Webhook: ${hook.name} on ${hook.table_name}`,
        `${hook.definition.replace(/;\s*$/, '')};`,
      ].join('\n'))

    const output = statements.length > 0
      ? `-- SupaForge Webhook Snapshot\n-- ${statements.length} webhooks\n\n${statements.join('\n\n')}\n`
      : '-- No webhooks found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: statements.length }
  } catch (err) {
    // Reading the system catalogs cannot fail for a missing `supabase_functions`
    // schema — a database without one simply has no such triggers and is
    // captured as zero webhooks, not skipped. So anything arriving here is a
    // real error rather than an absence, and is reported as one.
    const msg = errMsg(err)
    await writeFile(join(dir, file), `-- Webhook snapshot failed: ${msg}\n`).catch(() => {})
    return { captured: false, file, itemCount: 0, error: msg }
  }
}

async function captureRealtime(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'realtime.sql'
  try {
    const rows = await queryFn(dbUrl, PUBLICATION_SQL) as unknown as Array<{ pubname: string; schemaname: string | null; tablename: string | null }>

    // One CREATE per publication, then the tables added to it. `supabase_realtime`
    // exists on every Supabase project, so the CREATE is conditional and the
    // membership is what actually carries the state.
    const byPublication = new Map<string, string[]>()
    for (const row of rows) {
      const tables = byPublication.get(row.pubname) ?? []
      if (row.schemaname && row.tablename) {
        tables.push(`${quoteName(row.schemaname)}.${quoteName(row.tablename)}`)
      }
      byPublication.set(row.pubname, tables)
    }

    const statements: string[] = []
    for (const [pubname, tables] of byPublication) {
      statements.push(`-- Publication: ${pubname}`)
      statements.push(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = ${quoteLiteral(pubname)}) THEN
    EXECUTE ${quoteLiteral(`CREATE PUBLICATION ${quoteName(pubname)}`)};
  END IF;
END $$;`)
      for (const table of tables) {
        statements.push(`ALTER PUBLICATION ${quoteName(pubname)} ADD TABLE ${table};`)
      }
    }

    const output = statements.length > 0
      ? `-- SupaForge Realtime Snapshot\n-- ${byPublication.size} publication(s)\n\n${statements.join('\n')}\n`
      : '-- No publications found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: byPublication.size }
  } catch (err) {
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

async function captureVaultSecrets(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'vault.sql'
  try {
    // vault.secrets, not decrypted_secrets: only names and descriptions are
    // wanted, and the view decrypts every value to show them. `unique_name`
    // is gone from supabase_vault 0.3, and asking for it failed with
    // `column "unique_name" does not exist` — which the catch below then read
    // as Vault not being installed, on a project holding secrets.
    const rows = await queryFn(dbUrl, `
      SELECT coalesce(name, id::text) AS name, description
      FROM vault.secrets
      ORDER BY 1
    `) as unknown as Array<{ name: string; description: string | null }>

    // Names and descriptions only. A secret's value cannot be read out of
    // Vault across environments, so this is a list of what to recreate by hand
    // rather than SQL to replay — and deliberately not runnable, so a restore
    // cannot create a secret with an invented value the way the vault check
    // used to (issue #91).
    const lines = rows.map(row =>
      `--   ${row.name}${row.description ? ` — ${row.description}` : ''}`)

    const output = rows.length > 0
      ? `-- SupaForge Vault Snapshot\n-- ${rows.length} secret(s), names only:\n`
        + '-- the values cannot be read out of Vault and must be recreated by hand.\n'
        + `${lines.join('\n')}\n`
      : '-- No vault secrets found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch (err) {
    // Only the schema being absent means Vault is not there. Any other
    // failure — a permission, a column — is an error to report, not a reason
    // to call the layer skipped.
    if (!(await vaultInstalled(dbUrl, queryFn))) {
      return { captured: false, file, itemCount: 0, skipReason: 'vault extension not installed' }
    }
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

async function vaultInstalled(dbUrl: string, queryFn: QueryFn): Promise<boolean> {
  try {
    const [row] = await queryFn(dbUrl, `SELECT to_regnamespace('vault') IS NOT NULL AS installed`) as unknown as
      Array<{ installed: boolean }>
    return row?.installed === true
  } catch {
    // Cannot even ask: report the original failure rather than guess.
    return true
  }
}

async function captureRoleGrants(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'roles.sql'
  // Supabase's own schemas are left out: their grants are the platform's, and
  // replaying them into plain PostgreSQL — the usual restore target — fails on
  // a schema that does not exist there. A snapshot of a test stack held 348
  // grants, 201 of them on storage, realtime, supabase_functions and vault.
  const excluded = SUPABASE_PLATFORM_SCHEMAS.map(quoteLiteral).join(', ')
  try {
    const rows = await queryFn(dbUrl, `
      -- From relacl, not information_schema.role_table_grants: that view
      -- counts the owner's own privileges as grants, which a restore then
      -- replayed as GRANT ... TO <owner>, creating the role on the target;
      -- and it hides grants the connecting role takes no part in.
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
             n.nspname AS table_schema, c.relname AS table_name, NULL::text AS column_name,
             a.privilege_type, a.is_grantable,
             CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE '' END AS keyword, NULL::text AS args
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relacl IS NOT NULL AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND a.grantee <> c.relowner
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN (
          'postgres','supabase_admin','authenticator','supabase_auth_admin',
          'supabase_storage_admin','dashboard_user','pgbouncer','supavisor'
        ))
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT LIKE 'pg\\_%')
        AND n.nspname NOT IN (${excluded})
      UNION ALL
      -- Routines, through acldefault(): a NULL proacl is EXECUTE to PUBLIC,
      -- and leaving routines out restored a SECURITY DEFINER function the
      -- source kept from the API as callable by anyone.
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
             n.nspname, p.proname, NULL::text, a.privilege_type, a.is_grantable,
             CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, pg_get_function_identity_arguments(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee <> p.proowner
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN (
          'postgres','supabase_admin','authenticator','supabase_auth_admin',
          'supabase_storage_admin','dashboard_user','pgbouncer','supavisor'
        ))
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT LIKE 'pg\\_%')
        AND n.nspname NOT IN (${excluded})
      UNION ALL
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
             n.nspname, c.relname, att.attname, a.privilege_type, a.is_grantable, '', NULL::text
      FROM pg_attribute att
      JOIN pg_class c ON c.oid = att.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      WHERE att.attacl IS NOT NULL AND att.attnum > 0 AND NOT att.attisdropped
        AND a.grantee <> c.relowner
        AND n.nspname NOT IN (${excluded})
      ORDER BY 1, 2, 3, 8, 4, 5
    `) as unknown as Array<{
      grantee: string; table_schema: string; table_name: string
      column_name: string | null; privilege_type: string; is_grantable: boolean
      /** SEQUENCE, FUNCTION or PROCEDURE; empty for a table or view. */
      keyword: string
      /** A routine's identity arguments. */
      args: string | null
    }>

    // One statement per role, object and grant option, listing the
    // privileges: one per privilege made a restore that skipped a relation
    // list it once for every privilege of every role. MAINTAIN, a PostgreSQL
    // 17 privilege, stays on its own, so an older server skips only it rather
    // than rejecting every privilege granted alongside.
    const grouped = new Map<string, typeof rows>()
    for (const row of rows) {
      const key = JSON.stringify([row.grantee, row.keyword, row.table_schema, row.table_name, row.args, row.column_name,
        Boolean(row.is_grantable), row.privilege_type === 'MAINTAIN'])
      grouped.set(key, [...(grouped.get(key) ?? []), row])
    }
    const statements = [...grouped.values()].map(([row, ...rest]) =>
      `GRANT ${[row, ...rest].map(r => r.privilege_type + (r.column_name ? ` (${quoteName(r.column_name)})` : '')).join(', ')}`
      + ` ON ${row.keyword ? `${row.keyword} ` : ''}${quoteName(row.table_schema)}.${quoteName(row.table_name)}`
      + (row.args !== null && row.keyword !== 'SEQUENCE' && row.keyword ? `(${row.args})` : '')
      // PUBLIC is a keyword; quoted, it names a role that does not exist.
      + ` TO ${row.grantee === 'PUBLIC' ? 'PUBLIC' : quoteName(row.grantee)}`
      + (row.is_grantable ? ' WITH GRANT OPTION' : '')
      + ';')

    const output = statements.length > 0
      ? `-- SupaForge Role Grants Snapshot\n-- ${rows.length} grant(s)\n\n${statements.join('\n')}\n`
      : '-- No role grants found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch (err) {
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

async function captureExtensions(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'extensions.sql'
  try {
    const rows = await queryFn(dbUrl, `
      SELECT extname, extversion, n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY extname
    `)
    const statements = (rows as unknown as { extname: string; extversion: string; schema: string }[]).map(ext => {
      return `CREATE EXTENSION IF NOT EXISTS ${quoteName(ext.extname)} WITH SCHEMA ${quoteName(ext.schema)};`
    })
    const output = statements.length > 0
      ? `-- SupaForge Extensions Snapshot\n-- ${rows.length} extensions\n\n${statements.join('\n')}\n`
      : '-- No extensions found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch (err) {
    return { captured: false, file, itemCount: 0, error: errMsg(err) }
  }
}

// ─── Snapshot Reading ────────────────────────────────────────────────────────

/** Load the manifest from a snapshot directory. */
export async function loadSnapshot(dir: string): Promise<SnapshotManifest> {
  const raw = await readFile(join(dir, 'manifest.json'), 'utf-8')
  return JSON.parse(raw) as SnapshotManifest
}

/** Find the latest snapshot directory. */
export async function findLatestSnapshot(cwd = process.cwd()): Promise<string | null> {
  const base = snapshotsBaseDir(cwd)
  try {
    const entries = await readdir(base)
    const sorted = entries.filter(e => /^\d{8}T\d{6}Z$/.test(e)).sort()
    return sorted.length > 0 ? join(base, sorted[sorted.length - 1]) : null
  } catch {
    return null
  }
}

/** List all snapshot directories with their manifests. */
export async function listSnapshots(cwd = process.cwd()): Promise<{ dir: string; manifest: SnapshotManifest }[]> {
  const base = snapshotsBaseDir(cwd)
  try {
    const entries = await readdir(base)
    const sorted = entries.filter(e => /^\d{8}T\d{6}Z$/.test(e)).sort()
    const results: { dir: string; manifest: SnapshotManifest }[] = []
    for (const entry of sorted) {
      try {
        const manifest = await loadSnapshot(join(base, entry))
        results.push({ dir: join(base, entry), manifest })
      } catch { /* skip corrupt snapshots */ }
    }
    return results
  } catch {
    return []
  }
}

/** Default number of snapshots to keep when pruning. */
export const DEFAULT_KEEP_COUNT = 7

export interface PruneResult {
  /** Snapshot directories that were deleted. */
  deleted: string[]
  /** Snapshot directories that were kept. */
  kept: string[]
  /**
   * Snapshots kept despite being outside the budget, because a migration
   * names one as its `parent`.
   *
   * Deleting those broke the migration chain silently: the migration stayed,
   * referring to a snapshot that was no longer there (issue #92).
   */
  retainedForMigrations?: string[]
}

/**
 * Prune old snapshots, keeping the most recent `keep` snapshots.
 * Snapshots are sorted chronologically by their timestamp directory name.
 * Returns metadata about which directories were deleted.
 */
export async function pruneSnapshots(
  keep = DEFAULT_KEEP_COUNT,
  cwd = process.cwd(),
): Promise<PruneResult> {
  const snapshots = await listSnapshots(cwd)

  // Already within budget — nothing to prune
  if (snapshots.length <= keep) {
    return { deleted: [], kept: snapshots.map(s => s.dir) }
  }

  // Snapshots come back sorted oldest-first from listSnapshots
  const candidates = snapshots.slice(0, snapshots.length - keep)
  const withinBudget = snapshots.slice(snapshots.length - keep)

  // A snapshot a migration names as its `parent` is the other half of that
  // migration's diff. Deleting it broke the chain silently — the migration
  // stayed, referring to something that was no longer there (issue #92). Kept
  // regardless of the budget, and reported so the count still makes sense.
  const referenced = await snapshotVersionsReferencedByMigrations(cwd)
  const toDelete = candidates.filter(s => !referenced.has(versionOf(s.dir)))
  const retained = candidates.filter(s => referenced.has(versionOf(s.dir)))

  for (const snap of toDelete) {
    await rm(snap.dir, { recursive: true, force: true })
  }

  return {
    deleted: toDelete.map(s => s.dir),
    kept: [...retained, ...withinBudget].map(s => s.dir),
    retainedForMigrations: retained.map(s => s.dir),
  }
}

/** The timestamp a snapshot directory is named for. */
function versionOf(dir: string): string {
  return dir.split('/').filter(Boolean).pop() ?? dir
}

/**
 * Snapshot versions that migration files name as their parent.
 *
 * Best-effort: an unreadable migrations directory means nothing is protected,
 * which is the behaviour prune had before this existed.
 */
async function snapshotVersionsReferencedByMigrations(cwd: string): Promise<Set<string>> {
  const referenced = new Set<string>()

  try {
    const dir = resolve(cwd, SUPAFORGE_DIR, MIGRATIONS_SUBDIR)
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const migration = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { parent?: string | null }
        if (migration.parent) referenced.add(migration.parent)
      } catch { /* a migration that will not parse protects nothing */ }
    }
  } catch { /* no migrations directory */ }

  return referenced
}


// ─── SQL Generation Helpers (reused from checks) ────────────────────────────

interface RlsRow {
  schemaname: string
  tablename: string
  policyname: string
  permissive: string
  roles: string[] | string
  cmd: string
  qual: string | null
  with_check: string | null
  comment?: string | null
}

/**
 * Dropped first so a snapshot can be restored twice: without it a second
 * restore fails with `policy "…" already exists` and the layers after it
 * never run (issue #80). Written by the shared builders, which set the
 * comment after the policy.
 */
function generateCreatePolicySql(p: RlsRow): string {
  return `${dropPolicySql(p.schemaname, p)}\n${createPolicySql(p.schemaname, p)}`
}

interface CronRow {
  jobid: number
  schedule: string
  command: string
  jobname: string | null
}

interface WebhookRow {
  /** `schema.table` — a trigger name is only unique per table. */
  table_name: string
  /** The trigger name, which is what the Dashboard calls the webhook. */
  name: string
  /** `CREATE TRIGGER …`, as the server renders it, arguments included. */
  definition: string
}
