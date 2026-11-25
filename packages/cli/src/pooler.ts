/**
 * A database URL that looks like it goes through a transaction-mode pooler:
 * Supabase's on port 6543 (Supavisor), or PgBouncer, as a URL marks it with
 * `pgbouncer=true`.
 *
 * There each transaction may run on a different server connection, and a
 * setting made outside one stays on that connection for whoever gets it
 * next. SupaForge sets how values print on every connection (time zone, date
 * style, float digits) so that values compare exactly; through a transaction
 * pooler those settings could reach the application's own connections. A
 * session pooler (Supabase's on 5432) or a direct connection keeps them to
 * SupaForge's.
 */
export function transactionPoolerWarning(dbUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(dbUrl)
  } catch {
    return undefined
  }
  const pgbouncer = /^(?:1|true|yes|on)$/i.test(url.searchParams.get('pgbouncer') ?? '')
  if (url.port !== '6543' && !pgbouncer) return undefined
  const where = `${url.hostname}${url.port ? `:${url.port}` : ''}`
  return `${where} looks like a transaction-mode connection pooler. SupaForge sets how values print on its connections `
    + '(time zone, date style, float digits); through a transaction pooler those settings can stay on a server '
    + 'connection your application gets next. Use a session pooler (Supabase\'s is on port 5432) or a direct connection.'
}

const warned = new Set<string>()

/** Say it on stderr, once per URL, so a --json or --ci run says it too. */
export function warnIfTransactionPooler(dbUrl: string): void {
  const warning = transactionPoolerWarning(dbUrl)
  if (!warning || warned.has(dbUrl)) return
  warned.add(dbUrl)
  process.stderr.write(`Warning: ${warning}\n`)
}
