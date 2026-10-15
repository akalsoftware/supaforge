import { describe, expect, it } from 'vitest'
import { hazardsOf } from '../src/hazards.js'

const kinds = (sql: string) => hazardsOf(sql).map(h => `${h.kind}${h.on ? ' ' + h.on : ''}`)

describe('hazardsOf', () => {
  it('a column type change locks the table and may rewrite it', () => {
    expect(kinds('ALTER TABLE "public"."orders" ALTER COLUMN "total" TYPE numeric(12,2);'))
      .toEqual(['blocks-reads-and-writes public.orders', 'rewrite public.orders'])
  })

  it('a new CHECK scans the table, unless NOT VALID', () => {
    expect(kinds('ALTER TABLE orders ADD CONSTRAINT pos CHECK (total > 0);')).toEqual(['blocks-reads-and-writes orders', 'full-scan orders'])
    expect(kinds('ALTER TABLE orders ADD CONSTRAINT pos CHECK (total > 0) NOT VALID;')).toEqual(['blocks-reads-and-writes orders'])
  })

  it('a foreign key blocks writes only, and scans', () => {
    expect(kinds('ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (c) REFERENCES customers (id);'))
      .toEqual(['blocks-writes orders', 'full-scan orders'])
  })

  it('a column with a volatile default rewrites; a constant default does not', () => {
    expect(kinds('ALTER TABLE t ADD COLUMN id uuid DEFAULT gen_random_uuid();')).toEqual(['blocks-reads-and-writes t', 'rewrite t'])
    expect(kinds("ALTER TABLE t ADD COLUMN state text DEFAULT 'new';")).toEqual(['blocks-reads-and-writes t'])
  })

  it('statistics and storage options take no lock reads or writes wait on', () => {
    expect(kinds('ALTER TABLE t ALTER COLUMN v SET STATISTICS 500;')).toEqual([])
  })

  it('an index blocks writes; built concurrently, it cannot run in a transaction', () => {
    expect(kinds('CREATE INDEX i ON orders (total);')).toEqual(['blocks-writes orders'])
    expect(kinds('CREATE INDEX CONCURRENTLY i ON orders (total);')).toEqual(['not-transactional orders'])
  })

  it('a table the same fix creates is nobody\'s to wait on', () => {
    expect(kinds('CREATE TABLE fresh (id int);\nALTER TABLE fresh ADD CONSTRAINT c CHECK (id > 0);\nCREATE INDEX f ON fresh (id);')).toEqual([])
  })

  it('names data loss', () => {
    expect(hazardsOf('DROP TABLE "old";')[0]).toMatchObject({ kind: 'data-loss', detail: 'drops a table and its rows' })
  })

  it('policies, triggers and renames', () => {
    expect(kinds('CREATE POLICY p ON orders USING (true);')).toEqual(['blocks-reads-and-writes orders'])
    expect(kinds('CREATE TRIGGER t BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f();')).toEqual(['blocks-writes orders'])
    expect(kinds('ALTER TABLE "people" RENAME COLUMN "name" TO "full_name";')).toEqual(['blocks-reads-and-writes people'])
  })
})
