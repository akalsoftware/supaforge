/**
 * `--jsonl`: the result as JSON Lines, one record a line, written as the run
 * goes, for a consumer that reads a stream — a log pipeline, a job that acts
 * on each finding — rather than waiting for one document.
 *
 * Every record has a `type`. The first is `start`, with the record schema's
 * version; each check's `check` record is written when it finishes; then the
 * same content `--json` carries, a record per item; the last is `result`, or
 * `error` when the run could not go on.
 *
 * | type          | when                                  | carries                                         |
 * | ------------- | ------------------------------------- | ----------------------------------------------- |
 * | `start`       | first                                 | `schema` (1), `command`, `timestamp`            |
 * | `check`       | as each check finishes                | `check`, `status`, `issues`, `durationMs`        |
 * | `issue`       | each finding                          | the finding, as in --json                       |
 * | `applied`     | each fix applied                      | `check`, `issueId`, `sql`                        |
 * | `skipped`     | each fix held back                    | `check`, `issueId`, `reason`                     |
 * | `failed`      | each fix that failed                  | `check`, `issueId`, `error`                      |
 * | `rolled-back` | each fix undone by a later failure    | `check`, `issueId`                               |
 * | `note`, `warning` | what the apply had to say          | `text`                                          |
 * | `result`      | last                                  | the scores, counts and anything else --json has |
 * | `error`       | when the run stopped                  | `error`, `code`                                  |
 */

export const JSONL_SCHEMA = 1

/** --jsonl or --json, from a command's arguments: which machine output it writes, if any. */
export function outputMode(argv: readonly string[] | undefined): 'jsonl' | 'json' | undefined {
  if (argv?.includes('--jsonl')) return 'jsonl'
  if (argv?.includes('--json')) return 'json'
  return undefined
}

/** One record, on its own line. */
export function writeRecord(type: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ type, ...fields })}\n`)
}

type Rec = Record<string, unknown>
const isArray = (v: unknown): v is Rec[] => Array.isArray(v)

/**
 * A command's --json result as records: findings of a scan, the outcomes of
 * an apply, or a failure; and a closing `result` with whatever else it held.
 */
export function writeResultRecords(value: unknown): void {
  if (!value || typeof value !== 'object') {
    writeRecord('result', { value })
    return
  }
  const v = value as Rec
  if (typeof v.error === 'string' && !isArray(v.checks) && !isArray(v.applied)) {
    writeRecord('error', v)
    return
  }
  const rest: Rec = { ...v }
  if (isArray(v.checks)) {
    for (const check of v.checks) {
      for (const issue of isArray(check.issues) ? check.issues : []) writeRecord('issue', issue)
    }
    rest.checks = v.checks.map(({ issues, ...check }) => ({ ...check, issues: isArray(issues) ? issues.length : 0 }))
  }
  const lists: Array<[string, string]> = [['applied', 'applied'], ['skipped', 'skipped'], ['errors', 'failed'], ['rolledBack', 'rolled-back']]
  for (const [key, type] of lists) {
    if (!isArray(v[key])) continue
    for (const item of v[key] as Rec[]) writeRecord(type, item)
    rest[key] = (v[key] as Rec[]).length
  }
  for (const [key, type] of [['notes', 'note'], ['warnings', 'warning']] as const) {
    if (!Array.isArray(v[key])) continue
    for (const text of v[key] as unknown[]) writeRecord(type, { text })
    delete rest[key]
  }
  writeRecord('result', rest)
}
