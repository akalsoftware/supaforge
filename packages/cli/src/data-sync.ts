/**
 * Writing reference rows into a live target the way replication does.
 *
 * A data fix makes the target's rows equal the source's. The target's own
 * triggers fired on every row it wrote: an `updated_at` trigger overwrote the
 * value just synced, so the tables never converged; an audit trigger wrote
 * log rows that then collided with the log rows being synced, and rolled the
 * whole apply back; a Supabase webhook would call its endpoint once per row.
 * pg_dump's `--disable-triggers` and logical replication both apply rows with
 * the target's triggers held off, and so does this.
 *
 * Only triggers that would fire for an ordinary session are held off
 * (`tgenabled = 'O'`). One made `ENABLE ALWAYS` fires during replication, and
 * fires here too; constraint triggers and the internal ones enforcing foreign
 * keys are never touched. `ALTER TABLE … DISABLE TRIGGER` takes a SHARE ROW
 * EXCLUSIVE lock, which leaves the table readable, and is undone with the
 * rest of the transaction if the apply rolls back.
 *
 * A row can also need a row that comes after it in the same table: a tree
 * whose node was moved under a newer one. That is the only case where rows of
 * one table can't be put in an order that satisfies the table's own foreign
 * key one statement at a time. When a row fails that key, the key is made
 * `DEFERRABLE INITIALLY DEFERRED` for the rest of the transaction and the row
 * tried again; before commit every deferred row is checked
 * (`SET CONSTRAINTS … IMMEDIATE`) and the key made `NOT DEFERRABLE` again, so
 * an orphan still rolls the whole apply back. Done only on demand, because
 * altering a constraint takes an ACCESS EXCLUSIVE lock until commit.
 *
 * Both need the connecting role to own the table. Without that, triggers fire
 * as before, and the run says so.
 */
import type pg from 'pg'
import { quoteName } from './utils/sql.js'

/** The SQLSTATE of a foreign key violation. */
export const FOREIGN_KEY_VIOLATION = '23503'

/** `INSERT INTO t`, `UPDATE [ONLY] t`, `DELETE FROM [ONLY] t`: the table a data fix writes, as written. */
const WRITES = /^\s*(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM(?:\s+ONLY)?)\s+((?:"(?:[^"]|"")*"|[\w$]+)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[\w$]+))?)/i

/** The table a data fix writes, as the fix names it, or undefined when it writes none. */
export function writtenTable(sql: string): string | undefined {
  return WRITES.exec(sql)?.[1]
}

interface TableFacts {
  rel: string
  owned: boolean
  triggers: string[]
}

/** A foreign key by its table and name: where it is, whether this role may alter it, whether it is the table's own. */
const KEY_SQL = `
  SELECT c.oid::regclass::text AS rel, quote_ident(n.nspname) || '.' || quote_ident(k.conname) AS qualified,
         pg_has_role(c.relowner, 'MEMBER') AS owned, k.conrelid = k.confrelid AS self
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE k.contype = 'f' AND NOT k.condeferrable AND c.relname = $2 AND k.conname = $3
     AND ($1::text IS NULL OR n.nspname = $1)
   LIMIT 1`

const FACTS_SQL = `
  SELECT c.oid::regclass::text AS rel,
         pg_has_role(c.relowner, 'MEMBER') AS owned,
         coalesce((SELECT json_agg(t.tgname ORDER BY t.tgname) FROM pg_trigger t
                    WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND t.tgconstraint = 0
                      AND t.tgenabled = 'O'), '[]') AS triggers
    FROM pg_class c
   WHERE c.oid = to_regclass($1)`

/** One apply's data fixes: what it held off, and what it must put back before commit. */
export class DataSyncGuard {
  /** Facts per table as the fixes name it; null for a name the target does not resolve. */
  private readonly tables = new Map<string, TableFacts | null>()
  /** Statements to run before commit, in order: deferred checks first, then the triggers back on. */
  private readonly checks: string[] = []
  private readonly reenable: string[] = []
  private readonly deferred = new Set<string>()
  /** Said in the run's output: what was held off, and what could not be. */
  readonly notes: string[] = []
  readonly warnings: string[] = []

  constructor(private readonly client: Pick<pg.Client, 'query'>) {}

  /** Before a data fix: hold off the triggers of the table it writes, once per table. */
  /** True when it held triggers off, and so changed the target. */
  async before(sql: string): Promise<boolean> {
    const name = writtenTable(sql)
    if (!name || this.tables.has(name)) return false
    const facts = await this.factsFor(name)
    this.tables.set(name, facts)
    if (!facts || facts.triggers.length === 0) return false
    const list = facts.triggers.map(t => `"${t}"`).join(', ')
    if (!facts.owned) {
      this.warnings.push(`Triggers on ${facts.rel} fired as its rows were synced (${list}): the connecting role does not `
        + 'own the table, so they could not be held off, and what they write may differ from the source.')
      return false
    }
    for (const trigger of facts.triggers) {
      await this.client.query(`ALTER TABLE ${facts.rel} DISABLE TRIGGER ${quoteName(trigger)}`)
      this.reenable.push(`ALTER TABLE ${facts.rel} ENABLE TRIGGER ${quoteName(trigger)}`)
    }
    this.notes.push(`Held off ${facts.triggers.length === 1 ? 'trigger' : 'triggers'} ${list} on ${facts.rel} while its rows were synced.`)
    return true
  }

  /**
   * After a data fix failed with `err`: true when the failure was a foreign
   * key between rows this apply writes and it is now deferred, so the fix can
   * be tried again. A table's own key (a node moved under a newer one), or one
   * between tables that reference each other in a cycle, which no order of
   * tables satisfies. The key is found from the error: the table that holds
   * it, which for a delete is not the table the fix writes. It must be one
   * the connecting role owns, and not deferrable already.
   */
  async deferForeignKey(sql: string, err: unknown): Promise<boolean> {
    const e = err as { code?: unknown; schema?: unknown; table?: unknown; constraint?: unknown } | null
    if (e?.code !== FOREIGN_KEY_VIOLATION || typeof e.constraint !== 'string' || typeof e.table !== 'string') return false
    const written = writtenTable(sql)
    if (!written) return false
    const { rows: [key] } = await this.client.query<{ rel: string; qualified: string; owned: boolean; self: boolean }>(KEY_SQL,
      [typeof e.schema === 'string' ? e.schema : null, e.table, e.constraint])
    if (!key?.owned || this.deferred.has(key.qualified)) return false
    await this.client.query(`ALTER TABLE ${key.rel} ALTER CONSTRAINT ${quoteName(e.constraint)} DEFERRABLE INITIALLY DEFERRED`)
    this.deferred.add(key.qualified)
    this.checks.push(`SET CONSTRAINTS ${key.qualified} IMMEDIATE`,
      `ALTER TABLE ${key.rel} ALTER CONSTRAINT ${quoteName(e.constraint)} NOT DEFERRABLE`)
    this.notes.push(key.self
      ? `Checked ${key.rel}'s rows against its own foreign key "${e.constraint}" once all were written: a row needed one written after it.`
      : `Checked ${key.rel}'s rows against its foreign key "${e.constraint}" once all were written: rows of tables that reference each other needed each other.`)
    return true
  }

  /** Before commit: check what was deferred, and put the triggers back. Throws when a row is still orphaned. */
  async finish(): Promise<void> {
    for (const statement of [...this.checks, ...this.reenable]) await this.client.query(statement)
  }

  private async factsFor(name: string): Promise<TableFacts | null> {
    const { rows: [row] } = await this.client.query<TableFacts>(FACTS_SQL, [name])
    return row ?? null
  }
}
