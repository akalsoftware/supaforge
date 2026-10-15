import { createHash } from 'node:crypto'
import { comparedSchemas, fingerprint } from './prove.js'

/**
 * Which target a migration file was written against, and as it was then.
 *
 * `migrate create` turns the drift between two databases into a file that
 * runs later — after review, after a merge — against a target that may have
 * moved on: a column added by hand, another migration run. Applied then, a
 * file written for the old state could fail half way, or succeed and leave
 * something wrong. The target's schema fingerprint is recorded in the file,
 * and `migrate run` checks it before running the first pending migration
 * written against the same environment.
 */
export const WRITTEN_AGAINST = '-- supaforge:written-against'

/** A short digest of the target's structure, over the schemas a diff compares. */
export async function targetFingerprint(dbUrl: string, ignoreSchemas: readonly string[]): Promise<string> {
  const schemas = await comparedSchemas(dbUrl, dbUrl, ignoreSchemas)
  return createHash('sha256').update(await fingerprint(dbUrl, schemas)).digest('hex').slice(0, 16)
}

export function writtenAgainstLine(env: string, digest: string): string {
  return `${WRITTEN_AGAINST} ${env} ${digest}`
}

/** The environment and digest a migration's header records, if it has one. */
export function writtenAgainst(sql: string): { env: string; digest: string } | undefined {
  const line = sql.split('\n').find(l => l.startsWith(WRITTEN_AGAINST + ' '))
  const [env, digest] = line?.slice(WRITTEN_AGAINST.length + 1).trim().split(/\s+/) ?? []
  return env && digest ? { env, digest } : undefined
}
