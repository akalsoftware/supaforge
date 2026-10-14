/**
 * dbdiff's `--units` output: each change's statements between
 *
 *     -- dbdiff:unit <Kind> <object>
 *     ...
 *     -- dbdiff:end
 *
 * Some changes are several statements that only work together and in order —
 * an enum label swap, a column type change with the views reading it stood
 * aside, a generated column re-added, a serial column turned into an identity.
 * Split into separate findings they were reordered, half-applied, or held back
 * as destructive for a DROP the same change undoes a statement later. The
 * markers say where each change starts and ends, and which object it is, so
 * nothing here has to guess that from the SQL:
 *
 *   - a unit is one finding, whatever it holds;
 *   - its DOWN is the unit of the same kind and object in the DOWN section,
 *     not whatever happens to sit at the same position there.
 */

/** One change, as dbdiff marked it. */
export interface DbDiffUnit {
  /** dbdiff's diff class: `AlterTableChangeColumn`, `AlterEnum`, `CreateView`, … */
  kind: string
  /** `table`, `table.column`, `table.name` or `name` — empty when dbdiff gave none. */
  object: string
  /** The unit's SQL, statements in order, without the marker lines. */
  sql: string
}

const BEGIN = /^-- dbdiff:unit (\S+)(?: (.*))?$/
const END = '-- dbdiff:end'

/**
 * The units of one section (UP or DOWN), or undefined when it carries no
 * markers — output from a dbdiff without `--units`.
 *
 * Text outside any unit is ignored: dbdiff writes nothing there but blank
 * lines and, without `--nocomments`, its own header.
 */
export function parseUnits(section: string): DbDiffUnit[] | undefined {
  if (!section.includes('-- dbdiff:unit ')) return undefined

  const units: DbDiffUnit[] = []
  let open: { kind: string; object: string; lines: string[] } | undefined

  for (const line of section.split('\n')) {
    const begin = BEGIN.exec(line.trimEnd())
    if (begin) {
      open = { kind: begin[1], object: (begin[2] ?? '').trim(), lines: [] }
    } else if (line.trimEnd() === END && open) {
      units.push({ kind: open.kind, object: open.object, sql: open.lines.join('\n').trim() })
      open = undefined
    } else if (open) {
      open.lines.push(line)
    }
  }

  return units.filter(u => u.sql !== '')
}

/** What identifies a change across the two sections. */
export function unitKey(unit: DbDiffUnit): string {
  return `${unit.kind} ${unit.object}`
}

/**
 * Each UP unit with the DOWN unit for the same change, if there is one.
 *
 * By kind and object, in order: two units with the same key (two overloads of
 * one routine, say) pair first with first. A change can have nothing to do in
 * one direction — a column's storage on a column the DOWN drops anyway — so
 * an UP unit may have no DOWN.
 */
export function pairUnits(
  up: DbDiffUnit[],
  down: DbDiffUnit[],
): Array<{ up: DbDiffUnit; down: DbDiffUnit | undefined }> {
  const unclaimed = new Map<string, DbDiffUnit[]>()
  for (const unit of down) {
    const key = unitKey(unit)
    unclaimed.set(key, [...(unclaimed.get(key) ?? []), unit])
  }
  return up.map(unit => ({ up: unit, down: unclaimed.get(unitKey(unit))?.shift() }))
}

/** The kinds dbdiff renders as dropping and recreating one object. */
export const REPLACING_KINDS: Record<string, 'routine' | 'type' | 'sequence' | 'policy' | 'trigger' | 'view' | 'collation' | undefined> = {
  AlterRoutine: 'routine',
  AlterEnum: 'type',
  AlterCompositeType: 'type',
  AlterDomain: 'type',
  AlterPolicy: 'policy',
  AlterTrigger: 'trigger',
  AlterView: 'view',
  AlterMatView: 'view',
  AlterCollation: 'collation',
}
