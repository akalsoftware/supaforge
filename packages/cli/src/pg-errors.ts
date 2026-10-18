/**
 * SQLSTATEs for "that does not exist here": a relation, function, schema or
 * other object the statement names is missing from the database it ran on.
 */
export const ABSENT_ON_TARGET: ReadonlySet<string> = new Set(['42P01', '42883', '3F000', '42704'])

/** A column the statement names is missing. */
export const UNDEFINED_COLUMN = '42703'

/** SQLSTATEs for an extension the server does not ship. */
export const EXTENSION_UNAVAILABLE: ReadonlySet<string> = new Set(['0A000', '58P01'])

/** The SQLSTATE of a PostgreSQL error, if it is one. */
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * How an older server refuses what a newer one wrote: a syntax it does not
 * know (`UNIQUE NULLS NOT DISTINCT` before 15, a `VIRTUAL` column before 18),
 * a feature it lacks, a parameter it does not have (`security_invoker` before
 * 15). Taken as the target lacking it only when the target is older.
 */
export const OLDER_SERVER: ReadonlySet<string> = new Set(['42601', '0A000', '22023'])
