// SupaForge for VS Code and its forks (Cursor, Windsurf, VSCodium…).
//
// Two things: the SupaForge MCP server, offered to the editor's AI agent for
// each workspace folder that has a supaforge.config.json, and commands that
// run the CLI in a terminal. Both run `npx @akal/supaforge@<version>`, the
// version this extension was released with unless supaforge.cliVersion says
// otherwise, so there is nothing else to install beyond Node.js 20+.
'use strict'

const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG = 'supaforge.config.json'
const DOCS = 'https://github.com/akalsoftware/supaforge/tree/main/packages/cli#readme'

/** `@akal/supaforge@<version>` to run. */
function cliSpec(context) {
  const chosen = vscode.workspace.getConfiguration('supaforge').get('cliVersion')
  return `@akal/supaforge@${chosen || context.extension.packageJSON.version}`
}

/** Workspace folders that are SupaForge projects. */
function projectFolders() {
  return (vscode.workspace.workspaceFolders ?? []).filter(f => fs.existsSync(path.join(f.uri.fsPath, CONFIG)))
}

/** The environments a project's config names, and its source and target. */
function readConfig(folder) {
  try {
    // The config may carry comments; strip whole-line ones before parsing.
    const text = fs.readFileSync(path.join(folder.uri.fsPath, CONFIG), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    const json = JSON.parse(text)
    return { environments: Object.keys(json.environments ?? {}), source: json.source, target: json.target }
  } catch {
    return { environments: [] }
  }
}

/**
 * The MCP server definitions: one per project folder. On Windows npx is a
 * .cmd, which Node only starts through a shell.
 */
function mcpServers(context) {
  const folders = projectFolders()
  return folders.map(folder => {
    const args = ['-y', cliSpec(context), 'mcp', '--project', folder.uri.fsPath]
    const [command, commandArgs] = process.platform === 'win32' ? ['cmd', ['/d', '/s', '/c', 'npx', ...args]] : ['npx', args]
    const label = folders.length > 1 ? `SupaForge (${folder.name})` : 'SupaForge'
    const server = new vscode.McpStdioServerDefinition(label, command, commandArgs, {}, cliSpec(context))
    server.cwd = folder.uri
    return server
  })
}

/** The project to act on: the only one, or the user's choice. */
async function pickProject() {
  const folders = projectFolders()
  if (folders.length === 1) return folders[0]
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(
      folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder: 'Which project?' },
    )
    return pick?.folder
  }
  const choice = await vscode.window.showWarningMessage(`No ${CONFIG} in this workspace.`, 'Create one')
  if (choice) await vscode.commands.executeCommand('supaforge.init')
  return undefined
}

/** Run the CLI in a terminal in `folder`. Arguments are fixed words or validated names. */
function run(context, folder, args, title) {
  const terminal = vscode.window.createTerminal({ name: `SupaForge: ${title}`, cwd: folder.uri })
  terminal.show()
  terminal.sendText(['npx', '-y', cliSpec(context), ...args].join(' '))
}

function activate(context) {
  const command = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const onProject = (args, title) => async () => {
    const folder = await pickProject()
    if (folder) run(context, folder, args, title)
  }

  command('supaforge.diff', onProject(['diff'], 'Find Drift'))
  command('supaforge.diffDetail', onProject(['diff', '--detail'], 'Find Drift'))
  command('supaforge.preview', onProject(['diff', '--apply', '--dry-run'], 'Preview Fixes'))

  command('supaforge.apply', async () => {
    const folder = await pickProject()
    if (!folder) return
    const { source, target } = readConfig(folder)
    const choice = await vscode.window.showWarningMessage(
      `Apply SupaForge's fixes to ${target ? `"${target}"` : 'the target'}${source ? `, to match "${source}"` : ''}?`,
      {
        modal: true,
        detail: 'They run in one transaction. Drops and deletes are held back unless you add --allow-destructive yourself. Rehearsing first applies them to a throwaway copy, and only then to the target.',
      },
      'Rehearse, then Apply',
      'Apply',
    )
    if (choice === 'Apply') run(context, folder, ['diff', '--apply'], 'Apply Fixes')
    if (choice === 'Rehearse, then Apply') run(context, folder, ['diff', '--apply', '--prove'], 'Apply Fixes')
  })

  command('supaforge.snapshot', async () => {
    const folder = await pickProject()
    if (!folder) return
    const environments = readConfig(folder).environments.filter(name => /^[\w.-]+$/.test(name))
    const env = environments.length
      ? await vscode.window.showQuickPick(environments, { placeHolder: 'Snapshot which environment?' })
      : undefined
    if (env) run(context, folder, ['snapshot', `--env=${env}`, '--apply'], 'Snapshot')
  })

  command('supaforge.init', async () => {
    const folders = vscode.workspace.workspaceFolders ?? []
    const folder = folders.length > 1
      ? (await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, folder: f })), { placeHolder: 'Create the config where?' }))?.folder
      : folders[0]
    if (!folder) {
      if (!folders.length) vscode.window.showWarningMessage('Open a folder first.')
      return
    }
    run(context, folder, ['init'], 'Create Config')
  })

  command('supaforge.docs', () => vscode.env.openExternal(vscode.Uri.parse(DOCS)))

  // The MCP server, where the editor supports extensions providing one
  // (VS Code 1.101+). Elsewhere the commands still work.
  if (vscode.lm && typeof vscode.lm.registerMcpServerDefinitionProvider === 'function' && vscode.McpStdioServerDefinition) {
    const changed = new vscode.EventEmitter()
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG}`)
    context.subscriptions.push(
      changed,
      watcher,
      watcher.onDidCreate(() => changed.fire()),
      watcher.onDidDelete(() => changed.fire()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('supaforge') && changed.fire()),
      vscode.lm.registerMcpServerDefinitionProvider('supaforge', {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: async () => mcpServers(context),
      }),
    )
  }

  // For the extension's own tests.
  return { mcpServers: () => mcpServers(context), cliSpec: () => cliSpec(context) }
}

function deactivate() {}

module.exports = { activate, deactivate }
