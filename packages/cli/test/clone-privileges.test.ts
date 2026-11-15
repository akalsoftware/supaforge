import { describe, it, expect } from 'vitest'
import { privilegeEntries, privilegeStatements } from '../src/clone-privileges.js'
import { formatNotGranted } from '../src/commands/clone.js'

describe('privilegeEntries', () => {
  it('keeps the ACL and DEFAULT ACL lines of a pg_restore listing', () => {
    const listing = [
      ';',
      '; Archive created at 2026-11-15',
      '215; 1259 16390 TABLE public film postgres',
      '3370; 0 0 ACL - SCHEMA public pg_database_owner',
      '3371; 0 0 ACL public TABLE film postgres',
      '2052; 826 16400 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres',
      '3372; 0 0 COMMENT public TABLE film postgres',
    ].join('\n')
    expect(privilegeEntries(listing)).toEqual([
      '3370; 0 0 ACL - SCHEMA public pg_database_owner',
      '3371; 0 0 ACL public TABLE film postgres',
      '2052; 826 16400 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres',
    ])
  })
  it('drops the entries on a schema the clone leaves out, and the schema\'s own', () => {
    const listing = [
      '3370; 0 0 ACL - SCHEMA public pg_database_owner',
      '3380; 0 0 ACL - SCHEMA net supabase_admin',
      '3381; 0 0 ACL extensions FUNCTION algorithm_sign(signables text, secret text, algorithm text) supabase_admin',
      '3382; 0 0 ACL public TABLE film postgres',
      '2053; 826 16401 DEFAULT ACL extensions DEFAULT PRIVILEGES FOR FUNCTIONS postgres',
      '3383; 0 0 ACL - DATABASE postgres postgres',
    ].join('\n')
    expect(privilegeEntries(listing, ['net', 'extensions'])).toEqual([
      '3370; 0 0 ACL - SCHEMA public pg_database_owner',
      '3382; 0 0 ACL public TABLE film postgres',
      '3383; 0 0 ACL - DATABASE postgres postgres',
    ])
  })
})

describe('privilegeStatements', () => {
  it('splits the SQL into statements, without comments or psql meta-commands', () => {
    const sql = [
      '--',
      '-- PostgreSQL database dump',
      '--',
      '\\restrict abc123',
      "SET statement_timeout = 0;",
      "SELECT pg_catalog.set_config('search_path', '', false);",
      '--',
      '-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner',
      '--',
      '',
      'GRANT ALL ON SCHEMA public TO PUBLIC;',
      'GRANT SELECT ON TABLE public.film TO "Odd; Role";',
      '\\unrestrict abc123',
    ].join('\n')
    expect(privilegeStatements(sql)).toEqual([
      'SET statement_timeout = 0',
      "SELECT pg_catalog.set_config('search_path', '', false)",
      'GRANT ALL ON SCHEMA public TO PUBLIC',
      'GRANT SELECT ON TABLE public.film TO "Odd; Role"',
    ])
  })
})

describe('formatNotGranted', () => {
  it('counts what was not granted by role', () => {
    const lines = formatNotGranted([
      { role: 'anon', statement: 'GRANT SELECT ON TABLE public.a TO anon' },
      { role: 'anon', statement: 'GRANT SELECT ON TABLE public.b TO anon' },
      { role: 'authenticated', statement: 'GRANT SELECT ON TABLE public.a TO authenticated' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('anon (2), authenticated (1)')
  })

  it('says nothing when everything was granted', () => {
    expect(formatNotGranted([])).toEqual([])
  })
})
