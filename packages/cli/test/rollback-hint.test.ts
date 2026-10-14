import { describe, expect, it } from 'vitest'
import { rollbackHint } from '../src/commands/diff.js'

describe('rollbackHint', () => {
  it('suggests --no-transaction for an ordinary failure', () => {
    expect(rollbackHint([{ issueId: 'schema-alter-3', error: 'column "x" does not exist' }]))
      .toContain('--no-transaction')
  })

  it('does not, when the failed fix replaces a view others depend on', () => {
    const hint = rollbackHint([{ issueId: 'schema-alter-view-2', error: 'cannot drop view base_v because other objects depend on it' }])
    expect(hint).not.toContain('--no-transaction')
    expect(hint).toContain('schema-alter-view-2')
    expect(hint).toContain('--only')
  })

  it('recognises the dependency error whatever the fix', () => {
    expect(rollbackHint([{ issueId: 'schema-drop-4', error: 'ERROR: 2BP01: cannot drop type st' }]))
      .not.toContain('--no-transaction')
  })
})
