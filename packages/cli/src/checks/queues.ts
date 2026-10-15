import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { quoteLiteral } from '../utils/sql'
import { Check, CheckSkipped, readOrAbsent, type CheckContext } from './base'

/** A pgmq queue, as `pgmq.meta` records it. */
export interface Queue {
  queue_name: string
  is_partitioned: boolean
  is_unlogged: boolean
}

/**
 * Supabase Queues: pgmq's queues, compared by name and kind.
 *
 * A queue is tables pgmq makes and registers as its extension's own, so a
 * schema diff — which leaves an extension's objects to the extension —
 * never saw one: a queue the target lacked went unreported. Compared here
 * from `pgmq.meta`, and created or dropped through pgmq's own functions,
 * which keep its registry and the queue's tables in step. Dropping a queue
 * drops its messages, so it is held back like any destructive fix.
 */
export class QueuesCheck extends Check {
  readonly name = 'queues' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchQueues(ctx.source.dbUrl),
      this.fetchQueues(ctx.target.dbUrl),
    ])
    if (!source.available && !target.available) {
      throw new CheckSkipped('pgmq extension not installed')
    }
    return diffQueues(source.queues, target.queues, target.available)
  }

  private async fetchQueues(dbUrl: string): Promise<{ queues: Queue[]; available: boolean }> {
    return readOrAbsent<{ queues: Queue[]; available: boolean }>(
      async () => ({ queues: await this.queryFn(dbUrl, QUEUES_SQL) as unknown as Queue[], available: true }),
      { queues: [], available: false },
    )
  }
}

const QUEUES_SQL = `
  SELECT queue_name, is_partitioned, is_unlogged
  FROM pgmq.meta
  ORDER BY queue_name
`

/** The statement pgmq creates one with, or undefined for a partitioned queue. */
function createSql(q: Queue): string | undefined {
  if (q.is_partitioned) return undefined
  return `SELECT pgmq.${q.is_unlogged ? 'create_unlogged' : 'create'}(${quoteLiteral(q.queue_name)});`
}

const dropSql = (q: Queue) => `SELECT pgmq.drop_queue(${quoteLiteral(q.queue_name)});`

const kind = (q: Queue) => q.is_partitioned ? 'partitioned' : q.is_unlogged ? 'unlogged' : 'standard'

export function diffQueues(source: Queue[], target: Queue[], targetHasPgmq = true): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(q => [q.queue_name, q]))
  const targetMap = new Map(target.map(q => [q.queue_name, q]))
  const needsExtension = targetHasPgmq ? '' : 'CREATE EXTENSION IF NOT EXISTS pgmq;\n'

  for (const [name, q] of sourceMap) {
    const t = targetMap.get(name)
    if (!t) {
      const up = createSql(q)
      issues.push({
        id: `queues-missing-${name}`,
        check: 'queues',
        severity: 'warning',
        title: `Missing queue: ${name}`,
        description: `Queue "${name}" (${kind(q)}) exists in source but not in target.`,
        sourceValue: q,
        ...(up
          ? { sql: { up: needsExtension + up, down: dropSql(q) } }
          : { manualOnly: 'a partitioned queue is created with pg_partman settings pgmq.meta does not record — create it with pgmq.create_partitioned on the target' }),
      })
    } else if (kind(q) !== kind(t)) {
      issues.push({
        id: `queues-kind-${name}`,
        check: 'queues',
        severity: 'warning',
        title: `Queue kind differs: ${name}`,
        description: `Queue "${name}" is ${kind(q)} in source and ${kind(t)} in target. Changing it means dropping the queue and its messages, so it is left to you.`,
        sourceValue: q,
        targetValue: t,
        manualOnly: 'changing a queue\'s kind drops it and its messages; recreate it by hand when it is empty',
      })
    }
  }

  for (const [name, t] of targetMap) {
    if (sourceMap.has(name)) continue
    const down = createSql(t)
    issues.push({
      id: `queues-extra-${name}`,
      check: 'queues',
      severity: 'critical',
      title: `Extra queue: ${name}`,
      description: `Queue "${name}" exists in target but not in source. Dropping it drops its messages.`,
      targetValue: t,
      sql: { up: dropSql(t), down: down ?? '' },
    })
  }
  return issues
}
