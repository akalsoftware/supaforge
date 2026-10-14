/**
 * Splitting SQL text into statements.
 *
 * Kept apart from the quoting helpers in `sql.ts` because this is a scanner
 * rather than an escaper, and it is only needed where SQL arrives from outside
 * — a pg_dump, a migration file — rather than being generated here.
 */

/** The start of a statement that can hold a `BEGIN ATOMIC` body. */
const ROUTINE_HEAD = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i

/** A statement's text without the comments and blank lines before it. */
function withoutLeadingComments(text: string): string {
  let rest = text.trimStart()
  for (;;) {
    if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n')
      rest = newline === -1 ? '' : rest.slice(newline + 1).trimStart()
    } else if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/')
      rest = close === -1 ? '' : rest.slice(close + 2).trimStart()
    } else {
      return rest
    }
  }
}

/** `$$` or `$tag$`, anchored at the current position. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/

/**
 * Split SQL into individual statements.
 *
 * Splitting on `;` alone breaks the moment the SQL contains a routine body: a
 * `CREATE FUNCTION ... AS $$ BEGIN ... ; ... END; $$;` is shredded into three
 * fragments, none of which parse, and whatever depends on the function fails
 * after them. That is what `restore` did to a pg_dump's functions and their
 * triggers (issue #80).
 *
 * The text is walked once, tracking the four things that can hold a semicolon
 * without ending a statement:
 *
 *   - `'single quoted'`, where `''` is an escaped quote and not a close
 *   - `"quoted identifiers"`, same doubling rule
 *   - `$tag$ dollar quoted $tag$`, which is how routine bodies arrive
 *   - line comments, and block comments, which nest in PostgreSQL
 *   - a SQL-standard routine body, `BEGIN ATOMIC ... ; ... END`, whose
 *     statements end in semicolons of their own. As psql does, inside a
 *     CREATE FUNCTION or PROCEDURE each BEGIN or CASE opens a level and each
 *     END closes one, and a `;` ends the statement only at level zero. Split
 *     at the first `;`, restoring such a function failed with "syntax error
 *     at end of input".
 *
 * Statements come back trimmed with the trailing `;` removed, and empty
 * fragments dropped. Comments are left in place: they are part of the
 * statement's text, and a caller wanting a bare statement can say so.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let start = 0
  let i = 0
  let blockDepth = 0
  let beginDepth = 0

  const push = (end: number) => {
    const piece = sql.slice(start, end).trim()
    if (piece.length > 0) statements.push(piece)
  }

  while (i < sql.length) {
    if (blockDepth > 0) {
      if (sql.startsWith('/*', i)) { blockDepth++; i += 2; continue }
      if (sql.startsWith('*/', i)) { blockDepth--; i += 2; continue }
      i++
      continue
    }

    if (sql.startsWith('/*', i)) { blockDepth = 1; i += 2; continue }

    if (sql.startsWith('--', i)) {
      const newline = sql.indexOf('\n', i)
      i = newline === -1 ? sql.length : newline + 1
      continue
    }

    const ch = sql[i]

    if (ch === "'" || ch === '"') {
      i++
      while (i < sql.length) {
        if (sql[i] !== ch) { i++; continue }
        // A doubled quote is an escape, not the end of the run.
        if (sql[i + 1] === ch) { i += 2; continue }
        i++
        break
      }
      continue
    }

    if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? sql.length : close + tag[0].length
        continue
      }
      i++
      continue
    }

    if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i, i + 64))![0]
      const upper = word.toUpperCase()
      if ((upper === 'BEGIN' || upper === 'CASE') && ROUTINE_HEAD.test(withoutLeadingComments(sql.slice(start, i)))) {
        beginDepth++
      } else if (upper === 'END' && beginDepth > 0) {
        beginDepth--
      }
      i += word.length
      continue
    }

    if (ch === ';' && beginDepth === 0) {
      push(i)
      i++
      start = i
      continue
    }

    i++
  }

  push(sql.length)
  return statements
}

/** Whether a statement is nothing but comments and whitespace. */
export function isCommentOnly(statement: string): boolean {
  const meaningful = statement
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('--'))
  return meaningful.length === 0
}

/**
 * The `\restrict` / `\unrestrict` wrappers pg_dump 16 and later emit.
 *
 * Matched as whole lines, and only these two commands rather than anything
 * beginning with a backslash: a line inside a dollar-quoted routine body could
 * start with one, and rewriting a function's body would be worse than the
 * problem being solved.
 */
const PSQL_WRAPPER_LINE = /^[ \t]*\\(?:un)?restrict\b[^\n]*$/gm

/**
 * Remove psql meta-commands, which only psql understands.
 *
 * Done to the text *before* it is split, because these commands are terminated
 * by the end of the line rather than by a semicolon. Dropping them afterwards
 * as whole statements took the following statement with them — `\restrict abc`
 * and the `CREATE TABLE` under it are one fragment when nothing separates them
 * (issue #80). Sent to the server they fail with `syntax error at or near "\"`.
 */
export function stripPsqlMetaCommands(sql: string): string {
  return sql.replace(PSQL_WRAPPER_LINE, '')
}

/**
 * Whether a statement is nothing but psql meta-commands and comments.
 *
 * A safety net for anything `stripPsqlMetaCommands` does not cover. It
 * deliberately requires *every* meaningful line to be a meta-command, so a
 * statement that also carries SQL is never discarded wholesale.
 */
export function isPsqlMetaCommand(statement: string): boolean {
  const meaningful = statement
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('--'))

  return meaningful.length > 0 && meaningful.every(line => line.startsWith('\\'))
}
