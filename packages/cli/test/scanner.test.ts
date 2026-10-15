import { describe, it, expect } from 'vitest'
import { scan } from '../src/scanner.js'
import { CheckRegistry } from '../src/checks/registry.js'
import { Check, CheckSkipped, type CheckContext } from '../src/checks/base.js'
import { HookBus } from '../src/hooks.js'
import type { DriftIssue, CheckName } from '../src/types/drift.js'
import type { SupaForgeConfig } from '../src/types/config.js'

class MockLayer extends Check {
  readonly name: CheckName
  private issues: DriftIssue[]

  constructor(name: CheckName, issues: DriftIssue[] = []) {
    super()
    this.name = name
    this.issues = issues
  }

  async scan(_ctx: CheckContext): Promise<DriftIssue[]> {
    return this.issues
  }
}

class ErrorLayer extends Check {
  readonly name = 'auth' as const
  async scan(): Promise<DriftIssue[]> {
    throw new Error('connection refused')
  }
}

const config: SupaForgeConfig = {
  environments: {
    dev: { dbUrl: 'postgres://localhost/dev' },
    prod: { dbUrl: 'postgres://localhost/prod' },
  },
  source: 'dev',
  target: 'prod',
}

describe('scan', () => {
  it('returns clean results when no issues found', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config, checks: ['rls'] })

    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].status).toBe('clean')
    expect(result.summary.total).toBe(0)
    expect(result.score).toBe(100)
  })

  // What a check could not compare is said beside its result, and is not
  // drift: the check stays clean and the score whole.
  it('keeps a check\'s notices beside its findings, out of the count', async () => {
    class NoticingLayer extends Check {
      readonly name = 'schema' as const
      async scan(ctx: CheckContext): Promise<DriftIssue[]> {
        ctx.onNotice?.('Not compared: Operator (source 1, target 0: ===) — check them by hand.')
        return []
      }
    }
    const registry = new CheckRegistry()
    registry.register(new NoticingLayer())

    const result = await scan(registry, { config, checks: ['schema'] })

    expect(result.checks[0]).toMatchObject({
      status: 'clean',
      notices: ['Not compared: Operator (source 1, target 0: ===) — check them by hand.'],
    })
    expect(result.summary.total).toBe(0)
    expect(result.score).toBe(100)
  })

  it('returns drifted status when issues found', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls', [
      { id: '1', check: 'rls', severity: 'critical', title: 'Missing policy', description: '' },
    ]))

    const result = await scan(registry, { config, checks: ['rls'] })

    expect(result.checks[0].status).toBe('drifted')
    expect(result.summary.total).toBe(1)
    expect(result.summary.critical).toBe(1)
  })

  it('handles check errors gracefully', async () => {
    const registry = new CheckRegistry()
    registry.register(new ErrorLayer())

    const result = await scan(registry, { config, checks: ['auth'] })

    expect(result.checks[0].status).toBe('error')
    expect(result.checks[0].error).toContain('Cannot connect to PostgreSQL')
    expect(result.score).toBeLessThan(100)
  })

  it('skips unregistered checks', async () => {
    const registry = new CheckRegistry()

    const result = await scan(registry, { config, checks: ['cron'] })

    expect(result.checks[0].status).toBe('skipped')
  })

  it('scans multiple checks', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))
    registry.register(new MockLayer('cron', [
      { id: '1', check: 'cron', severity: 'warning', title: 'Missing job', description: '' },
    ]))

    const result = await scan(registry, { config, checks: ['rls', 'cron'] })

    expect(result.checks).toHaveLength(2)
    expect(result.checks[0].status).toBe('clean')
    expect(result.checks[1].status).toBe('drifted')
  })

  it('fires hook bus events', async () => {
    const bus = new HookBus()
    const events: string[] = []

    bus.on('supaforge.scan.before', () => { events.push('scan.before') })
    bus.on('supaforge.check.before', () => { events.push('check.before') })
    bus.on('supaforge.check.after', () => { events.push('check.after') })
    bus.on('supaforge.scan.after', () => { events.push('scan.after') })

    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    await scan(registry, { config, checks: ['rls'] }, bus)

    expect(events).toEqual([
      'scan.before',
      'check.before',
      'check.after',
      'scan.after',
    ])
  })

  it('includes timestamp and environment names', async () => {
    const registry = new CheckRegistry()
    const result = await scan(registry, { config, checks: ['schema'] })

    expect(result.source).toBe('dev')
    expect(result.target).toBe('prod')
    expect(result.timestamp).toBeTruthy()
  })
})

describe('scan — skip option', () => {
  it('skips a check listed in the skip option', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))
    registry.register(new MockLayer('cron'))

    const result = await scan(registry, { config, skip: ['cron'] })

    const names = result.checks.map(c => c.check)
    expect(names).not.toContain('cron')
    expect(names).toContain('rls')
  })

  it('skip takes precedence over an explicit checks include', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    // ask for rls but also skip rls → nothing runs
    const result = await scan(registry, { config, checks: ['rls'], skip: ['rls'] })

    expect(result.checks).toHaveLength(0)
  })

  it('skips multiple checks when skip contains several names', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))
    registry.register(new MockLayer('storage'))
    registry.register(new MockLayer('vault'))

    const result = await scan(registry, { config, skip: ['storage', 'vault'] })

    const names = result.checks.map(c => c.check)
    expect(names).toContain('rls')
    expect(names).not.toContain('storage')
    expect(names).not.toContain('vault')
  })

  it('respects config.checks.exclude as a permanent skip list', async () => {
    const configWithExclude: SupaForgeConfig = {
      ...config,
      checks: { exclude: ['auth', 'edge-functions', 'realtime'] },
    }
    const registry = new CheckRegistry()
    registry.register(new MockLayer('auth'))
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config: configWithExclude })

    const names = result.checks.map(c => c.check)
    expect(names).not.toContain('auth')
    expect(names).not.toContain('edge-functions')
    expect(names).not.toContain('realtime')
    expect(names).toContain('rls')
  })

  it('merges CLI skip and config.checks.exclude', async () => {
    const configWithExclude: SupaForgeConfig = {
      ...config,
      checks: { exclude: ['vault'] },
    }
    const registry = new CheckRegistry()
    registry.register(new MockLayer('vault'))
    registry.register(new MockLayer('storage'))
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config: configWithExclude, skip: ['storage'] })

    const names = result.checks.map(c => c.check)
    expect(names).not.toContain('vault')    // from config.checks.exclude
    expect(names).not.toContain('storage')  // from CLI skip
    expect(names).toContain('rls')
  })

  it('returns empty checks array when all checks are skipped', async () => {
    const registry = new CheckRegistry()
    registry.register(new MockLayer('rls'))

    const result = await scan(registry, { config, checks: ['rls'], skip: ['rls'] })

    expect(result.checks).toHaveLength(0)
    expect(result.summary.total).toBe(0)
    expect(result.score).toBe(100)
  })
})

// ─── issue #42: a check that declines to run is not a check that passed ──────

describe('skipped checks are distinguishable from clean ones (issue #42)', () => {
  class SkippingCheck extends Check {
    readonly name = 'auth' as const
    async scan(): Promise<DriftIssue[]> {
      throw new CheckSkipped('no projectRef or accessToken configured')
    }
  }

  class CleanCheck extends Check {
    readonly name = 'cron' as const
    async scan(): Promise<DriftIssue[]> {
      return []
    }
  }

  class BrokenCheck extends Check {
    readonly name = 'rls' as const
    async scan(): Promise<DriftIssue[]> {
      throw new Error('connection refused')
    }
  }

  function registryWith(...checks: Check[]): CheckRegistry {
    const reg = new CheckRegistry()
    for (const c of checks) reg.register(c)
    return reg
  }

  const config = {
    environments: { dev: { dbUrl: 'postgres://s' }, prod: { dbUrl: 'postgres://t' } },
    source: 'dev',
    target: 'prod',
  }

  it('records status skipped with the reason, not a clean pass', async () => {
    const result = await scan(registryWith(new SkippingCheck()), { config, checks: ['auth'] })
    expect(result.checks[0].status).toBe('skipped')
    expect(result.checks[0].skipReason).toBe('no projectRef or accessToken configured')
    expect(result.checks[0].issues).toEqual([])
  })

  it('keeps a genuinely clean check clean', async () => {
    // The distinction is the whole point: both produce zero issues.
    const result = await scan(registryWith(new CleanCheck()), { config, checks: ['cron'] })
    expect(result.checks[0].status).toBe('clean')
    expect(result.checks[0].skipReason).toBeUndefined()
  })

  it('does not treat a skip as an error', async () => {
    const result = await scan(registryWith(new SkippingCheck()), { config, checks: ['auth'] })
    expect(result.checks[0].status).not.toBe('error')
    expect(result.checks[0].error).toBeUndefined()
  })

  it('still treats a real failure as an error', async () => {
    const result = await scan(registryWith(new BrokenCheck()), { config, checks: ['rls'] })
    expect(result.checks[0].status).toBe('error')
    expect(result.checks[0].error).toBeTruthy()
  })

  it('reports the skip reason through onProgress', async () => {
    const events: Array<Record<string, unknown>> = []
    await scan(registryWith(new SkippingCheck()), {
      config,
      checks: ['auth'],
      onProgress: (e) => events.push(e as unknown as Record<string, unknown>),
    })
    const done = events.find(e => e.phase === 'check:done')!
    expect(done.status).toBe('skipped')
    expect(done.skipReason).toBe('no projectRef or accessToken configured')
  })

  it('a skip does not reduce the drift score', async () => {
    // Penalising it would give every self-hosted project a permanently
    // depressed score for layers it deliberately cannot run. Coverage is
    // reported separately instead.
    const result = await scan(registryWith(new SkippingCheck()), { config, checks: ['auth'] })
    expect(result.score).toBe(100)
  })
})

/**
 * Independent checks run a few at a time (issue #78).
 *
 * They share nothing and each is mostly waiting on a database, so running them
 * one after another paid the sum of their latencies: the 13 non-schema checks
 * took about 9 s of a 48 s diff over a 100 ms link.
 *
 * Two properties matter and pull in opposite directions — work must overlap,
 * and the report must not depend on which check happens to finish first.
 */
class SlowLayer extends Check {
  readonly name: CheckName
  constructor(name: CheckName, private ms: number, private log: string[]) {
    super()
    this.name = name
  }

  async scan(_ctx: CheckContext): Promise<DriftIssue[]> {
    this.log.push(`start:${this.name}`)
    await new Promise(resolve => setTimeout(resolve, this.ms))
    this.log.push(`end:${this.name}`)
    return []
  }
}

/** Records how many scans were in flight at once. */
class CountingLayer extends Check {
  readonly name: CheckName
  constructor(name: CheckName, private state: { now: number; peak: number }) {
    super()
    this.name = name
  }

  async scan(): Promise<DriftIssue[]> {
    this.state.now++
    this.state.peak = Math.max(this.state.peak, this.state.now)
    await new Promise(resolve => setTimeout(resolve, 20))
    this.state.now--
    return []
  }
}

describe('scan concurrency', () => {
  const four: CheckName[] = ['rls', 'cron', 'vault', 'extensions']

  function registryOf(checks: Check[]): CheckRegistry {
    const registry = new CheckRegistry()
    for (const c of checks) registry.register(c)
    return registry
  }

  it('overlaps independent checks', async () => {
    const log: string[] = []
    const registry = registryOf(four.map(n => new SlowLayer(n, 40, log)))

    await scan(registry, { config, checks: four })

    // Serial execution gives start,end,start,end… Overlap means at least one
    // check starts before an earlier one ends.
    const firstEnd = log.findIndex(e => e.startsWith('end:'))
    const startsBeforeFirstEnd = log.slice(0, firstEnd).filter(e => e.startsWith('start:')).length
    expect(startsBeforeFirstEnd).toBeGreaterThan(1)
  })

  it('is faster than the sum of its parts', async () => {
    const log: string[] = []
    const registry = registryOf(four.map(n => new SlowLayer(n, 60, log)))

    const started = Date.now()
    await scan(registry, { config, checks: four })
    const elapsed = Date.now() - started

    // Four 60 ms checks: 240 ms serially, about 60 ms at a concurrency of four.
    // Asserting a generous bound rather than a tight one, because a loaded CI
    // box should not make this flake.
    expect(elapsed).toBeLessThan(200)
  })

  it('keeps the report in check order however they finish', async () => {
    const log: string[] = []
    // Descending durations, so completion order is the reverse of check order.
    const registry = registryOf([
      new SlowLayer('rls', 80, log),
      new SlowLayer('cron', 60, log),
      new SlowLayer('vault', 40, log),
      new SlowLayer('extensions', 20, log),
    ])

    const result = await scan(registry, { config, checks: four })

    expect(result.checks.map(c => c.check)).toEqual(four)
    // …and the reverse really did finish first, so the ordering was exercised.
    expect(log.filter(e => e.startsWith('end:'))[0]).toBe('end:extensions')
  })

  it('never exceeds the concurrency limit', async () => {
    const state = { now: 0, peak: 0 }
    const names: CheckName[] = ['rls', 'cron', 'vault', 'extensions', 'storage', 'auth']
    const registry = registryOf(names.map(n => new CountingLayer(n, state)))

    await scan(registry, { config, checks: names })

    expect(state.peak).toBeLessThanOrEqual(4)
    expect(state.peak).toBeGreaterThan(1)
  })

  it('runs one at a time when asked to', async () => {
    const previous = process.env.SUPAFORGE_CHECK_CONCURRENCY
    process.env.SUPAFORGE_CHECK_CONCURRENCY = '1'
    try {
      const state = { now: 0, peak: 0 }
      const registry = registryOf(four.map(n => new CountingLayer(n, state)))

      await scan(registry, { config, checks: four })

      expect(state.peak).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.SUPAFORGE_CHECK_CONCURRENCY
      else process.env.SUPAFORGE_CHECK_CONCURRENCY = previous
    }
  })

  it('reports progress for every check, with its own index', async () => {
    const log: string[] = []
    const registry = registryOf(four.map(n => new SlowLayer(n, 10, log)))
    const done: Array<{ check: string; index: number }> = []

    await scan(registry, {
      config,
      checks: four,
      onProgress: (e) => {
        if (e.phase === 'check:done') done.push({ check: e.check, index: e.index })
      },
    })

    expect(done).toHaveLength(4)
    // The index travels with the event, so interleaved output stays meaningful.
    expect(done.map(d => d.index).sort()).toEqual([0, 1, 2, 3])
  })

  it('still records an errored check in its own slot', async () => {
    const registry = registryOf([
      new SlowLayer('rls', 30, []),
      new ErrorLayer(),
      new SlowLayer('cron', 10, []),
    ])

    const result = await scan(registry, { config, checks: ['rls', 'auth', 'cron'] })

    expect(result.checks.map(c => c.check)).toEqual(['rls', 'auth', 'cron'])
    expect(result.checks[1].status).toBe('error')
  })
})
