import type { EnvironmentConfig, SupaForgeConfig } from '../types/config'
import type { TableFilter } from '../utils/table-filter'
import type { DriftIssue, CheckName } from '../types/drift'

export interface CheckContext {
  /**
   * Which tables this run is scoped to, resolved from `checks.tables` /
   * `checks.excludeTables` and the `--tables` / `--exclude-tables` flags.
   *
   * Only the schema and data layers act on it — they are the ones backed by
   * @dbdiff/cli, which is where the table concept exists (issue #43). Absent
   * or empty means every table, which is the default.
   */
  tableFilter?: TableFilter
  /**
   * Optional sink for sub-check progress, e.g. the table counter emitted
   * during a long schema diff (issue #29). Checks that have nothing
   * fine-grained to report simply ignore it.
   */
  onDetail?: (detail: string) => void
  /** Sink for what the check could not compare — see CheckResult.notices. */
  onNotice?: (notice: string) => void
  source: EnvironmentConfig
  target: EnvironmentConfig
  config: SupaForgeConfig
}

/**
 * Thrown by a check that cannot run — missing credentials, an absent
 * extension, nothing configured to compare.
 *
 * Checks used to signal this by returning `[]`, which is the same value a
 * genuinely clean scan returns. The distinction was lost before it reached the
 * scanner, so a layer that never ran rendered as a green zero-issue pass
 * (issue #42). Throwing keeps `scan()` returning plain issues while giving the
 * scanner something it cannot mistake for a result.
 *
 * A skip is a normal outcome, not a failure: it carries no stack for the user
 * and is reported separately from errored checks.
 */
export class CheckSkipped extends Error {
  /** Distinguishes a skip from a genuine error across module boundaries. */
  override readonly name = 'CheckSkipped'

  constructor(reason: string) {
    super(reason)
  }
}

/**
 * Name-based rather than `instanceof`, which fails when two copies of the
 * module are loaded — a real possibility with bundled output and linked
 * packages.
 */
export function isCheckSkipped(err: unknown): err is CheckSkipped {
  return err instanceof Error && err.name === 'CheckSkipped'
}

/**
 * SQLSTATEs that mean the thing queried isn't there: no such table or view
 * (42P01), schema (3F000) or function (42883). A project without pg_cron or
 * Realtime answers with one of these, and that is a genuine "nothing to
 * compare".
 *
 * Nothing else is. A wrong password, a dropped connection or a permission
 * error read as "nothing there" made the source look empty — and the target's
 * webhooks, cron jobs and publications then looked extra and were dropped.
 */
const MISSING_OBJECT_CODES = new Set(['42P01', '3F000', '42883'])

export function isMissingObject(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && MISSING_OBJECT_CODES.has(code)
}

/** Run a read that may legitimately find nothing, returning `absent` only then. */
export async function readOrAbsent<T>(read: () => Promise<T>, absent: T): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (isMissingObject(err)) return absent
    throw err
  }
}

export abstract class Check {
  abstract readonly name: CheckName
  abstract scan(ctx: CheckContext): Promise<DriftIssue[]>
}
