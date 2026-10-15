import { describe, it, expect } from 'vitest'
import { renderSummary, renderDetailed, countErrored, countSkipped, coverage, splitCounts } from '../src/render.js'
import type { ScanResult } from '../src/types/drift.js'

const cleanResult: ScanResult = {
  timestamp: '2026-03-21T00:00:00.000Z',
  source: 'dev',
  target: 'prod',
  checks: [
    { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
  ],
  score: 100,
  postureScore: null,
  summary: { total: 0, critical: 0, warning: 0, info: 0 },
}

const driftedResult: ScanResult = {
  timestamp: '2026-03-21T00:00:00.000Z',
  source: 'dev',
  target: 'prod',
  checks: [
    {
      check: 'rls',
      status: 'drifted',
      issues: [{
        id: '1',
        check: 'rls',
        severity: 'critical',
        title: 'Missing RLS policy: users_read',
        description: 'Policy exists in source but not target',
        sql: { up: 'CREATE POLICY "users_read" ON "public"."users";', down: 'DROP POLICY "users_read";' },
      }],
      durationMs: 20,
    },
    {
      check: 'cron',
      status: 'drifted',
      issues: [{
        id: '2',
        check: 'cron',
        severity: 'warning',
        title: 'Missing cron job: cleanup',
        description: 'Job exists in source but not target',
      }],
      durationMs: 15,
    },
  ],
  score: 80,
  postureScore: null,
  summary: { total: 2, critical: 1, warning: 1, info: 0 },
}

describe('renderSummary', () => {
  it('shows clean message when no drift', () => {
    const output = renderSummary(cleanResult)
    expect(output).toContain('no drift detected')
    expect(output).toContain('100/100')
  })

  it('shows issue count when drift found', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('2 drift issues')
    expect(output).toContain('CRITICAL')
    expect(output).toContain('80/100')
  })

  it('shows source and target', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('dev')
    expect(output).toContain('prod')
  })

  it('shows check names', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('RLS Policies')
    expect(output).toContain('Cron Jobs')
  })
})

describe('notices', () => {
  it('are said under their layer, and the headline still reads clean', () => {
    const out = renderSummary({
      ...cleanResult,
      checks: [{ check: 'schema', status: 'clean', issues: [], notices: ['Not compared: Operator (source 1, target 0: ===) — check them by hand.'], durationMs: 5 }],
    })
    expect(out).toMatch(/Layer 1 \(Schema\):\s+0 issues\n\s+ⓘ Not compared: Operator \(source 1, target 0: ===\) — check them by hand\./)
    expect(out).toMatch(/No drift detected/i)
  })
})

describe('renderDetailed', () => {
  it('includes SQL fixes', () => {
    const output = renderDetailed(driftedResult)
    expect(output).toContain('CREATE POLICY')
    expect(output).toContain('SQL fix')
  })

  it('shows issue details', () => {
    const output = renderDetailed(driftedResult)
    expect(output).toContain('Missing RLS policy')
    expect(output).toContain('CRITICAL')
  })

  it('shows check headers for drifted checks', () => {
    const output = renderDetailed(driftedResult)
    expect(output).toContain('Layer 2: RLS Policies')
    expect(output).toContain('Layer 7: Cron Jobs')
  })
})

describe('error rendering', () => {
  const errorResult: ScanResult = {
    timestamp: '2026-04-13T00:00:00.000Z',
    source: 'local',
    target: 'prod',
    checks: [
      {
        check: 'schema',
        status: 'error',
        issues: [],
        error: 'Command failed: postgres://user:***@host/db',
        durationMs: 50,
      },
      { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
    ],
    score: 90,
    postureScore: null,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }

  it('shows error marker and message for errored checks', () => {
    const output = renderSummary(errorResult)
    expect(output).toContain('✖')
    expect(output).toContain('error:')
    expect(output).toContain('Command failed')
  })

  it('shows clean marker for non-errored checks', () => {
    const output = renderSummary(errorResult)
    expect(output).toContain('✓')
  })

  it('surfaces errored checks with detail and remediation in renderDetailed', () => {
    const output = renderDetailed(errorResult)
    expect(output).toContain('could not run')
    expect(output).toContain('Check failed')
    expect(output).toContain('Command failed')
    // remediation guidance is present
    expect(output).toContain('re-run')
  })

  it('does not leak credentials in errored-check detail', () => {
    const output = renderDetailed(errorResult)
    expect(output).not.toContain('password')
    expect(output).toContain('***')
  })

  it('shows fallback text in detail when errored check has no message', () => {
    const noMsg: ScanResult = {
      ...errorResult,
      checks: [{ check: 'schema', status: 'error', issues: [], durationMs: 10 }],
    }
    const output = renderDetailed(noMsg)
    expect(output).toContain('could not run')
    expect(output).toContain('no error message captured')
  })

  it('does not show raw credentials in error output', () => {
    const output = renderSummary(errorResult)
    expect(output).not.toContain('password')
    expect(output).toContain('***')
  })

  it('shows fallback label when error status has no error message', () => {
    const noMsgResult: ScanResult = {
      ...errorResult,
      checks: [
        { check: 'rls', status: 'error', issues: [], durationMs: 10 },
      ],
    }
    const output = renderSummary(noMsgResult)
    expect(output).toContain('✖')
    expect(output).toContain('error: check failed')
  })
})

describe('score color thresholds', () => {
  function makeResult(score: number): ScanResult {
    return {
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'dev',
      target: 'prod',
      checks: [],
      score,
      postureScore: null,
      summary: { total: 0, critical: 0, warning: 0, info: 0 },
    }
  }

  it('shows score at 100', () => {
    const output = renderSummary(makeResult(100))
    expect(output).toContain('100/100')
  })

  it('shows score at 80 (green boundary)', () => {
    const output = renderSummary(makeResult(80))
    expect(output).toContain('80/100')
  })

  it('shows score at 79 (yellow boundary)', () => {
    const output = renderSummary(makeResult(79))
    expect(output).toContain('79/100')
  })

  it('shows score at 50 (yellow lower boundary)', () => {
    const output = renderSummary(makeResult(50))
    expect(output).toContain('50/100')
  })

  it('shows score at 49 (red boundary)', () => {
    const output = renderSummary(makeResult(49))
    expect(output).toContain('49/100')
  })

  it('shows score at 0', () => {
    const output = renderSummary(makeResult(0))
    expect(output).toContain('0/100')
  })
})

describe('singular and plural nouns', () => {
  it('uses singular "issue" for exactly one drift issue', () => {
    const result: ScanResult = {
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'dev',
      target: 'prod',
      checks: [{
        check: 'rls',
        status: 'drifted',
        issues: [{ id: '1', check: 'rls', severity: 'critical', title: 'Missing policy', description: '' }],
        durationMs: 10,
      }],
      score: 85,
      postureScore: null,
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    }
    const output = renderSummary(result)
    expect(output).toContain('1 drift issue')
    expect(output).not.toContain('1 drift issues')
  })

  it('uses plural "issues" for two or more drift issues', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('2 drift issues')
  })

  it('uses singular "check" when exactly one check has drift', () => {
    const result: ScanResult = {
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'dev',
      target: 'prod',
      checks: [{
        check: 'rls',
        status: 'drifted',
        issues: [{ id: '1', check: 'rls', severity: 'critical', title: 'Missing policy', description: '' }],
        durationMs: 10,
      }],
      score: 85,
      postureScore: null,
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    }
    const output = renderSummary(result)
    expect(output).toContain('1 check')
    expect(output).not.toContain('1 checks')
  })

  it('uses plural "checks" when two or more checks have drift', () => {
    const output = renderSummary(driftedResult)
    expect(output).toContain('2 checks')
  })
})

describe('skipped check rendering', () => {
  const skippedResult: ScanResult = {
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'dev',
    target: 'prod',
    checks: [
      { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
      { check: 'vault', status: 'skipped', issues: [], durationMs: 0 },
    ],
    score: 100,
    postureScore: null,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }

  it('renders skipped check with hollow circle marker', () => {
    const output = renderSummary(skippedResult)
    expect(output).toContain('○')
  })

  it('shows 0 issues for skipped check', () => {
    const output = renderSummary(skippedResult)
    expect(output).toContain('0 issues')
  })
})

describe('action display in renderDetailed', () => {
  const actionResult: ScanResult = {
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'dev',
    target: 'prod',
    checks: [{
      check: 'auth',
      status: 'drifted',
      issues: [{
        id: 'auth-jwt_exp',
        check: 'auth',
        severity: 'critical',
        title: 'Auth config mismatch: JWT_EXP',
        description: '"JWT_EXP" differs between source (3600) and target (7200).',
        action: {
          method: 'PATCH',
          url: 'https://api.supabase.com/v1/projects/abc/config/auth',
          headers: { Authorization: 'Bearer token' },
          body: { JWT_EXP: 3600 },
          label: 'Set auth config "JWT_EXP" to 3600 in target',
        },
      }],
      durationMs: 20,
    }],
    score: 85,
    postureScore: null,
    summary: { total: 1, critical: 1, warning: 0, info: 0 },
  }

  it('shows API action label for action-only issues', () => {
    const output = renderDetailed(actionResult)
    expect(output).toContain('API action')
    expect(output).toContain('Set auth config "JWT_EXP" to 3600 in target')
  })

  it('does not show SQL fix header for action-only issues', () => {
    const output = renderDetailed(actionResult)
    expect(output).not.toContain('SQL fix')
  })

  it('shows action label alongside issue title and description', () => {
    const output = renderDetailed(actionResult)
    expect(output).toContain('Auth config mismatch: JWT_EXP')
    expect(output).toContain('JWT_EXP" differs between source')
    expect(output).toContain('Set auth config "JWT_EXP"')
  })
})


// ── Regression: issue #29 ─────────────────────────────────────────────────
// A scan whose only check errored printed "no drift detected. ✓" and scored
// 97/100. Nothing had been measured, but the output read as a clean run.

const erroredOnly: ScanResult = {
  timestamp: '2026-03-21T00:00:00.000Z',
  source: 'dev',
  target: 'prod',
  checks: [
    { check: 'schema', status: 'error', issues: [], durationMs: 5000, error: 'Schema diff timed out after 5s' },
  ],
  score: 97,
  postureScore: null,
  summary: { total: 0, critical: 0, warning: 0, info: 0 },
}

describe('renderSummary with errored checks (issue #29)', () => {
  it('never claims no drift when a check could not run', () => {
    const out = renderSummary(erroredOnly)
    expect(out).not.toContain('no drift detected')
    expect(out).toContain('could not complete')
    expect(out).toContain('drift is unknown')
  })

  it('still reports a genuinely clean scan as clean', () => {
    expect(renderSummary(cleanResult)).toContain('no drift detected')
  })

  it('flags that drift may be understated when both drift and errors occur', () => {
    const mixed: ScanResult = {
      ...erroredOnly,
      checks: [
        ...erroredOnly.checks,
        { check: 'rls', status: 'drifted', issues: [
          { id: 'rls-1', check: 'rls', severity: 'critical', title: 'x', description: 'y' },
        ], durationMs: 10 },
      ],
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    }
    const out = renderSummary(mixed)
    expect(out).toContain('1 drift issue')
    expect(out).toContain('drift may be understated')
  })

  it('pluralises the errored-check noun', () => {
    const two: ScanResult = {
      ...erroredOnly,
      checks: [
        erroredOnly.checks[0],
        { check: 'rls', status: 'error', issues: [], durationMs: 1, error: 'boom' },
      ],
    }
    expect(renderSummary(two)).toContain('2 checks could not complete')
    expect(renderSummary(erroredOnly)).toContain('1 check could not complete')
  })
})

describe('countErrored', () => {
  it('counts only errored checks', () => {
    expect(countErrored(erroredOnly)).toBe(1)
    expect(countErrored(cleanResult)).toBe(0)
  })

  it('tolerates a malformed or partial result rather than throwing', () => {
    // Defensive: an older cached report or a hand-built object from a hook.
    expect(countErrored({ checks: undefined as never })).toBe(0)
    expect(countErrored({ checks: null as never })).toBe(0)
    expect(countErrored({ checks: 'nope' as never })).toBe(0)
    expect(countErrored({ checks: [null as never] })).toBe(0)
  })
})

// ─── issue #42: a skipped layer must not render as a passing one ────────────

const partialResult: ScanResult = {
  timestamp: '2026-03-21T00:00:00.000Z',
  source: 'dev',
  target: 'prod',
  checks: [
    { check: 'cron', status: 'clean', issues: [], durationMs: 1700 },
    { check: 'auth', status: 'skipped', issues: [], skipReason: 'no projectRef or accessToken configured', durationMs: 0 },
    { check: 'edge-functions', status: 'skipped', issues: [], skipReason: 'no projectRef or accessToken configured', durationMs: 0 },
    { check: 'data', status: 'skipped', issues: [], skipReason: 'no tables configured in checks.data.tables', durationMs: 0 },
  ],
  score: 100,
  postureScore: null,
  summary: { total: 0, critical: 0, warning: 0, info: 0 },
}

describe('countSkipped', () => {
  it('counts skipped checks', () => {
    expect(countSkipped(partialResult)).toBe(3)
  })

  it('is zero when nothing was skipped', () => {
    expect(countSkipped(cleanResult)).toBe(0)
  })

  it('tolerates a malformed result rather than throwing', () => {
    expect(countSkipped({ checks: undefined as never })).toBe(0)
    expect(countSkipped({ checks: [null as never] })).toBe(0)
  })
})

describe('coverage', () => {
  it('counts only checks that actually compared', () => {
    expect(coverage(partialResult)).toEqual({ compared: 1, total: 4 })
  })

  it('counts an errored check as not compared', () => {
    const r = { checks: [{ check: 'rls', status: 'error', issues: [], durationMs: 1 }] } as Pick<ScanResult, 'checks'>
    expect(coverage(r)).toEqual({ compared: 0, total: 1 })
  })

  it('is full when every check ran', () => {
    expect(coverage(cleanResult)).toEqual({ compared: 1, total: 1 })
  })

  it('tolerates a malformed result', () => {
    expect(coverage({ checks: undefined as never })).toEqual({ compared: 0, total: 0 })
  })
})

describe('renderSummary with skipped checks (issue #42)', () => {
  it('shows the skip reason instead of "0 issues"', () => {
    const out = renderSummary(partialResult)
    expect(out).toContain('skipped — no projectRef or accessToken configured')
    expect(out).toContain('skipped — no tables configured in checks.data.tables')
  })

  it('does not render a skipped layer as a zero-issue pass', () => {
    const out = renderSummary(partialResult)
    // Cron genuinely ran and found nothing, so it keeps the issue count.
    expect(out).toMatch(/Layer 7 \(Cron Jobs\):\s+0 issues/)
    // The three that never ran must not say the same thing.
    expect(out).not.toMatch(/Layer 6 \(Auth Config\):\s+0 issues/)
    expect(out).not.toMatch(/Layer 4 \(Edge Functions\):\s+0 issues/)
  })

  it('says coverage is partial in the closing line', () => {
    expect(renderSummary(partialResult)).toContain('3 checks were skipped — coverage is partial')
  })

  it('uses the singular for one skipped check', () => {
    const one = { ...partialResult, checks: partialResult.checks.slice(0, 2) }
    expect(renderSummary(one)).toContain('1 check was skipped')
  })

  it('qualifies a perfect score with the number of checks compared', () => {
    // 100/100 across a partial run otherwise reads as full coverage.
    expect(renderSummary(partialResult)).toContain('(1 of 4 checks compared)')
  })

  it('leaves the score unqualified when everything ran', () => {
    expect(renderSummary(cleanResult)).not.toContain('checks compared')
  })

  it('still reports no drift — a skip is not drift', () => {
    expect(renderSummary(partialResult)).toContain('no drift detected')
  })

  it('says nothing about skips when there are none', () => {
    expect(renderSummary(cleanResult)).not.toContain('coverage is partial')
  })
})

// ─── issue #40: posture findings must not read as drift ─────────────────────

const postureOnlyResult: ScanResult = {
  timestamp: '2026-03-21T00:00:00.000Z',
  source: 'env-a',
  target: 'env-a',
  checks: [
    { check: 'schema', status: 'clean', issues: [], durationMs: 3200 },
    {
      check: 'rls-coverage',
      status: 'drifted',
      durationMs: 300,
      issues: Array.from({ length: 8 }, (_, i) => ({
        id: `rls-cov-${i}`, check: 'rls-coverage' as const, severity: 'critical' as const,
        title: `Table public.t${i} has RLS disabled`, description: 'd',
      })),
    },
    {
      check: 'migrations',
      status: 'drifted',
      durationMs: 120,
      issues: [{ id: 'mig-1', check: 'migrations' as const, severity: 'info' as const, title: 'Untracked workflow', description: 'd' }],
    },
  ],
  score: 100,
  postureScore: 0,
  summary: { total: 9, critical: 8, warning: 0, info: 1 },
}

describe('splitCounts', () => {
  it('separates drift from posture findings', () => {
    expect(splitCounts(postureOnlyResult)).toEqual({ drift: 0, posture: 9 })
  })

  it('counts comparison-check issues as drift', () => {
    expect(splitCounts(driftedResult).drift).toBeGreaterThan(0)
    expect(splitCounts(driftedResult).posture).toBe(0)
  })

  it('tolerates a malformed result', () => {
    expect(splitCounts({ checks: undefined as never })).toEqual({ drift: 0, posture: 0 })
  })
})

describe('renderSummary separates posture from drift (issue #40)', () => {
  it('reports no drift when only posture checks found anything', () => {
    // Diffing an environment against itself previously read
    // "9 drift issues found across 2 checks" with a 0/100 score.
    const out = renderSummary(postureOnlyResult)
    expect(out).toContain('no drift detected')
    expect(out).not.toContain('9 drift issues')
  })

  it('still surfaces the posture findings — they are not discarded', () => {
    const out = renderSummary(postureOnlyResult)
    expect(out).toContain('9 posture findings')
    expect(out).toContain('present regardless of which pair you diff')
    expect(out).toMatch(/Layer 3 \(RLS Coverage\):\s+8 issues/)
  })

  it('prints both scores, so a clean sync and a poor posture are both visible', () => {
    const out = renderSummary(postureOnlyResult)
    expect(out).toContain('Drift score:')
    expect(out).toContain('100/100')
    expect(out).toContain('Posture score:')
    expect(out).toContain('0/100')
  })

  it('omits the posture line entirely when no posture check ran', () => {
    expect(renderSummary(cleanResult)).not.toContain('Posture score')
    expect(renderSummary(cleanResult)).not.toContain('posture findings')
  })

  it('still headlines genuine drift', () => {
    const out = renderSummary(driftedResult)
    expect(out).toMatch(/drift issue/)
  })
})

describe('renderSummary layer lines', () => {
  const issue = (id: string, severity: 'critical' | 'warning') =>
    ({ id, check: 'rls' as const, severity, title: id, description: id })

  it('counts in the singular and plural, with a space before the severity', () => {
    const out = renderSummary({
      timestamp: '', source: 'dev', target: 'prod', score: 50, postureScore: null,
      summary: { total: 3, critical: 1, warning: 2, info: 0 },
      checks: [
        { check: 'rls', status: 'drifted', durationMs: 0, issues: [issue('a', 'critical')] },
        { check: 'cron', status: 'drifted', durationMs: 0, issues: [issue('b', 'warning'), issue('c', 'warning')] },
      ],
    } as ScanResult).replace(/\x1b\[[0-9;]*m/g, '')
    expect(out).toMatch(/1 issue \[CRITICAL\]/)
    expect(out).toMatch(/2 issues \[WARNING\]/)
    expect(out).not.toMatch(/issues?\[/)
  })
})
