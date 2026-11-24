/**
 * `JSON.stringify(value, null, 2)`, written out in pieces.
 *
 * `--json` built its whole result as one string, and V8 caps a string at
 * about 512 MiB: a sync of a few hundred thousand reference rows threw
 * `Invalid string length` after the apply had committed, and printed nothing
 * of what it had done. The text here is the same, byte for byte, but no piece
 * of it is ever larger than a chunk, however large the value.
 */

/** Strings longer than this are escaped a slice at a time. */
const LONG_STRING = 1 << 20
const SLICE = 1 << 16

type Write = (chunk: string) => void

/** What JSON.stringify leaves out of an object, and writes as null in an array. */
function omitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

/** The value JSON.stringify writes for `value` under `key`: its toJSON, or a boxed primitive's own value. */
function prepared(value: unknown, key: string): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: (key: string) => unknown }).toJSON(key)
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) return value.valueOf()
  return value
}

function writeString(s: string, write: Write): void {
  if (s.length <= LONG_STRING) {
    write(JSON.stringify(s))
    return
  }
  write('"')
  for (let at = 0; at < s.length;) {
    let end = Math.min(at + SLICE, s.length)
    // Not between the halves of a surrogate pair, which apart are escaped as lone ones.
    const code = s.charCodeAt(end - 1)
    if (end < s.length && code >= 0xd800 && code <= 0xdbff) end -= 1
    write(JSON.stringify(s.slice(at, end)).slice(1, -1))
    at = end
  }
  write('"')
}

function writeValue(value: unknown, indent: string, seen: Set<object>, write: Write): void {
  if (value === null) return write('null')
  switch (typeof value) {
    case 'string': return writeString(value, write)
    case 'number': return write(Number.isFinite(value) ? JSON.stringify(value) : 'null')
    case 'boolean': return write(value ? 'true' : 'false')
    case 'bigint': throw new TypeError('Do not know how to serialize a BigInt')
    case 'object': break
    default: return write('null')
  }
  const object = value as object
  if (seen.has(object)) throw new TypeError('Converting circular structure to JSON')
  seen.add(object)
  const inner = `${indent}  `
  if (Array.isArray(object)) {
    if (object.length === 0) {
      write('[]')
    } else {
      write('[')
      for (let i = 0; i < object.length; i++) {
        write(i === 0 ? `\n${inner}` : `,\n${inner}`)
        const item = prepared(object[i], String(i))
        if (omitted(item)) write('null')
        else writeValue(item, inner, seen, write)
      }
      write(`\n${indent}]`)
    }
  } else {
    let first = true
    for (const key of Object.keys(object)) {
      const item = prepared((object as Record<string, unknown>)[key], key)
      if (omitted(item)) continue
      write(first ? `{\n${inner}` : `,\n${inner}`)
      first = false
      write(`${JSON.stringify(key)}: `)
      writeValue(item, inner, seen, write)
    }
    write(first ? '{}' : `\n${indent}}`)
  }
  seen.delete(object)
}

/**
 * Write `value` as `JSON.stringify(value, null, 2)` would, through `write`,
 * gathered into chunks of about `chunkSize` characters. Returns false, and
 * writes nothing, for a value JSON.stringify gives no text for (undefined).
 */
export function writeJson(value: unknown, write: Write, chunkSize = 1 << 20): boolean {
  const top = prepared(value, '')
  if (omitted(top)) return false
  let buffer: string[] = []
  let size = 0
  const gather: Write = piece => {
    buffer.push(piece)
    size += piece.length
    if (size >= chunkSize) {
      write(buffer.join(''))
      buffer = []
      size = 0
    }
  }
  writeValue(top, '', new Set(), gather)
  if (size > 0) write(buffer.join(''))
  return true
}

/** As writeJson, collected: for tests, and for values known to be small. */
export function jsonText(value: unknown): string | undefined {
  const parts: string[] = []
  return writeJson(value, p => parts.push(p)) ? parts.join('') : undefined
}

/** `value` as JSON on stdout, then a newline: what every --json and --ci result is written with. */
export function printJson(value: unknown): void {
  writeJson(value, chunk => process.stdout.write(chunk))
  process.stdout.write('\n')
}
