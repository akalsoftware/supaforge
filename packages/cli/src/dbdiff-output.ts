import { createReadStream } from 'node:fs'
import { splitSqlStatements } from './utils/sql-split.js'

/**
 * Reading what DBDiff writes: its UP and DOWN sections, statement by
 * statement.
 *
 * The output file used to be read into one string and split, and V8 caps a
 * string at about 512 MiB: a data diff of a few hundred thousand rows could
 * not be read at all. `readDbDiffStatements` reads it as a stream and gives
 * the same statements, cut only where a statement ends, so no piece it holds
 * is larger than a statement and a line.
 */

export const UP_MARKER = '-- ==================== UP ===================='
export const DOWN_MARKER = '-- ==================== DOWN ===================='

/** A statement's text without the line comments before it. */
export function withoutLeadingComments(chunk: string): string {
  return chunk.trim().replace(/^(?:--[^\n]*(?:\n|$)\s*)+/, '').trim()
}

/** SQL as statements, each with its `;`, the comments before it left out. */
export function splitStatements(sql: string): string[] {
  if (!sql) return []
  return splitSqlStatements(sql)
    .map(statement => withoutLeadingComments(statement))
    .filter(statement => statement.length > 0)
    .map(statement => `${statement};`)
}

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/

type Section = 'before' | 'up' | 'down'
const enum Mode { Code, Quoted, Dollar, Block }

/**
 * DBDiff's output, pushed in pieces, as its sections' statements.
 *
 * Text is taken a line at a time, and the lexical states that can hold a `;`
 * without ending a statement (quotes, dollar quotes, comments) are tracked
 * across lines as `splitSqlStatements` tracks them. At the end of a line in
 * plain code, everything up to the last `;` there is complete and is split
 * then; the rest waits for the next line. A marker line starts a section, as
 * in parseDbDiffOutput; text before the first marker is the UP when there is
 * no marker at all.
 */
export class DbDiffOutputReader {
  readonly up: string[] = []
  readonly down: string[] = []
  private readonly before: string[] = []
  private section: Section = 'before'
  private sawMarker = false
  private carry = ''
  private pending = ''
  private mode = Mode.Code
  private quote = ''
  private tag = ''
  private depth = 0

  push(text: string): void {
    const data = this.carry + text
    const last = data.lastIndexOf('\n')
    if (last === -1) {
      this.carry = data
      return
    }
    this.carry = data.slice(last + 1)
    this.scan(data.slice(0, last + 1))
  }

  /** The statements of each section, once the whole output has been pushed. */
  end(): { up: string[]; down: string[] } {
    if (this.carry) this.scan(this.carry)
    this.carry = ''
    this.emit(this.pending)
    this.pending = ''
    return this.sawMarker ? { up: this.up, down: this.down } : { up: this.before, down: [] }
  }

  private target(): string[] {
    return this.section === 'up' ? this.up : this.section === 'down' ? this.down : this.before
  }

  private emit(sql: string): void {
    if (sql.trim()) this.target().push(...splitStatements(sql))
  }

  /** One or more whole lines (the last may lack its newline at the end of the output). */
  private scan(text: string): void {
    let start = 0
    let cut = -1
    let i = 0
    while (i < text.length) {
      if (this.mode === Mode.Block) {
        if (text.startsWith('/*', i)) { this.depth++; i += 2; continue }
        if (text.startsWith('*/', i)) { this.depth--; i += 2; if (this.depth === 0) this.mode = Mode.Code; continue }
        i++
        continue
      }
      if (this.mode === Mode.Quoted) {
        const close = text.indexOf(this.quote, i)
        if (close === -1) { i = text.length; continue }
        // A doubled quote is an escape, not the end of the run.
        if (text[close + 1] === this.quote) { i = close + 2; continue }
        this.mode = Mode.Code
        i = close + 1
        continue
      }
      if (this.mode === Mode.Dollar) {
        const close = text.indexOf(this.tag, i)
        if (close === -1) { i = text.length; continue }
        this.mode = Mode.Code
        i = close + this.tag.length
        continue
      }

      const ch = text[i]
      if (ch === '-' && text[i + 1] === '-') {
        const newline = text.indexOf('\n', i)
        const lineEnd = newline === -1 ? text.length : newline
        const line = text.slice(i, lineEnd).trim()
        if (line === UP_MARKER || line === DOWN_MARKER) {
          // What came before the marker is that section's, and complete.
          this.emit(this.pending + text.slice(start, i))
          this.pending = ''
          this.section = line === UP_MARKER ? 'up' : 'down'
          this.sawMarker = true
          start = lineEnd
          cut = -1
        }
        i = newline === -1 ? text.length : newline + 1
        continue
      }
      if (ch === '/' && text[i + 1] === '*') { this.mode = Mode.Block; this.depth = 1; i += 2; continue }
      if (ch === "'" || ch === '"') { this.mode = Mode.Quoted; this.quote = ch; i++; continue }
      if (ch === '$') {
        const tag = DOLLAR_TAG.exec(text.slice(i, i + 66))
        if (tag) { this.mode = Mode.Dollar; this.tag = tag[0]; i += tag[0].length; continue }
      }
      if (ch === ';') cut = i + 1
      i++
    }
    if (this.mode === Mode.Code && cut > start) {
      this.emit(this.pending + text.slice(start, cut))
      this.pending = text.slice(cut)
    } else {
      this.pending += text.slice(start)
    }
  }
}

/** DBDiff's output file as its sections' statements, read as a stream. */
export async function readDbDiffStatements(file: string): Promise<{ up: string[]; down: string[] }> {
  const reader = new DbDiffOutputReader()
  for await (const chunk of createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    reader.push(chunk as string)
  }
  return reader.end()
}
