import type { QueryFn } from '../db.js'
import { pgQuery } from '../db.js'
import type { DriftIssue } from '../types/drift.js'
import { Check, type CheckContext } from './base.js'
import { SUPABASE_PLATFORM_SCHEMAS } from '../defaults.js'
import { quoteName } from '../utils/sql.js'

interface PgRole {
  rolname: string
  rolsuper: boolean
  rolinherit: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  rolcanlogin: boolean
  rolreplication: boolean
  rolbypassrls: boolean
  rolconnlimit: number
  rolvaliduntil: string | null
}

/**
 * What a grant is on. Tables, views and the like share PostgreSQL's TABLE
 * syntax; a sequence and a routine each need their own keyword, and a
 * routine its argument types, since overloads share a name.
 */
type ObjectKind = 'table' | 'sequence' | 'function' | 'procedure'

interface RoleGrant {
  grantee: string
  table_schema: string
  /** The object's name; for a routine, without its arguments. */
  table_name: string
  privilege_type: string
  is_grantable: boolean
  /** Set for a column-level grant, `GRANT UPDATE (col) ON t TO r`. */
  column_name?: string | null
  /** Omitted for a table, view or other relation. */
  object_kind?: ObjectKind
  /** A routine's identity arguments, `p integer`. */
  args?: string | null
}

/**
 * Roles the platform owns outright.
 *
 * Their attributes and their grants are Supabase's to manage, and a difference
 * in either means the two projects run different Supabase versions rather than
 * that anybody changed anything.
 */
export const PLATFORM_ROLES = [
  'postgres', 'supabase_admin', 'authenticator',
  'supabase_auth_admin', 'supabase_storage_admin', 'dashboard_user',
  'pgbouncer', 'supavisor',
  // Created by Supabase's own images for Edge Functions, Realtime, read
  // replicas and logical replication. Diffing a project against plain
  // PostgreSQL offered to create all four on the target.
  'supabase_functions_admin', 'supabase_realtime_admin',
  'supabase_read_only_user', 'supabase_replication_admin',
]

/**
 * The roles the Data API authenticates as.
 *
 * Their *attributes* are Supabase's — nobody usefully diffs whether `anon` can
 * log in — but their *table grants* are the application's, and are exactly the
 * drift worth catching: `REVOKE ALL ON public.plans FROM anon` is the
 * difference between a table being readable through the anon key and not
 * (issue #90). All three were filtered out of the grants query, so that change
 * reported clean.
 */
const API_ROLES = ['anon', 'authenticated', 'service_role']

const quoted = (names: string[]) => names.map(n => `'${n.replace(/'/g, "''")}'`).join(', ')

/**
 * Every role but the platform's, the built-in ones, and the one this check is
 * connected as.
 *
 * The connecting role is the credential each environment was given, not part
 * of the project: two databases reached as different users reported each user
 * as drift, and the fix for the target's was `DROP ROLE` on the very role the
 * apply was running as.
 */
const ROLES_SQL = `
  SELECT
    rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
    rolcanlogin, rolreplication, rolbypassrls, rolconnlimit,
    rolvaliduntil::text AS rolvaliduntil
  FROM pg_roles
  WHERE NOT (rolname LIKE 'pg_%')
    AND rolname NOT IN (${quoted([...PLATFORM_ROLES, ...API_ROLES])})
    AND rolname <> current_user
  ORDER BY rolname
`

/**
 * Schemas whose grants are compared: everything but Supabase's own.
 *
 * Grants on `storage.objects`, `realtime.messages` or `vault.secrets` are set by
 * Supabase and move with its version. Comparing them reported one project's
 * Supabase upgrade as drift in the other — and offered `REVOKE ... ON
 * storage.objects FROM anon` as the fix, which breaks Storage. On a test stack
 * two thirds of the grants the Data API roles hold were in these schemas.
 */
function grantSchemaFilter(ignoreSchemas: string[]): string {
  const excluded = [...new Set([...SUPABASE_PLATFORM_SCHEMAS, ...ignoreSchemas])]
  return `NOT IN (${quoted(excluded)})`
}

/**
 * Table-level grants, read from `relacl` like the column grants below.
 *
 * `information_schema.role_table_grants` was read instead, and it is wrong
 * twice over for a comparison. It includes the owner's own privileges, which
 * are not grants: a table owned by `postgres` on one side and by another user
 * on the other reported every privilege of both owners as drift — 35 findings
 * for a project restored into plain PostgreSQL. And it lists only grants the
 * connecting role takes part in, so a grant between two other roles was not
 * seen at all.
 */
const grantsSql = (ignoreSchemas: string[]) => `
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         n.nspname AS table_schema, c.relname AS table_name,
         a.privilege_type, a.is_grantable,
         CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END AS object_kind
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relacl IS NOT NULL
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND a.grantee <> c.relowner
    AND n.nspname ${grantSchemaFilter(ignoreSchemas)}
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN (${quoted(PLATFORM_ROLES)}))
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT LIKE 'pg_%')
  ORDER BY 1, 2, 3, 4
`

/**
 * Column-level grants, read from `attacl`.
 *
 * `information_schema.column_privileges` also lists every column a table-level
 * grant covers, which would report each table grant once per column. The
 * attribute ACL holds only what was granted on the column itself —
 * `GRANT UPDATE (display_name) ON profiles TO authenticated`, the usual way to
 * let a user edit some columns of their row and not others.
 */
const columnGrantsSql = (ignoreSchemas: string[]) => `
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         n.nspname AS table_schema, c.relname AS table_name, att.attname AS column_name,
         a.privilege_type, a.is_grantable
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE att.attacl IS NOT NULL AND att.attnum > 0 AND NOT att.attisdropped
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.grantee <> c.relowner
    AND n.nspname ${grantSchemaFilter(ignoreSchemas)}
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN (${quoted(PLATFORM_ROLES)}))
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT LIKE 'pg_%')
  ORDER BY 1, 2, 3, 4, 5
`

/**
 * Routine grants, read from `proacl`.
 *
 * A NULL `proacl` is not "no grants": it is PostgreSQL's default, EXECUTE to
 * PUBLIC, so it is read through acldefault(). These were never compared at
 * all, and a SECURITY DEFINER function the source kept from the Data API —
 * the usual way to keep an elevated function out of reach — arrived on the
 * target callable with the anon key. Functions an extension owns are its own.
 */
const functionGrantsSql = (ignoreSchemas: string[]) => `
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         n.nspname AS table_schema, p.proname AS table_name,
         pg_get_function_identity_arguments(p.oid) AS args,
         CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS object_kind,
         a.privilege_type, a.is_grantable
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  WHERE a.grantee <> p.proowner
    AND n.nspname ${grantSchemaFilter(ignoreSchemas)}
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN (${quoted(PLATFORM_ROLES)}))
    AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT LIKE 'pg_%')
  ORDER BY 1, 2, 3, 4, 6
`

/** Each side's routines, to tell one the target lacks yet. */
const routinesSql = (ignoreSchemas: string[]) => `
  SELECT n.nspname AS table_schema, p.proname AS table_name,
         pg_get_function_identity_arguments(p.oid) AS args,
         CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS object_kind
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname ${grantSchemaFilter(ignoreSchemas)}
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
`

/** Each side's relations, to tell a table the target lacks yet. */
const relationsSql = (ignoreSchemas: string[]) => `
  SELECT n.nspname AS table_schema, c.relname AS table_name,
         CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END AS object_kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND n.nspname ${grantSchemaFilter(ignoreSchemas)}
`

/**
 * What an object the connecting role creates is granted by default, per kind
 * and schema (NULL for every schema): ALTER DEFAULT PRIVILEGES ... ON TABLES,
 * SEQUENCES and FUNCTIONS.
 *
 * A routine has a default of PostgreSQL's own as well: EXECUTE to PUBLIC. A
 * global entry for the role replaces it; without one it applies, and the
 * per-schema entries add to it. That is the second row source here.
 */
const DEFAULT_GRANTS_SQL = `
  SELECT CASE d.defaclobjtype WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'function' ELSE 'table' END AS object_kind,
         n.nspname AS table_schema,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
         a.privilege_type, a.is_grantable
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE d.defaclobjtype IN ('r', 'S', 'f') AND d.defaclrole = current_user::regrole::oid
    AND a.grantee <> d.defaclrole
  UNION ALL
  SELECT 'function', NULL, 'PUBLIC', 'EXECUTE', false
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
    WHERE d.defaclobjtype = 'f' AND d.defaclnamespace = 0 AND d.defaclrole = current_user::regrole::oid)
`

type Relation = { table_schema: string; table_name: string; object_kind?: ObjectKind; args?: string | null }
type DefaultGrant = {
  table_schema: string | null; grantee: string; privilege_type: string; is_grantable: boolean
  /** Omitted for tables. A procedure gets a function's defaults. */
  object_kind?: ObjectKind
}

/** The object a grant or relation names, with its kind and a routine's arguments. */
function objectKey(o: { table_schema: string; table_name: string; object_kind?: ObjectKind; args?: string | null }): string {
  const routine = o.object_kind === 'function' || o.object_kind === 'procedure'
  return `${routine ? 'routine' : o.object_kind ?? 'table'}:${o.table_schema}.${o.table_name}${routine ? `(${o.args ?? ''})` : ''}`
}

/** The kind of default privileges an object takes: a procedure's are a function's. */
function defaultKind(kind: ObjectKind | undefined): ObjectKind {
  return kind === 'procedure' ? 'function' : kind ?? 'table'
}

/**
 * Leave out a missing grant the target will make by itself: one on a table it
 * does not have yet, which its default privileges grant when the schema fix
 * creates it. On Supabase that is every Data API grant on every new table —
 * most of a report, and gone again after the first apply.
 */
export function grantedByDefault(
  relations: Relation[],
  defaults: DefaultGrant[],
): (g: RoleGrant) => boolean {
  const present = new Set(relations.map(objectKey))
  const granted = new Set(defaults.map(d =>
    `${defaultKind(d.object_kind)}|${d.table_schema ?? '*'}|${d.grantee}|${d.privilege_type}|${Boolean(d.is_grantable)}`))
  return g => !g.column_name
    && !present.has(objectKey(g))
    && [g.table_schema, '*'].some(schema =>
      granted.has(`${defaultKind(g.object_kind)}|${schema}|${g.grantee}|${g.privilege_type}|${Boolean(g.is_grantable)}`))
}

/**
 * What the target's default privileges will grant on a table the schema fix
 * creates, and the source does not: the other half of `grantedByDefault`.
 *
 * A table kept away from the Data API (`REVOKE ALL ... FROM anon,
 * authenticated`) and created on a Supabase target got everything the
 * defaults give, and nothing took it back until a second sync, so one sync
 * left it open to the anon key. The REVOKE runs with the grants, after the
 * table is created.
 */
export function defaultGrantsToRevoke(
  sourceRelations: Relation[],
  targetRelations: Relation[],
  defaults: DefaultGrant[],
  sourceGrants: RoleGrant[],
): DriftIssue[] {
  const present = new Set(targetRelations.map(objectKey))
  const held = new Set(sourceGrants.filter(g => !g.column_name)
    .map(g => `${objectKey(g)}|${g.grantee}|${g.privilege_type}`))
  const issues: DriftIssue[] = []
  for (const rel of sourceRelations) {
    if (present.has(objectKey(rel))) continue
    const name = `${rel.table_schema}.${rel.table_name}`
    const extra = new Map<string, Set<string>>()
    for (const d of defaults) {
      if (defaultKind(d.object_kind) !== defaultKind(rel.object_kind)) continue
      if (d.table_schema !== null && d.table_schema !== rel.table_schema) continue
      if (held.has(`${objectKey(rel)}|${d.grantee}|${d.privilege_type}`)) continue
      extra.set(d.grantee, (extra.get(d.grantee) ?? new Set()).add(d.privilege_type))
    }
    for (const [grantee, privileges] of [...extra].sort(([a], [b]) => a.localeCompare(b))) {
      const gs: RoleGrant[] = [...privileges].sort().map(privilege_type => ({
        grantee, table_schema: rel.table_schema, table_name: rel.table_name, privilege_type, is_grantable: false,
        ...(rel.object_kind && rel.object_kind !== 'table' ? { object_kind: rel.object_kind } : {}),
        ...(rel.args !== undefined ? { args: rel.args } : {}),
      }))
      const routine = rel.object_kind === 'function' || rel.object_kind === 'procedure'
      issues.push({
        // Tables keep the id they have always had; others say what they are.
        id: `roles-grant-default-${grantee}.${name}${routine ? `(${rel.args ?? ''})` : ''}`,
        check: 'roles',
        severity: extraGrantSeverity(grantee),
        title: `Default grants to take back: ${describeGroup(gs)}`,
        description: `Creating ${describeObject(gs[0])} on the target gives ${grantee} what its default privileges grant. `
          + `The source does not grant "${describeGroup(gs)}", so it is revoked once it exists.`,
        targetValue: gs,
        sql: {
          up: `REVOKE ${groupTarget(gs)} FROM ${granteeSql(grantee)};`,
          down: `GRANT ${groupTarget(gs)} TO ${granteeSql(grantee)};`,
        },
      })
    }
  }
  return issues
}

/**
 * A grant the target has and the source does not widens access. To the roles
 * the Data API serves (and PUBLIC) that is the anon key reaching a table, so
 * critical; to any other role a warning. It was info, which a sync's summary
 * does not lead with.
 */
const OPEN_GRANTEES = new Set(['anon', 'authenticated', 'PUBLIC'])
function extraGrantSeverity(grantee: string): 'critical' | 'warning' {
  return OPEN_GRANTEES.has(grantee) ? 'critical' : 'warning'
}

export class RolesCheck extends Check {
  readonly name = 'roles' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const ignore = ctx.config.ignoreSchemas ?? []
    const version = async (url: string) =>
      Number((await this.queryFn(url, `SELECT current_setting('server_version_num') AS v`) as Array<{ v: string }>)[0]?.v ?? 0)
    const [
      sourceRoles, targetRoles, sourceGrants, targetGrants, sourceColumns, targetColumns,
      sourceVersion, targetVersion, sourceRelations, targetRelations, targetDefaults,
      sourceRoutineGrants, targetRoutineGrants, sourceRoutines, targetRoutines,
    ] = await Promise.all([
      this.queryFn(ctx.source.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.target.dbUrl, ROLES_SQL) as unknown as Promise<PgRole[]>,
      this.queryFn(ctx.source.dbUrl, grantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, grantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.source.dbUrl, columnGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, columnGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      version(ctx.source.dbUrl),
      version(ctx.target.dbUrl),
      this.queryFn(ctx.source.dbUrl, relationsSql(ignore)) as unknown as Promise<Relation[]>,
      this.queryFn(ctx.target.dbUrl, relationsSql(ignore)) as unknown as Promise<Relation[]>,
      this.queryFn(ctx.target.dbUrl, DEFAULT_GRANTS_SQL) as unknown as Promise<DefaultGrant[]>,
      this.queryFn(ctx.source.dbUrl, functionGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.target.dbUrl, functionGrantsSql(ignore)) as unknown as Promise<RoleGrant[]>,
      this.queryFn(ctx.source.dbUrl, routinesSql(ignore)) as unknown as Promise<Relation[]>,
      this.queryFn(ctx.target.dbUrl, routinesSql(ignore)) as unknown as Promise<Relation[]>,
    ])
    const sourceObjects = [...(sourceRelations ?? []), ...(sourceRoutines ?? [])]
    const targetObjects = [...(targetRelations ?? []), ...(targetRoutines ?? [])]
    const sourceAll = [...(sourceGrants ?? []), ...(sourceRoutineGrants ?? [])]
    // A routine or sequence only the target has is the schema check's finding,
    // and its grants go with it. Every routine grants EXECUTE to PUBLIC unless
    // told otherwise, so each one present on the target alone was reported
    // again as an extra grant.
    const inSource = new Set(sourceObjects.map(objectKey))
    const targetAll = [...(targetGrants ?? []), ...(targetRoutineGrants ?? [])]
      .filter(g => !g.object_kind || g.object_kind === 'table' || inSource.has(objectKey(g)))
    const comparable = comparablePrivileges(sourceVersion, targetVersion)
    const byDefault = grantedByDefault(targetObjects, targetDefaults ?? [])

    return [
      ...diffRoles(sourceRoles, targetRoles),
      ...diffGrants(
        [...sourceAll, ...(sourceColumns ?? [])].filter(g => comparable(g) && !byDefault(g)),
        [...targetAll, ...(targetColumns ?? [])].filter(comparable),
        absentOn(targetRoles, sourceRoles),
      ),
      ...defaultGrantsToRevoke(
        sourceObjects, targetObjects,
        (targetDefaults ?? []).filter(d => comparable(d as RoleGrant)), sourceAll),
    ]
  }
}

/** Roles the source has and the target does not. PUBLIC is not a role either side lists. */
function absentOn(target: PgRole[] | undefined, source: PgRole[] | undefined): Set<string> {
  const present = new Set((target ?? []).map(r => r.rolname))
  return new Set((source ?? []).map(r => r.rolname).filter(name => !present.has(name)))
}

function roleAttrs(r: PgRole): string {
  const attrs: string[] = []
  if (r.rolsuper) attrs.push('SUPERUSER')
  if (r.rolinherit) attrs.push('INHERIT')
  if (r.rolcreaterole) attrs.push('CREATEROLE')
  if (r.rolcreatedb) attrs.push('CREATEDB')
  if (r.rolcanlogin) attrs.push('LOGIN')
  if (r.rolreplication) attrs.push('REPLICATION')
  if (r.rolbypassrls) attrs.push('BYPASSRLS')
  if (r.rolconnlimit >= 0) attrs.push(`CONNECTION LIMIT ${r.rolconnlimit}`)
  if (r.rolvaliduntil) attrs.push(`VALID UNTIL '${r.rolvaliduntil}'`)
  return attrs.length > 0 ? attrs.join(' ') : 'NOLOGIN'
}

function rolesEqual(a: PgRole, b: PgRole): boolean {
  return (
    a.rolsuper === b.rolsuper &&
    a.rolinherit === b.rolinherit &&
    a.rolcreaterole === b.rolcreaterole &&
    a.rolcreatedb === b.rolcreatedb &&
    a.rolcanlogin === b.rolcanlogin &&
    a.rolreplication === b.rolreplication &&
    a.rolbypassrls === b.rolbypassrls &&
    a.rolconnlimit === b.rolconnlimit &&
    a.rolvaliduntil === b.rolvaliduntil
  )
}

export function diffRoles(source: PgRole[], target: PgRole[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(r => [r.rolname, r]))
  const targetMap = new Map(target.map(r => [r.rolname, r]))

  for (const [name, sr] of sourceMap) {
    if (!targetMap.has(name)) {
      issues.push({
        id: `roles-missing-${name}`,
        check: 'roles',
        severity: 'critical',
        title: `Missing role: ${name}`,
        description: `Role "${name}" exists in source but is missing from target. Any RLS policies or grants referencing this role will be silently ineffective.`,
        sourceValue: sr,
        sql: {
          up: `CREATE ROLE ${quoteName(name)} ${roleAttrs(sr)};`,
          down: `DROP ROLE IF EXISTS ${quoteName(name)};`,
        },
      })
    }
  }

  for (const [name, tr] of targetMap) {
    if (!sourceMap.has(name)) {
      issues.push({
        id: `roles-extra-${name}`,
        check: 'roles',
        severity: 'warning',
        title: `Extra role: ${name}`,
        description: `Role "${name}" exists in target but not in source.`,
        targetValue: tr,
        sql: {
          up: `DROP ROLE IF EXISTS ${quoteName(name)};`,
          down: `CREATE ROLE ${quoteName(name)} ${roleAttrs(tr)};`,
        },
      })
    }
  }

  for (const [name, sr] of sourceMap) {
    const tr = targetMap.get(name)
    if (tr && !rolesEqual(sr, tr)) {
      issues.push({
        id: `roles-modified-${name}`,
        check: 'roles',
        severity: 'warning',
        title: `Modified role: ${name}`,
        description: `Role "${name}" has different attributes between source and target.`,
        sourceValue: sr,
        targetValue: tr,
        sql: {
          up: `ALTER ROLE ${quoteName(name)} ${roleAttrs(sr)};`,
          down: `ALTER ROLE ${quoteName(name)} ${roleAttrs(tr)};`,
        },
      })
    }
  }

  return issues
}

function grantKey(g: RoleGrant): string {
  const column = g.column_name ? `.${g.column_name}` : ''
  const routine = g.object_kind === 'function' || g.object_kind === 'procedure'
  return `${g.grantee}.${g.table_schema}.${g.table_name}${routine ? `(${g.args ?? ''})` : ''}${column}.${g.privilege_type}`
}

/** The object as SQL: `"s"."t"`, `SEQUENCE "s"."q"`, `FUNCTION "s"."f"(integer)`. */
function objectSql(g: RoleGrant): string {
  const name = `${quoteName(g.table_schema)}.${quoteName(g.table_name)}`
  switch (g.object_kind) {
    case 'sequence': return `SEQUENCE ${name}`
    case 'function': return `FUNCTION ${name}(${g.args ?? ''})`
    case 'procedure': return `PROCEDURE ${name}(${g.args ?? ''})`
    default: return name
  }
}

/** The object as a reader names it: `public.t`, `sequence public.q`, `function public.f(integer)`. */
function describeObject(g: RoleGrant): string {
  const name = `${g.table_schema}.${g.table_name}`
  switch (g.object_kind) {
    case 'sequence': return `sequence ${name}`
    case 'function': return `function ${name}(${g.args ?? ''})`
    case 'procedure': return `procedure ${name}(${g.args ?? ''})`
    default: return name
  }
}

/**
 * A grantee as SQL. `PUBLIC` is a keyword, not a role: quoted, it names a
 * role called "PUBLIC", which does not exist, so the fix failed.
 */
function granteeSql(grantee: string): string {
  return grantee === 'PUBLIC' ? 'PUBLIC' : `"${grantee.replace(/"/g, '""')}"`
}

/** `SELECT ON "s"."t"`, or `UPDATE ("col") ON "s"."t"` for a column grant. */
function grantTarget(g: RoleGrant): string {
  const column = g.column_name ? ` ("${g.column_name.replace(/"/g, '""')}")` : ''
  return `${g.privilege_type}${column} ON ${objectSql(g)}`
}

function describeGrant(g: RoleGrant): string {
  const column = g.column_name ? `(${g.column_name}) ` : ''
  return `${g.privilege_type} ${column}ON ${describeObject(g)} TO ${g.grantee}`
}

const grantSql = (g: RoleGrant, withOption = g.is_grantable) =>
  `GRANT ${grantTarget(g)} TO ${granteeSql(g.grantee)}${withOption ? ' WITH GRANT OPTION' : ''};`
const revokeSql = (g: RoleGrant) => `REVOKE ${grantTarget(g)} FROM ${granteeSql(g.grantee)};`

/**
 * The grants both servers can hold. MAINTAIN is a PostgreSQL 17 privilege:
 * a 17 source reported it missing from a 15 target, and the fix failed with
 * `unrecognized privilege type "maintain"`, rolling back every grant with it.
 */
export function comparablePrivileges(sourceVersion: number, targetVersion: number): (g: RoleGrant) => boolean {
  const both = Math.min(sourceVersion || Infinity, targetVersion || Infinity)
  return g => g.privilege_type !== 'MAINTAIN' || both >= 170000
}

/** Grants that differ the same way, on one table (or column) to one role, as one finding. */
function grouped(grants: RoleGrant[]): RoleGrant[][] {
  const groups = new Map<string, RoleGrant[]>()
  for (const g of grants) {
    const key = `${grantKey(g).replace(/\.[^.]+$/, '')}.${Boolean(g.is_grantable)}`
    groups.set(key, [...(groups.get(key) ?? []), g])
  }
  return [...groups.values()]
}

/** `SELECT, INSERT ON "s"."t"` for a group of grants on one object. */
function groupTarget(gs: RoleGrant[]): string {
  const column = gs[0].column_name ? ` ("${gs[0].column_name.replace(/"/g, '""')}")` : ''
  return `${gs.map(g => `${g.privilege_type}${column}`).join(', ')} ON ${objectSql(gs[0])}`
}

function describeGroup(gs: RoleGrant[]): string {
  const column = gs[0].column_name ? `(${gs[0].column_name}) ` : ''
  return `${gs.map(g => g.privilege_type).join(', ')} ${column}ON ${describeObject(gs[0])} TO ${gs[0].grantee}`
}

/** A group's key: the grant key without its privilege. */
const groupKey = (gs: RoleGrant[]) => grantKey(gs[0]).replace(/\.[^.]+$/, '')

/**
 * Grants to a role the target does not have, one finding per role.
 *
 * Each would otherwise be a finding of its own, and against a plain
 * PostgreSQL copy of a Supabase project — no `anon`, `authenticated` or
 * `service_role` — that was a finding per function per role: hundreds,
 * burying the rest. None can apply until the role exists, which is a finding
 * of its own; this one carries every grant for when it does.
 */
function grantsToMissingRoles(grants: RoleGrant[]): DriftIssue[] {
  const byRole = new Map<string, RoleGrant[]>()
  for (const g of grants) byRole.set(g.grantee, [...(byRole.get(g.grantee) ?? []), g])
  return [...byRole].map(([role, gs]) => {
    const groups = grouped(gs)
    const objects = new Set(gs.map(g => describeObject(g))).size
    const what = `${gs.length} privilege${gs.length === 1 ? '' : 's'} on ${objects} object${objects === 1 ? '' : 's'}`
    return {
      id: `roles-grant-missing-role-${role}`,
      check: 'roles' as const,
      severity: 'warning' as const,
      title: `Missing grants: ${what} to ${role}, a role the target does not have`,
      description: `The source grants ${what} to "${role}", which the target lacks. They can only be applied once `
        + 'the role exists (see "Missing role"); on a target that is not meant to have it, skip the roles check.',
      sourceValue: gs,
      sql: {
        up: groups.map(g => `GRANT ${groupTarget(g)} TO ${granteeSql(role)}${g[0].is_grantable ? ' WITH GRANT OPTION' : ''};`).join('\n'),
        down: groups.map(g => `REVOKE ${groupTarget(g)} FROM ${granteeSql(role)};`).reverse().join('\n'),
      },
    }
  })
}

/**
 * Grants on the target that differ from the source's.
 *
 * Missing and extra grants are one finding per role, table (or column) and
 * grant option, listing the privileges: one finding per privilege made a
 * table granted to Supabase's three API roles twenty-odd findings, most of a
 * report.
 */
export function diffGrants(
  source: RoleGrant[],
  target: RoleGrant[],
  missingRoles: ReadonlySet<string> = new Set(),
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(g => [grantKey(g), g]))
  const targetMap = new Map(target.map(g => [grantKey(g), g]))

  const missing = [...sourceMap].filter(([key]) => !targetMap.has(key)).map(([, g]) => g)
  issues.push(...grantsToMissingRoles(missing.filter(g => missingRoles.has(g.grantee))))
  for (const gs of grouped(missing.filter(g => !missingRoles.has(g.grantee)))) {
    const plural = gs.length > 1 ? 's' : ''
    issues.push({
      id: `roles-grant-missing-${groupKey(gs)}`,
      check: 'roles',
      severity: 'warning',
      title: `Missing grant${plural}: ${describeGroup(gs)}`,
      description: `Grant${plural} "${describeGroup(gs)}" ${gs.length > 1 ? 'are' : 'is'} missing from target.`,
      sourceValue: gs.length > 1 ? gs : gs[0],
      sql: {
        up: `GRANT ${groupTarget(gs)} TO ${granteeSql(gs[0].grantee)}${gs[0].is_grantable ? ' WITH GRANT OPTION' : ''};`,
        down: `REVOKE ${groupTarget(gs)} FROM ${granteeSql(gs[0].grantee)};`,
      },
    })
  }

  for (const [key, sg] of sourceMap) {
    const tg = targetMap.get(key)
    if (tg && Boolean(sg.is_grantable) !== Boolean(tg.is_grantable)) {
      // The same privilege, held with the grant option on one side only.
      // Keying on the privilege alone reported these identical; the grant
      // option is what lets the grantee pass the privilege on.
      const revokeOption = `REVOKE GRANT OPTION FOR ${grantTarget(sg)} FROM ${granteeSql(sg.grantee)};`
      issues.push({
        id: `roles-grant-option-${key}`,
        check: 'roles',
        severity: 'warning',
        title: `Grant option differs: ${describeGrant(sg)}`,
        description: `"${describeGrant(sg)}" is held ${sg.is_grantable ? 'with' : 'without'} the grant option in source `
          + `and ${tg.is_grantable ? 'with' : 'without'} it in target.`,
        sourceValue: sg,
        targetValue: tg,
        sql: sg.is_grantable
          ? { up: grantSql(sg, true), down: revokeOption }
          : { up: revokeOption, down: grantSql(tg, true) },
      })
    }
  }

  const extra = [...targetMap].filter(([key]) => !sourceMap.has(key)).map(([, g]) => g)
  for (const gs of grouped(extra)) {
    const plural = gs.length > 1 ? 's' : ''
    issues.push({
      id: `roles-grant-extra-${groupKey(gs)}`,
      check: 'roles',
      severity: extraGrantSeverity(gs[0].grantee),
      title: `Extra grant${plural}: ${describeGroup(gs)}`,
      description: `Grant${plural} "${describeGroup(gs)}" exist${gs.length > 1 ? '' : 's'} in target but not in source.`,
      targetValue: gs.length > 1 ? gs : gs[0],
      sql: {
        up: `REVOKE ${groupTarget(gs)} FROM ${granteeSql(gs[0].grantee)};`,
        down: `GRANT ${groupTarget(gs)} TO ${granteeSql(gs[0].grantee)}${gs[0].is_grantable ? ' WITH GRANT OPTION' : ''};`,
      },
    })
  }

  return issues
}
