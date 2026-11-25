import { describe, it, expect, vi, afterEach } from 'vitest'
import { transactionPoolerWarning, warnIfTransactionPooler } from '../src/pooler.js'

describe('transactionPoolerWarning', () => {
  it('names Supabase\'s transaction pooler port, and a URL marked pgbouncer', () => {
    expect(transactionPoolerWarning('postgresql://postgres.ref:pw@aws-0-eu-central-2.pooler.supabase.com:6543/postgres'))
      .toMatch(/^aws-0-eu-central-2\.pooler\.supabase\.com:6543 looks like a transaction-mode connection pooler\./)
    expect(transactionPoolerWarning('postgresql://u:p@db.example.com:5432/app?pgbouncer=true')).toMatch(/transaction-mode/)
  })

  it('says nothing of the session pooler, a direct connection, or what is not a URL', () => {
    expect(transactionPoolerWarning('postgresql://postgres.ref:pw@aws-0-eu-central-2.pooler.supabase.com:5432/postgres')).toBeUndefined()
    expect(transactionPoolerWarning('postgresql://u:p@db.example.com/app?pgbouncer=false')).toBeUndefined()
    expect(transactionPoolerWarning('not a url')).toBeUndefined()
  })

  it('never repeats the password', () => {
    expect(transactionPoolerWarning('postgresql://u:hunter2@h:6543/app')).not.toContain('hunter2')
  })
})

describe('warnIfTransactionPooler', () => {
  afterEach(() => vi.restoreAllMocks())

  it('says it on stderr once per URL', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    warnIfTransactionPooler('postgresql://u:p@h:6543/once')
    warnIfTransactionPooler('postgresql://u:p@h:6543/once')
    warnIfTransactionPooler('postgresql://u:p@h:5432/never')
    expect(write).toHaveBeenCalledTimes(1)
    expect(String(write.mock.calls[0][0])).toMatch(/^Warning: h:6543 looks like/)
  })
})
