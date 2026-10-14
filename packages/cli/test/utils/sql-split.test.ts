import { describe, it, expect } from 'vitest'
import {
  splitSqlStatements,
  isCommentOnly,
  isPsqlMetaCommand,
  stripPsqlMetaCommands,
} from '../../src/utils/sql-split.js'

/**
 * Splitting SQL that came from outside.
 *
 * `restore` split a pg_dump on `;` and shredded every routine body, because a
 * `CREATE FUNCTION … AS $$ BEGIN … ; … END; $$;` holds semicolons that end
 * nothing. Restoring a snapshot then failed with `unterminated dollar-quoted
 * string`, and every trigger executing one of those functions failed after it
 * (issue #80).
 */
describe('splitSqlStatements', () => {
  it('splits ordinary statements', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('drops the trailing semicolon and surrounding whitespace', () => {
    expect(splitSqlStatements('  SELECT 1  ;  ')).toEqual(['SELECT 1'])
  })

  it('returns a final statement with no trailing semicolon', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1'])
  })

  it('returns nothing for empty input', () => {
    expect(splitSqlStatements('')).toEqual([])
    expect(splitSqlStatements('   \n  ')).toEqual([])
  })

  it('ignores semicolons inside a dollar-quoted body', () => {
    const sql = `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.seen_at := now();
  RETURN NEW;
END;
$$;`

    const statements = splitSqlStatements(sql)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('BEGIN')
    expect(statements[0]).toContain('END;')
    expect(statements[0]).toContain('$$')
  })

  it('ignores semicolons inside a tagged dollar-quoted body', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$ SELECT 1; SELECT 2; $body$;
SELECT 'after';`

    const statements = splitSqlStatements(sql)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('SELECT 1; SELECT 2;')
    expect(statements[1]).toBe("SELECT 'after'")
  })

  it('does not confuse one dollar tag for another', () => {
    // `$a$ … $b$ … $a$` closes on $a$, not on the inner tag.
    const sql = `SELECT $a$ text with $b$ inside $a$; SELECT 2;`
    const statements = splitSqlStatements(sql)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe('SELECT $a$ text with $b$ inside $a$')
  })

  it('ignores semicolons inside string literals', () => {
    const statements = splitSqlStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain("'a;b'")
  })

  it('treats a doubled quote as an escape, not a close', () => {
    const statements = splitSqlStatements(`SELECT 'it''s; fine'; SELECT 2;`)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe("SELECT 'it''s; fine'")
  })

  it('ignores semicolons inside quoted identifiers', () => {
    const statements = splitSqlStatements('SELECT "odd;name" FROM t; SELECT 2;')

    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe('SELECT "odd;name" FROM t')
  })

  it('ignores semicolons inside line comments', () => {
    const statements = splitSqlStatements('SELECT 1 -- not; a; split\n; SELECT 2;')

    expect(statements).toHaveLength(2)
    expect(statements[1]).toBe('SELECT 2')
  })

  it('ignores semicolons inside block comments, which nest', () => {
    const statements = splitSqlStatements('SELECT 1 /* a; /* b; */ c; */ ; SELECT 2;')

    expect(statements).toHaveLength(2)
    expect(statements[1]).toBe('SELECT 2')
  })

  it('keeps a statement whose comment header precedes it', () => {
    // pg_dump puts three comment lines above every object.
    const sql = `--
-- Name: t; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.t (id integer);`

    const statements = splitSqlStatements(sql)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('CREATE TABLE public.t')
  })

  it('survives an unterminated dollar body without looping', () => {
    const statements = splitSqlStatements('CREATE FUNCTION f() AS $$ BEGIN')
    expect(statements).toHaveLength(1)
  })

  it('survives an unterminated string without looping', () => {
    const statements = splitSqlStatements("SELECT 'unclosed")
    expect(statements).toHaveLength(1)
  })
})

describe('isCommentOnly', () => {
  it('recognises a pure comment block', () => {
    expect(isCommentOnly('--\n-- Name: x\n--')).toBe(true)
  })

  it('recognises whitespace as nothing', () => {
    expect(isCommentOnly('   \n \n')).toBe(true)
  })

  it('does not discard a statement that has a comment header', () => {
    expect(isCommentOnly('-- header\nCREATE TABLE t (id int)')).toBe(false)
  })
})

describe('isPsqlMetaCommand', () => {
  it('recognises the wrappers pg_dump 16+ emits', () => {
    // Sent to the server these fail with `syntax error at or near "\"`.
    expect(isPsqlMetaCommand('\\restrict aBcDeF123')).toBe(true)
    expect(isPsqlMetaCommand('\\unrestrict aBcDeF123')).toBe(true)
  })

  it('looks past a comment header', () => {
    expect(isPsqlMetaCommand('-- wrapper\n\\restrict x')).toBe(true)
  })

  it('leaves SQL alone', () => {
    expect(isPsqlMetaCommand('CREATE TABLE t (id int)')).toBe(false)
    expect(isPsqlMetaCommand("SELECT '\\n'")).toBe(false)
  })

  it('is false for nothing at all', () => {
    expect(isPsqlMetaCommand('')).toBe(false)
    expect(isPsqlMetaCommand('-- only a comment')).toBe(false)
  })
})

describe('stripPsqlMetaCommands', () => {
  it('removes the wrappers pg_dump 16+ emits', () => {
    const sql = `\\restrict aBcDeF123

CREATE TABLE public.t (id integer);

\\unrestrict aBcDeF123;
`
    const stripped = stripPsqlMetaCommands(sql)

    expect(stripped).not.toContain('restrict')
    expect(stripped).toContain('CREATE TABLE public.t')
  })

  it('keeps the statement sitting under a wrapper', () => {
    // The wrappers end at the newline, not at a semicolon, so the CREATE TABLE
    // below one is part of the same fragment. Removing them as whole
    // statements after splitting took the table with them (issue #80).
    const statements = splitSqlStatements(
      stripPsqlMetaCommands('\\restrict abc\n\nCREATE TABLE public.t (id integer);\n'),
    )

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('CREATE TABLE public.t')
  })

  it('leaves other backslash lines alone', () => {
    // Only the two commands pg_dump emits are removed. A routine body could
    // begin a line with a backslash, and rewriting a function body would be
    // worse than the problem being fixed.
    const sql = `CREATE FUNCTION f() RETURNS text AS $$
  \\d is not a meta-command here
$$;`
    expect(stripPsqlMetaCommands(sql)).toBe(sql)
  })

  it('leaves ordinary SQL untouched', () => {
    const sql = 'CREATE TABLE t (id int);\nSELECT 1;\n'
    expect(stripPsqlMetaCommands(sql)).toBe(sql)
  })
})

describe('isPsqlMetaCommand: never discards SQL with it', () => {
  it('is false when the statement also carries SQL', () => {
    // Requiring every meaningful line to be a meta-command is what stops a
    // merged fragment being thrown away wholesale.
    expect(isPsqlMetaCommand('\\restrict abc\nCREATE TABLE t (id int)')).toBe(false)
  })

  it('is true for a statement that is only meta-commands', () => {
    expect(isPsqlMetaCommand('-- header\n\\unrestrict abc')).toBe(true)
  })
})

describe('splitSqlStatements: SQL-standard routine bodies', () => {
  it('keeps a BEGIN ATOMIC body whole', () => {
    const fn = 'CREATE FUNCTION public.inc(a integer) RETURNS integer\n    LANGUAGE sql IMMUTABLE\n    BEGIN ATOMIC\n SELECT (a + 1);\nEND'
    expect(splitSqlStatements(`${fn};\nCREATE TABLE t (id int);`)).toEqual([fn, 'CREATE TABLE t (id int)'])
  })

  it('counts a CASE inside the body, which ends in END too', () => {
    const fn = `CREATE OR REPLACE PROCEDURE p(x int) LANGUAGE sql BEGIN ATOMIC
      INSERT INTO t VALUES (CASE WHEN x > 0 THEN x ELSE 0 END);
      INSERT INTO t VALUES (CASE x WHEN 1 THEN 1 END);
    END`
    expect(splitSqlStatements(`${fn}; SELECT 1;`)).toEqual([fn, 'SELECT 1'])
  })

  it('finds the routine behind pg_dump\'s comment header', () => {
    const fn = '--\n-- Name: inc(integer); Type: FUNCTION\n--\n\nCREATE FUNCTION inc(a integer) RETURNS integer LANGUAGE sql BEGIN ATOMIC SELECT a + 1; END'
    expect(splitSqlStatements(`${fn};SELECT 2;`)).toEqual([fn, 'SELECT 2'])
  })

  it('leaves BEGIN and END outside a routine alone', () => {
    expect(splitSqlStatements('BEGIN; SELECT CASE WHEN true THEN 1 END; END;'))
      .toEqual(['BEGIN', 'SELECT CASE WHEN true THEN 1 END', 'END'])
  })

  it('does not count BEGIN in a dollar-quoted body', () => {
    const fn = 'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'
    expect(splitSqlStatements(`${fn}; SELECT 3;`)).toEqual([fn, 'SELECT 3'])
  })
})
