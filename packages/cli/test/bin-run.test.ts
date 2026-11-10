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
})
