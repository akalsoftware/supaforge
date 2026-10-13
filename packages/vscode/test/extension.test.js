// Runs inside VS Code, with test/fixture — a SupaForge project — open.
const assert = require('node:assert')
const path = require('node:path')
const vscode = require('vscode')

const ID = 'akalsoftware.supaforge'

suite('SupaForge extension', () => {
  let api
  let version

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(ID)
    assert.ok(extension, `${ID} is installed`)
    api = await extension.activate()
    version = extension.packageJSON.version
  })

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true)
    for (const id of ['diff', 'diffDetail', 'preview', 'apply', 'snapshot', 'init', 'docs']) {
      assert.ok(commands.includes(`supaforge.${id}`), `supaforge.${id}`)
    }
  })

  test('runs the CLI version it was released with', () => {
    assert.strictEqual(api.cliSpec(), `@akal/supaforge@${version}`)
  })

  test('offers the MCP server for the project, pointed at it', function () {
    if (!vscode.lm?.registerMcpServerDefinitionProvider) this.skip()
    const servers = api.mcpServers()
    assert.strictEqual(servers.length, 1)
    const [server] = servers
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath
    assert.strictEqual(server.label, 'SupaForge')
    assert.strictEqual(path.resolve(server.cwd.fsPath), path.resolve(folder))
    const args = server.args.join(' ')
    assert.ok(args.includes(`@akal/supaforge@${version} mcp --project ${folder}`), args)
  })

  test('follows supaforge.cliVersion', async () => {
    const config = vscode.workspace.getConfiguration('supaforge')
    await config.update('cliVersion', 'latest', vscode.ConfigurationTarget.Workspace)
    try {
      assert.strictEqual(api.cliSpec(), '@akal/supaforge@latest')
    } finally {
      await config.update('cliVersion', undefined, vscode.ConfigurationTarget.Workspace)
    }
  })
})
