import { describe, it, expect } from 'vitest'
import { statementSubject } from '../src/sql-deps.js'
import { platformOwnedObject, tolerableFailure, createdObjects } from '../src/restore.js'
import { replaceableSchemas } from '../src/restore-replace.js'
import { destructiveReason } from '../src/dbdiff.js'
import { isEnumValueAddition } from '../src/promote.js'
import { diffGrants } from '../src/checks/roles.js'

const grant = (o: Record<string, unknown> = {}) => ({
  grantee: 'authenticated', table_schema: 'public', table_name: 'profiles',
  privilege_type: 'UPDATE', is_grantable: false, ...o,
})

describe('statementSubject: what a statement acts on, not what it mentions', () => {
  it('a webhook trigger belongs to its table', () => {
    expect(statementSubject(`CREATE TRIGGER "w" AFTER INSERT ON "public"."orders" FOR EACH ROW
      EXECUTE FUNCTION "supabase_functions"."http_request"('https://x', 'POST', '{}', '{}', '1000');`))
      .toEqual({ schema: 'public', name: 'orders' })
  })
  it('a view is its own subject, whatever it reads', () => {
    expect(statementSubject('CREATE VIEW public.job_health AS SELECT * FROM cron.job_run_details;'))
      .toEqual({ schema: 'public', name: 'job_health' })
  })
  it('schema-level statements name the schema', () => {
    expect(statementSubject('CREATE SCHEMA pgbouncer;')).toEqual({ schema: 'pgbouncer', name: 'pgbouncer' })
    expect(statementSubject('GRANT USAGE ON SCHEMA cron TO postgres;')).toEqual({ schema: 'cron', name: 'cron' })
  })
  it('a grant and a column comment name their table', () => {
    expect(statementSubject('GRANT SELECT ON "storage"."objects" TO "anon";')).toEqual({ schema: 'storage', name: 'objects' })
    expect(statementSubject(`COMMENT ON COLUMN public.t.c IS 'x';`)).toEqual({ schema: 'public', name: 't' })
  })
})

describe('platformOwnedObject by subject', () => {
  it('keeps Database Webhooks and views that read platform schemas', () => {
    expect(platformOwnedObject('CREATE TRIGGER w AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request();')).toBeUndefined()
    expect(platformOwnedObject('CREATE VIEW public.keys AS SELECT name FROM vault.decrypted_secrets;')).toBeUndefined()
  })
  it('still skips what the platform owns', () => {
    expect(platformOwnedObject('CREATE FUNCTION pgbouncer.get_auth(p text) RETURNS text AS $$ $$;')).toBe('pgbouncer')
  })
})

describe('tolerableFailure', () => {
  const plain = new Set(['public', 'pg_catalog', 'information_schema'])
  const supabase = new Set([...plain, 'auth', 'storage', 'graphql', 'extensions'])
  const missing = (what: string) => ({ code: '3F000', message: `schema "${what}" does not exist` })

  it('skips an attachment that needs a Supabase schema the target lacks', () => {
    expect(tolerableFailure('GRANT SELECT ON "storage"."objects" TO "anon";', missing('storage'), plain)).toMatch(/storage/)
    expect(tolerableFailure('CREATE POLICY p ON public.t USING (auth.uid() = owner);',
      { code: '3F000', message: 'schema "auth" does not exist' }, plain)).toMatch(/auth/)
    expect(tolerableFailure('ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id);',
      missing('auth'), plain)).toMatch(/auth/)
    expect(tolerableFailure('CREATE TRIGGER w AFTER INSERT ON public.o FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request();',
      missing('supabase_functions'), plain)).toMatch(/supabase_functions/)
  })

  it('skips an extension the server does not ship', () => {
    expect(tolerableFailure('CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";',
      { code: '0A000', message: 'extension "pg_graphql" is not available' }, plain)).toMatch(/extension/)
  })

  it('never skips on a target that has the schema — a Supabase target', () => {
    // Something genuinely missing there is a real problem, not a plain-PG artefact.
    expect(tolerableFailure('CREATE POLICY p ON storage.objects USING (storage.my_helper());',
      { code: '42883', message: 'function storage.my_helper() does not exist' }, supabase)).toBeUndefined()
  })

  it('skips a routine whose signature needs a Supabase schema the target lacks', () => {
    expect(tolerableFailure('CREATE FUNCTION public.me() RETURNS SETOF auth.users LANGUAGE sql AS $$ SELECT * FROM auth.users $$;',
      missing('auth'), plain)).toMatch(/depends on auth/)
  })

  // A snapshot of PostgreSQL 17 restored into an older server.
  it('skips a MAINTAIN grant on a server without the privilege', () => {
    expect(tolerableFailure('GRANT MAINTAIN ON TABLE public.t TO app;',
      { code: '22023', message: 'unrecognized privilege type "maintain"' }, plain)).toMatch(/PostgreSQL 17/)
    expect(tolerableFailure('GRANT SELECT ON TABLE public.t TO app;',
      { code: '22023', message: 'unrecognized privilege type "maintain"' }, plain)).toBeUndefined()
  })

  // One missing extension rolled back the whole restore: the table typed by
  // it failed, then everything after that needed the table.
  it('skips what fails once the target has turned out to lack something', () => {
    const lacks = new Set(['the vector extension'])
    const noType = { code: '42704', message: 'type "public.vector" does not exist' }
    expect(tolerableFailure('CREATE TABLE public.docs (id int, e public.vector(3));', noType, plain, lacks))
      .toBe('type "public.vector" does not exist, as this target lacks the vector extension')
    expect(tolerableFailure('CREATE TABLE public.docs (id int, e public.vector(3));', noType, plain)).toBeUndefined()
  })

  it('never skips a table, whatever it references', () => {
    expect(tolerableFailure('CREATE TABLE public.t (id uuid DEFAULT auth.uid());', missing('auth'), plain)).toBeUndefined()
  })

  it('never skips anything else', () => {
    expect(tolerableFailure('CREATE TABLE public.t (id int);', { code: '42P07', message: 'exists' }, plain)).toBeUndefined()
    expect(tolerableFailure('CREATE VIEW public.v AS SELECT * FROM public.missing;', { code: '42P01', message: 'x' }, plain)).toBeUndefined()
    expect(tolerableFailure('GRANT SELECT ON storage.objects TO anon;', { code: '42501', message: 'denied' }, plain)).toBeUndefined()
    expect(tolerableFailure('CREATE EXTENSION foo;', { code: '42501', message: 'denied' }, plain)).toBeUndefined()
  })
})

describe('replaceableSchemas', () => {
  it('never clears a platform schema', () => {
    expect(replaceableSchemas(['graphql', 'pgbouncer', 'public', 'reporting', 'auth', 'pg_temp']))
      .toEqual(['public', 'reporting'])
  })
})

describe('destructiveReason: TRUNCATE only as a statement', () => {
  it('does not gate a TRUNCATE privilege or trigger event', () => {
    expect(destructiveReason('GRANT TRUNCATE ON "public"."plans" TO "anon";')).toBeUndefined()
    expect(destructiveReason('REVOKE TRUNCATE ON "public"."plans" FROM "anon";')).toBeUndefined()
    expect(destructiveReason('CREATE TRIGGER a BEFORE TRUNCATE ON public.plans FOR EACH STATEMENT EXECUTE FUNCTION f();')).toBeUndefined()
  })
  it('still gates TRUNCATE itself', () => {
    expect(destructiveReason('TRUNCATE public.plans;')).toBeDefined()
    expect(destructiveReason('SELECT 1; TRUNCATE public.plans;')).toBeDefined()
  })
})

describe('destructiveReason: dropping a role', () => {
  it('holds back DROP ROLE, DROP USER and DROP GROUP', () => {
    expect(destructiveReason('DROP ROLE IF EXISTS "reporting";')).toMatch(/drops a role/)
    expect(destructiveReason('DROP USER app_login;')).toMatch(/drops a role/)
    expect(destructiveReason('DROP GROUP readers;')).toMatch(/drops a role/)
  })

  it('does not take a role being created or altered for one being dropped', () => {
    expect(destructiveReason('CREATE ROLE "reporting" NOLOGIN;')).toBeUndefined()
    expect(destructiveReason('ALTER ROLE "reporting" NOLOGIN;')).toBeUndefined()
    expect(destructiveReason('REVOKE "reporting" FROM app;')).toBeUndefined()
  })
})

describe('isEnumValueAddition', () => {
  it('recognises label additions only', () => {
    expect(isEnumValueAddition(`ALTER TYPE "st" ADD VALUE IF NOT EXISTS 'paid' AFTER 'new';`)).toBe(true)
    expect(isEnumValueAddition(`ALTER TYPE "st" ADD VALUE 'a';\nALTER TABLE t ADD COLUMN c int;`)).toBe(false)
    expect(isEnumValueAddition('ALTER TYPE "st" RENAME TO s2;')).toBe(false)
  })
})

describe('diffGrants', () => {
  it('writes PUBLIC as the keyword, not a quoted role', () => {
    expect(diffGrants([grant({ grantee: 'PUBLIC', privilege_type: 'SELECT' })], [])[0].sql!.up)
      .toBe('GRANT SELECT ON "public"."profiles" TO PUBLIC;')
  })
  it('reports a grant option held on one side only', () => {
    const [issue] = diffGrants([grant({ is_grantable: true })], [grant()])
    expect(issue.id).toMatch(/^roles-grant-option-/)
    expect(issue.sql!.up).toContain('WITH GRANT OPTION')
  })
  it('keys and renders a column-level grant', () => {
    const [issue] = diffGrants([grant({ column_name: 'display_name' })], [])
    expect(issue.sql!.up).toBe('GRANT UPDATE ("display_name") ON "public"."profiles" TO "authenticated";')
    expect(diffGrants([grant({ column_name: 'a' })], [grant({ column_name: 'b' })])).toHaveLength(2)
  })
  it('makes the grants to a role the target lacks one finding, carrying every grant', () => {
    const fns = ['a', 'b', 'c'].map(name => grant({
      grantee: 'anon', privilege_type: 'EXECUTE', object_kind: 'function', table_name: name, args: 'integer',
    }))
    const issues = diffGrants([...fns, grant({ grantee: 'authenticated', privilege_type: 'SELECT' })], [], new Set(['anon']))
    const anon = issues.filter(i => i.title.includes(' to anon'))
    expect(anon).toHaveLength(1)
    expect(anon[0].id).toBe('roles-grant-missing-role-anon')
    expect(anon[0].title).toBe('Missing grants: 3 privileges on 3 objects to anon, a role the target does not have')
    expect(anon[0].sql!.up.split('\n')).toEqual([
      'GRANT EXECUTE ON FUNCTION "public"."a"(integer) TO "anon";',
      'GRANT EXECUTE ON FUNCTION "public"."b"(integer) TO "anon";',
      'GRANT EXECUTE ON FUNCTION "public"."c"(integer) TO "anon";',
    ])
    expect(anon[0].sql!.down.split('\n')[0]).toBe('REVOKE EXECUTE ON FUNCTION "public"."c"(integer) FROM "anon";')
    // A role the target has is still reported grant by grant.
    expect(issues.filter(i => i.title.includes('authenticated'))).toHaveLength(1)
  })
})

/**
 * Read from PostgreSQL's parse tree (sql-ast.ts), not the text. The text
 * version took a column added to *another* table as the dropped one coming
 * back, and let a drop that loses data through without --allow-destructive.
 */
describe('destructiveReason: from the parse tree', () => {
  it('does not take a column added to another table as the dropped one re-added', () => {
    expect(destructiveReason('ALTER TABLE a DROP COLUMN x; ALTER TABLE b ADD COLUMN x int;')).toMatch(/drops a column/)
  })

  it('still lets a column dropped and re-added on the same table through', () => {
    expect(destructiveReason('ALTER TABLE a DROP COLUMN x; ALTER TABLE a ADD COLUMN x int GENERATED ALWAYS AS (1) STORED;')).toBeUndefined()
  })

  it('reads a policy dropped from a schema-qualified table', () => {
    expect(destructiveReason('DROP POLICY "Owner only" ON "app"."docs";')).toMatch(/removes the policy app\.docs\.owner only/)
  })

  it('falls back to the text for SQL the parser does not accept', () => {
    expect(destructiveReason('DROP TABLE x; THIS IS NOT SQL')).toMatch(/drops a table/)
  })
})

describe('tolerableFailure names what the failure needs', () => {
  const plain = new Set(['public', 'pg_catalog', 'information_schema'])
  // Every missing extension was listed against every failure.
  it('names only the missing extension the error is about', () => {
    const lacks = new Set(['the pg_cron extension', 'the pg_net extension', 'the vector extension'])
    expect(tolerableFailure('CREATE TABLE public.docs (e extensions.vector(3));',
      { code: '42704', message: 'type "extensions.vector" does not exist' }, plain, lacks))
      .toBe('type "extensions.vector" does not exist, as this target lacks the vector extension')
  })

  it('names them all when the error names none of them', () => {
    const lacks = new Set(['the pg_net extension', 'the vector extension'])
    expect(tolerableFailure('CREATE VIEW public.v AS SELECT * FROM public.docs;',
      { code: '42P01', message: 'relation "public.docs" does not exist' }, plain, lacks))
      .toBe('relation "public.docs" does not exist, as this target lacks the pg_net extension, the vector extension')
  })
})

describe('tolerableFailure names the extension an object was left out for', () => {
  // An index or key on a table that was itself left out failed with
  // `relation "public.docs" does not exist`, and the reason listed every
  // extension the target lacked — pg_cron, pg_net, … — rather than the one
  // the table needed.
  const plain = new Set(['public', 'pg_catalog', 'information_schema'])
  const missing = new Set(['the pg_cron extension', 'the pg_net extension', 'the vector extension'])

  it('cites the left-out table and its own cause', () => {
    const leftOut = new Map([['public.docs', 'this target lacks the vector extension']])
    const reason = tolerableFailure('CREATE INDEX docs_embedding_idx ON public.docs USING btree (id);',
      { code: '42P01', message: 'relation "public.docs" does not exist' }, plain, missing, leftOut)
    expect(reason).toBe('relation "public.docs" does not exist, as public.docs was left out: this target lacks the vector extension')
  })

  it('matches an unqualified name against public', () => {
    const leftOut = new Map([['public.docs', 'this target lacks the vector extension']])
    expect(tolerableFailure('ALTER TABLE docs ADD CONSTRAINT k UNIQUE (id);',
      { code: '42P01', message: 'relation "docs" does not exist' }, plain, missing, leftOut)).toMatch(/docs was left out: this target lacks the vector extension$/)
  })
})

describe('createdObjects', () => {
  it('names what a statement creates, schema-qualified', () => {
    expect(createdObjects('CREATE TABLE public.docs (id int, e extensions.vector(3));')).toEqual(['public.docs'])
    expect(createdObjects('CREATE TABLE "App"."Docs" (id int);')).toEqual(['App.Docs'])
    expect(createdObjects('CREATE VIEW v AS SELECT 1;')).toEqual(['public.v'])
    expect(createdObjects('CREATE TYPE public.mood AS ENUM (\'a\');')).toEqual(['public.mood'])
    expect(createdObjects('GRANT SELECT ON public.docs TO anon;')).toEqual([])
  })
})

describe('tolerableFailure reads the statement for the extension it needs', () => {
  it('names pgvector for a table typed by it, though the error names only the schema', () => {
    const plain = new Set(['public', 'pg_catalog', 'information_schema'])
    const missing = new Set(['the pg_net extension', 'the vector extension'])
    expect(tolerableFailure('CREATE TABLE public.docs (id int, embedding extensions.vector(3));',
      { code: '3F000', message: 'schema "extensions" does not exist' }, plain, missing))
      .toBe('schema "extensions" does not exist, as this target lacks the vector extension')
  })
})
