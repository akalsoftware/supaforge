/**
 * A source that can't be read leaves the target alone.
 *
 * With a source it couldn't reach (a wrong password, say), --json and --ci skipped the reachability
 * check, and MCP had none. And with a source that answered the check but
 * failed a later read (a saturated pooler, a permission it lacked), the check
 * swallowed the error. Either way the webhooks check took the failure
 * for "the source has no webhooks", reported the target's as extra, and
 * `diff --apply` dropped them — exiting 0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

/** Enough of Supabase's webhooks for the check: a trigger calling supabase_functions.http_request. */
const WEBHOOKS = `
  CREATE SCHEMA IF NOT EXISTS supabase_functions;
  CREATE OR REPLACE FUNCTION supabase_functions.http_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TABLE public.orders (id int PRIMARY KEY);
  CREATE TRIGGER orders_webhook AFTER INSERT ON public.orders FOR EACH ROW
    EXECUTE FUNCTION supabase_functions.http_request('http://example.com/orders', 'POST', '{}', '{}', '1000');
`
const COUNT = `SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE p.proname = 'http_request'`

describeE2E('e2e: a source that cannot be read', () => {
  let h: PgHarness

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', WEBHOOKS + `
      CREATE ROLE sf_reader LOGIN PASSWORD 'reader';
      -- The source answers, but the read the webhooks check makes fails.
      REVOKE SELECT ON pg_catalog.pg_trigger FROM PUBLIC;`)
    await h.applySql('target', WEBHOOKS)
  }, 300_000)

  afterAll(async () => { await h?.down() }, 120_000)

  const withSource = (user: string, password: string, port?: string) => {
    const url = new URL(h.connectionString('source'))
    url.username = user
    url.password = password
    if (port) url.port = port
    return h.workspace({ environments: { source: { dbUrl: url.toString() }, target: { dbUrl: h.connectionString('target') } } })
  }

  it('aborts in every mode when the source cannot be reached', async () => {
    // A closed port: the harness trusts loopback, so a wrong password connects.
    const ws = await withSource('postgres', 'wrong', '1')
    // 2, couldn't run, in every mode: it was 1, drift found, outside --ci.
    for (const [args, code] of [
      [['diff', '--apply', '--json'], 2],
      [['diff', '--apply', '--ci'], 2],
      [['diff', '--apply'], 2],
      [['diff', '--apply', '--json', '--allow-destructive'], 2],
    ] as const) {
      const r = await h.cli([...args], { cwd: ws })
      expect(r.code, args.join(' ')).toBe(code)
      expect(await h.sql('target', COUNT), args.join(' ')).toBe('1')
    }
  }, 300_000)

  it('drops nothing, and exits 1, when a source read fails after the source answered', async () => {
    const ws = await withSource('sf_reader', 'reader')
    for (const args of [['diff', '--apply', '--json'], ['diff', '--apply', '--json', '--allow-destructive']]) {
      const r = await h.cli(args, { cwd: ws })
      expect(r.code, args.join(' ')).toBe(1)
      expect(await h.sql('target', COUNT), args.join(' ')).toBe('1')
      const out = JSON.parse(r.stdout)
      expect(out.applied.map((a: { issueId: string }) => a.issueId)).not.toContainEqual(expect.stringMatching(/^webhooks-/))
      expect(out.unchecked.map((u: { check: string }) => u.check)).toContain('webhooks')
    }
  }, 300_000)
})
