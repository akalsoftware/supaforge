import { describe, it, expect } from 'vitest'
import { RolesCheck, diffRoles, diffGrants, comparablePrivileges, grantedByDefault, defaultGrantsToRevoke } from '../../src/checks/roles.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
    },
  }
}

const makeRole = (overrides: Record<string, unknown> = {}) => ({
  rolname: 'app_readonly',
  rolsuper: false,
  rolinherit: true,
  rolcreaterole: false,
  rolcreatedb: false,
  rolcanlogin: true,
  rolreplication: false,
  rolbypassrls: false,
  rolconnlimit: -1,
  rolvaliduntil: null,
  ...overrides,
})

const makeGrant = (overrides: Record<string, unknown> = {}) => ({
  grantee: 'app_readonly',
  table_schema: 'public',
  table_name: 'users',
  privilege_type: 'SELECT',
  is_grantable: false,
  ...overrides,
})

describe('RolesCheck', () => {
  it('detects missing role in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) {
        return dbUrl.includes('source') ? [makeRole()] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const issue = issues.find(i => i.id === 'roles-missing-app_readonly')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('critical')
    expect(issue!.sql?.up).toContain('CREATE ROLE')
    expect(issue!.sql?.down).toContain('DROP ROLE')
  })

  it('detects extra role in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) {
        return dbUrl.includes('target') ? [makeRole({ rolname: 'extra_role' })] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const issue = issues.find(i => i.id === 'roles-extra-extra_role')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('warning')
    expect(issue!.sql?.up).toContain('DROP ROLE')
  })

  it('detects modified role attributes', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) {
        if (dbUrl.includes('source')) return [makeRole({ rolcanlogin: true })]
        return [makeRole({ rolcanlogin: false })]
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const issue = issues.find(i => i.id === 'roles-modified-app_readonly')
    expect(issue).toBeTruthy()
    expect(issue!.severity).toBe('warning')
    expect(issue!.sql?.up).toContain('ALTER ROLE')
    expect(issue!.sourceValue).toBeTruthy()
    expect(issue!.targetValue).toBeTruthy()
  })

  it('returns no issues when roles match', async () => {
    const role = makeRole()
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_roles')) return [role]
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects missing grant in target', async () => {
    const role = makeRole()
    const grant = makeGrant()
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) return [role]
      if (sql.includes('c.relacl')) {
        return dbUrl.includes('source') ? [grant] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const grantIssue = issues.find(i => i.id.startsWith('roles-grant-missing'))
    expect(grantIssue).toBeTruthy()
    expect(grantIssue!.severity).toBe('warning')
    expect(grantIssue!.sql?.up).toContain('GRANT SELECT')
    expect(grantIssue!.sql?.down).toContain('REVOKE SELECT')
  })

  it('detects extra grant in target', async () => {
    const role = makeRole()
    const grant = makeGrant({ privilege_type: 'INSERT' })
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_roles')) return [role]
      if (sql.includes('c.relacl')) {
        return dbUrl.includes('target') ? [grant] : []
      }
      return []
    }
    const check = new RolesCheck(queryFn)
    const issues = await check.scan(mockContext())
    const grantIssue = issues.find(i => i.id.startsWith('roles-grant-extra'))
    expect(grantIssue).toBeTruthy()
    expect(grantIssue!.severity).toBe('warning')
    expect(grantIssue!.sql?.up).toContain('REVOKE INSERT')
  })

  it('runs all 18 queries (roles, grants, column grants, routine grants, schema grants, version, tables and routines per side; the source\'s schemas; the target\'s default grants)', async () => {
    const calls: string[] = []
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      calls.push(sql)
      return []
    }
    const check = new RolesCheck(queryFn)
    await check.scan(mockContext())
    expect(calls).toHaveLength(18)
    expect(calls.filter(s => s.includes('n.nspacl'))).toHaveLength(2)
    expect(calls.filter(s => s.includes('proacl'))).toHaveLength(2)
    expect(calls.filter(s => s.includes('server_version_num'))).toHaveLength(2)
    const roleQueries  = calls.filter(s => s.includes('rolsuper'))
    const grantQueries = calls.filter(s => s.includes('c.relacl'))
    expect(roleQueries).toHaveLength(2)
    expect(grantQueries).toHaveLength(2)
    expect(calls.filter(s => s.includes('pg_default_acl'))).toHaveLength(1)
  })
})

describe('diffRoles', () => {
  it('generates CREATE ROLE with LOGIN attribute', () => {
    const role = makeRole({ rolcanlogin: true })
    const issues = diffRoles([role], [])
    expect(issues[0].sql?.up).toContain('LOGIN')
    expect(issues[0].sql?.up).toContain('CREATE ROLE "app_readonly"')
  })

  it('generates CREATE ROLE with CREATEDB and connection limit', () => {
    const role = makeRole({ rolcreatedb: true, rolconnlimit: 10 })
    const issues = diffRoles([role], [])
    expect(issues[0].sql?.up).toContain('CREATEDB')
    expect(issues[0].sql?.up).toContain('CONNECTION LIMIT 10')
  })

  it('generates DROP ROLE for extra roles', () => {
    const role = makeRole({ rolname: 'obsolete_role' })
    const issues = diffRoles([], [role])
    expect(issues[0].sql?.up).toContain('DROP ROLE IF EXISTS "obsolete_role"')
    expect(issues[0].sql?.down).toContain('CREATE ROLE "obsolete_role"')
  })

  it('generates ALTER ROLE for modified roles', () => {
    const source = makeRole({ rolbypassrls: true })
    const target = makeRole({ rolbypassrls: false })
    const issues = diffRoles([source], [target])
    expect(issues[0].sql?.up).toContain('BYPASSRLS')
    expect(issues[0].sql?.down).not.toContain('BYPASSRLS')
  })

  it('includes VALID UNTIL when set', () => {
    const role = makeRole({ rolvaliduntil: '2025-12-31 00:00:00+00' })
    const issues = diffRoles([role], [])
    expect(issues[0].sql?.up).toContain("VALID UNTIL '2025-12-31 00:00:00+00'")
  })

  it('returns empty when source and target match', () => {
    const role = makeRole()
    expect(diffRoles([role], [role])).toHaveLength(0)
  })

  it('handles multiple roles — reports only differences', () => {
    const roleA = makeRole({ rolname: 'role_a' })
    const roleB = makeRole({ rolname: 'role_b' })
    const roleC = makeRole({ rolname: 'role_c' })
    const issues = diffRoles([roleA, roleB, roleC], [roleA, roleC])
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('roles-missing-role_b')
  })
})

describe('diffGrants', () => {
  it('generates GRANT SQL for missing grants', () => {
    const grant = makeGrant()
    const issues = diffGrants([grant], [])
    expect(issues[0].sql?.up).toBe('GRANT SELECT ON "public"."users" TO "app_readonly";')
    expect(issues[0].sql?.down).toBe('REVOKE SELECT ON "public"."users" FROM "app_readonly";')
  })

  it('generates REVOKE SQL for extra grants', () => {
    const grant = makeGrant({ privilege_type: 'DELETE' })
    const issues = diffGrants([], [grant])
    expect(issues[0].sql?.up).toBe('REVOKE DELETE ON "public"."users" FROM "app_readonly";')
    expect(issues[0].sql?.down).toBe('GRANT DELETE ON "public"."users" TO "app_readonly";')
    expect(issues[0].severity).toBe('warning')
  })

  it('returns empty when grants match', () => {
    const grant = makeGrant()
    expect(diffGrants([grant], [grant])).toHaveLength(0)
  })

  it('handles multiple grants across tables', () => {
    const grants = [
      makeGrant({ privilege_type: 'SELECT' }),
      makeGrant({ table_name: 'posts', privilege_type: 'INSERT' }),
    ]
    const issues = diffGrants(grants, [grants[0]])
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toContain('posts')
    expect(issues[0].sql?.up).toContain('posts')
  })

  it('uses correct severity: warning for missing, and for extra to a role the Data API does not serve', () => {
    const grant = makeGrant()
    const missingIssues = diffGrants([grant], [])
    const extraIssues   = diffGrants([], [grant])
    expect(missingIssues[0].severity).toBe('warning')
    expect(extraIssues[0].severity).toBe('warning')
  })
})

/**
 * Which roles' grants are compared (issue #90).
 *
 * `anon`, `authenticated` and `service_role` were filtered out of the grants
 * query along with the platform's own roles. Those three are what the Data API
 * authenticates as, so `REVOKE ALL ON public.plans FROM anon` — the difference
 * between a table being readable through the anon key and not — reported
 * clean, and the drift score stayed at 100.
 */
describe('RolesCheck: the queries it runs', () => {
  /** Capture both statements the check issues. */
  async function capturedSql(): Promise<{ roles: string; grants: string }> {
    const seen: string[] = []
    const queryFn = (async (_url: string, sql: string) => {
      seen.push(sql)
      return []
    }) as unknown as QueryFn

    await new RolesCheck(queryFn).scan(mockContext())

    return {
      roles: seen.find(s => s.includes('pg_roles')) ?? '',
      grants: seen.find(s => s.includes('c.relacl')) ?? '',
    }
  }

  it('compares grants held by the Data API roles', async () => {
    const { grants } = await capturedSql()

    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(grants, `${role} must not be excluded from the grants query`)
        .not.toContain(`'${role}'`)
    }
  })

  it('still ignores grants held by platform roles', async () => {
    // A difference in these means the two projects run different Supabase
    // versions, not that anybody changed anything.
    const { grants } = await capturedSql()

    for (const role of ['supabase_admin', 'supabase_auth_admin', 'authenticator', 'pgbouncer', 'supabase_realtime_admin', 'supabase_replication_admin']) {
      expect(grants, `${role} should still be excluded`).toContain(`'${role}'`)
    }
    expect(grants).toContain("NOT LIKE 'pg_%'")
  })

  // information_schema.role_table_grants counted an owner's own privileges as
  // grants, and showed only grants the connecting role takes part in.
  it('reads table grants from the catalog, leaving out the owner', async () => {
    const { grants } = await capturedSql()

    expect(grants).not.toContain('role_table_grants')
    expect(grants).toContain('aclexplode(c.relacl)')
    expect(grants).toMatch(/a\.grantee\s*<>\s*c\.relowner/)
  })

  it('leaves out the role it is connected as', async () => {
    // Each environment's credential, not the project's: reported as drift, its
    // fix was DROP ROLE on the role the apply itself was running as.
    const { roles } = await capturedSql()

    expect(roles).toMatch(/rolname\s*<>\s*current_user/)
  })

  it('still ignores the Data API roles when comparing role attributes', async () => {
    // Nobody usefully diffs whether `anon` can log in — that is Supabase's to
    // set. It is only their table grants that belong to the application.
    const { roles } = await capturedSql()

    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(roles, `${role} should still be excluded from the attributes query`)
        .toContain(`'${role}'`)
    }
  })
})

// A Supabase target grants the Data API roles every table its owner creates,
// so the grants on a table the schema fix creates need no fix of their own.
describe('grantedByDefault', () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    grantee: 'anon', table_schema: 'public', table_name: 'items', privilege_type: 'SELECT', is_grantable: false, ...over,
  })
  const defaults = [{ table_schema: 'public', grantee: 'anon', privilege_type: 'SELECT', is_grantable: false }]

  it('covers a grant on a table the target lacks, that its defaults make', () => {
    expect(grantedByDefault([], defaults)(grant())).toBe(true)
  })

  it('covers it from defaults for every schema too', () => {
    expect(grantedByDefault([], [{ ...defaults[0], table_schema: null }])(grant({ table_schema: 'app' }))).toBe(true)
  })

  it('does not cover a table the target has: its grants are what they are', () => {
    expect(grantedByDefault([{ table_schema: 'public', table_name: 'items' }], defaults)(grant())).toBe(false)
  })

  it('does not cover what the defaults do not grant', () => {
    const covers = grantedByDefault([], defaults)
    expect(covers(grant({ privilege_type: 'INSERT' }))).toBe(false)
    expect(covers(grant({ grantee: 'authenticated' }))).toBe(false)
    expect(covers(grant({ table_schema: 'app' }))).toBe(false)
    expect(covers(grant({ is_grantable: true }))).toBe(false)
    expect(covers(grant({ column_name: 'name' }))).toBe(false)
  })
})

describe('grants across server versions and in groups', () => {
  const g = (privilege_type: string, extra: Record<string, unknown> = {}) => ({
    grantee: 'anon', table_schema: 'public', table_name: 'items', column_name: null,
    privilege_type, is_grantable: false, ...extra,
  }) as never

  // PostgreSQL 17's MAINTAIN, offered to a 15 target, failed every grant with it.
  it('leaves MAINTAIN out unless both servers are PostgreSQL 17 or later', () => {
    expect(comparablePrivileges(170000, 150008)(g('MAINTAIN'))).toBe(false)
    expect(comparablePrivileges(150008, 170000)(g('MAINTAIN'))).toBe(false)
    expect(comparablePrivileges(170000, 180000)(g('MAINTAIN'))).toBe(true)
    expect(comparablePrivileges(170000, 150008)(g('SELECT'))).toBe(true)
  })

  it('reports the privileges one role lacks on one table as one finding', () => {
    const issues = diffGrants([g('SELECT'), g('INSERT'), g('UPDATE')], [g('SELECT')])
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Missing grants: INSERT, UPDATE ON public.items TO anon')
    expect(issues[0].sql?.up).toBe('GRANT INSERT, UPDATE ON "public"."items" TO "anon";')
    expect(issues[0].sql?.down).toBe('REVOKE INSERT, UPDATE ON "public"."items" FROM "anon";')
  })

  it('keeps a grant held with the grant option apart from one without', () => {
    const issues = diffGrants([g('SELECT', { is_grantable: true }), g('INSERT')], [])
    expect(issues.map(i => i.sql?.up).sort()).toEqual([
      'GRANT INSERT ON "public"."items" TO "anon";',
      'GRANT SELECT ON "public"."items" TO "anon" WITH GRANT OPTION;',
    ])
  })

  it('groups a column\'s privileges with the column on each', () => {
    const issues = diffGrants([g('SELECT', { column_name: 'name' }), g('UPDATE', { column_name: 'name' })], [])
    expect(issues[0].sql?.up).toBe('GRANT SELECT ("name"), UPDATE ("name") ON "public"."items" TO "anon";')
  })
})


// A table the source keeps away from the Data API, created on a Supabase
// target by the schema fix, got everything the target's default privileges
// grant: one sync left it readable and writable with the anon key.
describe('a new table keeps the source\'s grants, not the target\'s defaults', () => {
  const ALL = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']
  const grant = (grantee: string, table: string, privilege_type: string) =>
    ({ grantee, table_schema: 'public', table_name: table, privilege_type, is_grantable: false })

  function target(sql: string, dbUrl: string): unknown[] {
    const source = dbUrl.includes('source')
    if (sql.includes('pg_default_acl')) {
      return source ? [] : ['anon', 'authenticated'].flatMap(grantee =>
        ALL.map(privilege_type => ({ table_schema: 'public', grantee, privilege_type, is_grantable: false })))
    }
    if (sql.includes('attacl') || sql.includes('rolsuper') || sql.includes('pg_proc') || sql.includes("'schema' AS object_kind")) return []
    if (sql.includes('server_version_num')) return [{ v: '150008' }]
    if (sql.includes('relacl')) {
      return source ? [
        ...['SELECT', 'REFERENCES', 'TRIGGER'].map(p => grant('anon', 'ro_items', p)),
        ...ALL.map(p => grant('authenticated', 'ro_items', p)),
        ...ALL.map(p => grant('service_role', 'private_notes', p)),
      ] : []
    }
    // The relations each side has.
    return source
      ? ['private_notes', 'ro_items', 'shared'].map(table_name => ({ table_schema: 'public', table_name }))
      : [{ table_schema: 'public', table_name: 'shared' }]
  }

  async function issues() {
    const check = new RolesCheck((async (dbUrl: string, sql: string) => target(sql, dbUrl)) as unknown as QueryFn)
    return (await check.scan(mockContext())).filter(i => i.id.startsWith('roles-grant-default-'))
  }

  it('revokes what the defaults would give a server-only table', async () => {
    const found = await issues()
    const notes = found.filter(i => i.id.endsWith('public.private_notes'))
    expect(notes.map(i => i.sql?.up).sort()).toEqual([
      'REVOKE DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON "public"."private_notes" FROM "anon";',
      'REVOKE DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON "public"."private_notes" FROM "authenticated";',
    ])
    expect(notes.every(i => i.severity === 'critical')).toBe(true)
  })

  it('revokes only what the source took away from a read-only table', async () => {
    const ro = (await issues()).filter(i => i.id.endsWith('public.ro_items'))
    expect(ro.map(i => i.sql?.up)).toEqual(['REVOKE DELETE, INSERT, TRUNCATE, UPDATE ON "public"."ro_items" FROM "anon";'])
    expect(ro[0].title).toBe('Default grants to take back: DELETE, INSERT, TRUNCATE, UPDATE ON public.ro_items TO anon')
  })

  it('says nothing about a table the target already has', async () => {
    expect((await issues()).some(i => i.id.endsWith('public.shared'))).toBe(false)
  })
})

describe('an extra grant to a Data API role is not a footnote', () => {
  const g = (grantee: string) => ({ grantee, table_schema: 'public', table_name: 'notes', privilege_type: 'SELECT', is_grantable: false })

  it('is critical for anon, authenticated and PUBLIC, a warning for any other role', () => {
    for (const grantee of ['anon', 'authenticated', 'PUBLIC']) {
      expect(diffGrants([], [g(grantee)])[0].severity, grantee).toBe('critical')
    }
    expect(diffGrants([], [g('app_readonly')])[0].severity).toBe('warning')
  })
})

describe('function and sequence grants', () => {
  // Never compared: a SECURITY DEFINER function the source kept from the Data
  // API arrived on the target callable with the anon key, and an existing
  // function's grants could differ without a word.
  const fn = (grantee: string, privilege_type = 'EXECUTE') => ({
    grantee, table_schema: 'public', table_name: 'admin_reset', args: 'p integer',
    object_kind: 'function' as const, privilege_type, is_grantable: false,
  })
  const seq = (grantee: string, privilege_type: string) => ({
    grantee, table_schema: 'public', table_name: 'private_seq', object_kind: 'sequence' as const, privilege_type, is_grantable: false,
  })

  it('reports a function the target opens to anon as critical, revoked with ON FUNCTION and its arguments', () => {
    const [issue] = diffGrants([], [fn('anon')])
    expect(issue.severity).toBe('critical')
    expect(issue.title).toBe('Extra grant: EXECUTE ON function public.admin_reset(p integer) TO anon')
    expect(issue.sql?.up).toBe('REVOKE EXECUTE ON FUNCTION "public"."admin_reset"(p integer) FROM "anon";')
  })

  it('tells overloads apart', () => {
    const one = fn('anon')
    const other = { ...fn('anon'), args: 'p text' }
    expect(diffGrants([one], [one, other]).map(i => i.sql?.up))
      .toEqual(['REVOKE EXECUTE ON FUNCTION "public"."admin_reset"(p text) FROM "anon";'])
  })

  it('writes sequence grants with ON SEQUENCE', () => {
    const [issue] = diffGrants([], [seq('anon', 'USAGE')])
    expect(issue.sql?.up).toBe('REVOKE USAGE ON SEQUENCE "public"."private_seq" FROM "anon";')
  })

  it('takes back what a new function gets by default — PUBLIC included — when the source grants none of it', () => {
    const defaults = [
      { object_kind: 'function' as const, table_schema: null, grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false },
      { object_kind: 'function' as const, table_schema: 'public', grantee: 'anon', privilege_type: 'EXECUTE', is_grantable: false },
      { object_kind: 'table' as const, table_schema: 'public', grantee: 'anon', privilege_type: 'SELECT', is_grantable: false },
    ]
    const routine = { table_schema: 'public', table_name: 'admin_reset', args: 'p integer', object_kind: 'function' as const }
    const issues = defaultGrantsToRevoke([routine], [], defaults, [])
    expect(issues.map(i => i.sql?.up).sort()).toEqual([
      'REVOKE EXECUTE ON FUNCTION "public"."admin_reset"(p integer) FROM "anon";',
      'REVOKE EXECUTE ON FUNCTION "public"."admin_reset"(p integer) FROM PUBLIC;',
    ])
    expect(issues.every(i => i.severity === 'critical')).toBe(true)
    // What the source does grant is left alone.
    expect(defaultGrantsToRevoke([routine], [], defaults, [fn('anon')]).map(i => i.sql?.up))
      .toEqual(['REVOKE EXECUTE ON FUNCTION "public"."admin_reset"(p integer) FROM PUBLIC;'])
  })

  it('does not report a function grant the target will make by default as missing', () => {
    const covers = grantedByDefault([], [{ object_kind: 'function', table_schema: null, grantee: 'PUBLIC', privilege_type: 'EXECUTE', is_grantable: false }])
    expect(covers(fn('PUBLIC'))).toBe(true)
    expect(covers({ ...fn('PUBLIC'), object_kind: 'sequence' as never })).toBe(false)
  })
})

describe('grants on a routine only the target has', () => {
  it('are not reported: the routine itself is the finding', async () => {
    const queryFn = (async (dbUrl: string, sql: string) => {
      if (dbUrl.includes('target') && sql.includes('proacl')) {
        return [{ grantee: 'PUBLIC', table_schema: 'public', table_name: 'example_fn', args: 'a uuid', object_kind: 'function', privilege_type: 'EXECUTE', is_grantable: false }]
      }
      if (dbUrl.includes('target') && sql.includes('pg_get_function_identity_arguments') && !sql.includes('proacl')) {
        return [{ table_schema: 'public', table_name: 'example_fn', args: 'a uuid', object_kind: 'function' }]
      }
      if (sql.includes('server_version_num')) return [{ v: '150008' }]
      return []
    }) as unknown as QueryFn
    const issues = await new RolesCheck(queryFn).scan(mockContext())
    expect(issues).toEqual([])
  })
})

// USAGE on a schema of its own is what lets a role reach the tables in it at
// all; it was not compared, so a target without it read as matching.
describe('RolesCheck: grants on schemas', () => {
  const schemaGrant = (overrides: Record<string, unknown> = {}) =>
    makeGrant({ table_schema: 'app', table_name: '', privilege_type: 'USAGE', object_kind: 'schema', ...overrides })
  const scanWith = (source: unknown[], target: unknown[], schemas = ['app']) => new RolesCheck(async (dbUrl, sql) => {
    if (sql.includes('pg_roles')) return [makeRole()]
    if (sql.includes('n.nspacl')) return (dbUrl.includes('source') ? source : target) as never
    if (sql.includes("'schema' AS object_kind") && dbUrl.includes('source')) {
      return schemas.map(table_schema => ({ table_schema, table_name: '', object_kind: 'schema' })) as never
    }
    return []
  }).scan(mockContext())

  it('reports a schema grant the target lacks, with the GRANT that makes it', async () => {
    const issues = await scanWith([schemaGrant()], [])
    const missing = issues.find(i => i.id.startsWith('roles-grant-missing'))
    expect(missing?.title).toContain('USAGE ON schema app TO app_readonly')
    expect(missing?.sql?.up).toBe('GRANT USAGE ON SCHEMA "app" TO "app_readonly";')
    expect(missing?.sql?.down).toBe('REVOKE USAGE ON SCHEMA "app" FROM "app_readonly";')
  })

  it('reports one only the target has, and revokes it', async () => {
    const issues = await scanWith([], [schemaGrant({ privilege_type: 'CREATE' })])
    const extra = issues.find(i => i.id.startsWith('roles-grant-extra'))
    expect(extra?.sql?.up).toBe('REVOKE CREATE ON SCHEMA "app" FROM "app_readonly";')
  })

  it('leaves the grants on a schema only the target has to the schema check', async () => {
    expect(await scanWith([], [schemaGrant({ table_schema: 'old' })])).toEqual([])
  })

  it('reports nothing when both match', async () => {
    expect(await scanWith([schemaGrant()], [schemaGrant()])).toEqual([])
  })
})

describe('comparablePrivileges: CREATE on public across PostgreSQL 15', () => {
  const g = { grantee: 'PUBLIC', table_schema: 'public', table_name: '', privilege_type: 'CREATE', is_grantable: false, object_kind: 'schema' as const }

  it('leaves out the default that changed, in either direction', () => {
    expect(comparablePrivileges(140010, 170000)(g)).toBe(false)
    expect(comparablePrivileges(170000, 140010)(g)).toBe(false)
  })

  it('still compares it between servers on the same side of the change', () => {
    expect(comparablePrivileges(140010, 140012)(g)).toBe(true)
    expect(comparablePrivileges(150008, 180000)(g)).toBe(true)
    expect(comparablePrivileges(140010, 170000)({ ...g, table_schema: 'app' })).toBe(true)
  })
})
