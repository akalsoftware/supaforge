/**
 * Structural diff between two schema-state documents.
 *
 * The convergence proof used to compare fingerprints — one sorted string per
 * database — and report the lines that differed. That is correct but close to
 * unreadable: a changed column arrives as two near-identical lines of catalog
 * shorthand and leaves the reader to spot the one field that moved.
 *
 *   missing:    col public.orders.total numeric NO - ident= gen= store=x compress=- coll=-
 *   unexpected: col public.orders.total numeric NO - ident= gen= store=p compress=- coll=-
 *
 * The state document has the same information as data, so the same difference
 * can be named:
 *
 *   column public.orders.total: storage extended → plain
 *
 * Detection is unchanged. The state document is verified to distinguish every
 * pair of schemas the fingerprint distinguishes, so this reports the same
 * differences — it does not find more of them, and it must not find fewer.
 */
import type { SchemaState, StateTable, StateColumn } from '@akal/pg-conformance'

/** How a value reads when absent, so `null` never reaches the output raw. */
const show = (v: unknown): string => {
  if (v === null || v === undefined) return 'none'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** `schema.name`, or just the name when the schema adds nothing. */
const qualify = (schema: string, name: string): string => `${schema}.${name}`

/**
 * Compare one field of two objects, appending a finding when it moved.
 *
 * Values are compared by their rendered form rather than by identity, so an
 * array whose contents match reads as unchanged even when the two documents
 * hold different array instances.
 */
function compareField(
  out: string[], subject: string, label: string, before: unknown, after: unknown,
): void {
  const a = show(before), b = show(after)
  if (a !== b) out.push(`${subject}: ${label} ${a} → ${b}`)
}

/** Diff two collections keyed by a stable identity. */
function compareKeyed<T>(
  out: string[],
  kind: string,
  before: T[] | null | undefined,
  after: T[] | null | undefined,
  keyOf: (item: T) => string,
  compare: (out: string[], subject: string, a: T, b: T) => void,
  /** Said after `unexpected`, of an object only the second side has. */
  note: (item: T) => string = () => '',
): void {
  const a = new Map((before ?? []).map(x => [keyOf(x), x]))
  const b = new Map((after ?? []).map(x => [keyOf(x), x]))

  for (const [key, item] of a) {
    if (!b.has(key)) out.push(`${kind} ${key}: missing`)
    else compare(out, `${kind} ${key}`, item, b.get(key) as T)
  }
  for (const [key, item] of b) {
    if (!a.has(key)) out.push(`${kind} ${key}: unexpected${note(item)}`)
  }
}

function compareColumn(out: string[], subject: string, a: StateColumn, b: StateColumn): void {
  compareField(out, subject, 'type', a.type, b.type)
  compareField(out, subject, 'not null', a.not_null, b.not_null)
  compareField(out, subject, 'default', a.default, b.default)
  compareField(out, subject, 'identity', a.identity, b.identity)
  compareField(out, subject, 'identity options', a.identity_options, b.identity_options)
  compareField(out, subject, 'generated', a.generated, b.generated)
  compareField(out, subject, 'storage', a.storage, b.storage)
  compareField(out, subject, 'compression', a.compression, b.compression)
  compareField(out, subject, 'collation', a.collation, b.collation)
  compareField(out, subject, 'comment', a.comment, b.comment)
}

function compareTable(out: string[], subject: string, a: StateTable, b: StateTable): void {
  compareField(out, subject, 'kind', a.kind, b.kind)
  compareField(out, subject, 'unlogged', a.unlogged, b.unlogged)
  compareField(out, subject, 'partition of', a.partition_of, b.partition_of)
  compareField(out, subject, 'partition bound', a.partition_bound, b.partition_bound)
  compareField(out, subject, 'partition by', a.partition_by, b.partition_by)
  compareField(out, subject, 'inherits', a.inherits, b.inherits)
  compareField(out, subject, 'options', a.options, b.options)
  compareField(out, subject, 'RLS enabled', a.rls_enabled, b.rls_enabled)
  compareField(out, subject, 'RLS forced', a.rls_forced, b.rls_forced)
  compareField(out, subject, 'comment', a.comment, b.comment)

  // Findings name the object in full — "column public.orders.total" — so a
  // reader never has to hold the enclosing table in their head.
  const prefix = subject.replace(/^table /, '')
  compareKeyed(out, 'column', a.columns, b.columns,
    c => `${prefix}.${c.name}`,
    (o, s, x, y) => compareColumn(o, s, x, y))
  compareKeyed(out, `constraint on ${prefix}`, a.constraints, b.constraints,
    c => c.name,
    (o, s, x, y) => {
      compareField(o, s, 'definition', x.definition, y.definition)
      compareField(o, s, 'validated', x.validated, y.validated)
      compareField(o, s, 'deferrable', x.deferrable, y.deferrable)
      compareField(o, s, 'deferred', x.deferred, y.deferred)
    })
  compareKeyed(out, `index on ${prefix}`, a.indexes, b.indexes,
    i => i.name,
    (o, s, x, y) => compareField(o, s, 'definition', x.definition, y.definition))
  compareKeyed(out, `policy on ${prefix}`, a.policies, b.policies,
    p => p.name,
    (o, s, x, y) => {
      compareField(o, s, 'command', x.command, y.command)
      compareField(o, s, 'permissive', x.permissive, y.permissive)
      compareField(o, s, 'roles', x.roles, y.roles)
      compareField(o, s, 'using', x.using, y.using)
      compareField(o, s, 'with check', x.with_check, y.with_check)
    })
  compareKeyed(out, `trigger on ${prefix}`, a.triggers, b.triggers,
    t => t.name,
    (o, s, x, y) => compareField(o, s, 'definition', x.definition, y.definition))
}

/**
 * Everything that differs between two schema states, most structural first.
 *
 * Returns an empty array when the two are identical. Each entry names the
 * object and what about it moved, so the caller can print the list as-is.
 */
export function diffState(before: SchemaState, after: SchemaState): string[] {
  const out: string[] = []

  compareKeyed(out, 'table', before.tables, after.tables,
    t => qualify(t.schema, t.name),
    (o, s, a, b) => compareTable(o, s, a, b))

  compareKeyed(out, 'view', before.views, after.views,
    v => qualify(v.schema, v.name),
    (o, s, a, b) => {
      compareField(o, s, 'materialized', a.materialized, b.materialized)
      compareField(o, s, 'definition', a.definition, b.definition)
      compareField(o, s, 'options', a.options, b.options)
    })

  compareKeyed(out, 'sequence', before.sequences, after.sequences,
    q => qualify(q.schema, q.name),
    (o, s, a, b) => {
      for (const k of ['type', 'start', 'increment', 'min', 'max', 'cache', 'cycle', 'owned_by'] as const) {
        compareField(o, s, k.replace('_', ' '), a[k], b[k])
      }
    },
    // A serial or identity column's: it goes with its table.
    q => q.owned_by ? ` (owned by ${q.owned_by})` : '')

  compareKeyed(out, 'routine', before.routines, after.routines,
    r => `${qualify(r.schema, r.name)}(${r.arguments})`,
    (o, s, a, b) => {
      compareField(o, s, 'kind', a.kind, b.kind)
      compareField(o, s, 'definition', a.definition, b.definition)
    })

  compareKeyed(out, 'type', before.types, after.types,
    t => qualify(t.schema, t.name),
    (o, s, a, b) => {
      compareField(o, s, 'kind', a.kind, b.kind)
      compareField(o, s, 'labels', a.labels, b.labels)
      compareField(o, s, 'base type', a.base_type, b.base_type)
      compareField(o, s, 'not null', a.not_null, b.not_null)
      compareField(o, s, 'default', a.default, b.default)
      compareField(o, s, 'constraints', a.constraints, b.constraints)
      compareField(o, s, 'attributes', a.attributes, b.attributes)
    })

  compareKeyed(out, 'extension', before.extensions, after.extensions,
    e => e.name,
    (o, s, a, b) => compareField(o, s, 'version', a.version, b.version))

  return out
}
