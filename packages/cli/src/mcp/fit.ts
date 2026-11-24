/**
 * What the MCP server returns, sized for an agent to read.
 *
 * The diff tool returned the whole scan and the whole plan, every fix's SQL
 * in both: a 100,000-row reference-data sync was a few hundred megabytes of
 * text, far past anything an agent's context holds, so the call was of no
 * use exactly when the drift was largest. Long strings — a batch of rows'
 * SQL, a function body — now keep their start and say how much is left out,
 * and if the result is still large, they are cut shorter and then long lists
 * are cut too, each saying so. The ids, titles, severities and counts an
 * agent decides with are never cut. The whole of any fix is a
 * `get_check_result` with its `issueId` away, or `supaforge diff --json`.
 */

/** How long a string stays whole. */
export const LONG_STRING = 4_000
/** The most text a result should come to. */
export const MAX_RESULT = 256_000

const ELLIPSIS = (rest: number, lines: number) =>
  `\n… ${rest.toLocaleString('en-US')} more characters${lines > 0 ? ` (${lines.toLocaleString('en-US')} more lines)` : ''} left out here: `
  + 'get_check_result with this issueId has the whole of it.'

function cutString(s: string, max: number): string {
  if (s.length <= max) return s
  const kept = s.slice(0, max)
  const rest = s.slice(max)
  return kept + ELLIPSIS(rest.length, rest.split('\n').length - 1)
}

/** Fields that are never cut: what an agent decides with. */
const KEEP = new Set(['id', 'issueId', 'check', 'severity', 'title', 'status', 'reason', 'error', 'code', 'label'])

function cut(value: unknown, maxString: number, maxItems: number, key?: string): unknown {
  if (typeof value === 'string') return key && KEEP.has(key) ? value : cutString(value, maxString)
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map(v => cut(v, maxString, maxItems))
    if (value.length > maxItems) {
      items.push(`… and ${(value.length - maxItems).toLocaleString('en-US')} more, left out here: supaforge diff --json lists them all.`)
    }
    return items
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v, maxString, maxItems, k)]))
  }
  return value
}

/**
 * `value` as text for an agent: long strings cut to LONG_STRING, then, while
 * the text is over MAX_RESULT, strings cut shorter and long lists shortened.
 */
export function fitForAgent(value: unknown): string {
  const steps: Array<[number, number]> = [[LONG_STRING, Infinity], [400, Infinity], [400, 200], [120, 50]]
  let text = ''
  for (const [maxString, maxItems] of steps) {
    text = JSON.stringify(cut(value, maxString, maxItems), null, 2)
    if (text.length <= MAX_RESULT) return text
  }
  return text
}
