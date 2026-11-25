import {describe, expect, it} from 'vitest'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const bin = fileURLToPath(new URL('../bin/run.js', import.meta.url))

// A reader that stops early (supaforge --help | head) closes stdout before the
// CLI is done writing. That must end the run as a success, not as Node's exit
// 13 for a top-level await that never settled.
describe('bin/run.js', () => {
  it('exits 0 when stdout is closed before it writes', async () => {
    const child = spawn(process.execPath, [bin, '--version'], {stdio: ['ignore', 'pipe', 'pipe']})
    child.stdout.destroy()
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(stderr).not.toMatch(/unsettled top-level await/)
    expect(code).toBe(0)
  })

  // What runs when the package is installed: not bin/dev.js, which the other
  // CLI tests use. A failure before any command, for a script.
  it('says an unknown command in one line, and as JSON under --json', async () => {
    const out = async (args: string[]) => {
      const child = spawn(process.execPath, [bin, ...args], {stdio: ['ignore', 'pipe', 'pipe']})
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      return {code, stdout, stderr}
    }
    const plain = await out(['frobnicate'])
    expect(plain.code).toBe(2)
    expect(plain.stderr).toBe('Error: command frobnicate not found\n')
    const json = await out(['frobnicate', '--json'])
    expect(JSON.parse(json.stdout)).toEqual({error: 'command frobnicate not found', code: 'E_USAGE'})
  })
})
