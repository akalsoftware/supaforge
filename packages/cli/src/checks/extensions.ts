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
    const [source, target] = await Promise.all([
      this.fetchExtensions(ctx.source.dbUrl),
      this.fetchExtensions(ctx.target.dbUrl),
    ])
    const ignored = new Set(ctx.config.ignoreExtensions ?? [])
    return diffExtensions(source, target.filter(e => !ignored.has(e.name) || source.some(s => s.name === e.name)))
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

export function diffExtensions(source: PgExtension[], target: PgExtension[]): DriftIssue[] {
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
          up: `CREATE EXTENSION IF NOT EXISTS ${quoteName(name)}${ext.schema !== 'public' ? ` SCHEMA ${quoteName(ext.schema)}` : ''};`,
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
      issues.push({
        id: `ext-version-${name}`,
        check: 'extensions',
        severity: 'info',
        title: `Extension version mismatch: ${name}`,
        description: `Extension "${name}" is v${srcExt.version} in source but v${tgtExt.version} in target.`,
        sourceValue: srcExt,
        targetValue: tgtExt,
        sql: {
          up: `ALTER EXTENSION ${quoteName(name)} UPDATE TO ${quoteLiteral(srcExt.version)};`,
          down: `ALTER EXTENSION ${quoteName(name)} UPDATE TO ${quoteLiteral(tgtExt.version)};`,
        },
      })
    }
  }

  return issues
}
