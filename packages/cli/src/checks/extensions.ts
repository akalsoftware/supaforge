import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { Check, type CheckContext } from './base'
import { quoteLiteral, quoteName } from '../utils/sql.js'

interface PgExtension {
  name: string
  version: string
  schema: string
}

export class ExtensionsCheck extends Check {
  readonly name = 'extensions' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target, reachable] = await Promise.all([
      this.fetchExtensions(ctx.source.dbUrl),
      this.fetchExtensions(ctx.target.dbUrl),
      this.fetchUpdates(ctx.target.dbUrl),
    ])
    const ignored = new Set(ctx.config.ignoreExtensions ?? [])
    return diffExtensions(source, target.filter(e => !ignored.has(e.name) || source.some(s => s.name === e.name)), reachable)
  }

  /** The versions each installed extension can be updated to on this server. */
  private async fetchUpdates(dbUrl: string): Promise<Map<string, Set<string>> | undefined> {
    try {
      const rows = await this.queryFn(dbUrl, UPDATES_SQL) as unknown as Array<{ name: string; version: string }>
      const out = new Map<string, Set<string>>()
      for (const r of rows) out.set(r.name, (out.get(r.name) ?? new Set()).add(r.version))
      return out
    } catch {
      return undefined
    }
  }

  private async fetchExtensions(dbUrl: string): Promise<PgExtension[]> {
    return await this.queryFn(dbUrl, EXTENSIONS_SQL) as unknown as PgExtension[]
  }
}

const EXTENSIONS_SQL = `
  SELECT e.extname AS name,
         e.extversion AS version,
         n.nspname AS schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  ORDER BY e.extname
`

const UPDATES_SQL = `
  SELECT e.extname AS name, p.target AS version
  FROM pg_extension e
  CROSS JOIN LATERAL pg_extension_update_paths(e.extname) p
  WHERE p.source = e.extversion AND p.path IS NOT NULL
`

/**
 * `reachable`: the versions each of the target's extensions can be updated
 * to there. A version mismatch gets its ALTER EXTENSION only when the
 * source's is one of them: PostgreSQL has no way down a version, and a
 * server may not ship the one asked for, and either failed the whole apply.
 */
export function diffExtensions(source: PgExtension[], target: PgExtension[], reachable?: Map<string, Set<string>>): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(e => [e.name, e]))
  const targetMap = new Map(target.map(e => [e.name, e]))

  // Enabled in source but missing in target
  for (const [name, ext] of sourceMap) {
    if (!targetMap.has(name)) {
      issues.push({
        id: `ext-missing-${name}`,
        check: 'extensions',
        severity: 'warning',
        title: `Missing extension: ${name}`,
        description: `Extension "${name}" (v${ext.version}) is enabled in source (schema: ${ext.schema}) but not in target.`,
        sourceValue: ext,
        sql: {
          // Into the schema it is in on the source, which plain PostgreSQL
          // may not have — Supabase's `extensions`. Made first; if the server
          // does not ship the extension, the fix is left out with it.
          up: ext.schema !== 'public'
            ? `CREATE SCHEMA IF NOT EXISTS ${quoteName(ext.schema)};\nCREATE EXTENSION IF NOT EXISTS ${quoteName(name)} SCHEMA ${quoteName(ext.schema)};`
            : `CREATE EXTENSION IF NOT EXISTS ${quoteName(name)};`,
          down: `DROP EXTENSION IF EXISTS ${quoteName(name)};`,
        },
      })
    }
  }

  // Enabled in target but not in source
  for (const [name, ext] of targetMap) {
    if (!sourceMap.has(name)) {
      issues.push({
        id: `ext-extra-${name}`,
        check: 'extensions',
        severity: 'info',
        title: `Extra extension: ${name}`,
        description: `Extension "${name}" (v${ext.version}) is enabled in target (schema: ${ext.schema}) but not in source.`,
        targetValue: ext,
      })
    }
  }

  // Version mismatch
  for (const [name, srcExt] of sourceMap) {
    const tgtExt = targetMap.get(name)
    if (!tgtExt) continue

    if (srcExt.version !== tgtExt.version) {
      const updatable = !reachable || reachable.get(name)?.has(srcExt.version)
      issues.push({
        id: `ext-version-${name}`,
        check: 'extensions',
        severity: 'info',
        title: `Extension version mismatch: ${name}`,
        description: `Extension "${name}" is v${srcExt.version} in source but v${tgtExt.version} in target.`,
        sourceValue: srcExt,
        targetValue: tgtExt,
        ...(updatable
          ? {
              sql: {
                up: `ALTER EXTENSION ${quoteName(name)} UPDATE TO ${quoteLiteral(srcExt.version)};`,
                down: `ALTER EXTENSION ${quoteName(name)} UPDATE TO ${quoteLiteral(tgtExt.version)};`,
              },
            }
          : { manualOnly: `the target cannot go from v${tgtExt.version} to v${srcExt.version}: its server has no update path there (an extension cannot be moved down a version)` }),
      })
    }
  }

  return issues
}
