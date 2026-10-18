import { describe, it, expect } from 'vitest'
import { estimateLocks, lockBudgetWarning, readLockBudget } from '../src/lock-budget.js'

describe('estimateLocks', () => {
  it('counts each relation once, however often it is named', () => {
    expect(estimateLocks([
      'ALTER TABLE public.a ADD COLUMN x int;',
      'ALTER TABLE public.a ADD COLUMN y int;',
      'COMMENT ON TABLE public.a IS \'one\';',
    ])).toBe(1)
  })

  it('adds what a new table brings: its TOAST table and index, and an index per key', () => {
    // a, its TOAST table and index, its primary key's index, its identity sequence
    expect(estimateLocks(['CREATE TABLE public.a (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);'])).toBe(5)
    // b and c, b's TOAST pair, its unique key's index; c is only referenced
    expect(estimateLocks(['CREATE TABLE public.b (id int UNIQUE REFERENCES public.c (id));'])).toBe(5)
  })

  it('counts a key added later, an index, and the tables they are on', () => {
    expect(estimateLocks([
      'ALTER TABLE ONLY public.a ADD CONSTRAINT a_pkey PRIMARY KEY (id);',
      'CREATE INDEX a_body ON public.a (body);',
    ])).toBe(3)
  })

  it('grows with the schema', () => {
    const tables = Array.from({ length: 200 }, (_, i) => `CREATE TABLE public.t${i} (id int PRIMARY KEY);`)
    expect(estimateLocks(tables)).toBe(800)
  })

  it('counts a statement it cannot parse as one', () => {
    expect(estimateLocks(['\\connect other', 'not sql at all'])).toBe(2)
  })
})

describe('lockBudgetWarning', () => {
  const budget = { capacity: 1000, inUse: 100 }

  it('says nothing when the locks fit, keeping a tenth for everyone else', () => {
    expect(lockBudgetWarning(800, budget, 'This restore')).toBeUndefined()
    expect(lockBudgetWarning(800, undefined, 'This restore')).toBeUndefined()
  })

  it('warns, with both numbers and the ways round it, when they do not', () => {
    const warning = lockBudgetWarning(801, budget, 'This restore')
    expect(warning).toMatch(/^This restore takes about 801 locks in one transaction, and the target has room for about 800/)
    expect(warning).toContain('max_locks_per_transaction')
    expect(warning).toContain('--no-transaction')
  })
})

describe('readLockBudget', () => {
  it('reads the lock table and what is held', async () => {
    const client = { query: async () => ({ rows: [{ capacity: '6400', in_use: '12' }] }) }
    expect(await readLockBudget(client as never)).toEqual({ capacity: 6400, inUse: 12 })
  })

  it('is undefined when the server will not say', async () => {
    const client = { query: async () => { throw new Error('permission denied') } }
    expect(await readLockBudget(client as never)).toBeUndefined()
  })
})
