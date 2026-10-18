import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  previewSnapshotRestore,
  summarizeStatement,
  createRoleIfMissing,
  conditionalPublicationMembership,
} from '../src/restore.js'
import { rolesNamedBy } from '../src/sql-deps.js'

/**
 * Which of a snapshot's twelve layers a restore actually replays.
 *
 * `realtime` and `roles` were captured as replayable SQL and then never
 * replayed: both layers were added to `snapshot` without being added to the
 * restore's layer order, so a restore silently dropped every publication
 * membership and every table grant the snapshot held, while reporting success.
 *
 * `vault` is deliberately not replayed — its file holds secret *names* as
 * comments, because a value cannot be read out of Vault and inventing one is
 * worse than leaving it absent (issue #91).
 */
describe('previewSnapshotRestore: layer coverage', () => {
  let dir: string

  /** A snapshot directory holding one file per replayable layer. */
  const files: Record<string, string> = {
    'extensions.sql': 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";\n',
    'schema.sql': 'CREATE TABLE public.orders (id bigint);\n',
    'rls.sql': 'CREATE POLICY "p" ON "public"."orders" FOR SELECT USING (true);\n',
    'cron.sql': `SELECT cron.schedule('nightly', '0 3 * * *', $$SELECT 1$$);\n`,
    'webhooks.sql': 'CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f();\n',
    'storage-policies.sql': 'CREATE POLICY "s" ON "storage"."objects" FOR SELECT USING (true);\n',
    'realtime.sql': 'ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."orders";\n',
    'roles.sql': 'GRANT SELECT ON "public"."orders" TO "anon";\n',
    'vault.sql': '-- SupaForge Vault Snapshot\n-- 1 secret(s), names only:\n--   smtp_password\n',
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'supaforge-restore-'))

    const captured = { captured: true, itemCount: 1 }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({
      layers: {
        extensions: captured,
        schema: { ...captured, file: 'schema.json' },
        rls: captured,
        cron: captured,
        webhooks: captured,
        storage: captured,
        realtime: captured,
        roles: captured,
        vault: captured,
        auth: captured,
        'edge-functions': captured,
        data: captured,
      },
    }))

    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content)
    }
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('replays the realtime layer', async () => {
    const preview = await previewSnapshotRestore(dir)

    expect(preview.map(p => p.layer)).toContain('realtime')
  })

  it('replays the roles layer', async () => {
    const preview = await previewSnapshotRestore(dir)

    expect(preview.map(p => p.layer)).toContain('roles')
  })

  it('does not replay the vault layer', async () => {
    // Comments only, so there is nothing to run — and nothing that could
    // create a secret with an invented value.
    const preview = await previewSnapshotRestore(dir)

    expect(preview.map(p => p.layer)).not.toContain('vault')
  })

  it('creates tables before the publication and grants that name them', async () => {
    // A publication can only add a table that exists, and a grant can only
    // name one.
    const order = (await previewSnapshotRestore(dir)).map(p => p.layer)

    expect(order.indexOf('schema')).toBeLessThan(order.indexOf('realtime'))
    expect(order.indexOf('schema')).toBeLessThan(order.indexOf('roles'))
  })

  it('still installs extensions first', async () => {
    const order = (await previewSnapshotRestore(dir)).map(p => p.layer)

    expect(order[0]).toBe('extensions')
  })

  it('carries the statement from each new layer, not just the layer name', async () => {
    const preview = await previewSnapshotRestore(dir)
    const byLayer = new Map(preview.map(p => [p.layer, p.statements.join('\n')]))

    expect(byLayer.get('realtime')).toContain('ALTER PUBLICATION')
    expect(byLayer.get('roles')).toContain('GRANT SELECT')
  })

  it('summarises every layer as SQL, not as the file header', async () => {
    // Each layer file opens with a `-- SupaForge … Snapshot` header, and it
    // lands in the same chunk as the first statement. The preview printed the
    // statement's first *line*, so every layer's first entry read
    // `-- SupaForge Role Grants Snapshot` instead of the GRANT — a preview you
    // cannot read, which is the one thing a preview must not be.
    const preview = await previewSnapshotRestore(dir)

    for (const { layer, statements } of preview) {
      const summary = summarizeStatement(statements[0])
      expect(summary.startsWith('--'), `${layer}: ${summary}`).toBe(false)
      expect(summary.length, layer).toBeGreaterThan(0)
    }
  })

  it('skips a layer the snapshot did not capture', async () => {
    // A snapshot written before these layers existed has no file and no
    // manifest entry for them; that must not become an error.
    const older = await mkdtemp(join(tmpdir(), 'supaforge-restore-old-'))
    try {
      await writeFile(join(older, 'manifest.json'), JSON.stringify({
        layers: { schema: { captured: true, itemCount: 1 } },
      }))
      await writeFile(join(older, 'schema.sql'), files['schema.sql'])

      const preview = await previewSnapshotRestore(older)

      expect(preview.map(p => p.layer)).toEqual(['schema'])
    } finally {
      await rm(older, { recursive: true, force: true })
    }
  })
})

/**
 * Why replaying those two layers needed guarding first.
 *
 * A restore runs in one transaction, so a single failing statement rolls the
 * whole thing back. Both of these fail on an ordinary restore target, which is
 * why simply adding the layers to the order would have been a worse bug than
 * the gap it closed. Both reproduced against a live PostgreSQL 16 before being
 * written: `role "anon" does not exist`, and `relation "orders" is already
 * member of publication`.
 */
describe('rolesNamedBy', () => {
  it('names the roles default privileges are for and grant to, not those they revoke from', () => {
    expect(rolesNamedBy('ALTER DEFAULT PRIVILEGES FOR ROLE "owner" IN SCHEMA app GRANT SELECT ON TABLES TO reader, PUBLIC;'))
      .toEqual(['owner', 'reader'])
    expect(rolesNamedBy('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM gone;')).toEqual([])
  })

  it('names the role a grant needs', () => {
    expect(rolesNamedBy('GRANT SELECT ON "public"."orders" TO "anon";')).toEqual(['anon'])
  })

  it('reads an unquoted grantee, folded as PostgreSQL folds it', () => {
    expect(rolesNamedBy('GRANT ALL ON public.orders TO service_role;')).toEqual(['service_role'])
    expect(rolesNamedBy('GRANT ALL ON public.orders TO Service_Role;')).toEqual(['service_role'])
  })

  it('reads every grantee, and stops before the grant options', () => {
    expect(rolesNamedBy('GRANT SELECT ON t TO "anon", authenticated WITH GRANT OPTION;'))
      .toEqual(['anon', 'authenticated'])
  })

  it('does not try to create PUBLIC or the current user', () => {
    // Not roles: keywords. `CREATE ROLE public` is an error.
    expect(rolesNamedBy('GRANT SELECT ON public.orders TO PUBLIC;')).toEqual([])
    expect(rolesNamedBy('GRANT SELECT ON public.orders TO CURRENT_USER;')).toEqual([])
  })

  it('does not try to create a built-in role', () => {
    // A `pg_` role either exists already or cannot be created.
    expect(rolesNamedBy('GRANT pg_read_all_data TO app;')).toEqual(['app'])
    expect(rolesNamedBy('GRANT SELECT ON public.orders TO pg_monitor;')).toEqual([])
  })

  it('is empty for anything that names no roles', () => {
    expect(rolesNamedBy('CREATE TABLE public.t (id int);')).toEqual([])
    expect(rolesNamedBy('REVOKE SELECT ON public.orders FROM anon;')).toEqual([])
    expect(rolesNamedBy('CREATE POLICY p ON t USING (true);')).toEqual([])
  })

  it('does not read a role name out of a function body', () => {
    // Read off the skeleton, so a literal mentioning a role is not a grantee.
    expect(rolesNamedBy(
      `CREATE FUNCTION f() RETURNS text AS $$ SELECT 'GRANT SELECT ON t TO nobody' $$ LANGUAGE sql;`,
    )).toEqual([])
  })

  // The schema dump and the RLS layer both replay policies long before the
  // roles layer: a policy for service_role restored into plain PostgreSQL
  // failed on the missing role and rolled the whole restore back.
  it('names every role a policy is for', () => {
    expect(rolesNamedBy(
      'CREATE POLICY auth_read ON public.notes FOR SELECT TO authenticated, service_role USING (id > 0);',
    )).toEqual(['authenticated', 'service_role'])
    expect(rolesNamedBy(
      'CREATE POLICY "p" ON "public"."t" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);',
    )).toEqual(['service_role'])
    expect(rolesNamedBy('ALTER POLICY p ON t TO anon;')).toEqual(['anon'])
  })

  it('reads a quoted role exactly, and not one out of a policy expression', () => {
    expect(rolesNamedBy(
      `CREATE POLICY p ON t FOR SELECT TO "We""ird" USING (x = 'TO bob');`,
    )).toEqual(['We"ird'])
  })

  // Read from the parse tree. Matched as text, the TO inside a quoted policy
  // name was taken for the role list, and restore tried to create a role
  // named after the rest of the policy's name.
  it('is not misled by a policy name that says TO', () => {
    expect(rolesNamedBy(
      'CREATE POLICY "Allow read to everyone" ON public.t FOR SELECT TO anon USING (true);',
    )).toEqual(['anon'])
    expect(rolesNamedBy('CREATE POLICY "Grant to admins" ON public.t USING (true);')).toEqual([])
    expect(rolesNamedBy('ALTER POLICY "up to you" ON public.t TO authenticated;')).toEqual(['authenticated'])
  })

  it('does not take a policy being renamed for a role', () => {
    expect(rolesNamedBy('ALTER POLICY p ON t RENAME TO q;')).toEqual([])
  })
})

describe('createRoleIfMissing', () => {
  it('guards on the role not already existing', () => {
    const sql = createRoleIfMissing('anon')

    expect(sql).toContain('pg_roles')
    expect(sql).toContain("rolname = 'anon'")
  })

  it('creates a role that cannot log in', () => {
    // A restore quietly creating a login role would be a worse outcome than a
    // failed grant.
    expect(createRoleIfMissing('anon')).toContain('NOLOGIN')
  })

  it('quotes a role name that needs it', () => {
    expect(createRoleIfMissing('needs quoting')).toContain('"needs quoting"')
  })

  it("escapes a role name containing an apostrophe", () => {
    expect(createRoleIfMissing("o'brien")).toContain("'o''brien'")
  })
})

describe('conditionalPublicationMembership', () => {
  it('guards an ADD TABLE on the table not already being a member', () => {
    const sql = conditionalPublicationMembership(
      'ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."orders";',
    )

    expect(sql).toContain('pg_publication_tables')
    expect(sql).toContain("pubname = 'supabase_realtime'")
    expect(sql).toContain("schemaname = 'public'")
    expect(sql).toContain("tablename = 'orders'")
  })

  it('still adds the table', () => {
    expect(conditionalPublicationMembership(
      'ALTER PUBLICATION "supabase_realtime" ADD TABLE "public"."orders";',
    )).toContain('ALTER PUBLICATION')
  })

  it('handles an unquoted, ONLY-qualified table', () => {
    const sql = conditionalPublicationMembership(
      'ALTER PUBLICATION pub ADD TABLE ONLY public.orders;',
    )

    expect(sql).toContain("tablename = 'orders'")
  })

  it('leaves anything else untouched', () => {
    for (const sql of [
      'CREATE PUBLICATION pub;',
      'ALTER PUBLICATION pub DROP TABLE public.orders;',
      'ALTER PUBLICATION pub SET (publish = \'insert\');',
      'GRANT SELECT ON public.orders TO anon;',
    ]) {
      expect(conditionalPublicationMembership(sql), sql).toBe(sql)
    }
  })

  it('leaves an unqualified table name untouched rather than guessing', () => {
    // The guard needs a schema to compare against pg_publication_tables; a
    // wrong guess would silently skip a table that is not in fact a member.
    const sql = 'ALTER PUBLICATION pub ADD TABLE orders;'
    expect(conditionalPublicationMembership(sql)).toBe(sql)
  })
})
