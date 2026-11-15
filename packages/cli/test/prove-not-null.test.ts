import { describe, it, expect } from 'vitest'
import { withoutNotNullConstraints } from '../src/prove.js'

describe('withoutNotNullConstraints', () => {
  const fp = [
    'col public.t.label type=text notnull=t default=- ident= gen= store=x compress=- coll=default',
    'con public.t.t_label_not_null NOT NULL label valid=t deferrable=f deferred=f',
    'con public.t."odd name" NOT NULL "Label" valid=t deferrable=f deferred=f',
    'con public.t.t_n_not_null NOT NULL n valid=f deferrable=f deferred=f',
    'con public.t.t_m_not_null NOT NULL m NO INHERIT valid=t deferrable=f deferred=f',
    'con public.t.t_pkey PRIMARY KEY (id) valid=t deferrable=f deferred=f',
  ].join('\n')

  it('leaves out plain NOT NULL constraints and keeps the column NOT NULL', () => {
    expect(withoutNotNullConstraints(fp).split('\n')).toEqual([
      'col public.t.label type=text notnull=t default=- ident= gen= store=x compress=- coll=default',
      'con public.t.t_n_not_null NOT NULL n valid=f deferrable=f deferred=f',
      'con public.t.t_m_not_null NOT NULL m NO INHERIT valid=t deferrable=f deferred=f',
      'con public.t.t_pkey PRIMARY KEY (id) valid=t deferrable=f deferred=f',
    ])
  })
})
