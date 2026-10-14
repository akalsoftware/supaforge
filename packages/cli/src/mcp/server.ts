import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, validateConfig } from '../config.js'
import { createDefaultRegistry } from '../checks/index.js'
import { scan } from '../scanner.js'
import { promote } from '../promote.js'
import { checkConnection } from '../preflight.js'
import { redactUrls, describeFailure } from '../utils/error.js'
import { captureSnapshot, unrestorableSchema } from '../snapshot.js'
import { backup } from '../migration.js'
import { CHECK_NAMES } from '../types/drift.js'
import type { ScanResult, CheckName } from '../types/drift.js'
import { setLastScanResult, getLastScanResult } from './state.js'

const SERVER_NAME = 'supaforge'

/**
 * The package's own version.
 *
 * Was a hardcoded '0.0.4' and had drifted fifteen releases behind (issue #82).
 * An MCP client has no other way to know which SupaForge it is talking to, so
 * an agent deciding whether a tool or argument exists was working from a
 * version that had not been true for months. Read from package.json, with a
 * fallback that says so rather than asserting a number.
 */
const SERVER_VERSION = resolveVersion()

function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // dist/ at runtime, src/mcp/ from source: walk up until package.json.
    for (const relative of ['../package.json', '../../package.json', '../../../package.json']) {
      const candidate = resolve(here, relative)
      if (!existsSync(candidate)) continue
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8'))
      if (typeof pkg.version === 'string' && pkg.name?.includes('supaforge')) {
        return pkg.version
      }
    }
  } catch {
    // Fall through.
  }
  return '0.0.0-unknown'
}

/** Masks sensitive fields (dbUrl, accessToken) in config output. */
function maskConfig(config: unknown): unknown {
  if (typeof config !== 'object' || config === null) return config
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (key === 'dbUrl' || key === 'accessToken') {
      result[key] = typeof value === 'string' && value.length > 0 ? '***' : value
    } else if (typeof value === 'object' && value !== null) {
      result[key] = maskConfig(value)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Create and configure the SupaForge MCP server.
 *
 * @param cwd - Working directory to resolve config files from (defaults to process.cwd())
 */
export interface ServerOptions {
  /**
   * Honour a `configPath` argument from the client.
   *
   * Off by default. Every tool accepted an arbitrary path and resolved its
   * working directory from it, so a tool call — or a prompt injected into one —
   * could point the server at any `supaforge.config.json` on disk, including
   * one holding production credentials, bypassing the config the server was
   * started with (issue #96). Enabled with `supaforge mcp --allow-config-path`
   * for the case where an agent legitimately manages several projects.
   */
  allowConfigPath?: boolean
}

export function createServer(cwd = process.cwd(), options: ServerOptions = {}): McpServer {
  const allowConfigPath = options.allowConfigPath ?? false

  /**
   * The directory to load the config from.
   *
   * Refuses a `configPath` unless the server was started with
   * --allow-config-path, rather than ignoring it silently: a client that asked
   * for a different project should be told it did not get one.
   */
  const resolveCwd = (configPath?: string): string => {
    if (!configPath) return cwd
    if (!allowConfigPath) {
      throw new Error(
        'configPath is not accepted by this server. It was started without '
        + '--allow-config-path, so it reads only the config in its own working '
        + `directory (${cwd}). Restart it with --allow-config-path to permit `
        + 'other projects.',
      )
    }
    return resolve(configPath, '..')
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  // ── Tools ──────────────────────────────────────────────────────────────────

  /**
   * scan_drift: Scan for environment drift and return a structured report.
   */
  server.registerTool(
    'scan_drift',
    {
      // Reads both databases and writes nothing. Without annotations a client
      // could not tell this from apply_fixes, so it could not ask for
      // confirmation on the one that writes (issue #96).
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },

      description:
        'Scan for drift between Supabase environments and return a structured report. ' +
        'Results include per-check status, issues with SQL fixes, and a health score.',
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe(
            'Absolute path to supaforge.config.json. Rejected unless the server was '
            + 'started with --allow-config-path; otherwise the config in the server\'s '
            + 'own working directory is used.',
          ),
        source: z
          .string()
          .optional()
          .describe('Source environment name (overrides config default).'),
        target: z
          .string()
          .optional()
          .describe('Target environment name (overrides config default).'),
        checks: z
          .array(z.enum(CHECK_NAMES))
          .optional()
          .describe('Limit scan to specific checks (e.g. ["rls", "rls-coverage"]).'),
        skip: z
          .array(z.enum(CHECK_NAMES))
          .optional()
          .describe(
            'Skip specific checks, the equivalent of the CLI --skip flag. ' +
            'Unioned with checks.exclude from the config file. Use this to avoid ' +
            'a slow or failing layer without editing the project config.',
          ),
      },
    },
    async ({ configPath, source, target, checks, skip }) => {
      try {
        const effectiveCwd = resolveCwd(configPath)
        const raw = JSON.parse(await readFile(resolve(effectiveCwd, 'supaforge.config.json'), 'utf-8'))
        const config = resolveConfig({
          ...raw,
          ...(source ? { source } : {}),
          ...(target ? { target } : {}),
        })

        const errors = validateConfig(config)
        if (errors.length > 0) {
          return { content: [{ type: 'text' as const, text: `Config errors:\n${errors.join('\n')}` }], isError: true }
        }

        const registry = createDefaultRegistry()
        const result: ScanResult = await scan(registry, {
          config,
          checks: checks as CheckName[] | undefined,
          skip: skip as CheckName[] | undefined,
        })
        setLastScanResult(result)

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
    },
  )

  /**
   * apply_fixes: Apply SQL fixes to resolve drift in the target environment.
   */
  server.registerTool(
    'apply_fixes',
    {
      // Writes to the target database, and destructively when
      // allowDestructive is set. This is the one a client should confirm.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },

      description:
        'Apply SQL fixes to resolve drift detected by scan_drift. ' +
        'Previews by default — pass dryRun=false to actually write to the target database.',
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe(
            'Absolute path to supaforge.config.json. Rejected unless the server was '
            + 'started with --allow-config-path; otherwise the config in the server\'s '
            + 'own working directory is used.',
          ),
        source: z.string().optional().describe('Source environment name.'),
        target: z.string().optional().describe('Target environment name.'),
        checks: z
          .array(z.enum(CHECK_NAMES))
          .optional()
          .describe('Apply fixes only for specific checks.'),
        dryRun: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            'Preview SQL without executing it. Defaults to true: writing is opt-in '
            + 'here as it is everywhere else in supaforge, where it needs --apply. '
            + 'Pass dryRun=false to actually apply the fixes.',
          ),
      },
    },
    async ({ configPath, source, target, checks, dryRun }) => {
      try {
        const effectiveCwd = resolveCwd(configPath)
        const raw = JSON.parse(await readFile(resolve(effectiveCwd, 'supaforge.config.json'), 'utf-8'))
        const config = resolveConfig({
          ...raw,
          ...(source ? { source } : {}),
          ...(target ? { target } : {}),
        })

        const errors = validateConfig(config)
        if (errors.length > 0) {
          return { content: [{ type: 'text' as const, text: `Config errors:\n${errors.join('\n')}` }], isError: true }
        }

        // Both databases must answer before anything is compared. Without
        // this, an unreadable source looked empty to the checks that treated a
        // failed read as "nothing there", and the target's webhooks were
        // dropped as extra.
        const unreachable: string[] = []
        for (const [label, name] of [['Source', config.source!], ['Target', config.target!]] as const) {
          const conn = await checkConnection(config.environments[name].dbUrl)
          if (!conn.reachable) unreachable.push(`${label} (${name}) not reachable: ${redactUrls(describeFailure(conn.error))}`)
        }
        if (unreachable.length > 0) {
          return { content: [{ type: 'text' as const, text: `Nothing compared or applied.\n${unreachable.join('\n')}` }], isError: true }
        }

        const registry = createDefaultRegistry()
        const scanResult: ScanResult = await scan(registry, {
          config,
          checks: checks as CheckName[] | undefined,
        })
        setLastScanResult(scanResult)

        const targetEnv = config.environments[config.target!]
        const promoteResult = await promote({
          dbUrl: targetEnv.dbUrl,
          scanResult,
          checks: checks as string[] | undefined,
          dryRun,
        })

        // A check that failed measured nothing, so none of its drift was
        // applied; the call is not a success.
        const unchecked = scanResult.checks
          .filter(c => c.status === 'error')
          .map(c => ({ check: c.check, error: c.error ?? 'check failed' }))
        const body = unchecked.length ? { ...promoteResult, unchecked } : promoteResult
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
          ...(unchecked.length || promoteResult.errors.length ? { isError: true } : {}),
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
    },
  )

  /**
   * take_snapshot: Capture a point-in-time snapshot of a Supabase environment.
   */
  server.registerTool(
    'take_snapshot',
    {
      // Reads the database and writes local files only — nothing in any
      // database changes.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

      description:
        'Capture a point-in-time snapshot of a Supabase environment. ' +
        'Snapshots are stored under .supaforge/snapshots/ and can be used to restore state.',
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe(
            'Absolute path to supaforge.config.json. Rejected unless the server was '
            + 'started with --allow-config-path; otherwise the config in the server\'s '
            + 'own working directory is used.',
          ),
        environment: z
          .string()
          .optional()
          .describe('Environment to snapshot (defaults to config source).'),
      },
    },
    async ({ configPath, environment }) => {
      try {
        const effectiveCwd = resolveCwd(configPath)
        const raw = JSON.parse(await readFile(resolve(effectiveCwd, 'supaforge.config.json'), 'utf-8'))
        const config = resolveConfig(raw)

        const envName = environment ?? config.source ?? Object.keys(config.environments)[0]
        const env = config.environments[envName]
        if (!env) {
          return {
            content: [{ type: 'text' as const, text: `Environment "${envName}" not found in config.` }],
            isError: true,
          }
        }

        const result = await captureSnapshot({ envName, env, config, cwd: effectiveCwd })
        const unrestorable = unrestorableSchema(result.manifest)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                timestamp: result.timestamp,
                dir: result.dir,
                manifest: result.manifest,
                // Said up front: restore is the wrong moment to find out.
                ...(unrestorable ? { warning: `This snapshot cannot restore the schema: ${unrestorable}` } : {}),
              }, null, 2),
            },
          ],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
    },
  )

  /**
   * create_migration: Create a migration file from snapshot diff.
   */
  server.registerTool(
    'create_migration',
    {
      // Local files only, as with take_snapshot.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

      description:
        'Capture a snapshot and generate a migration file containing the diff against the previous snapshot. ' +
        'Migration files are stored under .supaforge/migrations/.',
      inputSchema: {
        configPath: z
          .string()
          .optional()
          .describe(
            'Absolute path to supaforge.config.json. Rejected unless the server was '
            + 'started with --allow-config-path; otherwise the config in the server\'s '
            + 'own working directory is used.',
          ),
        environment: z
          .string()
          .optional()
          .describe('Environment to snapshot (defaults to config source).'),
        description: z
          .string()
          .optional()
          .describe('Human-readable description for the migration (e.g. "add-rls-to-orders").'),
      },
    },
    async ({ configPath, environment, description }) => {
      try {
        const effectiveCwd = resolveCwd(configPath)
        const raw = JSON.parse(await readFile(resolve(effectiveCwd, 'supaforge.config.json'), 'utf-8'))
        const config = resolveConfig(raw)

        const envName = environment ?? config.source ?? Object.keys(config.environments)[0]
        const env = config.environments[envName]
        if (!env) {
          return {
            content: [{ type: 'text' as const, text: `Environment "${envName}" not found in config.` }],
            isError: true,
          }
        }

        const result = await backup({
          envName,
          env,
          config,
          cwd: effectiveCwd,
          description,
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  isBaseline: result.isBaseline,
                  migrationFile: result.migrationFile,
                  snapshotDir: result.snapshot.dir,
                  timestamp: result.snapshot.timestamp,
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true }
      }
    },
  )

  /**
   * get_check_result: Retrieve the result for a specific check from the last scan.
   */
  server.registerTool(
    'get_check_result',
    {
      // Reads the last scan held in memory.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },

      description:
        'Retrieve the result for a specific check from the most recent scan_drift call. ' +
        'Returns issues, status, and duration for the named check.',
      inputSchema: {
        check: z.enum(CHECK_NAMES).describe('The check name to retrieve (e.g. "rls-coverage").'),
      },
    },
    async ({ check }) => {
      const result = getLastScanResult()
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: 'No scan result available. Run scan_drift first.' }],
          isError: true,
        }
      }
      const checkResult = result.checks.find(c => c.check === check)
      if (!checkResult) {
        return {
          content: [
            { type: 'text' as const, text: `Check "${check}" not found in last scan. Was it included in the scan?` },
          ],
          isError: true,
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(checkResult, null, 2) }] }
    },
  )

  // ── Resources ──────────────────────────────────────────────────────────────

  /** Current SupaForge config (sensitive fields masked). */
  server.registerResource(
    'config',
    'supaforge://config',
    {
      title: 'SupaForge Config',
      description: 'Current supaforge.config.json (sensitive fields masked)',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const raw = JSON.parse(await readFile(resolve(cwd, 'supaforge.config.json'), 'utf-8'))
        const masked = maskConfig(raw)
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(masked, null, 2), mimeType: 'application/json' }],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { contents: [{ uri: uri.href, text: `Error loading config: ${msg}`, mimeType: 'text/plain' }] }
      }
    },
  )

  /** Last scan result (updated after each scan_drift or apply_fixes call). */
  server.registerResource(
    'last-scan',
    'supaforge://last-scan',
    {
      title: 'Last Scan Result',
      description: 'The most recent drift scan result',
      mimeType: 'application/json',
    },
    async (uri) => {
      const result = getLastScanResult()
      if (!result) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ message: 'No scan result yet. Run scan_drift first.' }),
              mimeType: 'application/json',
            },
          ],
        }
      }
      return { contents: [{ uri: uri.href, text: JSON.stringify(result, null, 2), mimeType: 'application/json' }] }
    },
  )

  /** List of migration files under .supaforge/migrations/. */
  server.registerResource(
    'migrations',
    'supaforge://migrations',
    {
      title: 'Migration Files',
      description: 'Migration files under .supaforge/migrations/',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const migrationsDir = join(cwd, '.supaforge', 'migrations')
        const files = await readdir(migrationsDir).catch(() => [] as string[])
        const jsonFiles = files.filter(f => f.endsWith('.json')).sort()
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ directory: migrationsDir, files: jsonFiles }, null, 2),
              mimeType: 'application/json',
            },
          ],
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return { contents: [{ uri: uri.href, text: `Error: ${msg}`, mimeType: 'text/plain' }] }
      }
    },
  )

  // ── Prompts ────────────────────────────────────────────────────────────────

  /** Prompt: review drift before deploying. */
  server.registerPrompt(
    'review_drift_before_deploy',
    {
      description: 'Generate a drift review context to share with an AI agent before deploying.',
      argsSchema: {
        environment: z
          .string()
          .optional()
          .describe('Target environment name (e.g. "production")'),
      },
    },
    ({ environment }) => {
      const envNote = environment ? ` to **${environment}**` : ''
      const lastScan = getLastScanResult()
      const scanContext = lastScan
        ? `\n\nLast scan result (${lastScan.timestamp}):\n- Score: ${lastScan.score}\n- Total issues: ${lastScan.summary.total} (${lastScan.summary.critical} critical, ${lastScan.summary.warning} warnings)\n- Checks: ${lastScan.checks.filter(c => c.status === 'drifted').map(c => c.check).join(', ') || 'none drifted'}`
        : '\n\nNo recent scan found — run scan_drift first for a current drift report.'

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Before deploying${envNote}, please review the current SupaForge drift report.`,
                scanContext,
                '',
                'Steps:',
                '1. Call scan_drift to get the latest drift report.',
                '2. Review critical issues (especially rls-coverage and rls checks).',
                '3. Confirm all SQL fixes look correct before applying.',
                '4. If safe, run apply_fixes with dryRun=true first, then dryRun=false.',
              ].join('\n'),
            },
          },
        ],
      }
    },
  )

  /** Prompt: fix all critical issues. */
  server.registerPrompt(
    'fix_critical_issues',
    {
      description: 'Generate a step-by-step plan to fix all critical drift issues.',
      argsSchema: {},
    },
    () => {
      const lastScan = getLastScanResult()
      let criticalSummary = 'No recent scan — run scan_drift first.'
      if (lastScan) {
        const criticalIssues = lastScan.checks
          .flatMap(c => c.issues)
          .filter(i => i.severity === 'critical')
        if (criticalIssues.length === 0) {
          criticalSummary = 'No critical issues found in the last scan. The target environment looks healthy.'
        } else {
          criticalSummary = [
            `Found ${criticalIssues.length} critical issue(s) in last scan (${lastScan.timestamp}):`,
            ...criticalIssues.map(i => `- [${i.check}] ${i.title}`),
          ].join('\n')
        }
      }

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                'Fix all critical drift issues in the target Supabase environment.',
                '',
                criticalSummary,
                '',
                'Recommended steps:',
                '1. Run scan_drift to confirm the current state.',
                '2. Review each critical issue and its sql.up fix.',
                '3. Run apply_fixes with dryRun=true to preview the SQL.',
                '4. Confirm the SQL is safe, then run apply_fixes with dryRun=false.',
                '5. Run scan_drift again to confirm all critical issues are resolved.',
                '',
                'Pay special attention to rls-coverage issues — tables without RLS enabled',
                'are the CVE-2025-48757 vulnerability pattern.',
              ].join('\n'),
            },
          },
        ],
      }
    },
  )

  return server
}
