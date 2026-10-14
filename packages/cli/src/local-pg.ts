import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { newPgClient } from './db.js'
import { RUNTIME_DETECT_TIMEOUT_MS, CONTAINER_RM_TIMEOUT_MS, CONTAINER_START_TIMEOUT_MS } from './constants'

const defaultExecFile = promisify(execFile)

// ─── Types ───────────────────────────────────────────────────────────────────

/** Injected exec function for testability. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>

/** Injected PostgreSQL connect function for readiness polling. */
export type ConnectFn = (url: string) => Promise<void>

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default PostgreSQL image used for local containers. */
export const PG_IMAGE = 'docker.io/library/postgres:17'

/** Default host port for the local PostgreSQL container. */
export const DEFAULT_LOCAL_PORT = 5432

/** Default container name. */
export const CONTAINER_NAME = 'supaforge-local-pg'

/** Default credentials for the local container. */
export const LOCAL_PG_USER = 'postgres'
export const LOCAL_PG_PASSWORD = 'postgres'

/** Maximum retries when waiting for PostgreSQL readiness. */
export const READINESS_RETRIES = 30

/** Delay between readiness checks (ms). */
export const READINESS_INTERVAL_MS = 2000

// ─── Default implementations ────────────────────────────────────────────────

async function defaultConnectFn(url: string): Promise<void> {
  const client = newPgClient(url)
  await client.connect()
  await client.end()
}

// ─── Container Runtime Detection ─────────────────────────────────────────────

export type ContainerRuntime = 'podman' | 'docker'

/**
 * Detect the available container runtime.
 * Prefers podman (rootless, daemonless) over docker.
 * Returns null if neither is available.
 */
export async function detectRuntime(execFn: ExecFn = defaultExecFile): Promise<ContainerRuntime | null> {
  for (const rt of ['podman', 'docker'] as const) {
    try {
      await execFn(rt, ['--version'], { timeout: RUNTIME_DETECT_TIMEOUT_MS })
      return rt
    } catch {
      continue
    }
  }
  return null
}

// ─── Container Lifecycle ─────────────────────────────────────────────────────

export interface StartLocalPgOptions {
  /** Container runtime to use. Auto-detected if not provided. */
  runtime?: ContainerRuntime
  /** Host port to bind (default: 5432). */
  port?: number
  /** PostgreSQL password (default: 'postgres'). */
  password?: string
  /** Container name (default: 'supaforge-local-pg'). */
  name?: string
  /** PostgreSQL image (default: PG_IMAGE). */
  image?: string
  /** Injected exec function for testability. */
  execFn?: ExecFn
  /** Injected connect function for testability. */
  connectFn?: ConnectFn
}

export interface LocalPgInfo {
  runtime: ContainerRuntime
  containerName: string
  port: number
  url: string
}

/**
 * Start a local PostgreSQL container using the detected runtime.
 *
 * Uses tmpfs for ephemeral storage (fast, no disk writes).
 * Waits for PostgreSQL to accept connections before returning.
 */
export async function startLocalPg(options: StartLocalPgOptions = {}): Promise<LocalPgInfo> {
  const exec = options.execFn ?? defaultExecFile
  const connect = options.connectFn ?? defaultConnectFn
  const runtime = options.runtime ?? await detectRuntime(exec)
  if (!runtime) {
    throw new Error(
      'No container runtime found. Install Podman (recommended) or Docker.\n' +
      '  Podman: https://podman.io/docs/installation\n' +
      '  Docker: https://docs.docker.com/engine/install/',
    )
  }

  const port = options.port ?? DEFAULT_LOCAL_PORT
  const password = options.password ?? LOCAL_PG_PASSWORD
  const name = options.name ?? CONTAINER_NAME
  const image = options.image ?? PG_IMAGE

  // Check if container already exists and is running
  const existing = await getContainerStatus(runtime, name, exec)
  if (existing === 'running') {
    return {
      runtime,
      containerName: name,
      port,
      url: buildLocalUrl(port, password),
    }
  }

  // Remove stopped container with same name
  if (existing === 'stopped') {
    await exec(runtime, ['rm', '-f', name], { timeout: CONTAINER_RM_TIMEOUT_MS })
  }

  // Start the container
  const args = [
    'run', '-d',
    '--name', name,
    '-p', `${port}:5432`,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_USER=${LOCAL_PG_USER}`,
    '--tmpfs', '/var/lib/postgresql/data',
    '--health-cmd', `pg_isready -U ${LOCAL_PG_USER}`,
    '--health-interval', '5s',
    '--health-timeout', '5s',
    '--health-retries', '20',
    '--health-start-period', '10s',
    image,
  ]

  try {
    await exec(runtime, args, { timeout: CONTAINER_START_TIMEOUT_MS })
  } catch (err) {
    throw new Error(
      `Failed to start PostgreSQL container via ${runtime}: ${(err as Error).message}`,
    )
  }

  // Wait for readiness using actual pg connection
  const url = buildLocalUrl(port, password)
  await waitForPg(url, connect)

  return { runtime, containerName: name, port, url }
}

/**
 * Stop and remove the local PostgreSQL container.
 */
export async function stopLocalPg(
  runtime?: ContainerRuntime,
  name: string = CONTAINER_NAME,
  execFn: ExecFn = defaultExecFile,
): Promise<void> {
  const rt = runtime ?? await detectRuntime(execFn)
  if (!rt) return

  try {
    await execFn(rt, ['rm', '-f', name], { timeout: CONTAINER_RM_TIMEOUT_MS })
  } catch {
    // Container may not exist — ignore
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getContainerStatus(
  runtime: ContainerRuntime,
  name: string,
  execFn: ExecFn,
): Promise<'running' | 'stopped' | 'none'> {
  try {
    const { stdout } = await execFn(
      runtime,
      ['inspect', '--format', '{{.State.Running}}', name],
      { timeout: RUNTIME_DETECT_TIMEOUT_MS },
    )
    return stdout.trim() === 'true' ? 'running' : 'stopped'
  } catch {
    return 'none'
  }
}

function buildLocalUrl(port: number, password: string): string {
  return `postgres://${LOCAL_PG_USER}:${password}@localhost:${port}/postgres`
}

/**
 * Poll PostgreSQL until it accepts connections.
 * Uses actual pg.Client connection rather than relying on container health checks
 * (which may not work on all runtimes).
 */
async function waitForPg(url: string, connectFn: ConnectFn): Promise<void> {
  for (let i = 0; i < READINESS_RETRIES; i++) {
    try {
      await connectFn(url)
      return
    } catch {
      await sleep(READINESS_INTERVAL_MS)
    }
  }
  throw new Error(
    `PostgreSQL at ${url} did not become ready within ${READINESS_RETRIES * READINESS_INTERVAL_MS / 1000}s`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
