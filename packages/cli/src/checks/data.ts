import type { DriftIssue } from '../types/drift'
import { dataScope, runDbDiff, sqlToIssues, type DbDiffOptions } from '../dbdiff'
import { DEFAULT_IGNORE_SCHEMAS } from '../defaults'
import { filterChangedTables } from '../checksum'
import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import { Check, CheckSkipped, type CheckContext } from './base'
import { applyTableFilter } from '../utils/table-filter'

export type RunDbDiffFn = (options: DbDiffOptions) => ReturnType<typeof runDbDiff>

/**
 * Layer 7: Reference Data Drift — powered by @dbdiff/cli --type=data.
 *
 * Fingerprints each configured table on both sides — a digest of its contents,
 * not its size — and invokes `@dbdiff/cli diff --type=data` only for the ones
 * that differ. See src/checksum.ts for why the fingerprint reads the rows.
 *
 * Falls back gracefully when @dbdiff/cli is not installed.
 */
export class DataCheck extends Check {
  readonly name = 'data' as const

  constructor(
    private runFn: RunDbDiffFn = runDbDiff,
    private queryFn: QueryFn = pgQuery,
  ) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const configured = ctx.config.checks?.data?.tables
    // Nothing configured to compare is a skip, not a clean comparison — this
    // layer reported a green pass having read nothing at all (issue #42).
    if (!configured?.length) throw new CheckSkipped('no tables configured in checks.data.tables')

    // Narrowed here rather than through dbdiff's --tables, because this check
    // picks its tables from config and fingerprints them before dbdiff is
    // invoked (issue #43). A filter that excludes all of them is a skip, not a
    // clean pass — the same distinction #42 drew.
    const tables = applyTableFilter(configured, ctx.tableFilter)
    if (tables.length === 0) {
      throw new CheckSkipped('no configured data tables match the --tables / --exclude-tables filter')
    }

    // Fast fingerprint check — skip tables that haven't changed
    const { changed } = await filterChangedTables(
      ctx.source.dbUrl,
      ctx.target.dbUrl,
      tables,
      this.queryFn,
    )

    if (changed.length === 0) return []

    try {
      const result = await this.runFn({
        sourceUrl: ctx.source.dbUrl,
        targetUrl: ctx.target.dbUrl,
        type: 'data',
        include: 'both',
        ...dataScope(changed, ctx.config.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS),
        timeoutSeconds: ctx.target?.checks?.schema?.timeout,
      })
      return sqlToIssues(result, 'data')
    } catch (err) {
      if (err instanceof Error && err.message.includes('@dbdiff/cli is not installed')) {
        return []
      }
      throw err
    }
  }
}
