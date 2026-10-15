import { describe, expect, it } from 'vitest'
import { diffPartitionSets, type PartitionSet } from '../../src/checks/partitions.js'

const set = (o: Partial<PartitionSet> = {}): PartitionSet => ({
  parent_table: 'public.events', control: 'created_at', partition_interval: '1 day', partition_type: 'range',
  epoch: 'none', premake: 4, automatic_maintenance: 'on', constraint_cols: null, jobmon: true,
  date_trunc_interval: null, time_encoder: null, time_decoder: null, has_default: true,
  settings: { premake: 4, retention: null, retention_keep_table: true }, ...o,
})

describe('partition sets check', () => {
  it('registers a set the target lacks through create_parent, with its settings', () => {
    const [issue] = diffPartitionSets([set()], [], 'partman')
    expect(issue.title).toBe('Partition set not registered: public.events')
    expect(issue.sql!.up).toContain(`SELECT "partman".create_parent(p_parent_table => 'public.events', p_control => 'created_at', p_interval => '1 day'`)
    expect(issue.sql!.up).toContain(`UPDATE "partman".part_config SET "premake" = 4, "retention" = NULL, "retention_keep_table" = true WHERE parent_table = 'public.events';`)
    expect(issue.sql!.down).toBe(`DELETE FROM "partman".part_config WHERE parent_table = 'public.events';`)
  })

  it('updates only the settings that differ, and back', () => {
    const [issue] = diffPartitionSets(
      [set({ settings: { premake: 4, retention: '30 days', retention_keep_table: false } })],
      [set()], 'partman')
    expect(issue.sql).toEqual({
      up: `UPDATE "partman".part_config SET "retention" = '30 days', "retention_keep_table" = false WHERE parent_table = 'public.events';`,
      down: `UPDATE "partman".part_config SET "retention" = NULL, "retention_keep_table" = true WHERE parent_table = 'public.events';`,
    })
  })

  it('leaves a change of interval, and a set only the target has, to the user', () => {
    const issues = diffPartitionSets([set({ partition_interval: '1 week' })], [set(), set({ parent_table: 'public.logs' })], 'partman')
    expect(issues.map(i => [i.title, Boolean(i.manualOnly)])).toEqual([
      ['Partition set differs: public.events', true],
      ['Extra partition set: public.logs', true],
    ])
  })

  it('reports nothing for sets alike', () => {
    expect(diffPartitionSets([set()], [set()], 'partman')).toEqual([])
  })
})
