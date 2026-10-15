import { describe, it, expect } from 'vitest'
import { formatAnnotation, formatGitHubAnnotations, computeCiExitCode, formatCiSummary, type FailOn } from '../src/ci.js'
import type { ScanResult, DriftIssue } from '../src/types/drift.js'

function makeResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    timestamp: '2024-01-01T00:00:00.000Z',
    source: 'staging',
    target: 'production',
    checks: [],
    score: 100,
    postureScore: null,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
    ...overrides,
  }
}

/**
 * A result carrying real findings on a real check.
 *
 * The exit code is derived from `checks` — which findings, on which kind of
 * check — rather than from the aggregate `summary`, because a threshold that
 * cannot see the difference between drift and posture cannot express issue #66.
 * So these tests have to supply the findings, not just a count of them.
 */
function resultWith(
  check: 'schema' | 'rls' | 'rls-coverage' | 'migrations',
  severities: Array<DriftIssue['severity']>,
): ScanResult {
  const issues = severities.map((severity, i) => makeIssue({
    id: `${check}-${i}`, check, severity,
  }))
  const summary = {
    total: issues.length,
    critical: issues.filter(i => i.severity === 'critical').length,
    warning: issues.filter(i => i.severity === 'warning').length,
    info: issues.filter(i => i.severity === 'info').length,
  }
  return makeResult({
    checks: [{ check, status: issues.length > 0 ? 'drifted' : 'clean', issues, durationMs: 1 }],
    summary,
  })
}

function makeIssue(overrides: Partial<DriftIssue> = {}): DriftIssue {
  return {
    id: 'rls-missing-public.users.users_read',
    check: 'rls',
    severity: 'critical',
    title: 'Missing RLS policy: users_read',
    description: 'Policy is missing from production. CVE-2025-48757 risk.',
    ...overrides,
  }
}

describe('formatAnnotation', () => {
  it('formats critical issues as ::error annotations', () => {
    const issue = makeIssue({ severity: 'critical', title: 'Missing RLS', description: 'Policy missing' })
    const line = formatAnnotation(issue)
    expect(line).toMatch(/^::error title=/)
    expect(line).toContain('Missing RLS')
    expect(line).toContain('Policy missing')
  })

  it('formats warning issues as ::warning annotations', () => {
    const issue = makeIssue({ severity: 'warning', title: 'Extra policy', description: 'Extra policy in target' })
    const line = formatAnnotation(issue)
    expect(line).toMatch(/^::warning title=/)
  })

  it('formats info issues as ::warning annotations', () => {
    const issue = makeIssue({ severity: 'info', title: 'Info issue', description: 'Some info' })
    const line = formatAnnotation(issue)
    expect(line).toMatch(/^::warning title=/)
  })

  it('escapes newlines in description', () => {
    const issue = makeIssue({ description: 'Line one\nLine two' })
    const line = formatAnnotation(issue)
    expect(line).toContain('%0A')
    expect(line).not.toContain('\n')
  })

  it('escapes carriage returns in description', () => {
    const issue = makeIssue({ description: 'Line one\r\nLine two' })
    const line = formatAnnotation(issue)
    expect(line).toContain('%0D')
    expect(line).toContain('%0A')
  })

  it('percent-encodes commas and colons in title to avoid breaking annotation syntax', () => {
    const issue = makeIssue({ title: 'Missing: table, index' })
    const line = formatAnnotation(issue)
    expect(line).toContain('Missing%3A table%2C index')
    expect(line).not.toContain('\\')
  })

  it('escapes percent signs first so encoded sequences are not double-encoded', () => {
    const issue = makeIssue({ title: '100%,done', description: 'was 50% before' })
    const line = formatAnnotation(issue)
    expect(line).toBe('::error title=100%25%2Cdone::was 50%25 before')
  })

  it('produces well-formed annotation line', () => {
    const issue = makeIssue({ severity: 'critical', title: 'Critical', description: 'desc' })
    const line = formatAnnotation(issue)
    expect(line).toBe('::error title=Critical::desc')
  })
})

describe('formatGitHubAnnotations', () => {
  it('returns empty array for clean scan', () => {
    expect(formatGitHubAnnotations(makeResult())).toHaveLength(0)
  })

  it('returns one annotation per issue across all checks', () => {
    const result = makeResult({
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            makeIssue(),
            makeIssue({ id: 'rls-2', severity: 'warning', title: 'Extra policy', description: 'extra' }),
          ],
          durationMs: 10,
        },
        {
          check: 'schema',
          status: 'drifted',
          issues: [makeIssue({ id: 'schema-1', check: 'schema', title: 'Schema drift', description: 'Missing table' })],
          durationMs: 5,
        },
      ],
    })
    const annotations = formatGitHubAnnotations(result)
    expect(annotations).toHaveLength(3)
    expect(annotations[0]).toMatch(/^::error/)
    expect(annotations[1]).toMatch(/^::warning/)
    expect(annotations[2]).toMatch(/^::error/)
  })

  it('skips checks with no issues', () => {
    const result = makeResult({
      checks: [
        { check: 'schema', status: 'clean', issues: [], durationMs: 5 },
        { check: 'rls', status: 'drifted', issues: [makeIssue()], durationMs: 10 },
      ],
    })
    expect(formatGitHubAnnotations(result)).toHaveLength(1)
  })
})

describe('computeCiExitCode', () => {
  it('returns 0 for clean scan', () => {
    expect(computeCiExitCode(makeResult(), 'critical')).toBe(0)
  })

  it('returns 2 when any check has error status', () => {
    const result = makeResult({
      checks: [{ check: 'schema', status: 'error', issues: [], error: 'DB unreachable', durationMs: 0 }],
    })
    expect(computeCiExitCode(result, 'critical')).toBe(2)
  })

  it('error status takes precedence over drift threshold', () => {
    const result = makeResult({
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
      checks: [
        { check: 'rls', status: 'error', issues: [], error: 'Connection failed', durationMs: 0 },
      ],
    })
    expect(computeCiExitCode(result, 'critical')).toBe(2)
  })

  describe('fail-on=critical', () => {
    it('returns 1 only when critical issues exist', () => {
      expect(computeCiExitCode(resultWith('schema', ['critical']), 'critical')).toBe(1)
      expect(computeCiExitCode(resultWith('schema', ['warning']),  'critical')).toBe(0)
      expect(computeCiExitCode(resultWith('schema', ['info']),     'critical')).toBe(0)
    })
  })

  describe('fail-on=warning', () => {
    it('returns 1 on critical or warning, 0 on info only', () => {
      expect(computeCiExitCode(resultWith('schema', ['critical']), 'warning')).toBe(1)
      expect(computeCiExitCode(resultWith('schema', ['warning']),  'warning')).toBe(1)
      expect(computeCiExitCode(resultWith('schema', ['info']),     'warning')).toBe(0)
    })
  })

  describe('fail-on=any', () => {
    it('returns 1 for any issue including info', () => {
      expect(computeCiExitCode(resultWith('schema', ['info']), 'any')).toBe(1)
    })

    it('returns 0 for zero issues', () => {
      expect(computeCiExitCode(makeResult(), 'any')).toBe(0)
    })
  })

  it('uses critical as default when no failOn provided', () => {
    const withWarning = makeResult({ summary: { total: 1, critical: 0, warning: 1, info: 0 } })
    expect(computeCiExitCode(withWarning)).toBe(0)
  })
})

describe('formatCiSummary', () => {
  it('groups critical and warning issues separately', () => {
    const result = makeResult({
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            makeIssue({ id: 'rls-1', severity: 'critical', title: 'Critical issue' }),
            makeIssue({ id: 'rls-2', severity: 'warning',  title: 'Warning issue'  }),
          ],
          durationMs: 10,
        },
      ],
    })
    const summary = formatCiSummary(result)
    expect(summary.criticalIssues).toHaveLength(1)
    expect(summary.criticalIssues[0].title).toBe('Critical issue')
    expect(summary.warningIssues).toHaveLength(1)
    expect(summary.warningIssues[0].title).toBe('Warning issue')
  })

  it('includes score and timestamp', () => {
    const result = makeResult({ score: 75, timestamp: '2024-06-01T12:00:00Z' })
    const summary = formatCiSummary(result)
    expect(summary.score).toBe(75)
    expect(summary.timestamp).toBe('2024-06-01T12:00:00Z')
  })

  it('omits info issues from both lists', () => {
    const result = makeResult({
      summary: { total: 1, critical: 0, warning: 0, info: 1 },
      checks: [
        {
          check: 'roles',
          status: 'drifted',
          issues: [makeIssue({ id: 'info-1', severity: 'info', check: 'roles', title: 'Info issue' })],
          durationMs: 5,
        },
      ],
    })
    const summary = formatCiSummary(result)
    expect(summary.criticalIssues).toHaveLength(0)
    expect(summary.warningIssues).toHaveLength(0)
  })

  it('includes check name in each issue entry', () => {
    const result = makeResult({
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [makeIssue({ id: 'rls-1', check: 'rls' })],
          durationMs: 5,
        },
      ],
    })
    const summary = formatCiSummary(result)
    expect(summary.criticalIssues[0].check).toBe('rls')
  })
})

// ── Regression: issue #29 ─────────────────────────────────────────────────
// --ci exits 2 on an errored check, but the JSON artifact carried no error
// field. Anyone reading the uploaded report rather than the exit code saw a
// clean summary and no indication that a check had never run.

describe('formatCiSummary error signal (issue #29)', () => {
  const withError: ScanResult = {
    timestamp: '2026-03-21T00:00:00.000Z',
    source: 'dev',
    target: 'prod',
    checks: [
      { check: 'schema', status: 'error', issues: [], durationMs: 5000, error: 'Schema diff timed out after 5s' },
      { check: 'rls', status: 'clean', issues: [], durationMs: 10 },
    ],
    score: 97,
    postureScore: null,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }

  it('reports the errored check and its message', () => {
    const out = formatCiSummary(withError)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].check).toBe('schema')
    expect(out.errors[0].message).toContain('timed out')
  })

  it('emits an empty array on a healthy scan, so the field is always present', () => {
    const clean: ScanResult = { ...withError, checks: [withError.checks[1]], score: 100 }
    expect(formatCiSummary(clean).errors).toEqual([])
  })

  it('substitutes a message when a check errored without one', () => {
    const noMessage: ScanResult = {
      ...withError,
      checks: [{ check: 'schema', status: 'error', issues: [], durationMs: 1 }],
    }
    const out = formatCiSummary(noMessage)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].message).toBeTruthy()
  })

  it('tolerates a malformed result rather than throwing', () => {
    expect(() => formatCiSummary({ ...withError, checks: undefined as never })).not.toThrow()
  })
})

// ─── issue #42: skipped checks in the CI payload ────────────────────────────

describe('formatCiSummary reports skipped checks (issue #42)', () => {
  const partial: ScanResult = {
    timestamp: '2026-03-21T00:00:00.000Z',
    source: 'dev',
    target: 'prod',
    checks: [
      { check: 'cron', status: 'clean', issues: [], durationMs: 1700 },
      { check: 'auth', status: 'skipped', issues: [], skipReason: 'no projectRef or accessToken configured', durationMs: 0 },
      { check: 'rls', status: 'error', issues: [], error: 'connection refused', durationMs: 5 },
    ],
    score: 97,
    postureScore: null,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }

  it('lists skipped checks with their reason', () => {
    // Without this the artifact read as full coverage while a layer had never
    // opened a connection.
    expect(formatCiSummary(partial).skipped).toEqual([
      { check: 'auth', reason: 'no projectRef or accessToken configured' },
    ])
  })

  it('keeps skips out of errors — a skip is not a failure', () => {
    const out = formatCiSummary(partial)
    expect(out.errors).toEqual([{ check: 'rls', message: 'connection refused' }])
    expect(out.errors.some(e => e.check === 'auth')).toBe(false)
  })

  it('falls back to a placeholder reason rather than omitting the entry', () => {
    const noReason: ScanResult = {
      ...partial,
      checks: [{ check: 'auth', status: 'skipped', issues: [], durationMs: 0 }],
    }
    expect(formatCiSummary(noReason).skipped).toEqual([{ check: 'auth', reason: 'no reason given' }])
  })

  it('reports how many checks actually compared', () => {
    expect(formatCiSummary(partial).coverage).toEqual({ compared: 1, total: 3 })
  })

  it('is empty on a fully-run scan', () => {
    const full: ScanResult = {
      ...partial,
      checks: [{ check: 'cron', status: 'clean', issues: [], durationMs: 10 }],
    }
    const out = formatCiSummary(full)
    expect(out.skipped).toEqual([])
    expect(out.coverage).toEqual({ compared: 1, total: 1 })
  })

  it('does not make a skip fail the build', () => {
    // A skip is a coverage signal, not a drift signal — the exit code must
    // stay 0 so an intentionally-unconfigurable layer cannot break CI.
    const skipOnly: ScanResult = {
      ...partial,
      checks: [{ check: 'auth', status: 'skipped', issues: [], skipReason: 'no credentials', durationMs: 0 }],
    }
    expect(computeCiExitCode(skipOnly, 'any')).toBe(0)
  })
})

describe('formatCiSummary carries the posture score (issue #40)', () => {
  it('reports drift and posture as separate numbers', () => {
    const r: ScanResult = {
      timestamp: 't', source: 'a', target: 'a',
      checks: [
        { check: 'schema', status: 'clean', issues: [], durationMs: 1 },
        { check: 'rls-coverage', status: 'drifted', durationMs: 1, issues: [{ id: 'x', check: 'rls-coverage', severity: 'critical', title: 'RLS disabled', description: 'd' }] },
      ],
      score: 100,
      postureScore: 85,
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    }
    const out = formatCiSummary(r)
    expect(out.score).toBe(100)
    expect(out.postureScore).toBe(85)
  })

  it('is null when no posture check ran', () => {
    const r: ScanResult = {
      timestamp: 't', source: 'a', target: 'b',
      checks: [{ check: 'schema', status: 'clean', issues: [], durationMs: 1 }],
      score: 100, postureScore: null,
      summary: { total: 0, critical: 0, warning: 0, info: 0 },
    }
    expect(formatCiSummary(r).postureScore).toBeNull()
  })

  it('a critical posture finding is still reported in full', () => {
    // Scope changes the exit code, never the report: the finding keeps its
    // severity and appears in criticalIssues for the pipeline to read.
    const r = resultWith('rls-coverage', ['critical'])
    const out = formatCiSummary(r)
    expect(out.criticalIssues).toHaveLength(1)
    expect(out.criticalIssues[0].check).toBe('rls-coverage')
  })
})

/**
 * The exit code has to distinguish "the environments differ" from "the target
 * has a pre-existing gap".
 *
 * Gating on the combined critical count meant a diff of an environment against
 * *itself* exited 1 forever — RLS Coverage and Migration History report on the
 * target alone and fire identically whichever pair you diff, so a long-standing
 * RLS gap failed every sync check. `--fail-on` is a severity threshold and could
 * not express this, because the distinction is one of scope (issue #66).
 */
describe('computeCiExitCode — drift and posture are different scopes (issue #66)', () => {
  it('exits 0 when only the target-only checks found anything', () => {
    expect(computeCiExitCode(resultWith('rls-coverage', ['critical']), 'critical')).toBe(0)
    expect(computeCiExitCode(resultWith('migrations', ['critical']), 'critical')).toBe(0)
  })

  it('exits 1 for the same severity on a comparison check', () => {
    expect(computeCiExitCode(resultWith('rls', ['critical']), 'critical')).toBe(1)
  })

  it('exits 1 on posture findings when asked to', () => {
    const r = resultWith('rls-coverage', ['critical'])
    expect(computeCiExitCode(r, 'critical', { failOnPosture: true })).toBe(1)
  })

  it('applies the severity threshold within the posture scope too', () => {
    const warningOnly = resultWith('rls-coverage', ['warning'])
    expect(computeCiExitCode(warningOnly, 'critical', { failOnPosture: true })).toBe(0)
    expect(computeCiExitCode(warningOnly, 'warning', { failOnPosture: true })).toBe(1)
  })

  it('still exits 2 for an errored check, whichever scope it is in', () => {
    const r = makeResult({
      checks: [{ check: 'rls-coverage', status: 'error', issues: [], error: 'boom', durationMs: 1 }],
    })
    expect(computeCiExitCode(r, 'critical')).toBe(2)
    expect(computeCiExitCode(r, 'critical', { failOnPosture: true })).toBe(2)
  })

  it('a mixed scan exits 1 on the drift, not on the posture', () => {
    const mixed = makeResult({
      checks: [
        { check: 'schema', status: 'drifted', durationMs: 1, issues: [makeIssue({ id: 's1', check: 'schema', severity: 'critical' })] },
        { check: 'rls-coverage', status: 'drifted', durationMs: 1, issues: [makeIssue({ id: 'p1', check: 'rls-coverage', severity: 'critical' })] },
      ],
      summary: { total: 2, critical: 2, warning: 0, info: 0 },
    })
    expect(computeCiExitCode(mixed, 'critical')).toBe(1)
  })
})

describe('formatCiSummary carries what a check could not compare', () => {
  it('lists each notice with its check, and none when there are none', () => {
    const result: ScanResult = {
      timestamp: '2026-03-21T00:00:00.000Z', source: 'dev', target: 'prod', score: 100, postureScore: null,
      summary: { total: 0, critical: 0, warning: 0, info: 0 },
      checks: [
        { check: 'schema', status: 'clean', issues: [], notices: ['Not compared: Operator (source 1, target 0: ===) — check them by hand.'], durationMs: 1 },
        { check: 'rls', status: 'clean', issues: [], durationMs: 1 },
      ],
    }
    expect(formatCiSummary(result).notices).toEqual([
      { check: 'schema', notice: 'Not compared: Operator (source 1, target 0: ===) — check them by hand.' },
    ])
    expect(formatCiSummary({ ...result, checks: [result.checks[1]] }).notices).toEqual([])
  })
})
