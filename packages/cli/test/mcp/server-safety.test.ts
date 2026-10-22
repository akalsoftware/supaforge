import { describe, it, expect } from 'vitest'
import { createServer } from '../../src/mcp/server.js'

/**
 * What an MCP client can tell about these tools, and what it can reach (#96).
 *
 * Three things made it easy for an agent to write when it only meant to look:
 * no tool carried annotations, so a client could not tell the read-only scan from
 * the tool that applies fixes and could not confirm the right one; that tool wrote unless
 * `dryRun: true` was passed, the opposite of everywhere else in supaforge; and
 * every tool accepted an arbitrary `configPath`, so a tool call — or a prompt
 * injected into one — could point the server at any config on disk, including
 * one holding production credentials.
 */

/**
 * The registered tools, read off the server.
 *
 * The SDK keeps them on the instance and the shape is not part of its public
 * types, so this reaches in deliberately. `inputSchema` is a Zod schema rather
 * than JSON Schema, and the callback is `handler`.
 */
function toolsOf(server: unknown): Record<string, {
  annotations?: Record<string, unknown>
  inputSchema?: { parse: (value: unknown) => Record<string, unknown>; shape?: Record<string, unknown> }
  handler: (args: unknown, extra: unknown) => Promise<{
    isError?: boolean
    content: Array<{ text: string }>
  }>
}> {
  const registered = (server as { _registeredTools?: Record<string, unknown> })._registeredTools
  return (registered ?? {}) as ReturnType<typeof toolsOf>
}

describe('MCP tool annotations', () => {
  const tools = toolsOf(createServer('/tmp'))

  it('registers the documented tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'create_migration', 'diff', 'get_check_result', 'list_environments', 'sync', 'take_snapshot',
    ])
  })

  it('marks the read-only tools read-only', () => {
    for (const name of ['diff', 'get_check_result', 'list_environments']) {
      expect(tools[name].annotations?.readOnlyHint, name).toBe(true)
      expect(tools[name].annotations?.destructiveHint, name).toBe(false)
    }
  })

  it('marks sync destructive, and nothing else', () => {
    // This is the one a client should ask about before running.
    expect(tools.sync.annotations?.destructiveHint).toBe(true)
    expect(tools.sync.annotations?.readOnlyHint).toBe(false)

    for (const name of ['diff', 'get_check_result', 'list_environments', 'take_snapshot', 'create_migration']) {
      expect(tools[name].annotations?.destructiveHint, name).toBe(false)
    }
  })

  it('does not call the local-file tools read-only', () => {
    // They write snapshots and migration files, so a client that treats
    // readOnly as "safe to run unattended" should not be told they are.
    for (const name of ['take_snapshot', 'create_migration']) {
      expect(tools[name].annotations?.readOnlyHint, name).toBe(false)
    }
  })

  it('gives every tool annotations', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.annotations, `${name} has no annotations`).toBeDefined()
    }
  })
})

describe('MCP planning and writing are separate tools', () => {
  // A single tool with a "really write" argument has to be marked destructive,
  // so a client asks before every plan too — or it is marked read-only and
  // can write. Two tools let the annotations tell the truth about each.
  const tools = toolsOf(createServer('/tmp'))

  it('diff and sync take the same arguments, so the plan shown is the plan run', () => {
    const args = (name: string) => Object.keys(tools[name].inputSchema?.shape ?? {}).sort()
    expect(args('sync').filter(a => a !== 'prove')).toEqual(args('diff'))
  })

  it('holds back drops, and does not prove, unless asked', () => {
    // Parsed with the arguments left out, which is what the tool receives
    // when a client does not pass them.
    expect(tools.sync.inputSchema?.parse({})).toMatchObject({ allowDestructive: false, prove: false })
    expect(tools.diff.inputSchema?.parse({})).toMatchObject({ allowDestructive: false })
  })

  it('has no dry-run switch on sync: previewing is diff\'s job', () => {
    expect(Object.keys(tools.sync.inputSchema?.shape ?? {})).not.toContain('dryRun')
  })
})

describe('MCP configPath', () => {
  /** Call a tool the way the transport would, and return its text. */
  async function callScan(server: unknown, args: Record<string, unknown>) {
    return toolsOf(server).diff.handler(args, {})
  }

  it('is refused by default, and says why', async () => {
    const result = await callScan(createServer('/tmp/here'), {
      configPath: '/somewhere/else/supaforge.config.json',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('configPath is not accepted')
    expect(result.content[0].text).toContain('--allow-config-path')
    // Naming the directory it *will* read matters: a client that asked for
    // another project should know which one it got instead.
    expect(result.content[0].text).toContain('/tmp/here')
  })

  it('is refused rather than ignored', async () => {
    // Silently reading a different config than the one asked for would be
    // worse than refusing: the caller would trust the answer.
    const result = await callScan(createServer('/tmp/here'), {
      configPath: '/somewhere/else/supaforge.config.json',
    })

    expect(result.isError).toBe(true)
  })

  it('is accepted when the server was started with the flag', async () => {
    // It fails on the missing file rather than on the path being refused,
    // which is what shows the guard is off.
    const result = await callScan(
      createServer('/tmp/here', { allowConfigPath: true }),
      { configPath: '/somewhere/else/supaforge.config.json' },
    )

    expect(result.content[0].text).not.toContain('configPath is not accepted')
  })

  it('reads its own working directory when no path is given', async () => {
    const result = await callScan(createServer('/tmp/here'), {})

    expect(result.content[0].text).not.toContain('configPath is not accepted')
  })
})

describe('MCP server version', () => {
  it('reports the package version rather than a hardcoded one', async () => {
    // It was pinned at '0.0.4' and had drifted fifteen releases (issue #82).
    const { readFile } = await import('node:fs/promises')
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf-8'))

    const version = (createServer('/tmp') as unknown as {
      server: { _serverInfo: { version: string } }
    }).server._serverInfo.version

    expect(version).toBe(pkg.version)
    expect(version).not.toBe('0.0.4')
  })
})
