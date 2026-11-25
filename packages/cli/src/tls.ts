import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect as netConnect } from 'node:net'
import type { ConnectionOptions } from 'node:tls'

/**
 * TLS for every connection SupaForge makes, with libpq's meanings.
 *
 * Three clients read a connection URL: `pg` for SupaForge's own queries,
 * DBDiff for the schema and data checks, and pg_dump/psql. They disagreed:
 * `pg` took `sslmode=require` as full verification, so a server whose
 * certificate comes from a CA of its own (a hosted Supabase project's) could
 * not be reached with the URL its dashboard gives out, while with no
 * `sslmode` at all `pg` connected unencrypted where libpq would encrypt. The
 * URL now means one thing everywhere, what it means to psql:
 *
 * | sslmode     | encrypts          | verifies the chain | verifies the name |
 * | ----------- | ----------------- | ------------------ | ----------------- |
 * | disable     | no                |                    |                   |
 * | allow       | as prefer         | no                 | no                |
 * | prefer      | if the server can | no                 | no                |
 * | require     | yes               | only with sslrootcert (as libpq) | no  |
 * | verify-ca   | yes               | yes                | no                |
 * | verify-full | yes               | yes                | yes               |
 *
 * `prefer` is the default, as it is libpq's. `sslrootcert` names the CA file
 * (`system` for the operating system's), defaulting to
 * `~/.postgresql/root.crt` as libpq does; `sslcert` / `sslkey` a client
 * certificate.
 */

export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
const MODES: readonly SslMode[] = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']

/** What libpq has no use for and rejects: `pg`'s own spellings. */
const PG_ONLY = ['uselibpqcompat', 'ssl', 'sslaccept', 'sslidentity', 'sslpassword']
/** libpq's TLS parameters, which `pg` must not read for itself. */
const LIBPQ_TLS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']

export interface TlsSettings {
  mode: SslMode
  rootcert?: string
  cert?: string
  key?: string
}

/** A query string's parameters as written, without URLSearchParams re-encoding the rest. */
function queryParts(url: string): { base: string; parts: string[]; hash: string } {
  const hashAt = url.indexOf('#')
  const hash = hashAt === -1 ? '' : url.slice(hashAt)
  const noHash = hashAt === -1 ? url : url.slice(0, hashAt)
  const q = noHash.indexOf('?')
  if (q === -1) return { base: noHash, parts: [], hash }
  return { base: noHash.slice(0, q), parts: noHash.slice(q + 1).split('&').filter(Boolean), hash }
}

function param(parts: string[], name: string): string | undefined {
  const part = parts.find(p => p === name || p.startsWith(`${name}=`))
  if (part === undefined) return undefined
  const value = part.slice(name.length + 1)
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

function withParts(base: string, parts: string[], hash: string): string {
  return `${base}${parts.length ? `?${parts.join('&')}` : ''}${hash}`
}

/**
 * The TLS a URL asks for. `pg`'s `ssl=true` reads as `require`, and
 * `ssl=false` as `disable`, when no `sslmode` says otherwise. An unknown
 * mode is refused, as libpq refuses it, rather than guessed at.
 */
export function tlsSettings(url: string): TlsSettings {
  const { parts } = queryParts(url)
  let mode = param(parts, 'sslmode')
  if (mode === undefined) {
    const ssl = param(parts, 'ssl')
    if (ssl !== undefined) mode = /^(?:0|false|no|off)$/i.test(ssl) ? 'disable' : 'require'
  }
  mode = mode === undefined || mode === '' ? 'prefer' : mode.toLowerCase()
  if (!MODES.includes(mode as SslMode)) {
    throw new Error(`Invalid sslmode "${mode}" in the database URL: use one of ${MODES.join(', ')}.`)
  }
  const settings: TlsSettings = { mode: mode as SslMode }
  for (const [key, name] of [['rootcert', 'sslrootcert'], ['cert', 'sslcert'], ['key', 'sslkey']] as const) {
    const value = param(parts, name)
    if (value) settings[key] = value
  }
  return settings
}

/** The URL as libpq (pg_dump, psql, DBDiff) should read it: `pg`'s own parameters translated or left out. */
export function libpqUrl(url: string): string {
  const { base, parts, hash } = queryParts(url)
  if (!parts.some(p => PG_ONLY.some(n => p === n || p.startsWith(`${n}=`)))) return url
  const kept = parts.filter(p => !PG_ONLY.some(n => p === n || p.startsWith(`${n}=`)))
  if (param(parts, 'sslmode') === undefined && param(parts, 'ssl') !== undefined) {
    kept.push(`sslmode=${tlsSettings(url).mode}`)
  }
  return withParts(base, kept, hash)
}

/** The URL as `pg` should read it: no TLS parameter left for it to interpret its own way. */
export function pgUrl(url: string): string {
  const { base, parts, hash } = queryParts(url)
  const kept = parts.filter(p => ![...PG_ONLY, ...LIBPQ_TLS].some(n => p === n || p.startsWith(`${n}=`)))
  return kept.length === parts.length ? url : withParts(base, kept, hash)
}

function readFile(what: string, path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`Cannot read ${what} "${path}" named in the database URL: ${(err as Error).message}`)
  }
}

/** The CA to verify against: sslrootcert, or libpq's default file; undefined for the system's. */
function rootCa(settings: TlsSettings, mustExist: boolean): string | undefined {
  if (settings.rootcert === 'system') return undefined
  if (settings.rootcert) return readFile('sslrootcert', settings.rootcert)
  const fallback = join(homedir(), '.postgresql', 'root.crt')
  if (existsSync(fallback)) return readFile('the root certificate', fallback)
  if (mustExist) {
    throw new Error(
      `sslmode=${settings.mode} verifies the server against a CA, and none was named: add sslrootcert=<file> to the `
      + 'database URL (for a hosted Supabase project, the CA it offers for download in its database settings), or '
      + 'sslrootcert=system for the CAs this machine trusts.',
    )
  }
  return undefined
}

/**
 * `pg`'s `ssl` option for a URL: false for no TLS, otherwise how to verify.
 * `plain` is set for a `prefer` / `allow` connection to a server found not
 * to offer TLS (see `resolvePgSsl`).
 */
export function pgSsl(url: string, plain = false): false | ConnectionOptions {
  const settings = tlsSettings(url)
  const { mode } = settings
  // allow is taken as prefer: TLS where the server offers it.
  if (mode === 'disable' || ((mode === 'prefer' || mode === 'allow') && plain)) return false

  const client: ConnectionOptions = {}
  if (settings.cert) client.cert = readFile('sslcert', settings.cert)
  if (settings.key) client.key = readFile('sslkey', settings.key)

  if (mode === 'prefer' || mode === 'allow' || (mode === 'require' && !settings.rootcert)) {
    return { ...client, rejectUnauthorized: false }
  }
  const ca = rootCa(settings, true)
  return {
    ...client,
    ...(ca ? { ca } : {}),
    rejectUnauthorized: true,
    // verify-ca (and require with a CA, as libpq): the chain, not the name.
    ...(mode === 'verify-full' ? {} : { checkServerIdentity: () => undefined }),
  }
}

/** Whether a URL's host is this machine, where an unencrypted connection leaves nothing to read. */
export function isLoopback(url: string): boolean {
  // A Unix socket: libpq's host=/directory.
  if (param(queryParts(url).parts, 'host')?.startsWith('/')) return true
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  if (host === '') return true
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host)
}

/**
 * Whether a server offers TLS, asked as libpq asks: an SSLRequest, to which
 * the server answers one byte, `S` or `N`. Nothing is sent before it, so no
 * credential crosses unencrypted. Undefined when the question got no answer;
 * the connection then reports why itself.
 */
export function offersTls(host: string, port: number, timeoutMs: number): Promise<boolean | undefined> {
  return new Promise(resolve => {
    const socket = netConnect({ host, port })
    const done = (answer: boolean | undefined) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs, () => done(undefined))
    socket.once('error', () => done(undefined))
    socket.once('connect', () => socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])))
    socket.once('data', (b: Buffer) => done(b[0] === 0x53 ? true : b[0] === 0x4e ? false : undefined))
  })
}

const answers = new Map<string, Promise<boolean | undefined>>()
const warned = new Set<string>()

/**
 * `pg`'s `ssl` for a URL, asking the server first where `sslmode` leaves it
 * to the server (prefer, allow): TLS if it offers it, else none, as libpq.
 * Asked once per server. An unencrypted connection to a server off this
 * machine is said on stderr, once, so a --json run says it too.
 */
export async function resolvePgSsl(url: string, timeoutMs: number): Promise<false | ConnectionOptions> {
  const { mode } = tlsSettings(url)
  if (mode !== 'prefer' && mode !== 'allow') return pgSsl(url)
  // libpq never uses TLS over a Unix socket.
  if (param(queryParts(url).parts, 'host')?.startsWith('/')) return false
  let host: string
  let port: number
  try {
    const parsed = new URL(url)
    host = parsed.hostname.replace(/^\[|\]$/g, '') || 'localhost'
    port = Number(parsed.port || 5432)
  } catch {
    return pgSsl(url)
  }
  const key = `${host}:${port}`
  if (!answers.has(key)) answers.set(key, offersTls(host, port, timeoutMs))
  const offered = await answers.get(key)
  if (offered !== false) return pgSsl(url)
  if (!isLoopback(url) && !warned.has(key)) {
    warned.add(key)
    process.stderr.write(`Warning: ${key} offers no TLS, so its connection is not encrypted: the password and data `
      + 'cross the network as written. Add sslmode=require to the database URL to refuse that, or sslmode=disable '
      + 'to connect this way knowingly.\n')
  }
  return false
}

/** For tests: forget what servers answered. */
export function forgetTlsAnswers(): void {
  answers.clear()
  warned.clear()
}
