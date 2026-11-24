import { describe, it, expect } from 'vitest'
import { errorCode, errorJson, errorLine, oneLine, preflightCode } from '../src/utils/error-report.js'

describe('oneLine', () => {
  it('takes out oclif’s "See more help" pointer and colour codes', () => {
    expect(oneLine('Nonexistent flag: --x\nSee more help with --help')).toBe('Nonexistent flag: --x')
    expect(oneLine('\u001b[31mred\u001b[39m')).toBe('red')
  })

  it('joins a list under a heading with semicolons', () => {
    expect(oneLine('Invalid configuration:\n  a is missing\n  b is missing')).toBe('Invalid configuration: a is missing; b is missing')
  })

  it('hides a URL’s password', () => {
    expect(oneLine('failed for postgresql://user:hunter2@db.example.com/app')).not.toContain('hunter2')
  })
})

describe('errorCode', () => {
  it('keeps a code its throw site set', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'E_CONFIG' }))).toBe('E_CONFIG')
  })

  it('ignores a code that is not one of ours, such as a Node errno', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('E_FAILED')
  })

  it('reads oclif’s parser errors as usage', () => {
    class NonExistentFlagsError extends Error {}
    expect(errorCode(new NonExistentFlagsError('Nonexistent flag: --x'))).toBe('E_USAGE')
    expect(errorCode(new Error('command frobnicate not found'))).toBe('E_USAGE')
    expect(errorCode(new Error('Expected --check=x to be one of: a, b'))).toBe('E_USAGE')
  })

  it('reads config and TLS failures', () => {
    expect(errorCode(new Error('Could not load supaforge.config.json: bad'))).toBe('E_CONFIG')
    expect(errorCode(new Error('TLS check of db:5432 failed: self-signed certificate'))).toBe('E_TLS')
  })

  it('is E_FAILED otherwise', () => {
    expect(errorCode(new Error('something else'))).toBe('E_FAILED')
    expect(errorCode('a string')).toBe('E_FAILED')
  })
})

describe('preflightCode', () => {
  it('a database it could not reach, or whose certificate failed, or another check', () => {
    expect(preflightCode([{ kind: 'database', error: 'connect ECONNREFUSED' }])).toBe('E_CONNECT')
    expect(preflightCode([{ kind: 'database', error: 'TLS check of h:1 failed: x' }])).toBe('E_TLS')
    expect(preflightCode([{ kind: 'check', error: 'pg_dump not found' }])).toBe('E_PRECONDITION')
  })
})

it('errorLine and errorJson', () => {
  const err = Object.assign(new Error('Invalid configuration:\n  a\n  b'), { code: 'E_CONFIG' })
  expect(errorLine(err)).toBe('Error: Invalid configuration: a; b')
  expect(errorJson(err)).toEqual({ error: 'Invalid configuration: a; b', code: 'E_CONFIG' })
})
