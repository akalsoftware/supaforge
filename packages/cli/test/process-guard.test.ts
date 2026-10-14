import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const guard = fileURLToPath(new URL('../src/process-guard.ts', import.meta.url))

/** Run a script that installs the guard and then lets an error escape. */
function crash(escape: string, args: string[] = [], before = '') {
  const script = `
    import { installProcessGuard, keepRunningOnStrayErrors, noteJsonWritten } from ${JSON.stringify(guard)}
    ${before}
    installProcessGuard(${JSON.stringify(args)})
    ${escape}
    setTimeout(() => { process.stdout.write('still running\\n') }, 50)
  `
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' })
}

describe('process guard', () => {
  it('ends an unhandled error event with one line and exit 1, not a stack trace', () => {
    const run = crash(`new (await import('node:events')).EventEmitter().emit('error', new Error('canceling statement due to statement timeout'))`)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Unexpected error: canceling statement due to statement timeout')
    expect(run.stderr).not.toMatch(/\n\s+at /)
    expect(run.stdout).not.toContain('still running')
  })

  it('prints a JSON error under --json', () => {
    const run = crash(`Promise.reject(new Error('lost'))`, ['--json'])
    expect(run.status).toBe(1)
    expect(JSON.parse(run.stdout)).toEqual({ error: 'lost' })
  })

  it('adds no second JSON document once the result was written', () => {
    const run = crash(`Promise.reject(new Error('late'))`, ['--json'], 'noteJsonWritten()')
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
  })

  it('redacts a connection URL in the message', () => {
    const run = crash(`Promise.reject(new Error('could not reach postgres://u:secret@db.example.com:5432/x'))`)
    expect(run.stderr).not.toContain('secret')
  })

  it('keeps a server running', () => {
    const run = crash(`Promise.reject(new Error('one bad call'))`, [], 'keepRunningOnStrayErrors()')
    expect(run.status).toBe(0)
    expect(run.stderr).toContain('one bad call')
    expect(run.stdout).toContain('still running')
  })
})
