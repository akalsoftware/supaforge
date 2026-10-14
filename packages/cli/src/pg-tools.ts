/**
 * pg_dump / pg_restore version detection and install guidance.
 *
 * Used by branch/clone commands that need the pg_dump ↔ pg_restore pipeline.
 * Detects local tool version, compares it against the remote server's major
 * version, and produces actionable install instructions on mismatch.
 */
import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { existsSync } from 'node:fs'
import { newPgClient } from './db.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PgToolCheck {
  /** Local pg_dump major version, or null if not found. */
  localMajor: number | null
  /** Remote server major version. */
  serverMajor: number
  /** True when local tool matches or exceeds server major version. */
  compatible: boolean
  /** Human-readable message (empty when compatible). */
  message: string
  /** Resolved absolute path to a compatible pg_dump binary (may differ from PATH default). */
  pgDumpPath: string
  /** Resolved absolute path to a compatible pg_restore binary. */
  pgRestorePath: string
}

// ─── Version Parsing ─────────────────────────────────────────────────────────

/** Extract major version from pg_dump --version output, e.g. "pg_dump (PostgreSQL) 16.3" → 16. */
export function parsePgDumpVersion(output: string): number | null {
  const m = output.match(/(\d+)(?:\.\d+)?/)
  return m ? Number(m[1]) : null
}

/** Extract major version from `SHOW server_version`, e.g. "17.6 (Ubuntu 17.6-1.pgdg22.04+1)". */
export function parseServerVersion(versionStr: string): number | null {
  const m = versionStr.match(/^(\d+)/)
  return m ? Number(m[1]) : null
}

// ─── Detection ───────────────────────────────────────────────────────────────

/** Get local pg_dump major version (null if not installed). */
export async function getLocalPgDumpVersion(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('pg_dump', ['--version'], (err, stdout) => {
      if (err) return resolve(null)
      resolve(parsePgDumpVersion(stdout))
    })
  })
}

/** Get pg_dump version at a specific path (null if not found). */
function getPgDumpVersionAt(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], (err, stdout) => {
      if (err) return resolve(null)
      resolve(parsePgDumpVersion(stdout))
    })
  })
}

/**
 * Well-known directories where versioned PostgreSQL client binaries are installed.
 * Checked in order when the default PATH binary is too old.
 */
const VERSIONED_PG_DIRS: readonly string[] = [
  '/usr/lib/postgresql/{v}/bin',       // Debian / Ubuntu (PGDG)
  '/opt/homebrew/opt/postgresql@{v}/bin', // macOS Homebrew (Apple Silicon)
  '/usr/local/opt/postgresql@{v}/bin', // macOS Homebrew (Intel)
  '/usr/pgsql-{v}/bin',               // RHEL / CentOS (PGDG)
]

/**
 * Resolve a compatible pg_dump binary path for the given server major version.
 *
 * 1. The directory SUPAFORGE_PG_BIN names, if set. It comes first so it can
 *    pin the tools; one that holds no pg_dump is a mistake worth reporting,
 *    not something to ignore silently. One too old for this server falls
 *    through to the rest.
 * 2. The default `pg_dump` on PATH.
 * 3. Well-known versioned directories.
 *
 * Returns `{ path, major }` or `null` if no compatible binary is found.
 */
export async function resolvePgDumpPath(
  serverMajor: number,
): Promise<{ path: string; major: number } | null> {
  const named = process.env.SUPAFORGE_PG_BIN?.trim()
  if (named) {
    if (!existsSync(`${named}/pg_dump`)) {
      throw new Error(`SUPAFORGE_PG_BIN is set to "${named}", which has no pg_dump`)
    }
    const major = await getPgDumpVersionAt(`${named}/pg_dump`)
    if (major !== null && major >= serverMajor) return { path: `${named}/pg_dump`, major }
  }

  const defaultMajor = await getLocalPgDumpVersion()
  if (defaultMajor !== null && defaultMajor >= serverMajor) {
    return { path: 'pg_dump', major: defaultMajor }
  }

  // Search versioned directories (highest version first)
  for (const v of versionsToCheck(serverMajor)) {
    for (const tmpl of VERSIONED_PG_DIRS) {
      const dir = tmpl.replace('{v}', String(v))
      const candidate = `${dir}/pg_dump`
      if (!existsSync(candidate)) continue
      const major = await getPgDumpVersionAt(candidate)
      if (major !== null && major >= serverMajor) {
        return { path: candidate, major }
      }
    }
  }

  return null
}

/**
 * Refuse a SUPAFORGE_PG_BIN that names no pg_dump, before anything is
 * captured. Mistyped, it used to be noticed only as a snapshot without a
 * restorable schema, reported as a success.
 */
export function assertPgBinUsable(): void {
  const named = process.env.SUPAFORGE_PG_BIN?.trim()
  if (named && !existsSync(`${named}/pg_dump`)) {
    throw new Error(
      `SUPAFORGE_PG_BIN is set to "${named}", which has no pg_dump. `
      + 'Point it at a directory of PostgreSQL client tools, or unset it to use the ones on PATH.',
    )
  }
}

/**
 * Why no pg_dump would do, for a message that says what to change: the
 * version needed, what PATH and SUPAFORGE_PG_BIN offered, and the variable.
 */
export async function describeMissingPgDump(neededMajor: number): Promise<string> {
  const onPath = await getLocalPgDumpVersion()
  const named = process.env.SUPAFORGE_PG_BIN?.trim()
  const namedMajor = named ? await getPgDumpVersionAt(`${named}/pg_dump`) : null
  const found = [
    onPath === null ? 'none on PATH' : `${onPath} on PATH`,
    ...(named ? [`${namedMajor ?? 'none'} in SUPAFORGE_PG_BIN`] : []),
  ].join(', ')
  return `no pg_dump ${neededMajor} or newer (found: ${found}); `
    + `set SUPAFORGE_PG_BIN to a directory of PostgreSQL ${neededMajor}+ client tools`
}

/**
 * Derive the pg_restore path from a resolved pg_dump path.
 * If pg_dump was resolved from PATH, returns 'pg_restore'.
 * Otherwise returns the sibling binary in the same directory.
 */
export function resolvePgRestorePath(pgDumpPath: string): string {
  if (pgDumpPath === 'pg_dump') return 'pg_restore'
  return pgDumpPath.replace(/pg_dump$/, 'pg_restore')
}

/** Versions to check, from the required version up to +3 (handles newer installs). */
function versionsToCheck(required: number): number[] {
  const versions: number[] = []
  for (let v = required + 3; v >= required; v--) {
    versions.push(v)
  }
  return versions
}

/** Get remote PostgreSQL server major version via SQL. */
export async function getServerMajorVersion(dbUrl: string): Promise<number> {
  const client = newPgClient(dbUrl)
  try {
    await client.connect()
    const { rows } = await client.query('SHOW server_version')
    const raw = (rows[0] as Record<string, string>).server_version
    const major = parseServerVersion(raw)
    if (!major) throw new Error(`Could not parse server version: ${raw}`)
    return major
  } finally {
    await client.end()
  }
}

// ─── Compatibility Check ─────────────────────────────────────────────────────

/**
 * Check whether the local pg_dump is compatible with the remote server.
 *
 * pg_dump requires its major version to be ≥ the server major version.
 * Returns a structured result with an actionable install message on mismatch.
 */
export async function checkPgDumpCompat(dbUrl: string): Promise<PgToolCheck> {
  const serverMajor = await getServerMajorVersion(dbUrl)
  const resolved = await resolvePgDumpPath(serverMajor)

  if (resolved) {
    return {
      localMajor: resolved.major,
      serverMajor,
      compatible: true,
      message: '',
      pgDumpPath: resolved.path,
      pgRestorePath: resolvePgRestorePath(resolved.path),
    }
  }

  const localMajor = await getLocalPgDumpVersion()
  const message = buildInstallMessage(localMajor, serverMajor)
  return {
    localMajor,
    serverMajor,
    compatible: false,
    message,
    pgDumpPath: 'pg_dump',
    pgRestorePath: 'pg_restore',
  }
}

// ─── Install Guidance ────────────────────────────────────────────────────────

function buildInstallMessage(localMajor: number | null, serverMajor: number): string {
  const header = localMajor === null
    ? `pg_dump not found. The server is PostgreSQL ${serverMajor} — install postgresql-client-${serverMajor}:`
    : `pg_dump version mismatch: local v${localMajor}, server v${serverMajor}. Install postgresql-client-${serverMajor}:`

  const instructions = getInstallInstructions(serverMajor)
  return `${header}\n\n${instructions}`
}

/** Platform-specific install instructions for a given PostgreSQL major version. */
export function getInstallInstructions(majorVersion: number): string {
  const os = platform()
  const v = majorVersion

  switch (os) {
    case 'darwin':
      return [
        `  brew install postgresql@${v}`,
        `  # Then add to PATH:`,
        `  export PATH="/opt/homebrew/opt/postgresql@${v}/bin:$PATH"`,
      ].join('\n')

    case 'linux':
      return [
        `  # Debian / Ubuntu:`,
        `  sudo apt-get install -y postgresql-client-${v}`,
        `  # If the package is not found, add the PGDG repository first:`,
        `  # https://www.postgresql.org/download/linux/ubuntu/`,
        ``,
        `  # RHEL / Fedora:`,
        `  sudo dnf install -y postgresql${v}`,
      ].join('\n')

    case 'win32':
      return [
        `  # Download the installer from:`,
        `  # https://www.postgresql.org/download/windows/`,
        `  # Or use Chocolatey:`,
        `  choco install postgresql${v} --params '/Password:postgres'`,
      ].join('\n')

    default:
      return `  Download PostgreSQL ${v} client tools from: https://www.postgresql.org/download/`
  }
}
