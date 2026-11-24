import { describe, it, expect } from 'vitest'
import { jsonText, writeJson } from '../src/utils/json-stream.js'

/** A small seeded generator, so a failure names a seed that reproduces it. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

const STRINGS = ['', 'a', 'quote " and \\ backslash', 'line\nbreak\ttab', '\u0000\u001f control', 'é ü 中文 🎉',
  '\ud800 lone high', 'lone low \udc00', '</script>', '  ']
const ATOMS: unknown[] = [null, true, false, 0, -0, 1.5, -1e21, 1e-7, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity,
  undefined, () => 1, Symbol('s'), new Date(0), new Number(3), new String('boxed'), new Boolean(false),
  { toJSON: () => 'from toJSON' }, { toJSON: (key: string) => `key was ${key}` }, new Map([[1, 2]]), new Set([1])]

function generate(next: () => number, depth: number): unknown {
  const r = next()
  if (depth > 4 || r < 0.35) return next() < 0.5 ? STRINGS[Math.floor(next() * STRINGS.length)] : ATOMS[Math.floor(next() * ATOMS.length)]
  const n = Math.floor(next() * 5)
  if (r < 0.65) return Array.from({ length: n }, () => generate(next, depth + 1))
  const o: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) o[next() < 0.2 ? STRINGS[i % STRINGS.length] : `k${i}`] = generate(next, depth + 1)
  return o
}

describe('writeJson writes what JSON.stringify(value, null, 2) does', () => {
  it.each(ATOMS.map((a, i) => [i, a]))('atom %i', (_i, atom) => {
    expect(jsonText(atom)).toBe(JSON.stringify(atom, null, 2))
    expect(jsonText([atom])).toBe(JSON.stringify([atom], null, 2))
    expect(jsonText({ a: atom, b: 1 })).toBe(JSON.stringify({ a: atom, b: 1 }, null, 2))
  })

  it('empty arrays and objects, nested', () => {
    const v = { a: [], b: {}, c: [[], {}, [[]]], d: { e: {} } }
    expect(jsonText(v)).toBe(JSON.stringify(v, null, 2))
  })

  it('a thousand random values', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const v = generate(rng(seed), 0)
      expect(jsonText(v), `seed ${seed}`).toBe(JSON.stringify(v, null, 2))
    }
  })

  it('whatever the chunk size', () => {
    const v = generate(rng(42), 0)
    for (const size of [1, 7, 64, 4096]) {
      const parts: string[] = []
      writeJson(v, p => parts.push(p), size)
      expect(parts.join('')).toBe(JSON.stringify(v, null, 2))
    }
  })

  it('a long string, escaped a slice at a time, a surrogate pair never split', () => {
    // Pairs straddling every slice boundary, escapes, and a lone surrogate at the end.
    const s = ('🎉"\\\n'.repeat(70_000) + 'x').repeat(5) + '\ud800'
    expect(s.length).toBeGreaterThan(1 << 20)
    expect(jsonText({ s })).toBe(JSON.stringify({ s }, null, 2))
  })

  it('refuses what JSON.stringify refuses', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => jsonText(circular)).toThrow(/circular/)
    expect(() => jsonText({ n: 1n })).toThrow(/BigInt/)
  })

  it('a value seen twice is not circular', () => {
    const shared = { x: 1 }
    const v = { a: shared, b: [shared, shared] }
    expect(jsonText(v)).toBe(JSON.stringify(v, null, 2))
  })

  it('gives no text for undefined, as JSON.stringify gives none', () => {
    expect(jsonText(undefined)).toBeUndefined()
    expect(writeJson(undefined, () => { throw new Error('wrote') })).toBe(false)
  })

  it('writes a result JSON.stringify cannot: more text than a string can hold', () => {
    // One 100 MB string, six times over: over 600 MB of JSON, past V8's
    // ~512 MiB string limit. JSON.stringify throws; the stream does not, and
    // never holds more than a chunk.
    const big = 'x'.repeat(100 * 1024 * 1024)
    const v = { rows: Array.from({ length: 6 }, () => big) }
    expect(() => JSON.stringify(v, null, 2)).toThrow(RangeError)
    let length = 0
    let largest = 0
    writeJson(v, p => { length += p.length; largest = Math.max(largest, p.length) })
    // {\n  "rows": [\n    "…",\n … \n  ]\n}
    expect(length).toBe(6 * (big.length + 2) + 6 * 5 + 5 * 1 + '{\n  "rows": ['.length + '\n  ]\n}'.length)
    expect(largest).toBeLessThan(4 * 1024 * 1024)
  }, 120_000)
})
