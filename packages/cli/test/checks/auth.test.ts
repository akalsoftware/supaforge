import { describe, it, expect } from 'vitest'
import { CheckSkipped } from '../../src/checks/base.js'
import { AuthCheck, resolveAuthSource, normalizeGoTrueSettings, normalizeApiUrl } from '../../src/checks/auth.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { FetchFn } from '../../src/checks/auth.js'

function mockContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    source: { dbUrl: 'postgres://source', projectRef: 'src-ref', accessToken: 'src-key' },
    target: { dbUrl: 'postgres://target', projectRef: 'tgt-ref', accessToken: 'tgt-key' },
    config: {
      environments: {
        dev: { dbUrl: '', projectRef: 'src-ref', accessToken: 'src-key' },
        prod: { dbUrl: '', projectRef: 'tgt-ref', accessToken: 'tgt-key' },
      },
      source: 'dev',
      target: 'prod',
    },
    ...overrides,
  }
}

function makeFetchFn(sourceConfig: Record<string, unknown>, targetConfig: Record<string, unknown>): FetchFn {
  return async (url: string) => {
    const body = url.includes('src-ref') ? sourceConfig : targetConfig
    return { ok: true, json: async () => body } as Response
  }
}

describe('AuthCheck', () => {
  it('returns no issues when configs match', async () => {
    const config = { JWT_EXP: 3600, MFA_ENABLED: true, SITE_URL: 'https://example.com' }
    const check = new AuthCheck(makeFetchFn(config, config))
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects critical auth config mismatch (MFA_TOTP_ENROLL_ENABLED)', async () => {
    const check = new AuthCheck(makeFetchFn(
      { MFA_TOTP_ENROLL_ENABLED: true },
      { MFA_TOTP_ENROLL_ENABLED: false },
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].id).toBe('auth-mfa_totp_enroll_enabled')
    expect(issues[0].title).toContain('MFA_TOTP_ENROLL_ENABLED')
    expect(issues[0].sourceValue).toBe(true)
    expect(issues[0].targetValue).toBe(false)
    // Auth issues have PATCH action
    expect(issues[0].action).toBeDefined()
    expect(issues[0].action!.method).toBe('PATCH')
    expect(issues[0].action!.url).toContain('/v1/projects/tgt-ref/config/auth')
    expect(issues[0].action!.body).toEqual({ MFA_TOTP_ENROLL_ENABLED: true })
  })

  it('detects critical auth config mismatch (JWT_EXP)', async () => {
    const check = new AuthCheck(makeFetchFn(
      { JWT_EXP: 3600 },
      { JWT_EXP: 86400 },
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('JWT_EXP')
  })

  it('detects critical mismatch for SECURITY_CAPTCHA_ENABLED', async () => {
    const check = new AuthCheck(makeFetchFn(
      { SECURITY_CAPTCHA_ENABLED: true },
      { SECURITY_CAPTCHA_ENABLED: false },
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('detects info-level mismatch for non-critical keys', async () => {
    const check = new AuthCheck(makeFetchFn(
      { SITE_URL: 'https://dev.example.com' },
      { SITE_URL: 'https://prod.example.com' },
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('SITE_URL')
  })

  it('detects multiple mismatches at once', async () => {
    const check = new AuthCheck(makeFetchFn(
      { JWT_EXP: 3600, SITE_URL: 'https://dev.example.com', EXTERNAL_EMAIL_ENABLED: true },
      { JWT_EXP: 7200, SITE_URL: 'https://prod.example.com', EXTERNAL_EMAIL_ENABLED: false },
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(3)
    const severities = issues.map(i => i.severity)
    expect(severities).toContain('critical')
    expect(severities).toContain('info')
  })

  it('detects keys present in source but missing in target', async () => {
    const check = new AuthCheck(makeFetchFn(
      { MFA_ENABLED: true, CUSTOM_KEY: 'value' },
      { MFA_ENABLED: true },
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('CUSTOM_KEY')
  })

  it('detects keys present in target but missing in source', async () => {
    const check = new AuthCheck(makeFetchFn(
      {},
      { NEW_FEATURE: 'enabled' },
    ))
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('NEW_FEATURE')
  })

  it('skips with a reason when projectRef or accessToken is missing', async () => {
    // Was: returned []. Indistinguishable from a layer that was compared and
    // found clean, so a self-hosted user saw a green tick for a check that
    // never opened a connection (issue #42).
    const ctx = mockContext({
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
    })
    const check = new AuthCheck(makeFetchFn({}, {}))
    await expect(check.scan(ctx)).rejects.toThrow(CheckSkipped)
    await expect(check.scan(ctx)).rejects.toThrow('no apiUrl/projectRef or accessToken configured')
  })

  it('calls correct API URL with auth header', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return { ok: true, json: async () => ({}) } as Response
    }

    const check = new AuthCheck(fetchFn)
    await check.scan(mockContext())

    expect(calls).toHaveLength(2)
    expect(calls[0].url).toContain('/v1/projects/src-ref/config/auth')
    expect(calls[0].headers.Authorization).toBe('Bearer src-key')
    expect(calls[1].url).toContain('/v1/projects/tgt-ref/config/auth')
    expect(calls[1].headers.Authorization).toBe('Bearer tgt-key')
  })

  it('throws on API error', async () => {
    const fetchFn: FetchFn = async () => {
      return { ok: false, statusText: 'Forbidden' } as Response
    }

    const check = new AuthCheck(fetchFn)
    await expect(check.scan(mockContext())).rejects.toThrow('Forbidden')
  })
})

// ─── issue #41: self-hosted deployments have no project on api.supabase.com ──

describe('resolveAuthSource', () => {
  it('prefers apiUrl — an environment that sets it is not on api.supabase.com', () => {
    expect(resolveAuthSource({
      dbUrl: 'postgres://x',
      apiUrl: 'https://supabase.example.com',
      projectRef: 'my-project',
      accessToken: 'service-key',
    })).toEqual({ kind: 'self-hosted', apiUrl: 'https://supabase.example.com', key: 'service-key' })
  })

  it('does not require projectRef when apiUrl is set', () => {
    // projectRef was only ever a path segment on a hosted URL that will not be
    // called, which the issue calls out as confusing (point 4).
    const src = resolveAuthSource({ dbUrl: 'postgres://x', apiUrl: 'https://sb.example.com', accessToken: 'k' })
    expect(src?.kind).toBe('self-hosted')
  })

  it('strips a trailing slash so the path is not doubled', () => {
    const src = resolveAuthSource({ dbUrl: 'postgres://x', apiUrl: 'https://sb.example.com//', accessToken: 'k' })
    expect(src).toEqual({ kind: 'self-hosted', apiUrl: 'https://sb.example.com', key: 'k' })
  })

  it('rejects a gateway URL that is not http(s)', () => {
    // The service-role key is sent to whatever this names, so it is checked
    // before it is used rather than interpolated into a request as-is.
    for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'not a url', 'supabase.example.com']) {
      expect(() => resolveAuthSource({ dbUrl: 'postgres://x', apiUrl: bad, accessToken: 'k' }))
        .toThrow(CheckSkipped)
    }
  })

  it('rejects credentials embedded in the gateway URL', () => {
    // Almost always a database URL pasted into the wrong field; they would be
    // sent on every request.
    expect(() => resolveAuthSource({ dbUrl: 'postgres://x', apiUrl: 'https://user:pw@sb.example.com', accessToken: 'k' }))
      .toThrow('not a usable http(s) gateway URL')
  })

  it('keeps only the origin, so a stray path cannot move the endpoint', () => {
    const src = resolveAuthSource({ dbUrl: 'postgres://x', apiUrl: 'https://sb.example.com/rest/v1?a=1#f', accessToken: 'k' })
    expect(src).toEqual({ kind: 'self-hosted', apiUrl: 'https://sb.example.com', key: 'k' })
  })

  it('allows a local http gateway — the documented self-hosted default', () => {
    const src = resolveAuthSource({ dbUrl: 'postgres://x', apiUrl: 'http://localhost:54321', accessToken: 'k' })
    expect(src).toEqual({ kind: 'self-hosted', apiUrl: 'http://localhost:54321', key: 'k' })
  })

  it('falls back to hosted when there is no apiUrl', () => {
    expect(resolveAuthSource({ dbUrl: 'postgres://x', projectRef: 'ref', accessToken: 'tok' }))
      .toEqual({ kind: 'hosted', ref: 'ref', token: 'tok' })
  })

  it('is null without a token, whichever kind', () => {
    expect(resolveAuthSource({ dbUrl: 'postgres://x', apiUrl: 'https://sb.example.com' })).toBeNull()
    expect(resolveAuthSource({ dbUrl: 'postgres://x', projectRef: 'ref' })).toBeNull()
  })
})

describe('normalizeApiUrl', () => {
  it('returns the origin for a valid gateway', () => {
    expect(normalizeApiUrl('https://supabase.example.com')).toBe('https://supabase.example.com')
    expect(normalizeApiUrl('  https://supabase.example.com/  ')).toBe('https://supabase.example.com')
  })

  it('keeps a non-default port', () => {
    expect(normalizeApiUrl('http://localhost:54321')).toBe('http://localhost:54321')
  })

  it('drops path, query and fragment', () => {
    expect(normalizeApiUrl('https://sb.example.com/a/b?c=d#e')).toBe('https://sb.example.com')
  })

  it('returns null for anything that is not http(s)', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://x.com', 'javascript:alert(1)', 'sb.example.com', '', '   ']) {
      expect(normalizeApiUrl(bad)).toBeNull()
    }
  })

  it('returns null when credentials are embedded', () => {
    expect(normalizeApiUrl('https://user:pw@sb.example.com')).toBeNull()
    expect(normalizeApiUrl('https://user@sb.example.com')).toBeNull()
  })
})

describe('normalizeGoTrueSettings', () => {
  it('flattens external providers into the Management API key form', () => {
    expect(normalizeGoTrueSettings({ external: { email: true, phone: false, apple: false } })).toEqual({
      EXTERNAL_EMAIL_ENABLED: true,
      EXTERNAL_PHONE_ENABLED: false,
      EXTERNAL_APPLE_ENABLED: false,
    })
  })

  it('uppercases top-level keys', () => {
    expect(normalizeGoTrueSettings({ disable_signup: false, mailer_autoconfirm: true })).toEqual({
      DISABLE_SIGNUP: false,
      MAILER_AUTOCONFIRM: true,
    })
  })

  it('handles the response shape from the issue', () => {
    const raw = { external: { anonymous_users: false, apple: false, azure: false, email: true, phone: true } }
    const out = normalizeGoTrueSettings(raw)
    expect(out.EXTERNAL_EMAIL_ENABLED).toBe(true)
    expect(out.EXTERNAL_ANONYMOUS_USERS_ENABLED).toBe(false)
    expect(out.external).toBeUndefined()
  })

  it('tolerates a missing or malformed external block', () => {
    // A malformed block contributes nothing rather than a bogus EXTERNAL key,
    // so both sides normalise identically and it reports no drift.
    expect(normalizeGoTrueSettings({})).toEqual({})
    expect(normalizeGoTrueSettings({ external: null })).toEqual({})
    expect(normalizeGoTrueSettings({ external: 'nonsense' })).toEqual({})
    expect(normalizeGoTrueSettings({ external: [] })).toEqual({})
  })
})

describe('AuthCheck against self-hosted Supabase (issue #41)', () => {
  const selfHosted = (apiUrl: string) => ({ dbUrl: 'postgres://x', apiUrl, projectRef: 'my-project', accessToken: 'service-key' })

  /** Which of the two fake gateways a request went to, matched on host. */
  const isSourceGateway = (url: string): boolean => new URL(url).host === 'a.example.com'

  function selfHostedContext(): CheckContext {
    return {
      source: selfHosted('https://a.example.com'),
      target: selfHosted('https://b.example.com'),
      config: { environments: {}, source: 'a', target: 'b' },
    }
  }

  it('calls the gateway, not the hosted Management API', async () => {
    // Previously every request went to api.supabase.com/v1/projects/... and
    // could only ever return Unauthorized for a self-hosted deployment.
    const urls: string[] = []
    const headers: Array<Record<string, string>> = []
    const fetchFn: FetchFn = async (url, init) => {
      urls.push(url)
      headers.push((init?.headers ?? {}) as Record<string, string>)
      return { ok: true, json: async () => ({ external: { email: true } }) } as Response
    }

    await new AuthCheck(fetchFn).scan(selfHostedContext())

    expect(urls).toEqual([
      'https://a.example.com/auth/v1/settings',
      'https://b.example.com/auth/v1/settings',
    ])
    // Host compared exactly rather than by substring: `includes` would also
    // pass for `api.supabase.com.evil.test`, which is the opposite of what
    // this asserts.
    expect(urls.map(u => new URL(u).host)).toEqual(['a.example.com', 'b.example.com'])
  })

  it('authenticates with the service-role key in both headers', async () => {
    // The gateway routes on apikey; GoTrue authorises on Authorization.
    let seen: Record<string, string> = {}
    const fetchFn: FetchFn = async (_url, init) => {
      seen = (init?.headers ?? {}) as Record<string, string>
      return { ok: true, json: async () => ({ external: { email: true } }) } as Response
    }
    await new AuthCheck(fetchFn).scan(selfHostedContext())
    expect(seen.apikey).toBe('service-key')
    expect(seen.Authorization).toBe('Bearer service-key')
  })

  it('detects real drift between two self-hosted deployments', async () => {
    const fetchFn: FetchFn = async (url) => ({
      ok: true,
      json: async () => ({ external: { email: isSourceGateway(url), phone: true } }),
    } as Response)

    const issues = await new AuthCheck(fetchFn).scan(selfHostedContext())
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('Auth config mismatch: EXTERNAL_EMAIL_ENABLED')
  })

  it('reports no drift when two self-hosted deployments match', async () => {
    const fetchFn: FetchFn = async () => ({
      ok: true,
      json: async () => ({ external: { email: true, phone: true } }),
    } as Response)
    expect(await new AuthCheck(fetchFn).scan(selfHostedContext())).toHaveLength(0)
  })

  it('attaches no API action — self-hosted GoTrue has no config write endpoint', async () => {
    // Attaching a hosted PATCH would hand --apply a request that cannot succeed.
    const fetchFn: FetchFn = async (url) => ({
      ok: true,
      json: async () => ({ external: { email: isSourceGateway(url) } }),
    } as Response)

    const issues = await new AuthCheck(fetchFn).scan(selfHostedContext())
    expect(issues[0].action).toBeUndefined()
    expect(issues[0].description).toContain('configured through its environment')
  })

  it('still attaches a PATCH action for hosted targets', async () => {
    const check = new AuthCheck(makeFetchFn({ MFA_ENABLED: true }, { MFA_ENABLED: false }))
    const issues = await check.scan(mockContext())
    expect(issues[0].action?.method).toBe('PATCH')
    expect(issues[0].action?.url).toContain('api.supabase.com')
  })

  it('names the gateway in the error when the gateway rejects', async () => {
    const fetchFn: FetchFn = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' } as Response)
    await expect(new AuthCheck(fetchFn).scan(selfHostedContext()))
      .rejects.toThrow('Failed to fetch auth settings from https://a.example.com: HTTP 401 Unauthorized')
  })

  it('skips rather than comparing a self-hosted source against a hosted target', async () => {
    // The two endpoints do not expose the same keys, so every key one side
    // lacks would be reported as drift — worse than not comparing.
    const ctx: CheckContext = {
      source: selfHosted('https://a.example.com'),
      target: { dbUrl: 'postgres://y', projectRef: 'ref', accessToken: 'tok' },
      config: { environments: {}, source: 'a', target: 'b' },
    }
    const fetchFn: FetchFn = async () => ({ ok: true, json: async () => ({}) } as Response)
    await expect(new AuthCheck(fetchFn).scan(ctx)).rejects.toThrow(CheckSkipped)
    await expect(new AuthCheck(fetchFn).scan(ctx)).rejects.toThrow('different deployment kinds')
  })
})
