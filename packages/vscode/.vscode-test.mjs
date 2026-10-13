import { defineConfig } from '@vscode/test-cli'

export default defineConfig({
  files: 'test/**/*.test.js',
  workspaceFolder: 'test/fixture',
  mocha: { timeout: 60_000 },
})
