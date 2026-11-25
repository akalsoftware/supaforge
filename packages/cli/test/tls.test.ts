import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import { forgetTlsAnswers, isLoopback, libpqUrl, pgSsl, pgUrl, resolvePgSsl, tlsSettings } from '../src/tls.js'
import { pgClientConfig } from '../src/db.js'
import { pgToolConnection } from '../src/utils/pg-env.js'
import { dbdiffUrlEnv } from '../src/dbdiff.js'
import { friendlyDbError } from '../src/utils/error.js'

const HOST = 'postgresql://u:p@db.example.com:5432/app'

let dir: string
let ca: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sf-tls-'))
  ca = join(dir, 'ca.crt')
  writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nnot-a-real-ca\n-----END CERTIFICATE-----\n')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('sslmode means what it means to psql', () => {
  it('prefer is the default, and encrypts without verifying', () => {
    expect(tlsSettings(HOST).mode).toBe('prefer')
    expect(pgSsl(HOST)).toEqual({ rejectUnauthorized: false })
  })

  it('prefer to a server found to offer no TLS connects without it', () => {
    expect(pgSsl(HOST, true)).toBe(false)
  })

  it('require encrypts without verifying, which pg alone took as verify-full', () => {
    expect(pgSsl(`${HOST}?sslmode=require`)).toEqual({ rejectUnauthorized: false })
  })

  it('require with a CA verifies the chain but not the name, as libpq does', () => {
    const ssl = pgSsl(`${HOST}?sslmode=require&sslrootcert=${ca}`) as Record<string, unknown>
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.ca).toContain('not-a-real-ca')
    expect(typeof ssl.checkServerIdentity).toBe('function')
  })

  it('verify-ca verifies the chain, not the name', () => {
    const ssl = pgSsl(`${HOST}?sslmode=verify-ca&sslrootcert=${ca}`) as Record<string, unknown>
    expect(ssl.rejectUnauthorized).toBe(true)
    expect((ssl.checkServerIdentity as () => unknown)()).toBeUndefined()
  })

  it('verify-full verifies both', () => {
    const ssl = pgSsl(`${HOST}?sslmode=verify-full&sslrootcert=${ca}`) as Record<string, unknown>
    expect(ssl.rejectUnauthorized).toBe(true)
    expect(ssl.ca).toContain('not-a-real-ca')
    expect(ssl.checkServerIdentity).toBeUndefined()
  })

  it('verify-full against the system CAs when told sslrootcert=system', () => {
    expect(pgSsl(`${HOST}?sslmode=verify-full&sslrootcert=system`)).toEqual({ rejectUnauthorized: true })
  })

  it('verify-full with no CA named, and none at libpq\'s default path, is refused, not run unverified', () => {
    const home = process.env.HOME
    process.env.HOME = dir
    try {
      expect(() => pgSsl(`${HOST}?sslmode=verify-full`)).toThrow(/sslrootcert=<file>/)
    } finally {
      process.env.HOME = home
    }
  })

  it('a CA file that cannot be read is said so', () => {
    expect(() => pgSsl(`${HOST}?sslmode=verify-full&sslrootcert=${join(dir, 'missing.crt')}`)).toThrow(/Cannot read sslrootcert/)
  })

  it('disable connects without TLS', () => {
    expect(pgSsl(`${HOST}?sslmode=disable`)).toBe(false)
  })

  it('an unknown mode is refused', () => {
    expect(() => tlsSettings(`${HOST}?sslmode=sometimes`)).toThrow(/Invalid sslmode/)
  })

  it('reads pg\'s ssl=true as require and ssl=false as disable', () => {
    expect(tlsSettings(`${HOST}?ssl=true`).mode).toBe('require')
    expect(tlsSettings(`${HOST}?ssl=false`).mode).toBe('disable')
    expect(tlsSettings(`${HOST}?ssl=true&sslmode=verify-full`).mode).toBe('verify-full')
  })

  it('takes a client certificate', () => {
    writeFileSync(join(dir, 'me.crt'), 'CERT')
    writeFileSync(join(dir, 'me.key'), 'KEY')
    const ssl = pgSsl(`${HOST}?sslmode=require&sslcert=${join(dir, 'me.crt')}&sslkey=${join(dir, 'me.key')}`) as Record<string, unknown>
    expect(ssl.cert).toBe('CERT')
    expect(ssl.key).toBe('KEY')
  })
})

describe('each client gets the URL in its own terms', () => {
  const url = `${HOST}?sslmode=require&uselibpqcompat=true&application_name=a%20b`

  it('pg gets no TLS parameter to read its own way, and the TLS settings decided here', () => {
    const config = pgClientConfig(url)
    expect(config.connectionString).toBe(`${HOST}?application_name=a%20b`)
    expect(config.ssl).toEqual({ rejectUnauthorized: false })
  })

  it('libpq tools and DBDiff get libpq\'s parameters, without pg\'s, which libpq refuses', () => {
    expect(libpqUrl(url)).toBe(`${HOST}?sslmode=require&application_name=a%20b`)
    expect(pgToolConnection(url).url).toBe('postgresql://u@db.example.com:5432/app?sslmode=require&application_name=a%20b')
    expect(dbdiffUrlEnv({ sourceUrl: url, targetUrl: `${HOST}?ssl=true` } as never)).toEqual({
      DBDIFF_SERVER1_URL: `${HOST}?sslmode=require&application_name=a%20b`,
      DBDIFF_SERVER2_URL: `${HOST}?sslmode=require`,
    })
  })

  it('a URL with nothing to translate is left exactly as written', () => {
    const plain = `${HOST}?sslmode=verify-full&sslrootcert=/c/ca.crt&options=-c%20search_path%3Dapp`
    expect(libpqUrl(plain)).toBe(plain)
    expect(pgUrl(`${HOST}?application_name=x`)).toBe(`${HOST}?application_name=x`)
  })
})

describe('isLoopback', () => {
  it.each([
    ['postgresql://u@localhost/db', true],
    ['postgresql://u@127.0.0.1:5432/db', true],
    ['postgresql://u@[::1]:5432/db', true],
    ['postgresql://u@/db?host=/var/run/postgresql', true],
    ['postgresql://u@db.example.com/db', false],
    ['postgresql://u@10.0.0.5/db', false],
  ])('%s → %s', (url, expected) => {
    expect(isLoopback(url)).toBe(expected)
  })
})

describe('a TLS failure reads as one', () => {
  const url = 'postgresql://u:p@localhost:5432/db'

  it('from libpq, behind a refused address it tried first', () => {
    const raw = 'SQLSTATE[08006] [7] connection to server at "localhost" (::1), port 5432 failed: Connection refused\n'
      + '\tIs the server running on that host and accepting TCP/IP connections?\n'
      + 'connection to server at "localhost" (127.0.0.1), port 5432 failed: SSL error: certificate verify failed'
    const msg = friendlyDbError(new Error(raw), url)
    expect(msg).toMatch(/^TLS check of localhost:5432 failed: SSL error: certificate verify failed\./)
    expect(msg).toContain('sslrootcert=<file>')
    expect(msg).not.toMatch(/does not appear to be running/)
  })

  it('from pg', () => {
    expect(friendlyDbError(new Error('self-signed certificate in certificate chain'), url))
      .toMatch(/^TLS check of localhost:5432 failed: self-signed certificate in certificate chain\./)
  })

  it('a refused connection with no TLS in it is still a server not running', () => {
    expect(friendlyDbError(new Error('connect ECONNREFUSED 127.0.0.1:5432'), url)).toMatch(/does not appear to be running/)
  })
})

describe('prefer asks the server, once, before anything else is sent', () => {
  /** A server that answers an SSLRequest with one byte, counting who asked. */
  async function answering(byte: 'S' | 'N') {
    const seen: Buffer[] = []
    const server = createServer(socket => socket.once('data', b => { seen.push(b); socket.end(Buffer.from(byte)) }))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    return { url: `postgresql://u:p@127.0.0.1:${port}/db`, seen, close: () => new Promise(r => server.close(r)) }
  }

  it('connects without TLS to a server that offers none, as libpq would', async () => {
    forgetTlsAnswers()
    const s = await answering('N')
    try {
      expect(await resolvePgSsl(s.url, 2000)).toBe(false)
      // The SSLRequest, and nothing else: no credential sent in the clear to ask.
      expect(s.seen).toEqual([Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])])
    } finally { await s.close() }
  })

  it('encrypts with a server that offers TLS, and asks once per server', async () => {
    forgetTlsAnswers()
    const s = await answering('S')
    try {
      expect(await resolvePgSsl(s.url, 2000)).toEqual({ rejectUnauthorized: false })
      expect(await resolvePgSsl(s.url.replace(/\/db$/, '/other'), 2000)).toEqual({ rejectUnauthorized: false })
      expect(s.seen).toHaveLength(1)
    } finally { await s.close() }
  })

  it('does not ask where the URL decides', async () => {
    forgetTlsAnswers()
    const s = await answering('N')
    try {
      expect(await resolvePgSsl(`${s.url}?sslmode=require`, 2000)).toEqual({ rejectUnauthorized: false })
      expect(await resolvePgSsl(`${s.url}?sslmode=disable`, 2000)).toBe(false)
      expect(s.seen).toEqual([])
    } finally { await s.close() }
  })

  it('never uses TLS over a Unix socket', async () => {
    expect(await resolvePgSsl('postgresql://u@/db?host=/var/run/postgresql', 2000)).toBe(false)
  })
})
