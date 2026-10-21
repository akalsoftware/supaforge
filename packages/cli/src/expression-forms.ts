/**
 * One spelling for two ways PostgreSQL prints the same constant array.
 *
 * `x IN ('a', 'b')` on a varchar column is printed with the cast on the whole
 * array — `(ARRAY['a'::character varying, 'b'::character varying])::text[]` —
 * but SQL written from that print, parsed again, can come back with the cast
 * on each element instead — `ARRAY[('a'::character varying)::text, …]`. Both
 * forms are stable from then on, so a CHECK, index or policy made from a
 * previous sync's SQL never reads like the source's. Only an array of quoted
 * constants is rewritten: for those, casting the array and casting each
 * element are the same.
 */
const LITERAL = `'(?:[^']|'')*'(?:::[a-z_][\\w ]*(?:\\(\\d+(?:,\\s*\\d+)?\\))?)?`
const CAST_ARRAY = new RegExp(`\\(ARRAY\\[(${LITERAL}(?:, ${LITERAL})*)\\]\\)::([a-z_][\\w ]*?(?:\\(\\d+(?:,\\s*\\d+)?\\))?)\\[\\]`, 'g')
const ELEMENT = new RegExp(LITERAL, 'g')

export function canonicalArrays(text: string): string {
  return text.replace(CAST_ARRAY, (_match, elements: string, type: string) =>
    `ARRAY[${(elements.match(ELEMENT) ?? []).map(e => `(${e})::${type}`).join(', ')}]`)
}
