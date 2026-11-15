/**
 * Persistent command run log stored at ~/.supaforge/run-log.jsonl.
 *
 * Each entry is one JSON object per line (JSONL format) recording:
 * timestamp, command, args (with URLs redacted), duration, exitStatus, error.
 *
 * Used by `supaforge report` to show recent command history.
 * Entries older than RUN_LOG_MAX_ENTRIES are pruned automatically on append.
 */
import { readFile, writeFile, mkdir, appendFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactUrls } from './utils/error.js'
import { RUN_LOG_MAX_ENTRIES, RUN_LOG_DIR, RUN_LOG_FILE } from './constants.js'

/**
 * Per-check summary attached to diff/apply run log entries.
 * Contains only operational metadata — never SQL, table names, or data values.
 * Error strings are sanitized (URLs and file paths stripped) before storage.
 */
export interface RunLogCheckSummary {
  check: string
  status: string
  issueCount: number
  durationMs: number
  error?: string
}

export interface RunLogEntry {
  timestamp: string
  command: string
  args: string[]
  durationMs: number
  exitStatus: 'success' | 'error'
  error?: string
  /** supaforge version that produced this entry */
  version?: string
  /** Populated by diff/apply: per-check status and counts, no SQL content. */
  checkSummaries?: RunLogCheckSummary[]
}

/** Full path to the run log file. */
export function runLogPath(): string {
  return join(homedir(), RUN_LOG_DIR, RUN_LOG_FILE)
}

/** Full path to the run log directory. */
export function runLogDir(): string {
  return join(homedir(), RUN_LOG_DIR)
}

/** Append a single run entry to the log. Prunes old entries if needed. */
export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  const dir = runLogDir()
  // Commands, hosts and errors: readable by this user only.
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = runLogPath()
  const line = JSON.stringify(entry) + '\n'
  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
  // Prune asynchronously — don't block command output
  pruneRunLog(path).catch(() => {})
}

/** Read all run log entries (most recent last). Returns [] if file doesn't exist. */
export async function readRunLog(): Promise<RunLogEntry[]> {
  try {
    const raw = await readFile(runLogPath(), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as RunLogEntry }
        catch { return null }
      })
      .filter((e): e is RunLogEntry => e !== null)
  } catch {
    return []
  }
}

/** Remove oldest entries, keeping at most RUN_LOG_MAX_ENTRIES. */
async function pruneRunLog(path: string): Promise<void> {
  try {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    if (lines.length <= RUN_LOG_MAX_ENTRIES) return
    const trimmed = lines.slice(lines.length - RUN_LOG_MAX_ENTRIES)
    await writeFile(path, trimmed.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Non-fatal
  }
}

/** Build a redacted args list safe for logging. Strips passwords from URLs. */
export function redactArgs(argv: string[]): string[] {
  return argv.map(redactUrls)
}
