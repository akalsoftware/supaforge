/**
 * TLS through the command, against servers that take TLS connections only,
 * with a certificate from a CA of their own: a root, an intermediate and the
 * server's, the chain sent by the server, as a hosted Supabase project does.
 *
 * `pg` read sslmode=require as full verification, so the URL Supabase gives
 * out could not connect at all; DBDiff dropped sslrootcert, so verify-full
 * passed SupaForge's own check and then failed the schema and data checks as
 * "the server does not appear to be running".
 */
import { it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

/** root → intermediate → server certificate for localhost and 127.0.0.1, and a CA that signed none of it. */
function makeCertificates(dir: string): void {
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  writeFileSync(join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n')
  writeFileSync(join(dir, 'leaf.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Test Root CA', '-keyout', 'root.key', '-out', 'root.crt')
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Test Intermediate CA', '-keyout', 'int.key', '-out', 'int.csr')
  ssl('x509', '-req', '-in', 'int.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-days', '2', '-extfile', 'ca.ext', '-out', 'int.crt')
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr')
  ssl('x509', '-req', '-in', 'server.csr', '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-days', '2', '-extfile', 'leaf.ext', '-out', 'server.crt')
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Other CA', '-keyout', 'other.key', '-out', 'other.crt')
}

describeE2E('e2e: TLS, libpq\'s way, for every client', () => {
  let h: PgHarness
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sf-tls-e2e-'))
    makeCertificates(dir)
    h = new PgHarness({ readyTimeoutSec: 180, verbose: !!process.env.E2E_VERBOSE })
    await h.up()
    const chain = readFileSync(join(dir, 'server.crt'), 'utf8') + readFileSync(join(dir, 'int.crt'), 'utf8')
    const key = readFileSync(join(dir, 'server.key'), 'utf8')
    for (const role of ['source', 'target'] as const) await h.enableTls(role, { cert: chain, key }, { only: true })
    await h.applySql('source', `CREATE TABLE public.plans (id int PRIMARY KEY, name text); INSERT INTO public.plans VALUES (1, 'free'), (2, 'pro');`)
  }, 600_000)

  afterAll(async () => {
    await h?.down()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 120_000)

  const withQuery = (q: string) => ({
    source: { dbUrl: `${h.connectionString('source')}${q}` },
    target: { dbUrl: `${h.connectionString('target')}${q}` },
  })

  async function run(q: string, args: string[]) {
    const ws = await h.workspace({ environments: withQuery(q), checks: { data: { tables: ['plans'] } } })
    return h.cli([...args, '--json'], { cwd: ws })
  }

  it('the servers really take TLS connections only', async () => {
    const plain = await run('?sslmode=disable', ['diff', '--check', 'schema'])
    expect(plain.code).not.toBe(0)
    expect(plain.stdout).toMatch(/no encryption|pg_hba/)
  }, 300_000)

  it('verify-full against the CA: every check reads both sides, and the apply converges', async () => {
    const q = `?sslmode=verify-full&sslrootcert=${join(dir, 'root.crt')}`
    const applied = await run(q, ['diff', '--apply', '--prove'])
    const result = JSON.parse(applied.stdout)
    expect(result.errors ?? []).toEqual([])
    expect(applied.code).toBe(0)
    expect(await h.sql('target', `SELECT string_agg(name, ',' ORDER BY id) FROM public.plans`)).toBe('free,pro')

    const again = JSON.parse((await run(q, ['diff'])).stdout)
    expect(again.checks.filter((c: { status: string }) => c.status === 'error')).toEqual([])
    const left = again.checks.filter((c: { check: string }) => c.check === 'schema' || c.check === 'data')
      .flatMap((c: { issues: Array<{ id: string }> }) => c.issues.map(i => i.id))
    expect(left).toEqual([])
  }, 600_000)

  it('require, as the Supabase dashboard\'s URL has it, encrypts and connects', async () => {
    const res = await run('?sslmode=require', ['diff'])
    const result = JSON.parse(res.stdout)
    expect(result.checks.filter((c: { status: string }) => c.status === 'error')).toEqual([])
  }, 300_000)

  it('no sslmode is libpq\'s prefer: TLS, since the server offers it', async () => {
    const res = await run('', ['diff'])
    const result = JSON.parse(res.stdout)
    expect(result.checks.filter((c: { status: string }) => c.status === 'error')).toEqual([])
  }, 300_000)

  it('verify-full against a CA that signed none of it is refused, and says it is TLS', async () => {
    const res = await run(`?sslmode=verify-full&sslrootcert=${join(dir, 'other.crt')}`, ['diff'])
    expect(res.code).not.toBe(0)
    const out = res.stdout + res.stderr
    expect(out).toMatch(/TLS check of 127\.0\.0\.1:\d+ failed/)
    expect(out).not.toMatch(/does not appear to be running/)
  }, 300_000)

  it('verify-full with no CA is refused rather than run unverified', async () => {
    const res = await run('?sslmode=verify-full', ['diff'])
    expect(res.code).not.toBe(0)
    expect(res.stdout + res.stderr).toMatch(/sslrootcert=<file>/)
  }, 300_000)
})
