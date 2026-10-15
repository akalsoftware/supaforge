/**
 * Convergence proof.
 *
 * A migration is only trustworthy if applying it actually produces the target
 * schema. Every silent-wrong-answer bug found so far shared one shape: the
 * generated SQL executed without error and left the database in a state that
 * was *not* the source — a duplicate primary key aborted loudly, but a
 * flattened partition, a dropped enum type name and an unpropagated index all
 * ran cleanly and lied.
 *
 * A text comparison cannot catch that class, and neither can a test suite that
 * only exercises the patterns its authors thought of. The only check that
 * generalises is to run the migration and look at what came out.
 *
 * So: copy the target's schema into a throwaway database, apply the migration
 * there, and diff the result against the source. Zero drift means the migration
 * does what it claims. Anything else is reported as residual drift, naming the
 * objects the migration failed to reproduce.
 *
 * The real target is never touched. The clone lives on the target's own server
 * (so no cross-host credentials are needed) and is dropped in a finally block
 * even when the proof throws.
 */
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fingerprintSql, stateSql, type SchemaState } from '@akal/pg-conformance'
import { pgQuery, type QueryFn } from './db'
import { runLikeApply, type PlannedSql } from './promote'
import { diffState } from './state-diff'
import { resolvePgDumpPath, getServerMajorVersion, describeMissingPgDump } from './pg-tools'
import { rolesNamedBy, sqlSkeleton } from './sql-deps'
import { splitSqlStatements, isCommentOnly } from './utils/sql-split.js'
import { quoteName } from './utils/sql.js'
import { globToRegExp } from './utils/strings.js'
import { join, dirname } from 'node:path'
import { compareTables, sampleInto, sampleRows, snapshotTables, type DataProof } from './prove-data.js'

const exec = promisify(execFile)

/**
 * Extensions on the target, and the schema each is installed into.
 *
 * The clone holds only the schemas being proved, so anything those schemas
 * reference from outside has to be put there first — and in practice that means
 * extensions: a Supabase column default calling `extensions.uuid_generate_v4()`
 * cannot be created without the extension that owns the function.
 *
 * Extensions living in a system schema are excluded, by *schema* rather than
 * by name. Filtering `plpgsql` by name left `pg_cron` — which Supabase installs
 * into `pg_catalog` — and the clone preparation then ran
 * `CREATE SCHEMA IF NOT EXISTS "pg_catalog"`. PostgreSQL rejects a name
 * beginning with `pg_` before it evaluates `IF NOT EXISTS`:
 *
 *     error: unacceptable schema name "pg_catalog"  (42939)
 *
 * so `--prove` aborted on every project with Cron enabled (issue #94). There is
 * nothing to create for these schemas in any case: they exist in every
 * database, and so do the extensions in them.
 */
const TARGET_EXTENSIONS_SQL = `
  SELECT e.extname AS name, n.nspname AS schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\\_%'
   ORDER BY e.extname
`

export interface ProofResult {
  /** True when the clone matched the source after applying. */
  converged: boolean
  /** Objects still differing after the migration — the migration's blind spots. */
  residual: string[]
  /** Name of the throwaway database, for error messages. */
  cloneName: string
  /** Set when the proof could not run at all (missing pg_dump, no CREATEDB). */
  skipped?: string
  /**
   * Fixes the replay left out because the server can't hold them — an
   * extension it does not ship, and what needs it — as the apply will. Their
   * absence is expected, not a failure to converge.
   */
  notApplied?: Array<{ issueId: string; sql: string; reason: string }>
  /**
   * For a run limited to some checks: differences the target already had,
   * still there, and of a kind none of those checks compares — see
   * outsideTheRun(). They do not count against convergence.
   */
  outOfScope?: string[]
  /**
   * What became of a sample of the target's rows — see prove-data.ts. A
   * kept table that lost rows fails the proof.
   */
  data?: DataProof
}

/** Replace the database name in a libpq URL, keeping everything else. */
export function withDatabase(dbUrl: string, database: string): string {
  const url = new URL(dbUrl)
  url.pathname = `/${database}`
  return url.toString()
}


/**
 * The structural fingerprint comes from @akal/pg-conformance.
 *
 * It used to be defined here, and separately in the e2e harness, and again in
 * dbdiff's conformance runner. They drifted, and this copy was the one that
 * compared views, functions and triggers by name alone — so it called two
 * schemas converged when a view's predicate had been inverted, a function's
 * body replaced, or a trigger moved from AFTER INSERT to BEFORE UPDATE.
 *
 * A shared definition of "same schema" is the whole point of the proof, so it
 * lives in one place that both projects depend on.
 */

export async function fingerprint(dbUrl: string, schemas: string[]): Promise<string> {
  const rows = await pgQuery(dbUrl, fingerprintSql(schemas)) as unknown as
    Array<{ fingerprint: string | null }>

  // An empty fingerprint would make every comparison succeed, so a schema that
  // produced nothing is treated as a fault rather than as "no differences".
  // Reading the wrong column name would fail exactly this way, silently.
  const value = rows[0]?.fingerprint
  if (value === undefined) {
    throw new Error('fingerprint query returned no "fingerprint" column')
  }
  return value ?? ''
}

/**
 * Say what differs, in terms a reader can act on.
 *
 * The fingerprint has already decided that something does. This turns the two
 * schema-state documents into named findings — "column public.orders.total:
 * storage extended → plain" — rather than two near-identical lines of catalog
 * shorthand with one field moved somewhere in the middle.
 *
 * Falls back to the raw fingerprint lines if the structured diff comes back
 * empty. That should not happen, but "the schemas differ and I cannot tell you
 * how" is a far worse answer than an ugly one.
 */
async function describeDifference(
  sourceUrl: string, cloneUrl: string, schemas: string[], want: string, got: string,
): Promise<string[]> {
  try {
    const [before, after] = await Promise.all([
      schemaState(sourceUrl, schemas),
      schemaState(cloneUrl, schemas),
    ])
    const findings = diffState(before, after)
    if (findings.length > 0) return findings
  } catch {
    // fall through to the fingerprint lines
  }

  const wanted = new Set(want.split('\n').filter(Boolean))
  const actual = new Set(got.split('\n').filter(Boolean))
  return [
    ...[...wanted].filter(l => !actual.has(l)).map(l => `missing: ${l}`),
    ...[...actual].filter(l => !wanted.has(l)).map(l => `unexpected: ${l}`),
  ]
}

/** The schema-state document for one database. */
async function schemaState(dbUrl: string, schemas: string[]): Promise<SchemaState> {
  const rows = await pgQuery(dbUrl, stateSql(schemas)) as unknown as Array<{ state: string | null }>
  const value = rows[0]?.state
  if (!value) throw new Error('state query returned no "state" column')
  return JSON.parse(value) as SchemaState
}

/**
 * The schemas a schema diff compares between two databases: every schema
 * either has, but the system's own, an extension's own, and `ignore`
 * (globs: `*`, `?`), as `dbdiff --ignore-schemas` chooses them. What a
 * proof must cover, and nothing more.
 */
export async function comparedSchemas(
  sourceUrl: string, targetUrl: string, ignore: readonly string[], query: QueryFn = pgQuery,
): Promise<string[]> {
  const sql = `SELECT n.nspname AS name FROM pg_namespace n
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_namespace'::regclass
                        AND d.objid = n.oid AND d.deptype = 'e')`
  const ignored = ignore.map(globToRegExp)
  const names = (await Promise.all([sourceUrl, targetUrl].map(url => query(url, sql))))
    .flat().map(r => String((r as { name: unknown }).name))
  return [...new Set(names)].filter(n => !ignored.some(g => g.test(n))).sort()
}

/**
 * Prove that `migrationSql` turns the target into the source.
 *
 * Returns `converged: false` with the differing objects rather than throwing,
 * so the caller can decide whether that blocks an apply or merely warns.
 */
export async function proveConvergence(opts: {
  sourceUrl: string
  targetUrl: string
  migrationSql: string
  /**
   * The fixes behind migrationSql. Given, they are replayed exactly as the
   * apply will run them (see runLikeApply), so a fix the server can't hold is
   * left out rather than stopping the proof. Without them the SQL runs as one
   * script and any error ends the proof.
   */
  fixes?: PlannedSql[]
  schemas?: string[]
  /**
   * The checks the run compares. Without the schema check the migration only
   * sets out to fix part of the difference, and must not be refused for the
   * rest — see outsideTheRun(). Omitted, the whole schema must converge.
   */
  checks?: readonly string[]
}): Promise<ProofResult> {
  const schemas = opts.schemas ?? ['public']
  const suffix = randomBytes(4).toString('hex')
  const cloneName = `supaforge_prove_${suffix}`
  const adminUrl = withDatabase(opts.targetUrl, 'postgres')
  const cloneUrl = withDatabase(opts.targetUrl, cloneName)

  let pgDump: string
  let psql: string
  let serverMajor: number
  let clientMajor: number
  let sourceMajor: number
  try {
    serverMajor = await getServerMajorVersion(opts.targetUrl)
    sourceMajor = await getServerMajorVersion(opts.sourceUrl).catch(() => serverMajor)
    // The proof dumps both servers: the target into the clone, and the source
    // into a copy compared like with like. A pg_dump new enough for the target
    // alone failed on a newer source, and the proof fell back to comparing a
    // 17 source's rendering with a 15 clone's, refusing correct migrations.
    const resolved = await resolvePgDumpPath(Math.max(serverMajor, sourceMajor))
      ?? await resolvePgDumpPath(serverMajor)
    if (!resolved) {
      return { converged: false, residual: [], cloneName, skipped: await describeMissingPgDump(serverMajor) }
    }
    pgDump = resolved.path
    clientMajor = resolved.major
    psql = psqlBeside(pgDump)
  } catch (err) {
    return {
      converged: false, residual: [], cloneName,
      skipped: `could not resolve pg_dump: ${(err as Error).message}`,
    }
  }

  // A role is the server's, not the database's: creating one for the proof
  // would create it for real, and the apply's own CREATE ROLE then failed
  // with "already exists". So a migration that needs a role the server does
  // not have yet cannot be proved here — say so rather than create it.
  const absent = await absentRoles(opts.targetUrl, opts.migrationSql)
  if (absent.length > 0) {
    return {
      converged: false, residual: [], cloneName,
      skipped: `the migration needs role(s) this server does not have yet (${absent.join(', ')}), `
        + 'and creating a role is server-wide, so it cannot be done in a throwaway database',
    }
  }

  let created = false
  let sourceCopyCreated = false
  let roundTripName: string | undefined
  try {
    try {
      await pgQuery(adminUrl, `CREATE DATABASE ${quoteName(cloneName)}`)
      created = true
    } catch (err) {
      // Typically insufficient privilege. Not being able to prove is not the
      // same as failing to converge, so say which it is.
      return {
        converged: false, residual: [], cloneName,
        skipped: `could not create a throwaway database: ${(err as Error).message}`,
      }
    }

    const tools = { pgDump, psql, clientMajor, serverMajor }
    await copyStructure(opts.targetUrl, cloneUrl, schemas, tools, opts.sourceUrl)
    const scoped = opts.checks !== undefined && !opts.checks.includes('schema')
    const before = scoped ? await schemaState(cloneUrl, schemas) : undefined

    // A sample of the target's rows, to see that they survive.
    const limit = sampleRows()
    const sample = limit > 0 ? await sampleInto(psql, opts.targetUrl, cloneUrl, schemas, limit) : undefined
    const tablesBefore = sample ? await snapshotTables(cloneUrl, schemas) : undefined

    // The migration under test.
    let notApplied: ProofResult['notApplied']
    if (opts.fixes) {
      const replayed = await runLikeApply(cloneUrl, opts.fixes)
      const unmet = replayed.errors.filter(e => / — not applied: /.test(e.error))
      const failed = replayed.errors.filter(e => !unmet.includes(e))
      if (failed.length > 0) {
        // A fix the apply itself would fail on: the migration can't reproduce
        // the source, and saying which fix and why is the useful answer.
        return {
          converged: false, cloneName,
          residual: failed.map(e => `fix ${e.issueId} failed: ${e.error}`),
        }
      }
      const byId = new Map(opts.fixes.map(f => [f.issueId, f.sql]))
      notApplied = unmet.map(e => ({ issueId: e.issueId, sql: byId.get(e.issueId) ?? '', reason: e.error }))
    } else {
      await runSql(psql, cloneUrl, opts.migrationSql)
    }
    let data: DataProof | undefined
    if (sample && tablesBefore) {
      data = { ...sample, ...compareTables(tablesBefore, await snapshotTables(cloneUrl, schemas), sample.sampled, opts.migrationSql) }
      if (data.lost.length > 0) {
        return { converged: false, cloneName, data, residual: data.lost.map(l => `rows lost in ${l}`) }
      }
    }
    const reported = (r: ProofResult): ProofResult => {
      const withData = data ? { ...r, data } : r
      return notApplied?.length ? { ...withData, notApplied } : withData
    }

    const [want, got] = await Promise.all([
      fingerprint(opts.sourceUrl, schemas),
      fingerprint(cloneUrl, schemas),
    ])

    // The verdict stays with the fingerprint. It is the comparison already
    // trusted, and keeping it means the structured diff below can only change
    // how a difference is *described*, never whether one is detected.
    if (want === got) return reported({ converged: true, residual: [], cloneName })

    // The clone's objects have been through a dump and restore, or were
    // recreated from the SQL a rendering produced; the source's have not, and
    // PostgreSQL does not render every expression the same way twice —
    // `status IN ('draft', 'active')` on a varchar column comes back as a
    // different but equivalent ARRAY expression. So a correct migration
    // creating such a CHECK, index or policy was refused. Compared with the
    // source copied the same way, like is compared with like.
    roundTripName = `${cloneName}_src`
    const roundTripUrl = withDatabase(opts.targetUrl, roundTripName)
    const roundTrip = await copyOfSource(adminUrl, opts.sourceUrl, roundTripUrl, roundTripName, schemas, tools)
    if (roundTrip !== null) {
      sourceCopyCreated = true
      if (roundTrip.ok) {
        const wantRoundTripped = await fingerprint(roundTripUrl, schemas)
        if (wantRoundTripped === got) return reported({ converged: true, residual: [], cloneName })
        const residual = await describeDifference(roundTripUrl, cloneUrl, schemas, wantRoundTripped, got)
        return reported(withinScope(residual, before && diffState(await schemaState(roundTripUrl, schemas), before), opts.checks, cloneName))
      }
    }

    // Without a copy of the source on the target's server, two major versions
    // cannot be compared: each prints the same objects its own way. That is
    // not proven rather than not converged.
    if (sourceMajor !== serverMajor) {
      return {
        converged: false, residual: [], cloneName,
        skipped: `no pg_dump ${sourceMajor} or later to copy the PostgreSQL ${sourceMajor} source onto the `
          + `PostgreSQL ${serverMajor} target's server, which comparing across the two versions needs`,
      }
    }
    const residual = await describeDifference(opts.sourceUrl, cloneUrl, schemas, want, got)
    return reported(withinScope(residual, before && diffState(await schemaState(opts.sourceUrl, schemas), before), opts.checks, cloneName))
  } finally {
    if (sourceCopyCreated && roundTripName) {
      await dropDatabase(adminUrl, roundTripName)
    }
    if (created) {
      // Never leave a clone behind, even on failure. Terminating first because
      // a failed apply can leave a session attached.
      await dropDatabase(adminUrl, cloneName)
    }
  }
}

export interface PgTools { pgDump: string; psql: string; clientMajor: number; serverMajor: number }

/**
 * Copy `fromUrl`'s structure in the given schemas into the empty database at
 * `intoUrl` — data is irrelevant to a schema proof and copying it would make
 * this unusable on anything but a toy database.
 *
 * Only the schemas being proved. Listing Supabase's schemas as exclusions
 * instead left the dump carrying everything that *references* them — a
 * `CREATE EXTENSION ... WITH SCHEMA extensions`, an event trigger calling
 * `extensions.set_graphql_placeholder()` — none of which could be replayed
 * into a clone that deliberately has no such schema. `--prove` therefore
 * failed on every real Supabase project, whatever the client version.
 */
export async function copyStructure(
  fromUrl: string, intoUrl: string, schemas: string[], tools: PgTools, migratingFrom?: string,
): Promise<void> {
  // Prepare the copy to receive the proved schemas, and nothing else.
  await prepareClone(intoUrl, fromUrl, schemas)

  // And the schemas they lean on. A Supabase table referencing auth.users, or
  // a policy calling auth.uid(), cannot be created without them — every real
  // project failed here with `schema "auth" does not exist`. Copied, not
  // compared: the fingerprint covers only the proved schemas.
  //
  // The schemas the source's objects lean on as well, when it is a migration
  // from that source being proved: a foreign key the migration adds onto
  // another schema's table needs that schema in the clone, though nothing in
  // the target uses it yet — the proof failed with `schema "app" does not
  // exist` where the apply itself would have worked. Only those the target
  // has: one it lacks would fail the real apply as well.
  const supporting = await supportingSchemas(fromUrl, schemas)
  const present = new Set((await pgQuery(fromUrl, 'SELECT nspname FROM pg_namespace') as Array<{ nspname: string }>).map(r => r.nspname))
  if (migratingFrom) {
    for (const name of await supportingSchemas(migratingFrom, schemas)) {
      if (present.has(name) && !supporting.includes(name)) supporting.push(name)
    }
  }

  // A proved schema only the source has is the migration's to create. Each
  // name quoted: pg_dump reads --schema as a pattern, folding `App Data` to
  // lower case, which matched nothing.
  const dumpArgs = [
    fromUrl, '--schema-only', '--no-owner', '--no-privileges',
    ...[...schemas.filter(s => present.has(s)), ...supporting].map(s => `--schema=${quoteName(s)}`),
  ]
  const { stdout: structure } = await exec(tools.pgDump, dumpArgs, {
    maxBuffer: 256 * 1024 * 1024, timeout: 300_000,
  })

  // pg_dump writes its preamble for its own version, so a newer client can
  // hand an older server a parameter that does not exist there (issue #72).
  // A supporting schema may already exist, created for an extension living in
  // it, so its CREATE SCHEMA has to tolerate that.
  const { sql: replayable } = dropUnsupportedSetStatements(
    tolerateExistingSchemas(structure), await knownParameters(intoUrl),
  )

  try {
    await runSql(tools.psql, intoUrl, replayable)
  } catch (err) {
    // Rethrown, not returned as `skipped`: a caller treats `skipped` as
    // "could not check, carry on and apply", and this is a case where we do
    // not know what the migration would do. Blocking the apply is the
    // behaviour that was already right (issue #72 confirmed nothing was
    // written and no clone was left behind) — only the message needed to say
    // what the cause actually is.
    throw new Error(explainStructureFailure((err as Error).message, tools.clientMajor, tools.serverMajor))
  }
}

/**
 * Schemas outside `schemas` holding something an object in them depends on —
 * a referenced table, a called function, a column's type — followed
 * transitively. Extension members are left out: prepareClone installs the
 * extensions themselves.
 */
export async function supportingSchemas(
  dbUrl: string, schemas: string[], queryFn: QueryFn = pgQuery,
): Promise<string[]> {
  const known = new Set(schemas)
  const found: string[] = []
  for (let from = [...schemas]; from.length > 0;) {
    const rows = await queryFn(dbUrl, SUPPORTING_SCHEMAS_SQL(from)) as unknown as Array<{ schema: string }>
    from = rows.map(r => r.schema).filter(s => !known.has(s))
    for (const schema of from) {
      known.add(schema)
      found.push(schema)
    }
  }
  return found
}

/** The namespace of any object pg_depend can name, by catalog. */
const NAMESPACE_OF = (cls: string, oid: string) => `CASE ${cls}
    WHEN 'pg_class'::regclass      THEN (SELECT relnamespace FROM pg_class WHERE oid = ${oid})
    WHEN 'pg_proc'::regclass       THEN (SELECT pronamespace FROM pg_proc WHERE oid = ${oid})
    WHEN 'pg_type'::regclass       THEN (SELECT typnamespace FROM pg_type WHERE oid = ${oid})
    WHEN 'pg_constraint'::regclass THEN (SELECT connamespace FROM pg_constraint WHERE oid = ${oid})
    WHEN 'pg_attrdef'::regclass    THEN (SELECT x_c.relnamespace FROM pg_attrdef x_d JOIN pg_class x_c ON x_c.oid = x_d.adrelid WHERE x_d.oid = ${oid})
    WHEN 'pg_policy'::regclass     THEN (SELECT x_c.relnamespace FROM pg_policy x_p JOIN pg_class x_c ON x_c.oid = x_p.polrelid WHERE x_p.oid = ${oid})
    WHEN 'pg_trigger'::regclass    THEN (SELECT x_c.relnamespace FROM pg_trigger x_t JOIN pg_class x_c ON x_c.oid = x_t.tgrelid WHERE x_t.oid = ${oid})
    WHEN 'pg_rewrite'::regclass    THEN (SELECT x_c.relnamespace FROM pg_rewrite x_r JOIN pg_class x_c ON x_c.oid = x_r.ev_class WHERE x_r.oid = ${oid})
  END`

const SUPPORTING_SCHEMAS_SQL = (from: string[]) => `
  SELECT DISTINCT rn.nspname AS schema
    FROM pg_depend d
    JOIN pg_namespace n  ON n.oid  = ${NAMESPACE_OF('d.classid', 'd.objid')}
    JOIN pg_namespace rn ON rn.oid = ${NAMESPACE_OF('d.refclassid', 'd.refobjid')}
   WHERE n.nspname IN (${from.map(quoteLiteral).join(', ')})
     AND rn.nspname <> n.nspname
     AND rn.nspname NOT IN ('pg_catalog', 'information_schema')
     AND rn.nspname NOT LIKE 'pg\\_%'
     AND d.deptype IN ('n', 'a')
     AND NOT EXISTS (SELECT 1 FROM pg_depend e
                      WHERE e.classid = d.refclassid AND e.objid = d.refobjid AND e.deptype = 'e')
   ORDER BY 1`

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** `CREATE SCHEMA x;` lines made `IF NOT EXISTS`. */
export function tolerateExistingSchemas(sql: string): string {
  return sql.replace(/^CREATE SCHEMA (?!IF NOT EXISTS )/gm, 'CREATE SCHEMA IF NOT EXISTS ')
}

/**
 * The source's structure copied onto the target's server the way the clone
 * was, for comparing like with like. `null` when the database could not be
 * created, `{ ok: false }` when the copy failed — the proof then falls back to
 * comparing against the source itself, as it did before.
 */
async function copyOfSource(
  adminUrl: string, sourceUrl: string, intoUrl: string, name: string, schemas: string[], tools: PgTools,
): Promise<{ ok: boolean } | null> {
  try {
    await pgQuery(adminUrl, `CREATE DATABASE ${quoteName(name)}`)
  } catch {
    return null
  }
  try {
    await copyStructure(sourceUrl, intoUrl, schemas, tools)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Drop a throwaway database, ending any session still attached first. */
export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await pgQuery(adminUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${name}' AND pid <> pg_backend_pid()`).catch(() => undefined)
  await pgQuery(adminUrl, `DROP DATABASE IF EXISTS ${quoteName(name)}`).catch(() => undefined)
}

/**
 * Execute a multi-statement script through psql rather than a plain connection.
 *
 * pg_dump output is not pure SQL: recent versions emit psql meta-commands such
 * as `\restrict`, which a normal client rejects with a scanner error. psql also
 * gives us ON_ERROR_STOP, so a migration that half-applies fails the proof
 * loudly instead of producing a partially-migrated clone that then reports
 * confusing residual drift.
 */
export function runSql(psqlPath: string, dbUrl: string, sql: string): Promise<void> {
  const trimmed = sql.trim()
  if (!trimmed) return Promise.resolve()

  return new Promise((resolve, reject) => {
    // Fed over stdin: promisified execFile has no `input` option, so passing
    // one silently leaves psql waiting on a stdin that never closes until the
    // timeout kills it.
    const child = spawn(psqlPath, [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `psql exited ${code}`))
    })
    child.stdin.write(trimmed)
    child.stdin.end()
  })
}

/** psql ships alongside pg_dump; reuse the version-matched directory. */
export function psqlBeside(pgDumpPath: string): string {
  return pgDumpPath === 'pg_dump' ? 'psql' : join(dirname(pgDumpPath), 'psql')
}

/**
 * Lines pg_dump emits before the first real object, in the order it emits them.
 *
 * `\restrict` is a psql meta-command recent versions wrap the script in;
 * `SET` and `SELECT pg_catalog.set_config(...)` configure the session. Nothing
 * here creates anything, which is what makes the preamble safe to rewrite.
 */
const PREAMBLE_LINE =
  /^\s*(?:--|$|\\(?:un)?restrict\b|SET\s+[\w.]+\s*=|SELECT\s+pg_catalog\.set_config\s*\()/i

/** A top-level `SET some.guc = value;`, capturing the parameter name. */
const SET_STATEMENT = /^\s*SET\s+([\w.]+)\s*=/i

/**
 * Drop `SET` statements from a dump's preamble that the destination server
 * would reject.
 *
 * pg_dump writes its preamble for the version of pg_dump, not the version of
 * the server the SQL will be replayed into: pg_dump 17 added an unconditional
 * `SET transaction_timeout = 0;`, and a PostgreSQL 15 or 16 server answers that
 * with `unrecognized configuration parameter`. A PostgreSQL 18 client against a
 * Supabase still on 15 is the common case rather than an exotic one, and it made
 * `--prove` unusable there — it aborted before replaying anything (issue #72).
 *
 * The filter asks the destination which parameters it actually has rather than
 * carrying a list of version-specific names, so the next parameter a future
 * pg_dump adds to the preamble needs no change here.
 *
 * Deliberately narrow in two ways. It only rewrites the leading run of
 * preamble lines, so a `SET` inside a function body — which lives after the
 * first `CREATE` — is never touched. And it only removes statements naming a
 * parameter the destination does not have, so a `SET` that fails for any other
 * reason still fails the proof loudly: `ON_ERROR_STOP` stays on, and no error
 * from the replay is ignored. Tolerating errors instead (as `pg_restore` does,
 * which is why `clone` never noticed this) would let an incomplete clone be
 * reported as converged.
 */
export function dropUnsupportedSetStatements(
  sql: string, knownParameters: ReadonlySet<string>,
): { sql: string; dropped: string[] } {
  const lines = sql.split('\n')
  const dropped: string[] = []
  const kept: string[] = []

  let inPreamble = true
  for (const line of lines) {
    if (inPreamble && !PREAMBLE_LINE.test(line)) inPreamble = false

    if (inPreamble) {
      const name = SET_STATEMENT.exec(line)?.[1]
      if (name && !knownParameters.has(name.toLowerCase())) {
        dropped.push(name.toLowerCase())
        continue
      }
    }
    kept.push(line)
  }

  return { sql: kept.join('\n'), dropped }
}

/**
 * Make a fresh clone ready to receive a dump of just the proved schemas.
 *
 * Two steps, in this order.
 *
 * The proved schemas are dropped, because the dump recreates them itself —
 * pg_dump emits `CREATE SCHEMA public` for an explicitly selected schema, which
 * a database that already has one rejects.
 *
 * Then the target's extensions are installed, those living in a proved schema
 * too: `pg_dump --schema` does not carry an extension, even one in the schema
 * it dumps, so a table whose exclusion constraint needs btree_gist in `public`
 * could not be replayed. Without this, a table whose column default calls an
 * extension function — the `extensions.uuid_generate_v4()` pattern all over
 * Supabase — cannot be created either, because a default is resolved when the
 * table is created, not when it is used. The dump's own CREATE SCHEMA then
 * finds the schema there, which tolerateExistingSchemas() allows.
 */
export async function prepareClone(
  cloneUrl: string, targetUrl: string, schemas: string[], queryFn: QueryFn = pgQuery,
): Promise<void> {
  for (const schema of schemas) {
    await queryFn(cloneUrl, `DROP SCHEMA IF EXISTS ${quoteName(schema)} CASCADE`)
  }

  const extensions = await queryFn(targetUrl, TARGET_EXTENSIONS_SQL) as unknown as
    Array<{ name: string; schema: string }>

  for (const ext of extensions) {
    // Tolerated for the same reason the CREATE EXTENSION below it is: a schema
    // this clone will not accept is not a reason to abandon the proof. If the
    // structure genuinely needed it, the replay fails next and says so — which
    // is a better error than this one (issue #94).
    await queryFn(cloneUrl, `CREATE SCHEMA IF NOT EXISTS ${quoteName(ext.schema)}`)
      .catch(() => undefined)
    // Best-effort: an extension the server cannot offer this database is not a
    // reason to abandon the proof. If the schema genuinely needed it, the replay
    // fails next and says so.
    await queryFn(cloneUrl,
      `CREATE EXTENSION IF NOT EXISTS ${quoteName(ext.name)} WITH SCHEMA ${quoteName(ext.schema)}`,
    ).catch(() => undefined)
  }
}

/** Configuration parameter names this server recognises. */
export async function knownParameters(dbUrl: string): Promise<Set<string>> {
  const rows = await pgQuery(dbUrl, 'SELECT name FROM pg_settings') as unknown as
    Array<{ name: string }>
  return new Set(rows.map(r => r.name.toLowerCase()))
}

/**
 * Explain a failure to replay the target's own structure.
 *
 * The raw psql error names a parameter or a syntax element, with nothing to
 * connect it to the real cause — a client newer than the server. Someone
 * reading `unrecognized configuration parameter` goes looking at their schema,
 * which is the one place the problem is not (issue #72).
 */
export function explainStructureFailure(
  message: string, clientMajor: number, serverMajor: number,
): string {
  // Only when the error actually looks like one — a newer client emitting SQL
  // the server has no concept of. Appending it to every failure would send
  // someone chasing a version gap that has nothing to do with, say, a missing
  // schema, which is the same species of misdirection this message exists to
  // undo.
  const looksLikeVersionGap = /unrecognized configuration parameter|syntax error/i.test(message)
  const versionGap = clientMajor > serverMajor && looksLikeVersionGap
    ? ` The local client is PostgreSQL ${clientMajor} and the target server is `
      + `${serverMajor}; pg_dump ${clientMajor} can emit SQL that a ${serverMajor} `
      + `server rejects. Installing postgresql-client-${serverMajor} removes the gap.`
    : ''
  return `could not replay the target's structure onto the clone: ${message}${versionGap}`
}

/** `DROP <kind> [IF EXISTS] <name>` and `DROP COLUMN [IF EXISTS] <name>`, capturing the bare name. */
const DROPPED_NAME = /\bDROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|TYPE|DOMAIN|SEQUENCE|FUNCTION|PROCEDURE|INDEX|COLUMN|CONSTRAINT|POLICY|TRIGGER)\s+(?:IF\s+EXISTS\s+)?(?:(?:"[^"]+"|[\w$]+)\s*\.\s*)?("[^"]+"|[\w$]+)/gi

/** `CREATE [OR REPLACE] <kind> [IF NOT EXISTS] <name>`, capturing the bare name. */
const CREATED_NAME = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|TYPE|DOMAIN|SEQUENCE|FUNCTION|PROCEDURE|INDEX|POLICY|TRIGGER|EXTENSION)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|[\w$]+)\s*\.\s*)?("[^"]+"|[\w$]+)/gi

/**
 * Split a proof's residual into what the held-back fixes account for and
 * what they do not.
 *
 * A fix held back — a destructive drop without --allow-destructive, one left
 * out by --only — leaves its object on the target on purpose, and the proof
 * then reported that object as `unexpected`, refusing the whole apply. A line
 * is only accounted for when it is that shape — an object present that the
 * source lacks — and a held-back fix drops an object of that name; anything
 * else about the same table still blocks.
 */
export function residualHeldBack(
  residual: string[],
  heldBackSql: string[],
): { heldBack: string[]; unexplained: string[] } {
  const dropped = new Set<string>()
  for (const sql of heldBackSql) {
    for (const m of sql.matchAll(DROPPED_NAME)) dropped.add(m[1].replace(/^"|"$/g, '').toLowerCase())
  }
  // And the creations a fix left out would have made: on a target that can't
  // hold them (no supabase_functions for a webhook, no auth schema for a
  // policy calling auth.uid()) the apply leaves them out, so the clone lacks
  // them by design and the line reads `…: missing`.
  const created: string[] = []
  for (const sql of heldBackSql) {
    for (const m of sql.matchAll(CREATED_NAME)) created.push(m[1].replace(/^"|"$/g, '').toLowerCase())
  }
  const heldBack: string[] = []
  const unexplained: string[] = []
  for (const line of residual) {
    const subject = /^[a-z ]+?\s([^\s:]+(?:\s[^\s:]+)?):\s*unexpected$/i.exec(line)?.[1]
    const name = subject?.split(/[.\s]/).pop()?.replace(/^"|"$/g, '').toLowerCase()
    const missing = /^(.*):\s*missing$/i.exec(line)?.[1].toLowerCase()
    if (name && dropped.has(name)) heldBack.push(line)
    else if (missing && created.some(n => missing.endsWith(` ${n}`) || missing.endsWith(`.${n}`))) heldBack.push(line)
    else unexplained.push(line)
  }
  return { heldBack, unexplained }
}

/**
 * The checks whose fixes the proof replays: the ones that act on the proved
 * schemas, which is all the fingerprint compares.
 *
 * The others act on something the throwaway database does not have, or that
 * is not its own. pg_cron lives in one database per server, so
 * `cron.schedule()` failed in the clone with `schema "cron" does not exist`
 * and aborted the proof, blocking an apply that would have worked. A role
 * belongs to the whole server, so `CREATE ROLE` in the clone created it for
 * real. A publication, a reference-data row, a storage policy: none of them
 * is in the fingerprint, so replaying them could only fail, never prove.
 */
const PROVED_CHECKS: ReadonlySet<string> = new Set(['schema', 'rls', 'rls-coverage', 'extensions', 'webhooks'])

/** A statement that acts on the server rather than the database it runs in. */
const SERVER_WIDE = [
  /^\s*(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|GROUP|DATABASE|TABLESPACE)\b/i,
  /^\s*ALTER\s+SYSTEM\b/i,
  // Role membership: a GRANT or REVOKE with no ON names roles, not objects.
  /^\s*(?:GRANT|REVOKE)\b(?![\s\S]*\bON\b)/i,
]

/**
 * Split the planned fixes into those the proof replays and those it cannot.
 *
 * A fix holding a server-wide statement is never replayed, whichever check it
 * came from: the proof must not change anything outside the database it made.
 */
export function proofScope<T extends { check: string; sql: string }>(
  statements: readonly T[],
): { replay: T[]; unproved: T[] } {
  const replay: T[] = []
  const unproved: T[] = []
  for (const stmt of statements) {
    const serverWide = splitSqlStatements(stmt.sql)
      .filter(s => !isCommentOnly(s))
      .some(s => SERVER_WIDE.some(re => re.test(sqlSkeleton(s))))
    if (PROVED_CHECKS.has(stmt.check) && !serverWide) replay.push(stmt)
    else unproved.push(stmt)
  }
  return { replay, unproved }
}

/** Roles the migration grants to or scopes a policy to that the server lacks. */
async function absentRoles(dbUrl: string, sql: string): Promise<string[]> {
  const named = [...new Set(splitSqlStatements(sql).flatMap(s => rolesNamedBy(s)))]
  if (named.length === 0) return []
  const rows = await pgQuery(dbUrl, 'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [named]) as unknown as
    Array<{ rolname: string }>
  const present = new Set(rows.map(r => r.rolname))
  return named.filter(r => !present.has(r))
}

/**
 * The verdict for what remains after the migration.
 *
 * Unscoped — `baseline` undefined — everything remaining is a failure to
 * converge. Scoped, a remaining difference is set aside when the target
 * already had it and none of the run's checks compares that kind of object:
 * `diff --check=rls --prove` was refused for every unrelated table the target
 * lacked, which the run never set out to create.
 */
function withinScope(
  residual: string[], baseline: string[] | undefined, checks: readonly string[] | undefined, cloneName: string,
): ProofResult {
  if (!baseline || !checks) return { converged: residual.length === 0, residual, cloneName }
  const had = new Set(baseline)
  const outOfScope = residual.filter(l => had.has(l) && outsideTheRun(l, checks))
  const remaining = residual.filter(l => !outOfScope.includes(l))
  return { converged: remaining.length === 0, residual: remaining, outOfScope, cloneName }
}

/** Which state-diff lines each check compares, beyond the schema check's all. */
const GOVERNED: Record<string, RegExp> = {
  'rls': /^policy on |: RLS (?:enabled|forced) /,
  'rls-coverage': /: RLS enabled /,
  'extensions': /^extension /,
  'webhooks': /^trigger on /,
}

/** A difference none of the run's checks compares. */
export function outsideTheRun(line: string, checks: readonly string[]): boolean {
  if (checks.includes('schema')) return false
  return !checks.some(c => GOVERNED[c]?.test(line))
}
