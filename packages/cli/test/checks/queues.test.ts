import { describe, expect, it } from 'vitest'
import { QueuesCheck, diffQueues, type Queue } from '../../src/checks/queues.js'
import { destructiveReason } from '../../src/dbdiff.js'

const q = (queue_name: string, o: Partial<Queue> = {}): Queue => ({ queue_name, is_partitioned: false, is_unlogged: false, ...o })

describe('queues check', () => {
  it('creates a missing queue through pgmq, and drops it again on the way down', () => {
    const [issue] = diffQueues([q('jobs')], [])
    expect(issue).toMatchObject({ title: 'Missing queue: jobs', severity: 'warning' })
    expect(issue.sql).toEqual({ up: "SELECT pgmq.create('jobs');", down: "SELECT pgmq.drop_queue('jobs');" })
  })

  it('creates an unlogged queue as one, and installs pgmq first where the target lacks it', () => {
    const [issue] = diffQueues([q('fast', { is_unlogged: true })], [], false)
    expect(issue.sql!.up).toBe("CREATE EXTENSION IF NOT EXISTS pgmq;\nSELECT pgmq.create_unlogged('fast');")
  })

  it('leaves a partitioned queue, and a change of kind, as manual steps', () => {
    const issues = diffQueues([q('big', { is_partitioned: true }), q('k')], [q('k', { is_unlogged: true })])
    expect(issues.map(i => [i.title, Boolean(i.manualOnly), i.sql])).toEqual([
      ['Missing queue: big', true, undefined],
      ['Queue kind differs: k', true, undefined],
    ])
  })

  it('reports an extra queue as critical, and the drop is held back as destructive', () => {
    const [issue] = diffQueues([], [q('old')])
    expect(issue).toMatchObject({ title: 'Extra queue: old', severity: 'critical' })
    expect(destructiveReason(issue.sql!.up)).toBe('drops a queue and the messages in it')
  })

  it('is skipped when neither side has pgmq', async () => {
    const check = new QueuesCheck(async () => { throw Object.assign(new Error('relation "pgmq.meta" does not exist'), { code: '42P01' }) })
    await expect(check.scan({ source: { dbUrl: 's' }, target: { dbUrl: 't' }, config: { environments: {} } } as never))
      .rejects.toThrow('pgmq extension not installed')
  })
})
