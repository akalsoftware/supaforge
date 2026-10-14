import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command, Flags } from '@oclif/core'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from '../mcp/server.js'
import { installProcessGuard, keepRunningOnStrayErrors } from '../process-guard.js'

export default class Mcp extends Command {
  static override description =
    'Start the SupaForge MCP stdio server for use with Claude Desktop, Cursor, or any MCP-compatible AI client'

  static override examples = [
    '<%= config.bin %> mcp',
    '<%= config.bin %> mcp --allow-config-path',
    '<%= config.bin %> mcp --project ~/code/my-app',
    '# Claude Desktop / Cursor config:\n# { "mcpServers": { "supaforge": { "command": "supaforge", "args": ["mcp"] } } }',
  ]

  static override flags = {
    project: Flags.string({
      description:
        'The project directory, holding supaforge.config.json. Defaults to the '
        + 'directory the server starts in — which an AI client may not let you '
        + 'choose, so name it here.',
    }),
    'allow-config-path': Flags.boolean({
      description:
        'Let a client choose which supaforge.config.json to load. Off by default: '
        + 'a tool call, or a prompt injected into one, could otherwise point the '
        + 'server at any config on disk — including one holding production '
        + 'credentials — bypassing the one it was started with.',
      default: false,
    }),
  }

  async run(): Promise<void> {
    keepRunningOnStrayErrors()
    installProcessGuard(this.argv)
    const { flags } = await this.parse(Mcp)
    const project = resolve(flags.project ?? process.cwd())
    if (!existsSync(project) || !statSync(project).isDirectory()) {
      this.error(`--project: ${project} is not a directory`)
    }
    const server = createServer(project, {
      allowConfigPath: flags['allow-config-path'],
    })
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // Log to stderr so it doesn't pollute MCP stdio communication
    this.warn('SupaForge MCP server running on stdio')
  }
}
