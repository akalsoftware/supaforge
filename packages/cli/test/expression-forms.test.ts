import { describe, it, expect } from 'vitest'
import { canonicalArrays } from '../src/expression-forms.js'

// The two ways PostgreSQL prints `kind IN ('web', 'shop')` on a varchar
// column, after one round of SQL written from a print and parsed again.
const WHOLE = `CHECK (((kind)::text = ANY ((ARRAY['web'::character varying, 'shop'::character varying])::text[])))`
const EACH = `CHECK (((kind)::text = ANY (ARRAY[('web'::character varying)::text, ('shop'::character varying)::text])))`

describe('canonicalArrays', () => {
  it('spells a cast on a constant array as a cast on each element', () => {
    expect(canonicalArrays(WHOLE)).toBe(EACH)
    expect(canonicalArrays(EACH)).toBe(EACH)
  })

  it('keeps quotes, types with a length, and several arrays apart', () => {
    expect(canonicalArrays(`a = ANY ((ARRAY['it''s'::varchar(10), 'x'])::text[]) AND b = ANY ((ARRAY['1'::text])::integer[])`))
      .toBe(`a = ANY (ARRAY[('it''s'::varchar(10))::text, ('x')::text]) AND b = ANY (ARRAY[('1'::text)::integer])`)
  })

  it('leaves an array of anything but constants alone', () => {
    const columns = `a = ANY ((ARRAY[b, c])::text[])`
    expect(canonicalArrays(columns)).toBe(columns)
  })
})
