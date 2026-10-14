import type { EnvironmentConfig } from '../types/config'
import type { DriftIssue, SyncAction } from '../types/drift'
import { Check, CheckSkipped, type CheckContext } from './base'
import { SUPABASE_MGMT_API } from '../constants'
import { httpStatus, readJsonObject } from '../utils/http.js'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** GoTrue's settings endpoint on a self-hosted gateway. */
const AUTH_SETTINGS_PATH = '/auth/v1/settings'

/**
 * Where an environment's auth config is read from.
 *
 * A self-hosted deployment has no project on api.supabase.com, so the hosted
 * Management API can only ever answer Unauthorized for it (issue #41). GoTrue
 * exposes the equivalent data on the gateway itself, authenticated with the
 * service-role key rather than a personal access token.
 */
export type AuthSource =
  | { kind: 'hosted'; ref: string; token: string }
  | { kind: 'self-hosted'; apiUrl: string; key: string }

/**
 * Pick the endpoint for an environment, preferring the self-hosted gateway.
 *
 * `apiUrl` wins when present: it is the documented override, and an
 * environment that sets it is by definition not on api.supabase.com. Note that
 * `projectRef` is not required in that case — it was only ever a path segment
 * on a hosted URL that will not be called (issue #41, point 4).
 */
export function resolveAuthSource(env: EnvironmentConfig): AuthSource | null {
  if (env.apiUrl && env.accessToken) {
    const apiUrl = normalizeApiUrl(env.apiUrl)
    if (!apiUrl) {
      throw new CheckSkipped(
        `apiUrl "${env.apiUrl}" is not a usable http(s) gateway URL — expected something like https://supabase.example.com`,
      )
    }
    return { kind: 'self-hosted', apiUrl, key: env.accessToken }
  }
  if (env.projectRef && env.accessToken) {
    return { kind: 'hosted', ref: env.projectRef, token: env.accessToken }
  }
  return null
}

/**
 * Validate and canonicalise a configured gateway URL, or return null.
 *
 * The service-role key is sent to whatever this names, so it is checked before
 * being used rather than interpolated into a request as-is:
 *
 * - It must parse, and be http or https. Anything else — `file:`, `ftp:`, a
 *   bare hostname — is a misconfiguration, and some of them are worse than
 *   that.
 * - Embedded credentials are rejected. They would be sent on every request and
 *   are almost always a copy-paste of a database URL into the wrong field.
 * - Only the origin is kept. A path, query or fragment on the base would end
 *   up merged with `/auth/v1/settings` in ways that are hard to predict.
 */
export function normalizeApiUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(stripTrailingSlashes(raw.trim()))
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password) return null
  return parsed.origin
}

/**
 * Trim trailing slashes so the path is not doubled.
 *
 * Scanned rather than matched with /\/+$/, whose repeated group backtracks
 * super-linearly on a long run of slashes. The value comes from user config,
 * so it is worth not having the sharp edge at all.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
}

/**
 * Flatten GoTrue's `/auth/v1/settings` into the shape the Management API's
 * `/config/auth` returns, so the two can be compared key by key.
 *
 * GoTrue nests provider flags under `external`; the Management API's keys are
 * flat. Neither is a superset of the other, which is why the comparison is
 * only ever run between two environments of the same kind.
 */
export function normalizeGoTrueSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  const external = raw.external
  if (external && typeof external === 'object' && !Array.isArray(external)) {
    for (const [provider, enabled] of Object.entries(external as Record<string, unknown>)) {
      out[`EXTERNAL_${provider.toUpperCase()}_ENABLED`] = enabled
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'external') continue
    out[key.toUpperCase()] = value
  }

  return out
}

/**
 * Settings whose drift is critical: how users sign in, how long a session
 * lasts, and what stands between a request and an account.
 *
 * Matched in lower case. The Management API returns lower-case keys and
 * normalised GoTrue settings are upper case; when these were listed in upper
 * case only, nothing on a hosted project was ever critical.
 */
const CRITICAL_KEYS = new Set([
  'external_email_enabled',
  'external_phone_enabled',
  'jwt_exp',
  'security_captcha_enabled',
  'security_update_password_require_reauthentication',
  'disable_signup',
])
const CRITICAL_PATTERN = /^mfa_[a-z_]+_(enroll|verify)_enabled$/

/** Credentials. Their values are never shown, and never copied to the target. */
const SECRET_PATTERN = /(_secret|_secrets|_pass|_auth_token|_api_key|_access_key)$/

/**
 * Settings that name the environment itself or an account it uses: its URLs,
 * its OAuth apps, its mail and SMS senders. They differ between staging and
 * production by design, so copying the source's into the target would point
 * production at staging. Reported, so a difference can be checked, but not
 * applied.
 */
const ENVIRONMENT_PATTERNS = [
  /^(site_url|uri_allow_list|saml_external_url)$/,
  /^external_[a-z0-9_]+_(client_id|url)$/,
  /^nimbus_oauth_client_id$/,
  /^hook_[a-z_]+_uri$/,
  /^smtp_(host|port|user|admin_email|sender_name)$/,
  /^sms_[a-z]+_(account_sid|message_service_sid|content_sid|originator|sender|from)$/,
  /^sms_twilio_verify_(account_sid|message_service_sid)$/,
  /^sms_test_otp(_valid_until)?$/,
  /^webauthn_rp_(id|origins|display_name)$/,
]

type AuthKeyKind = 'secret' | 'environment' | 'shared'

function classifyAuthKey(key: string): AuthKeyKind {
  const k = key.toLowerCase()
  if (SECRET_PATTERN.test(k)) return 'secret'
  if (ENVIRONMENT_PATTERNS.some(p => p.test(k))) return 'environment'
  return 'shared'
}

function isCriticalAuthKey(key: string): boolean {
  const k = key.toLowerCase()
  return CRITICAL_KEYS.has(k) || CRITICAL_PATTERN.test(k)
}

export class AuthCheck extends Check {
  readonly name = 'auth' as const

  constructor(private fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const sourceSrc = resolveAuthSource(ctx.source)
    const targetSrc = resolveAuthSource(ctx.target)

    if (!sourceSrc || !targetSrc) {
      // Returning [] here rendered as a green zero-issue pass, identical to a
      // layer that was compared and found clean (issue #42).
      throw new CheckSkipped('no apiUrl/projectRef or accessToken configured')
    }

    // The two endpoints do not expose the same keys — GoTrue's /settings is a
    // subset of the Management API's /config/auth. Comparing across them would
    // report every key one side lacks as drift, which is worse than not
    // comparing at all (issue #41).
    if (sourceSrc.kind !== targetSrc.kind) {
      throw new CheckSkipped(
        'source and target are different deployment kinds (one self-hosted, one hosted) — auth config is not comparable',
      )
    }

    const [source, target] = await Promise.all([
      this.fetchAuthConfig(sourceSrc),
      this.fetchAuthConfig(targetSrc),
    ])

    return diffAuthConfig(source, target, targetSrc)
  }

  private async fetchAuthConfig(src: AuthSource): Promise<Record<string, unknown>> {
    return src.kind === 'hosted'
      ? this.fetchHostedAuthConfig(src.ref, src.token)
      : this.fetchSelfHostedAuthConfig(src.apiUrl, src.key)
  }

  private async fetchHostedAuthConfig(projectRef: string, accessToken: string): Promise<Record<string, unknown>> {
    const url = `${SUPABASE_MGMT_API}/${encodeURIComponent(projectRef)}/config/auth`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch auth config for ${projectRef}: HTTP ${httpStatus(res)}`)
    return readJsonObject(res, `The auth config of ${projectRef}`)
  }

  /**
   * GoTrue wants the service-role key in both `apikey` and `Authorization`.
   * The gateway routes on the former and GoTrue authorises on the latter.
   */
  private async fetchSelfHostedAuthConfig(apiUrl: string, serviceKey: string): Promise<Record<string, unknown>> {
    // Built through URL rather than string concatenation, so the path is fixed
    // and cannot be shifted by whatever the config held.
    const url = new URL(AUTH_SETTINGS_PATH, apiUrl).toString()
    const res = await this.fetchFn(url, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch auth settings from ${apiUrl}: HTTP ${httpStatus(res)}`)
    const raw = await readJsonObject(res, `The auth settings at ${apiUrl}`)
    return normalizeGoTrueSettings(raw)
  }
}

function diffAuthConfig(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  targetSrc: AuthSource,
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const allKeys = new Set([...Object.keys(source), ...Object.keys(target)])

  for (const key of allKeys) {
    const sv = source[key]
    const tv = target[key]

    if (JSON.stringify(sv) === JSON.stringify(tv)) continue

    const kind = classifyAuthKey(key)
    const base = {
      id: `auth-${key.toLowerCase()}`,
      check: 'auth' as const,
      severity: isCriticalAuthKey(key) ? 'critical' as const : 'info' as const,
      title: `Auth config mismatch: ${key}`,
    }

    if (kind === 'secret') {
      issues.push({
        ...base,
        description: `"${key}" differs between source and target. It is a secret: set it on the target directly.`,
        manualOnly: `"${key}" is a secret and is never copied. Set it on the target directly.`,
      })
      continue
    }

    // Only the hosted Management API can be written to. Self-hosted GoTrue
    // takes its configuration from the environment it was started with and
    // exposes no write endpoint, so attaching a PATCH action there would
    // hand --apply a request that cannot succeed (issue #41).
    const action: SyncAction | undefined = targetSrc.kind === 'hosted' && kind === 'shared'
      ? {
          method: 'PATCH',
          url: `${SUPABASE_MGMT_API}/${encodeURIComponent(targetSrc.ref)}/config/auth`,
          headers: { Authorization: `Bearer ${targetSrc.token}` },
          body: { [key]: sv },
          label: `Set auth config "${key}" to ${JSON.stringify(sv)} in target`,
        }
      : undefined

    const manualOnly = kind === 'environment'
      ? `"${key}" belongs to each environment and is not copied. Change it on the target if it is wrong there.`
      : action
        ? undefined
        : 'Self-hosted GoTrue is configured through its environment — update the target deployment and restart it.'

    issues.push({
      ...base,
      description: `"${key}" differs between source (${JSON.stringify(sv)}) and target (${JSON.stringify(tv)}).`
        + (manualOnly ? ` ${manualOnly}` : ''),
      sourceValue: sv,
      targetValue: tv,
      ...(action ? { action } : {}),
      ...(manualOnly ? { manualOnly } : {}),
    })
  }

  return issues
}
