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
import { proveBeforeApply } from '../prove-gate.js'
import { checkConnection } from '../preflight.js'
import { redactUrls, describeFailure } from '../utils/error.js'
import { captureSnapshot, unrestorableSchema } from '../snapshot.js'
import { writeMigrationFile, migrationsDir } from '../migration-file.js'
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

  const configPathArg = z
    .string()
    .optional()
    .describe(
      'Absolute path to supaforge.config.json. Rejected unless the server was '
      + 'started with --allow-config-path; otherwise the config in the server\'s '
      + 'own working directory is used.',
    )

  /** The arguments diff and sync share, so the plan diff shows is the one sync runs. */
  const comparisonArgs = {
    configPath: configPathArg,
    source: z.string().optional().describe('Source environment name; list_environments shows them. Defaults to the config\'s source.'),
    target: z.string().optional().describe('Target environment name. Defaults to the config\'s target.'),
    checks: z
      .array(z.enum(CHECK_NAMES))
      .optional()
      .describe('Compare only these checks (e.g. ["schema", "rls"]).'),
    skip: z
      .array(z.enum(CHECK_NAMES))
      .optional()
      .describe('Leave these checks out, as the CLI --skip flag does. Added to checks.exclude from the config.'),
    only: z
      .array(z.string())
      .optional()
      .describe('Fix only these findings, by id from diff (globs allowed, e.g. "rls-*").'),
    allowDestructive: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include fixes that drop tables or columns. Off by default: they are reported but held back.'),
  }

  /** Load the config with the source and target asked for, or say what is wrong with it. */
  const loadComparison = async (args: { configPath?: string; source?: string; target?: string }) => {
    const effectiveCwd = resolveCwd(args.configPath)
    const raw = JSON.parse(await readFile(resolve(effectiveCwd, 'supaforge.config.json'), 'utf-8'))
    const config = resolveConfig({
      ...raw,
      ...(args.source ? { source: args.source } : {}),
      ...(args.target ? { target: args.target } : {}),
    })
    const errors = validateConfig(config)
    if (errors.length > 0) return { error: `Config errors:\n${errors.join('\n')}` }

    // Both databases must answer before anything is compared. Without this, an
    // unreadable source looked empty to the checks that treated a failed read
    // as "nothing there", and the target's webhooks were dropped as extra.
    const unreachable: string[] = []
    for (const [label, name] of [['Source', config.source!], ['Target', config.target!]] as const) {
      const conn = await checkConnection(config.environments[name].dbUrl)
      if (!conn.reachable) unreachable.push(`${label} (${name}) not reachable: ${redactUrls(describeFailure(conn.error))}`)
    }
    if (unreachable.length > 0) return { error: `Nothing compared.\n${unreachable.join('\n')}` }
    return { config, cwd: effectiveCwd }
  }

  const textResult = (body: unknown, isError = false) => ({
    content: [{ type: 'text' as const, text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true } : {}),
  })
  const failure = (err: unknown) => textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true)

  /** A check that failed measured nothing, so none of its drift is known. */
  const uncheckedOf = (scanResult: ScanResult) => scanResult.checks
    .filter(c => c.status === 'error')
    .map(c => ({ check: c.check, error: c.error ?? 'check failed' }))

  /**
   * list_environments: the environments in the config, so an agent can name
   * them. Clients that show tools but not resources had no other way to learn
   * them short of reading the config file, credentials and all.
   */
  server.registerTool(
    'list_environments',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      description:
        'List the environments in supaforge.config.json, and which are the default source and target. '
        + 'Says whether each has the Supabase project details the API-based checks need; never returns credentials.',
      inputSchema: { configPath: configPathArg },
    },
    async ({ configPath }) => {
      try {
        const raw = JSON.parse(await readFile(resolve(resolveCwd(configPath), 'supaforge.config.json'), 'utf-8'))
        const config = resolveConfig(raw)
        return textResult({
          source: config.source ?? null,
          target: config.target ?? null,
          environments: Object.entries(config.environments).map(([name, env]) => ({
            name,
            database: Boolean(env.dbUrl),
            supabaseProject: Boolean(env.projectRef),
            accessToken: Boolean(env.accessToken),
          })),
        })
      } catch (err: unknown) {
        return failure(err)
      }
    },
  )

  /**
   * diff: what differs, and exactly what sync would run to fix it.
   */
  server.registerTool(
    'diff',
    {
      // Reads both databases and writes nothing, so a client can let it run
      // without asking. sync is the one that writes.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      description:
        'Compare two Supabase environments and report every difference: schema, RLS, roles and grants, '
        + 'auth, storage, Edge Functions, cron and more. Returns the findings with their SQL, a drift score, '
        + 'and the plan: the statements sync would run, in order, and what it would hold back and why. '
        + 'Writes nothing. Show the plan to the user before calling sync.',
      inputSchema: comparisonArgs,
    },
    async ({ configPath, source, target, checks, skip, only, allowDestructive }) => {
      try {
        const loaded = await loadComparison({ configPath, source, target })
        if ('error' in loaded) return textResult(loaded.error, true)
        const { config } = loaded

        const scanResult: ScanResult = await scan(createDefaultRegistry(), {
          config,
          checks: checks as CheckName[] | undefined,
          skip: skip as CheckName[] | undefined,
        })
        setLastScanResult(scanResult)

        const preview = await promote({
          dbUrl: config.environments[config.target!].dbUrl,
          sourceUrl: config.environments[config.source!].dbUrl,
          scanResult,
          checks: checks as string[] | undefined,
          only,
          allowDestructive,
          dryRun: true,
        })
        const unchecked = uncheckedOf(scanResult)
        return textResult({
          ...scanResult,
          plan: {
            statements: preview.applied,
            heldBack: preview.skipped,
            ...(preview.warnings?.length ? { warnings: preview.warnings } : {}),
          },
          ...(unchecked.length ? { unchecked } : {}),
        })
      } catch (err: unknown) {
        return failure(err)
      }
    },
  )

  /**
   * sync: make the target match the source.
   */
  server.registerTool(
    'sync',
    {
      // Writes to the target database. This is the one a client should confirm.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      description:
        'Make the target environment match the source by running the plan diff shows. WRITES TO THE TARGET '
        + 'DATABASE: call diff first, show the user the plan, and call this only once they agree, with the '
        + 'same arguments. SQL fixes run in one transaction and roll back together if any fails. '
        + 'prove=true first rehearses the plan on a throwaway copy of the target and refuses to write '
        + 'if the result would not match the source.',
      inputSchema: {
        ...comparisonArgs,
        prove: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Rehearse on a throwaway copy of the target first, and write nothing unless the copy ends up '
            + 'matching the source. Needs permission to create a database on the target\'s server.',
          ),
      },
    },
    async ({ configPath, source, target, checks, skip, only, allowDestructive, prove }) => {
      try {
        const loaded = await loadComparison({ configPath, source, target })
        if ('error' in loaded) return textResult(loaded.error, true)
        const { config } = loaded
        const sourceUrl = config.environments[config.source!].dbUrl
        const targetUrl = config.environments[config.target!].dbUrl

        const scanResult: ScanResult = await scan(createDefaultRegistry(), {
          config,
          checks: checks as CheckName[] | undefined,
          skip: skip as CheckName[] | undefined,
        })
        setLastScanResult(scanResult)

        const proof = prove
          ? await proveBeforeApply({
            scanResult,
            plan: { checks: checks as string[] | undefined, only, allowDestructive },
            sourceUrl,
            targetUrl,
            ignoreSchemas: config.ignoreSchemas,
          })
          : undefined
        if (proof && !proof.proceed) {
          return textResult({ written: false, proof, applied: [], skipped: [], errors: [] }, true)
        }

        const result = await promote({
          dbUrl: targetUrl,
          sourceUrl,
          scanResult,
          checks: checks as string[] | undefined,
          only,
          allowDestructive,
        })
        // A check that failed measured nothing, so none of its drift was
        // applied; the call is not a success.
        const unchecked = uncheckedOf(scanResult)
        return textResult(
          { ...result, ...(proof ? { proof } : {}), ...(unchecked.length ? { unchecked } : {}) },
          unchecked.length > 0 || result.errors.length > 0,
        )
      } catch (err: unknown) {
        return failure(err)
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
   * create_migration: write the schema drift as a migration file, as
   * `migrate create` does — the same file, grants and all.
   */
  server.registerTool(
    'create_migration',
    {
      // Reads both databases and writes one local file; no database changes.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      description:
        'Write the schema difference between source and target as a migration file, as '
        + '`supaforge migrate create` does: the SQL that brings the target to the source, the grants on '
        + 'what it creates (so it works where new tables are not granted by default), and a DOWN to '
        + 'revert it. Written to the configured migrations directory (supabase/migrations by default). '
        + 'Changes no database.',
      inputSchema: {
        configPath: configPathArg,
        source: comparisonArgs.source,
        target: comparisonArgs.target,
        name: z
          .string()
          .min(1)
          .describe('Name for the migration, used in the file name (e.g. "add_rls_to_orders").'),
      },
    },
    async ({ configPath, source, target, name }) => {
      try {
        const loaded = await loadComparison({ configPath, source, target })
        if ('error' in loaded) return textResult(loaded.error, true)
        const { config, cwd: effectiveCwd } = loaded
        const { filePath, destructive } = await writeMigrationFile({
          config, name, dir: migrationsDir(config, effectiveCwd),
        })
        if (!filePath) return textResult({ written: false, reason: 'No schema drift between source and target.' })
        return textResult({
          written: true,
          migrationFile: filePath,
          ...(destructive.length > 0
            ? { destructive, warning: 'These statements drop or delete data. migrate run applies them only with --allow-destructive.' }
            : {}),
        })
      } catch (err: unknown) {
        return failure(err)
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
        'Retrieve the result for one check from the most recent diff or sync call. ' +
        'Returns issues, status, and duration for the named check.',
      inputSchema: {
        check: z.enum(CHECK_NAMES).describe('The check name to retrieve (e.g. "rls-coverage").'),
      },
    },
    async ({ check }) => {
      const result = getLastScanResult()
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: 'No scan result available. Run diff first.' }],
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

  /** Last scan result (updated after each diff or sync call). */
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
              text: JSON.stringify({ message: 'No scan result yet. Run diff first.' }),
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
        : '\n\nNo recent scan found — run diff first for a current drift report.'

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
                '1. Call diff to get the latest drift report and the plan.',
                '2. Review critical issues (especially rls-coverage and rls checks).',
                '3. Confirm all SQL fixes look correct before applying.',
                '4. If safe, and the user agrees to the plan, run sync (prove=true to rehearse it first).',
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
      let criticalSummary = 'No recent scan — run diff first.'
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
                '1. Run diff to confirm the current state and see the plan.',
                '2. Review each critical issue and its sql.up fix.',
                '3. Check the plan diff returned: the SQL sync will run, in order.',
                '4. Confirm with the user, then run sync with the same arguments (prove=true to rehearse it first).',
                '5. Run diff again to confirm all critical issues are resolved.',
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
