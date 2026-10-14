import pg from 'pg'
import { DB_CONNECT_TIMEOUT_MS } from './constants.js'

export type QueryFn = (dbUrl: string, sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/**
 * Resolve the bound on establishing a connection (ms).
 *
 * SUPAFORGE_CONNECT_TIMEOUT is in seconds, so a network that legitimately
 * needs longer than the default can raise it without a code change. A
 * malformed or non-positive value falls back to the default rather than
 * forwarding something `pg` would treat as "wait forever" — which is the very
 * failure this bound exists to prevent (issue #44).
 */
export function resolveConnectTimeoutMs(): number {
  const raw = process.env.SUPAFORGE_CONNECT_TIMEOUT
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000)
  }
  return DB_CONNECT_TIMEOUT_MS
}

/**
 * Build `pg.Client` config with a connection bound always applied.
 *
 * Every client in the codebase goes through here so none can be constructed
 * without one. `queryTimeoutMs` is opt-in: it belongs on short probes, not on
 * a migration or restore that is legitimately slow.
 */
export function pgClientConfig(dbUrl: string, queryTimeoutMs?: number): pg.ClientConfig {
  const config: pg.ClientConfig = {
    connectionString: dbUrl,
    connectionTimeoutMillis: resolveConnectTimeoutMs(),
  }
  if (queryTimeoutMs !== undefined) {
    config.query_timeout = queryTimeoutMs
  }
  return config
}

/**
 * A `pg.Client` whose stray errors cannot take the process down.
 *
 * `pg` reports an error through the query that hit it, but one that arrives
 * when no query is running — the server cancelling a statement the client had
 * already given up on, or closing an idle connection — is emitted as an
 * `'error'` event, and an unhandled one ends the process with a stack trace.
 * Under --json that meant no JSON at all. The next query on the client fails
 * and reports it, so swallowing the event loses nothing.
 */
export function newPgClient(dbUrl: string, queryTimeoutMs?: number): pg.Client {
  const client = new pg.Client(pgClientConfig(dbUrl, queryTimeoutMs))
  client.on('error', () => undefined)
  return client
}

/**
 * The same for a pool: its own `'error'` event (an idle client dropped), and
 * every client's while it is checked out, when the pool's listener is off.
 */
export function newPgPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config)
  pool.on('error', () => undefined)
  pool.on('connect', client => { client.on('error', () => undefined) })
  return pool
}

/**
 * One pool per database, shared by every query in a run.
 *
 * `pgQuery` used to open and close a `pg.Client` per query, and each connection
 * costs several round trips before the query itself runs: TCP, startup, then
 * SCRAM authentication. Over a link with latency that dominated a diff — a full
 * run opened 47 connections for 574 round trips, and the storage check alone
 * opened 14 (issue #78). `schema-introspect.ts` already shared a pool for
 * snapshots; the diff path did not.
 *
 * `allowExitOnIdle` is what makes this safe to do without lifecycle plumbing
 * through every command: an idle pool does not hold the process open, so a CLI
 * that forgets to close one still exits. `closePgPools()` exists for tests and
 * for anywhere that wants the sockets gone at a known moment.
 */
const pools = new Map<string, pg.Pool>()

/**
 * Concurrent checks share these, so a pool needs more than one connection —
 * but a diff is not a web server, and a Supabase pooler counts every one.
 */
const POOL_MAX = 4

function poolFor(dbUrl: string): pg.Pool {
  const existing = pools.get(dbUrl)
  if (existing) return existing

  const pool = newPgPool({
    ...pgClientConfig(dbUrl),
    max: POOL_MAX,
    allowExitOnIdle: true,
  })

  pools.set(dbUrl, pool)
  return pool
}

export const pgQuery: QueryFn = async (dbUrl, sql, params) => {
  const { rows } = await poolFor(dbUrl).query(sql, params)
  return rows
}

/**
 * Run `fn` on one pooled connection inside a transaction that is always
 * rolled back — for reading what the server makes of something by creating it
 * as a temporary object, without leaving anything behind.
 */
export async function inRolledBackTransaction<T>(
  dbUrl: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await poolFor(dbUrl).connect()
  try {
    await client.query('BEGIN')
    try {
      return await fn(client)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
    }
  } finally {
    client.release()
  }
}

/** Close every pool this process opened. Safe to call more than once. */
export async function closePgPools(): Promise<void> {
  const open = [...pools.values()]
  pools.clear()
  await Promise.all(open.map(pool => pool.end().catch(() => undefined)))
}
