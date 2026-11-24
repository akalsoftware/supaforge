import { libpqUrl } from '../tls.js'

/**
 * A connection URL for a libpq tool's command line, without its password,
 * and the environment that carries the password instead.
 *
 * A process's arguments are readable by every user on the machine
 * (`ps`, `/proc/<pid>/cmdline`); its environment only by its own user. So
 * pg_dump, pg_restore and psql are given the password as PGPASSWORD, which
 * libpq reads when the URL has none.
 */
export function pgToolConnection(dbUrl: string, base: NodeJS.ProcessEnv = process.env): { url: string; env: NodeJS.ProcessEnv } {
  // libpq refuses a parameter it does not know, such as pg's uselibpqcompat.
  const url = libpqUrl(dbUrl)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { url, env: base }
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) return { url, env: base }

  const inQuery = parsed.searchParams.get('password')
  const password = parsed.password ? decodeURIComponent(parsed.password) : inQuery
  if (password === null || password === '') return { url, env: base }

  parsed.password = ''
  // The query string is edited as written: URLSearchParams would re-encode
  // the rest of it, `%20` as `+`, which libpq does not read as a space.
  if (inQuery !== null) {
    const rest = parsed.search.slice(1).split('&').filter(p => !/^password(?:=|$)/.test(p))
    parsed.search = rest.length ? `?${rest.join('&')}` : ''
  }
  return { url: parsed.toString(), env: { ...base, PGPASSWORD: password } }
}
