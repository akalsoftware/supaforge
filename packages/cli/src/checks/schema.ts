import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { runDbDiff, schemaNotices, sqlToIssues, withoutAbsentRoles, type DbDiffOptions } from '../dbdiff'
import { Check, CheckSkipped, type CheckContext } from './base'
import { DEFAULT_IGNORE_SCHEMAS } from '../defaults'

export type RunDbDiffFn = (options: DbDiffOptions) => ReturnType<typeof runDbDiff>

/**
 * Layer 1: Schema Drift — powered by @dbdiff/cli.
 *
 * Invokes `@dbdiff/cli diff` to diff table structure,
 * columns, indexes, constraints, and sequences between environments.
 *
 * Falls back gracefully when @dbdiff/cli is not installed.
 */
export class SchemaCheck extends Check {
  readonly name = 'schema' as const

  constructor(
    private runFn: RunDbDiffFn = runDbDiff,
    private queryFn: QueryFn = pgQuery,
  ) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    try {
      const ignoreSchemas = ctx.config.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS
      const [result, ignoredSchemaTables] = await Promise.all([
        this.runFn({
          sourceUrl: ctx.source.dbUrl,
          targetUrl: ctx.target.dbUrl,
          type: 'schema',
          include: 'both',
          timeoutSeconds: ctx.target?.checks?.schema?.timeout,
          onProgress: ctx.onDetail
            ? ({ table, tablesSeen }) => ctx.onDetail?.(`${tablesSeen} tables · ${table}`)
            : undefined,
          ignoreSchemas,
          // dbdiff takes the include/exclude lists natively, globs and all, so
          // the scope is enforced in the diff itself rather than by discarding
          // findings afterwards (issue #43).
          ...(ctx.tableFilter?.tables?.length ? { tables: ctx.tableFilter.tables } : {}),
          ...(ctx.tableFilter?.excludeTables?.length ? { ignoreTables: ctx.tableFilter.excludeTables } : {}),
        }),
        this.fetchIgnoredSchemaTables(ctx.target.dbUrl, ignoreSchemas),
      ])
      for (const notice of schemaNotices(result.notices ?? [])) ctx.onNotice?.(notice)
      const issues = sqlToIssues(result, 'schema', ignoreSchemas, ignoredSchemaTables)
      const roles = await this.targetRoles(ctx.target.dbUrl)
      return roles?.size ? withoutAbsentRoles(issues, roles) : issues
    } catch (err) {
      if (err instanceof Error && err.message.includes('@dbdiff/cli is not installed')) {
        throw new CheckSkipped('@dbdiff/cli is not installed')
      }
      throw err
    }
  }

  /**
   * Query the target DB for table names inside ignored schemas.
   *
   * These are used to detect unqualified FK REFERENCES like `REFERENCES "users"`
   * where "users" lives in the ignored "auth" schema but dbdiff omitted the
   * schema prefix (due to search_path or its own normalisation).
   *
   * Returns a Set of lowercase table names, bare and schema-qualified. Fails silently so that a transient
   * DB error here never blocks the main schema diff.
   */
  /** The target's roles, or undefined when they cannot be read. */
  private async targetRoles(dbUrl: string): Promise<Set<string> | undefined> {
    try {
      const rows = await this.queryFn(dbUrl, 'SELECT rolname FROM pg_roles') as Array<{ rolname: string }>
      return new Set(rows.map(r => r.rolname))
    } catch {
      return undefined
    }
  }

  async fetchIgnoredSchemaTables(dbUrl: string, ignoreSchemas: string[]): Promise<Set<string>> {
    if (ignoreSchemas.length === 0) return new Set()
    try {
      const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
      const rows = await this.queryFn(
        dbUrl,
        `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN (${placeholders})`,
        ignoreSchemas,
      )
      // Bare names catch an unqualified REFERENCES; `schema.table` lets a
      // qualified one onto a table the target has through.
      return new Set(rows.flatMap(r => [
        String(r.tablename).toLowerCase(),
        `${String(r.schemaname)}.${String(r.tablename)}`.toLowerCase(),
      ]))
    } catch {
      // Non-fatal: return empty set and let the existing filter handle what it can
      return new Set()
    }
  }
}
