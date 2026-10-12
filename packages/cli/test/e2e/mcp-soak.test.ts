/**
 * The MCP server is the one long-lived SupaForge process: an editor keeps it
 * running for a whole session and calls it again and again. A leak that a
 * one-shot CLI run never notices adds up there — memory that is never
 * released, a database connection never closed, a child process (dbdiff,
 * pg_dump) never reaped.
 *
 * Drives the real server over stdio, as a client does, through many scans of
 * two databases that differ, and checks that none of the three grows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PgHarness } from '../harness/PgHarness.js'
import { describeWithContainers } from '../harness/containers.js'

const describeE2E = describeWithContainers()

const CALLS = Number(process.env.MCP_SOAK_CALLS ?? 60)
const WARMUP = 15

const SCHEMA = `
  CREATE TABLE public.customers (id bigint PRIMARY KEY, email text NOT NULL, created_at timestamptz DEFAULT now());
  CREATE TABLE public.orders (id bigint PRIMARY KEY, customer_id bigint REFERENCES public.customers(id), total numeric(10,2));
  CREATE INDEX orders_customer_idx ON public.orders (customer_id);
  ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_orders ON public.orders FOR SELECT USING (true);
  CREATE FUNCTION public.order_total(o bigint) RETURNS numeric LANGUAGE sql AS 'SELECT total FROM public.orders WHERE id = o';
  CREATE VIEW public.big_orders AS SELECT * FROM public.orders WHERE total > 100;
`

/** Resident memory of a process, from /proc (Linux, where the container tests run). */
function rssMb(pid: number): number {
  const kb = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]
  return Number(kb) / 1024
}

function childPids(pid: number): string[] {
  try {
    return execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return [] // ps exits 1 when there are none
  }
}

describeE2E('e2e: the MCP server does not leak across many calls', () => {
  let h: PgHarness
  let client: Client
  let transport: StdioClientTransport

  const connections = async (role: 'source' | 'target') =>
    Number(await h.sql(role, `SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`))

  beforeAll(async () => {
    h = new PgHarness({ verbose: !!process.env.E2E_VERBOSE, keep: !!process.env.E2E_KEEP })
    await h.up()
    await h.applySql('source', SCHEMA + `ALTER TABLE public.customers ADD COLUMN plan text DEFAULT 'free';`)
    await h.applySql('target', SCHEMA + `DROP VIEW public.big_orders;`)
    const ws = await h.workspace()

    const entry = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'bin', 'run.js')
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, 'mcp'],
      cwd: ws,
      env: { ...process.env, NO_COLOR: '1', CI: '1' } as Record<string, string>,
      stderr: 'ignore',
    })
    client = new Client({ name: 'soak', version: '1.0.0' })
    await client.connect(transport)
  }, 300_000)

  afterAll(async () => {
    await client?.close()
    await h?.down()
  }, 120_000)

  it(`holds memory, connections and child processes steady over ${CALLS} scans`, async () => {
    const pid = transport.pid
    expect(pid, 'server pid').toBeTypeOf('number')

    const baseline = { source: await connections('source'), target: await connections('target') }
    const rss: number[] = []
    const peakConnections = { source: 0, target: 0 }

    for (let i = 1; i <= CALLS; i++) {
      const res = await client.callTool({ name: 'scan_drift', arguments: {} })
      expect(res.isError, JSON.stringify(res.content).slice(0, 500)).toBeFalsy()
      if (i % 5 === 0) {
        await client.callTool({ name: 'get_check_result', arguments: { check: 'schema' } })
      }
      rss.push(rssMb(pid!))
      if (i % 10 === 0) {
        peakConnections.source = Math.max(peakConnections.source, await connections('source'))
        peakConnections.target = Math.max(peakConnections.target, await connections('target'))
      }
    }

    const warm = rss[WARMUP - 1]
    const end = rss[rss.length - 1]
    const peak = Math.max(...rss.slice(WARMUP - 1))
    console.log(`MCP soak: ${CALLS} scans, RSS after warm-up ${warm.toFixed(1)} MB, end ${end.toFixed(1)} MB, peak ${peak.toFixed(1)} MB`
      + ` — samples ${rss.filter((_, i) => i % 10 === 9).map((v) => v.toFixed(0)).join(' ')}`)

    // Connections are pooled per database, so some stay open between calls —
    // but never more than the pool allows, however many calls there were…
    expect(peakConnections.source, 'source connections during the run').toBeLessThanOrEqual(baseline.source + POOL_MAX)
    expect(peakConnections.target, 'target connections during the run').toBeLessThanOrEqual(baseline.target + POOL_MAX)

    // …and once the server goes idle they are all closed.
    await new Promise((r) => setTimeout(r, IDLE_CLOSE_MS))
    expect(await connections('source'), 'source connections once idle').toBe(baseline.source)
    expect(await connections('target'), 'target connections once idle').toBe(baseline.target)

    // Every child process (dbdiff and friends) has exited and been reaped.
    expect(childPids(pid!), 'child processes still running').toEqual([])

    // A leak grows with every call; garbage collection only ever lets memory
    // drift within a band. Past warm-up, allow that band and no more.
    expect(end - warm, `RSS grew from ${warm.toFixed(1)} to ${end.toFixed(1)} MB`).toBeLessThan(MAX_GROWTH_MB)
  }, 900_000)
})

const MAX_GROWTH_MB = 60
/** src/db.ts keeps one pool per database, at most this many connections each. */
const POOL_MAX = 4
/** node-postgres closes a pooled connection idle for 10 s; allow a margin. */
const IDLE_CLOSE_MS = 13_000
