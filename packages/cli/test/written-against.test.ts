import { describe, expect, it } from 'vitest'
import { writtenAgainst, writtenAgainstLine } from '../src/written-against.js'

describe('written-against header', () => {
  it('reads back what migrate create writes', () => {
    const sql = `-- Migration: x\n${writtenAgainstLine('production', 'abc123')}\n\nCREATE TABLE t (id int);`
    expect(writtenAgainst(sql)).toEqual({ env: 'production', digest: 'abc123' })
  })

  it('is absent from a migration written by hand', () => {
    expect(writtenAgainst('CREATE TABLE t (id int);')).toBeUndefined()
  })
})
