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

/**
 * A scan reads each database as of one instant.
 *
 * The checks run many queries, concurrently, over seconds or minutes; a
 * change made meanwhile — a migration, a policy someone adds — was seen by
 * some and not others, and the report described a database that never
 * existed. While a database is held (holdSnapshot), one connection keeps a
 * REPEATABLE READ, READ ONLY transaction open that exports its snapshot, and
 * each pooled connection joins it once, in a REPEATABLE READ transaction of
 * its own — not read only, so a definition can still be rendered with a
 * temporary object, inside a savepoint. A query that fails ends that
 * connection's transaction; it is rolled back and joins again next time.
 *
 * As with pg_dump, what the reads lock stays locked until the scan ends, so
 * releaseSnapshots() runs before anything is applied.
 */
const snapshots = new Map<string, { id: string; anchor: pg.Client }>()
let readAlone = false

/** Read each query on its own, as --no-snapshot asks, here and in @dbdiff/cli. */
export function setSnapshotsOff(off: boolean): void {
  readAlone = off
}

export function snapshotsOff(): boolean {
  return readAlone
}
const joined = new WeakMap<pg.PoolClient, string>()

/** Read `dbUrl` as of one instant until releaseSnapshots(). False, and nothing held, when the server will not. */
export async function holdSnapshot(dbUrl: string): Promise<boolean> {
  if (snapshots.has(dbUrl)) return true
  const anchor = newPgClient(dbUrl)
  try {
    await anchor.connect()
    await anchor.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const { rows: [row] } = await anchor.query<{ id: string }>('SELECT pg_export_snapshot() AS id')
    snapshots.set(dbUrl, { id: row.id, anchor })
    return true
  } catch {
    await anchor.end().catch(() => undefined)
    return false
  }
}

/** The snapshot `dbUrl` is read as of, while it is held. */
export function heldSnapshot(dbUrl: string): string | undefined {
  return snapshots.get(dbUrl)?.id
}

/**
 * Let every held database go. The pools reading them are closed with them:
 * their connections sit in the snapshot's transactions.
 */
export async function releaseSnapshots(): Promise<void> {
  const held = [...snapshots.entries()]
  snapshots.clear()
  await Promise.all(held.map(async ([dbUrl, { anchor }]) => {
    const pool = pools.get(dbUrl)
    pools.delete(dbUrl)
    await pool?.end().catch(() => undefined)
    await anchor.end().catch(() => undefined)
  }))
}

/** A pooled connection, in the held snapshot's transaction when `dbUrl` is held. */
async function connectionFor(dbUrl: string): Promise<pg.PoolClient> {
  const client = await poolFor(dbUrl).connect()
  const id = snapshots.get(dbUrl)?.id
  if (id && joined.get(client) !== id) {
    try {
      await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ; SET TRANSACTION SNAPSHOT '${id.replace(/'/g, "''")}'`)
      joined.set(client, id)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
      throw err
    }
  }
  return client
}

export const pgQuery: QueryFn = async (dbUrl, sql, params) => {
  if (!snapshots.has(dbUrl)) {
    const { rows } = await poolFor(dbUrl).query(sql, params)
    return rows
  }
  const client = await connectionFor(dbUrl)
  try {
    const { rows } = await client.query(sql, params)
    return rows
  } catch (err) {
    // The transaction is over for this connection; it joins again next time.
    await client.query('ROLLBACK').catch(() => undefined)
    joined.delete(client)
    throw err
  } finally {
    client.release()
  }
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
  const client = await connectionFor(dbUrl)
  // Inside the held snapshot's transaction, a savepoint does what a
  // transaction of its own would.
  const [begin, undo] = joined.has(client)
    ? ['SAVEPOINT sf_scratch', 'ROLLBACK TO SAVEPOINT sf_scratch']
    : ['BEGIN', 'ROLLBACK']
  try {
    await client.query(begin)
    try {
      return await fn(client)
    } finally {
      await client.query(undo).catch(() => undefined)
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
