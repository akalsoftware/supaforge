import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { quoteIdent, quoteLiteral } from '../utils/sql'
import { Check, CheckSkipped, type CheckContext } from './base'

/** A pg_partman partition set, as its part_config row records it. */
export interface PartitionSet {
  parent_table: string
  control: string
  partition_interval: string
  partition_type: string
  epoch: string
  premake: number
  automatic_maintenance: string
  constraint_cols: string[] | null
  jobmon: boolean
  date_trunc_interval: string | null
  time_encoder: string | null
  time_decoder: string | null
  has_default: boolean
  /** The settings part_config takes by UPDATE, by column. */
  settings: Record<string, unknown>
}

/** What decides how the set is partitioned: changed, it has to be rebuilt. */
const SHAPE = ['control', 'partition_interval', 'partition_type', 'epoch', 'time_encoder', 'time_decoder'] as const

/** part_config columns pg_partman documents setting with UPDATE. */
const SETTINGS = [
  'premake', 'automatic_maintenance', 'retention', 'retention_schema', 'retention_keep_index', 'retention_keep_table',
  'optimize_constraint', 'infinite_time_partitions', 'inherit_privileges', 'constraint_valid', 'ignore_default_data',
  'maintenance_order', 'retention_keep_publication', 'detach_before_drop', 'jobmon', 'date_trunc_interval',
]

/**
 * pg_partman partition sets, compared by their registration.
 *
 * The partitions themselves are pg_partman's to make and drop, so the schema
 * diff leaves them alone; what makes a set is its row in part_config, written
 * by create_parent(). A set the target lacks is registered through that
 * function, and its settings put as the source has them; a setting that
 * differs is updated where it stands. How the set is partitioned — its
 * control column, interval or type — cannot be changed in place, so a
 * difference there, and a set only the target has, are left to the user.
 */
export class PartitionsCheck extends Check {
  readonly name = 'partitions' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([this.fetch(ctx.source.dbUrl), this.fetch(ctx.target.dbUrl)])
    if (source.schema === null && target.schema === null) {
      throw new CheckSkipped('pg_partman extension not installed')
    }
    return diffPartitionSets(source.sets, target.sets, target.schema)
  }

  private async fetch(dbUrl: string): Promise<{ schema: string | null; sets: PartitionSet[] }> {
    const rows = await this.queryFn(dbUrl, `SELECT n.nspname AS schema FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_partman'`) as Array<{ schema: string }>
    const schema = rows[0]?.schema ?? null
    if (schema === null) return { schema, sets: [] }
    const sets = await this.queryFn(dbUrl, `
      SELECT (SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.oid = to_regclass(pc.parent_table)) AS parent_table, pc.control, pc.partition_interval, pc.partition_type,
             pc.epoch, pc.premake, pc.automatic_maintenance, pc.constraint_cols, pc.jobmon, pc.date_trunc_interval,
             pc.time_encoder, pc.time_decoder,
             to_regclass(pc.parent_table || '_default') IS NOT NULL AS has_default,
             (to_jsonb(pc) - ARRAY(SELECT k FROM jsonb_object_keys(to_jsonb(pc)) k WHERE k <> ALL($1::text[]))) AS settings
        FROM ${quoteIdent(schema)}.part_config pc
       WHERE to_regclass(pc.parent_table) IS NOT NULL
       ORDER BY 1`, [SETTINGS]) as unknown as PartitionSet[]
    return { schema, sets }
  }
}

const literal = (v: unknown): string =>
  v === null || v === undefined ? 'NULL'
    : typeof v === 'boolean' || typeof v === 'number' ? String(v)
      : Array.isArray(v) ? `ARRAY[${v.map(x => quoteLiteral(String(x))).join(', ')}]::text[]`
        : quoteLiteral(String(v))

function registerSql(set: PartitionSet, schema: string): string {
  const args = [
    `p_parent_table => ${quoteLiteral(set.parent_table)}`,
    `p_control => ${quoteLiteral(set.control)}`,
    `p_interval => ${quoteLiteral(set.partition_interval)}`,
    `p_type => ${quoteLiteral(set.partition_type)}`,
    `p_epoch => ${quoteLiteral(set.epoch)}`,
    `p_premake => ${set.premake}`,
    `p_default_table => ${set.has_default}`,
    `p_automatic_maintenance => ${quoteLiteral(set.automatic_maintenance)}`,
    `p_jobmon => ${set.jobmon}`,
    ...(set.constraint_cols?.length ? [`p_constraint_cols => ${literal(set.constraint_cols)}`] : []),
    ...(set.date_trunc_interval ? [`p_date_trunc_interval => ${quoteLiteral(set.date_trunc_interval)}`] : []),
    ...(set.time_encoder ? [`p_time_encoder => ${quoteLiteral(set.time_encoder)}`] : []),
    ...(set.time_decoder ? [`p_time_decoder => ${quoteLiteral(set.time_decoder)}`] : []),
  ]
  return `SELECT ${quoteIdent(schema)}.create_parent(${args.join(', ')});`
}

function updateSql(schema: string, parent: string, settings: Record<string, unknown>): string {
  const sets = Object.entries(settings).map(([k, v]) => `${quoteIdent(k)} = ${literal(v)}`)
  return `UPDATE ${quoteIdent(schema)}.part_config SET ${sets.join(', ')} WHERE parent_table = ${quoteLiteral(parent)};`
}

function undoSql(schema: string, parent: string): string {
  return `DELETE FROM ${quoteIdent(schema)}.part_config WHERE parent_table = ${quoteLiteral(parent)};`
}

export function diffPartitionSets(source: PartitionSet[], target: PartitionSet[], targetSchema: string | null): DriftIssue[] {
  const issues: DriftIssue[] = []
  const targetMap = new Map(target.map(s => [s.parent_table, s]))
  const sourceNames = new Set(source.map(s => s.parent_table))

  for (const s of source) {
    const t = targetMap.get(s.parent_table)
    if (!t) {
      issues.push({
        id: `partitions-missing-${s.parent_table}`,
        check: 'partitions',
        severity: 'warning',
        title: `Partition set not registered: ${s.parent_table}`,
        description: `pg_partman manages ${s.parent_table} in source (${s.partition_type} by ${s.control}, every ${s.partition_interval}) but not in target.`,
        sourceValue: s,
        ...(targetSchema
          ? { sql: { up: `${registerSql(s, targetSchema)}\n${updateSql(targetSchema, s.parent_table, s.settings)}`, down: undoSql(targetSchema, s.parent_table) } }
          : { manualOnly: 'the target does not have pg_partman; install it, then re-run to register the partition set' }),
      })
      continue
    }
    const reshaped = SHAPE.filter(k => String(s[k] ?? '') !== String(t[k] ?? ''))
    if (reshaped.length > 0) {
      issues.push({
        id: `partitions-shape-${s.parent_table}`,
        check: 'partitions',
        severity: 'warning',
        title: `Partition set differs: ${s.parent_table}`,
        description: `${reshaped.join(', ')} differ${reshaped.length === 1 ? 's' : ''} for ${s.parent_table}. pg_partman cannot change that in place.`,
        sourceValue: s,
        targetValue: t,
        manualOnly: 'changing how a set is partitioned means undoing and recreating it with pg_partman (undo_partition, then create_parent)',
      })
      continue
    }
    const changed = Object.fromEntries(Object.entries(s.settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(t.settings[k])))
    if (Object.keys(changed).length > 0 && targetSchema) {
      const previous = Object.fromEntries(Object.keys(changed).map(k => [k, t.settings[k]]))
      issues.push({
        id: `partitions-settings-${s.parent_table}`,
        check: 'partitions',
        severity: 'warning',
        title: `Partition set settings differ: ${s.parent_table}`,
        description: `${Object.keys(changed).join(', ')} differ for ${s.parent_table}.`,
        sourceValue: s.settings,
        targetValue: t.settings,
        sql: { up: updateSql(targetSchema, s.parent_table, changed), down: updateSql(targetSchema, s.parent_table, previous) },
      })
    }
  }

  for (const t of target) {
    if (sourceNames.has(t.parent_table)) continue
    issues.push({
      id: `partitions-extra-${t.parent_table}`,
      check: 'partitions',
      severity: 'info',
      title: `Extra partition set: ${t.parent_table}`,
      description: `pg_partman manages ${t.parent_table} in target but not in source.`,
      targetValue: t,
      manualOnly: 'unregistering a set leaves its partitions as ordinary tables; use pg_partman\'s undo_partition if that is what you want',
    })
  }
  return issues
}
