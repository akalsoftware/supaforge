import { describe, it, expect } from 'vitest'
import { promote, planWork, outOfScopeReason } from '../src/promote.js'
import type { ScanResult } from '../src/types/drift.js'

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  const base: ScanResult = {
    timestamp: new Date().toISOString(),
    source: 'dev',
    target: 'prod',
    checks: [],
    score: 100,
    postureScore: null,
    summary: { total: 0, critical: 0, warning: 0, info: 0 },
  }
  // Object.assign rather than a spread: spreading Partial<ScanResult> widens
  // every property to `| undefined`, which no longer satisfies ScanResult.
  return Object.assign(base, overrides)
}

describe('promote', () => {
  it('returns empty result when no drift', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScanResult(),
      dryRun: true,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('collects SQL statements in dry-run mode', async () => {
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            {
              id: 'rls-missing-public.users.read_policy',
              check: 'rls',
              severity: 'critical',
              title: 'Missing RLS policy',
              description: 'Policy missing in target',
              sql: {
                up: 'CREATE POLICY "read_policy" ON "public"."users" AS PERMISSIVE FOR SELECT TO authenticated USING (true);',
                down: 'DROP POLICY IF EXISTS "read_policy" ON "public"."users";',
              },
            },
          ],
          durationMs: 50,
        },
      ],
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].check).toBe('rls')
    expect(result.applied[0].sql).toContain('CREATE POLICY')
    expect(result.errors).toHaveLength(0)
  })

  it('skips issues without SQL fix', async () => {
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'auth',
          status: 'drifted',
          issues: [
            {
              id: 'auth-jwt_exp',
              check: 'auth',
              severity: 'critical',
              title: 'Auth config mismatch: JWT_EXP',
              description: 'JWT_EXP differs',
              // No sql field
            },
          ],
          durationMs: 50,
        },
      ],
      summary: { total: 1, critical: 1, warning: 0, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain('No SQL fix')
  })

  it('filters by specific checks', async () => {
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'rls',
          status: 'drifted',
          issues: [
            {
              id: 'rls-missing-1',
              check: 'rls',
              severity: 'critical',
              title: 'Missing RLS',
              description: 'desc',
              sql: { up: 'CREATE POLICY ...;', down: 'DROP POLICY ...;' },
            },
          ],
          durationMs: 10,
        },
        {
          check: 'cron',
          status: 'drifted',
          issues: [
            {
              id: 'cron-missing-1',
              check: 'cron',
              severity: 'warning',
              title: 'Missing cron',
              description: 'desc',
              sql: { up: "SELECT cron.schedule('x','y',$$ z $$);", down: "SELECT cron.unschedule('x');" },
            },
          ],
          durationMs: 10,
        },
      ],
      summary: { total: 2, critical: 1, warning: 1, info: 0 },
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      checks: ['rls'],
      dryRun: true,
    })

    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].check).toBe('rls')
  })

  it('skips destructive statements unless allowDestructive is set', async () => {
    // @dbdiff/cli now returns these (SupaForge passes --allow-destructive so
    // drift is *reported*), so the safety gate has to live here at apply time.
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'schema',
          status: 'drifted',
          durationMs: 10,
          issues: [
            {
              id: 'schema-drop-1',
              check: 'schema',
              severity: 'critical',
              title: 'Extra table: stale',
              description: 'x',
              sql: { up: 'DROP TABLE "stale";', down: '' },
            },
            {
              id: 'schema-alter-1',
              check: 'schema',
              severity: 'warning',
              title: 'Table altered: users',
              description: 'x',
              sql: { up: 'ALTER TABLE "users" ADD COLUMN "bio" text;', down: '' },
            },
          ],
        },
      ],
    })

    const guarded = await promote({ dbUrl: 'postgres://unused', scanResult, dryRun: true })
    expect(guarded.applied).toHaveLength(1)
    expect(guarded.applied[0].issueId).toBe('schema-alter-1')
    expect(guarded.skipped).toHaveLength(1)
    expect(guarded.skipped[0].issueId).toBe('schema-drop-1')
    expect(guarded.skipped[0].reason).toContain('--allow-destructive')

    const opted = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
      allowDestructive: true,
    })
    expect(opted.applied).toHaveLength(2)
    expect(opted.skipped).toHaveLength(0)
  })

  it('skips clean checks', async () => {
    const scanResult = makeScanResult({
      checks: [
        {
          check: 'rls',
          status: 'clean',
          issues: [],
          durationMs: 10,
        },
      ],
    })

    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult,
      dryRun: true,
    })

    expect(result.applied).toHaveLength(0)
  })
})

/**
 * The fix set @dbdiff/cli produced for issue #48's two databases, scoped to
 * `--tables=users`. dbdiff's `--tables` filters tables only, so the view and
 * trigger belonging to the excluded `orders` survive into the fix set while the
 * column they need does not.
 */
function makeScopedScanResult(): ScanResult {
  return makeScanResult({
    checks: [
      {
        check: 'schema',
        status: 'drifted',
        durationMs: 10,
        issues: [
          {
            id: 'schema-alter-1',
            check: 'schema',
            severity: 'warning',
            title: 'Table altered: users',
            description: 'x',
            sql: { up: 'ALTER TABLE "users" ADD COLUMN "created_at" timestamptz(6);', down: '' },
          },
          {
            id: 'schema-create-view-2',
            check: 'schema',
            severity: 'warning',
            title: 'View missing: active_orders',
            description: 'x',
            sql: { up: `CREATE VIEW "active_orders" AS SELECT id FROM orders WHERE (status = 'pending');`, down: '' },
          },
          {
            id: 'schema-create-trigger-3',
            check: 'schema',
            severity: 'warning',
            title: 'Trigger missing: trg_orders_touch',
            description: 'x',
            sql: {
              up: 'CREATE TRIGGER trg_orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION touch_updated();',
              down: '',
            },
          },
          {
            id: 'schema-create-function-4',
            check: 'schema',
            severity: 'warning',
            title: 'Function missing: public.touch_updated()',
            description: 'x',
            sql: {
              up: 'CREATE OR REPLACE FUNCTION public.touch_updated() RETURNS trigger AS $fn$ BEGIN RETURN NEW; END; $fn$;',
              down: '',
            },
          },
        ],
      },
    ],
    summary: { total: 4, critical: 0, warning: 4, info: 0 },
  })
}

describe('outOfScopeReason', () => {
  it('returns null when nothing is scoped', () => {
    expect(outOfScopeReason('CREATE VIEW v AS SELECT 1 FROM orders;', undefined)).toBeNull()
    expect(outOfScopeReason('CREATE VIEW v AS SELECT 1 FROM orders;', {})).toBeNull()
  })

  it('names the excluded table and the flag that excluded it', () => {
    const reason = outOfScopeReason('CREATE VIEW v AS SELECT 1 FROM orders;', { tables: ['users'] })
    expect(reason).toBe("Depends on table 'orders', excluded by --tables")
  })

  it('credits --exclude-tables when that is what narrowed the run', () => {
    const reason = outOfScopeReason('CREATE INDEX i ON public.orders (status);', { excludeTables: ['orders'] })
    expect(reason).toBe("Depends on table 'orders', excluded by --exclude-tables")
  })

  it('lets through a fix that only touches tables still in scope', () => {
    expect(outOfScopeReason('ALTER TABLE "users" ADD COLUMN "bio" text;', { tables: ['users'] })).toBeNull()
  })

  it('lets through a fix that touches no table at all', () => {
    const sql = 'CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $fn$ BEGIN RETURN NEW; END; $fn$;'
    expect(outOfScopeReason(sql, { tables: ['users'] })).toBeNull()
  })

  it('honours the globs the filter itself supports', () => {
    expect(outOfScopeReason('CREATE INDEX i ON billing_events (id);', { tables: ['billing_*'] })).toBeNull()
  })
})

describe('planWork ordering', () => {
  it('returns SQL in dependency order, not the order the check reported it', () => {
    const plan = planWork(makeScopedScanResult())
    const ids = plan.sqlStatements.map(s => s.issueId)
    expect(ids.indexOf('schema-create-function-4')).toBeLessThan(ids.indexOf('schema-create-trigger-3'))
  })
})

describe('planWork policy de-duplication', () => {
  // The schema check's SQL comes from @dbdiff/cli, which models RLS policies as
  // of 3.0.0-rc.10, and the rls check writes its own. Both in one fix set meant
  // the second failed with "already exists" — and since the apply is
  // transactional, that one collision discarded every other fix with it.
  function withDuplicatePolicy(): ScanResult {
    return makeScanResult({
      checks: [
        {
          check: 'schema', status: 'drifted', issues: [{
            id: 'schema-create-table-1', severity: 'warning', title: 'Table missing: t',
            sql: {
              up: 'CREATE TABLE "t" ("id" integer);\n'
                + 'ALTER TABLE "t" ENABLE ROW LEVEL SECURITY;\n'
                + 'CREATE POLICY "t_read" ON "t" FOR SELECT USING (true);',
            },
          }],
        },
        {
          check: 'rls', status: 'drifted', issues: [{
            id: 'rls-missing-public.t.t_read', severity: 'critical', title: 'Missing RLS policy: t_read',
            sql: { up: 'CREATE POLICY "t_read"\n  ON "public"."t"\n  FOR SELECT\n  USING (true);' },
          }],
        },
      ],
    } as Partial<ScanResult>)
  }

  it('drops the rls fix when the schema fix already creates that policy', () => {
    const plan = planWork(withDuplicatePolicy())
    const ids = plan.sqlStatements.map(s => s.issueId)

    expect(ids).toContain('schema-create-table-1')
    expect(ids).not.toContain('rls-missing-public.t.t_read')
  })

  it('reports the dropped fix rather than discarding it silently', () => {
    const plan = planWork(withDuplicatePolicy())
    const skipped = plan.skipped.find(s => s.issueId === 'rls-missing-public.t.t_read')

    expect(skipped?.reason).toMatch(/already created/i)
  })

  it('keeps the schema statement, which also creates the table and enables RLS', () => {
    const plan = planWork(withDuplicatePolicy())
    const schemaSql = plan.sqlStatements.find(s => s.issueId === 'schema-create-table-1')?.sql ?? ''

    expect(schemaSql).toContain('CREATE TABLE')
    expect(schemaSql).toContain('ENABLE ROW LEVEL SECURITY')
  })

  it('keeps a policy fix that nothing else covers', () => {
    const plan = planWork(makeScanResult({
      checks: [{
        check: 'rls', status: 'drifted', issues: [{
          id: 'rls-missing-public.other.other_read', severity: 'critical', title: 'Missing RLS policy',
          sql: { up: 'CREATE POLICY "other_read" ON "public"."other" FOR SELECT USING (true);' },
        }],
      }],
    } as Partial<ScanResult>))

    expect(plan.sqlStatements.map(s => s.issueId)).toContain('rls-missing-public.other.other_read')
  })

  it('tells policies on different tables apart', () => {
    const plan = planWork(makeScanResult({
      checks: [
        {
          check: 'schema', status: 'drifted', issues: [{
            id: 'schema-1', severity: 'warning', title: 'a',
            sql: { up: 'CREATE POLICY "p" ON "a" FOR SELECT USING (true);' },
          }],
        },
        {
          check: 'rls', status: 'drifted', issues: [{
            id: 'rls-b', severity: 'critical', title: 'b',
            sql: { up: 'CREATE POLICY "p" ON "public"."b" FOR SELECT USING (true);' },
          }],
        },
      ],
    } as Partial<ScanResult>))

    // Same policy name, different table: not a duplicate.
    expect(plan.sqlStatements.map(s => s.issueId)).toContain('rls-b')
  })
})

describe('planWork posture fixes', () => {
  // A posture check judges the target alone and fires identically whichever pair
  // you diff, so applying its fix moves the target away from the source and
  // creates drift. Observed as an endless loop: sync enables RLS for coverage,
  // the next diff calls it "RLS enabled unexpectedly", the next sync disables it,
  // coverage flags it again.
  function withPostureAndDrift(): ScanResult {
    return makeScanResult({
      checks: [
        {
          check: 'schema', status: 'drifted', issues: [{
            id: 'schema-create-table-1', severity: 'warning', title: 'Table missing: t',
            sql: { up: 'CREATE TABLE "t" ("id" integer);' },
          }],
        },
        {
          check: 'rls-coverage', status: 'drifted', issues: [{
            id: 'rls-coverage-public.customers', severity: 'critical', title: 'RLS not enabled',
            sql: { up: 'ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;' },
          }],
        },
      ],
    } as Partial<ScanResult>)
  }

  it('applies the drift fix and leaves the posture fix alone', () => {
    const plan = planWork(withPostureAndDrift())
    const ids = plan.sqlStatements.map(s => s.issueId)

    expect(ids).toContain('schema-create-table-1')
    expect(ids).not.toContain('rls-coverage-public.customers')
  })

  it('says why the posture fix was not applied', () => {
    const plan = planWork(withPostureAndDrift())
    const skipped = plan.skipped.find(s => s.issueId === 'rls-coverage-public.customers')

    expect(skipped?.reason).toMatch(/posture/i)
    expect(skipped?.reason).toMatch(/--apply-posture/)
  })

  it('applies posture fixes when asked for explicitly', () => {
    const plan = planWork(withPostureAndDrift(), { applyPosture: true })

    expect(plan.sqlStatements.map(s => s.issueId)).toContain('rls-coverage-public.customers')
  })

  it('treats naming the check as asking for it', () => {
    const plan = planWork(withPostureAndDrift(), { checks: ['rls-coverage'] })

    expect(plan.sqlStatements.map(s => s.issueId)).toContain('rls-coverage-public.customers')
  })

  it('still applies comparison fixes that happen to touch RLS', () => {
    // The schema check is a comparison check, so its ENABLE ROW LEVEL SECURITY
    // reconciles the target with the source and must not be caught by this.
    const plan = planWork(makeScanResult({
      checks: [{
        check: 'schema', status: 'drifted', issues: [{
          id: 'schema-alter-1', severity: 'warning', title: 'Table altered: t',
          sql: { up: 'ALTER TABLE "t" ENABLE ROW LEVEL SECURITY;' },
        }],
      }],
    } as Partial<ScanResult>))

    expect(plan.sqlStatements.map(s => s.issueId)).toContain('schema-alter-1')
  })

  /**
   * Every test above calls planWork directly — and that is exactly how
   * `--apply-posture` shipped broken.
   *
   * `promote()` accepted `applyPosture` in its options type and never passed it
   * on, so the flag was a no-op through the CLI's own apply path while the unit
   * tests stayed green. These go through promote() for that reason: the option
   * has to be honoured by the function the command actually calls.
   */
  it('promote() honours applyPosture, not just planWork', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: withPostureAndDrift(),
      dryRun: true,
      applyPosture: true,
    })

    expect(result.applied.map(a => a.issueId)).toContain('rls-coverage-public.customers')
  })

  it('promote() defaults to leaving posture fixes alone', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: withPostureAndDrift(),
      dryRun: true,
    })

    expect(result.applied.map(a => a.issueId)).not.toContain('rls-coverage-public.customers')
    expect(result.skipped.find(s => s.issueId === 'rls-coverage-public.customers')?.reason)
      .toMatch(/--apply-posture/)
  })
})

describe('promote scoping', () => {
  it('skips a dependant of an excluded table instead of attempting and failing', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      tableFilter: { tables: ['users'] },
    })

    expect(result.applied.map(a => a.issueId).sort()).toEqual(['schema-alter-1', 'schema-create-function-4'])
    expect(result.errors).toHaveLength(0)

    const skipped = Object.fromEntries(result.skipped.map(s => [s.issueId, s.reason]))
    expect(skipped['schema-create-view-2']).toContain("'orders'")
    expect(skipped['schema-create-trigger-3']).toContain("'orders'")
  })

  it('applies every fix when no table filter is active', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
    })
    expect(result.applied).toHaveLength(4)
    expect(result.skipped).toHaveLength(0)
  })
})

describe('promote --only', () => {
  it('applies exactly the listed issue ids', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      only: ['schema-alter-1'],
    })

    expect(result.applied.map(a => a.issueId)).toEqual(['schema-alter-1'])
    expect(result.skipped).toHaveLength(3)
    expect(result.skipped[0].reason).toBe('Not selected by --only')
  })

  it('supports globs so a family of fixes can be picked in one go', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      only: ['schema-create-*'],
    })

    expect(result.applied.map(a => a.issueId).sort()).toEqual([
      'schema-create-function-4',
      'schema-create-trigger-3',
      'schema-create-view-2',
    ])
  })

  it('treats an empty list as no selection at all', async () => {
    const result = await promote({
      dbUrl: 'postgres://unused',
      scanResult: makeScopedScanResult(),
      dryRun: true,
      only: [],
    })
    expect(result.applied).toHaveLength(4)
  })
})

/**
 * The same collision as policies, one layer along (issue #77).
 *
 * The schema check's SQL creates webhook triggers, and the webhooks check now
 * emits the server's own `pg_get_triggerdef()` for the same trigger. Applied
 * together the second failed with `trigger ... already exists`, and because the
 * apply is transactional that one collision discarded every other fix: the
 * reported symptom was a full `diff --apply` rolling back six correct schema
 * fixes.
 */
describe('planWork trigger de-duplication', () => {
  function withSchemaAndWebhookTrigger(): ScanResult {
    return makeScanResult({
      checks: [
        {
          check: 'schema', status: 'drifted', issues: [{
            id: 'schema-create-trigger-1', severity: 'warning',
            title: 'Trigger missing: public.orders_webhook',
            sql: {
              up: 'CREATE TRIGGER "orders_webhook" AFTER INSERT ON "public"."orders" '
                + "FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://e.invalid/o');",
            },
          }],
        },
        {
          check: 'webhooks', status: 'drifted', issues: [{
            id: 'webhooks-missing-public.orders.orders_webhook', severity: 'warning',
            title: 'Missing webhook: orders_webhook on public.orders',
            sql: {
              up: 'CREATE TRIGGER orders_webhook AFTER INSERT ON public.orders '
                + "FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('https://e.invalid/o');",
            },
          }],
        },
      ],
    } as Partial<ScanResult>)
  }

  it('keeps one statement for the trigger, not two', () => {
    const plan = planWork(withSchemaAndWebhookTrigger())
    const ids = plan.sqlStatements.map(s => s.issueId)

    expect(ids).toContain('schema-create-trigger-1')
    expect(ids).not.toContain('webhooks-missing-public.orders.orders_webhook')
  })

  it('says which fix already did it', () => {
    const plan = planWork(withSchemaAndWebhookTrigger())
    const skipped = plan.skipped.find(s => s.check === 'webhooks')

    expect(skipped?.reason).toMatch(/already created/i)
    expect(skipped?.reason).toMatch(/trigger/i)
  })

  it('keeps both when they are different triggers on different tables', () => {
    // Two webhooks may share a trigger name, which is why the table is part of
    // the key. Dropping the second as a duplicate would lose a webhook.
    const plan = planWork(makeScanResult({
      checks: [{
        check: 'webhooks', status: 'drifted', issues: [
          {
            id: 'webhooks-missing-public.a_items.notify_webhook', severity: 'warning',
            title: 'a', sql: { up: 'CREATE TRIGGER notify_webhook AFTER INSERT ON public.a_items FOR EACH ROW EXECUTE FUNCTION f();' },
          },
          {
            id: 'webhooks-missing-public.b_items.notify_webhook', severity: 'warning',
            title: 'b', sql: { up: 'CREATE TRIGGER notify_webhook AFTER INSERT ON public.b_items FOR EACH ROW EXECUTE FUNCTION f();' },
          },
        ],
      }],
    } as Partial<ScanResult>))

    expect(plan.sqlStatements).toHaveLength(2)
  })

  it('never drops a statement that also creates the function the trigger calls', () => {
    const plan = planWork(makeScanResult({
      checks: [
        {
          check: 'webhooks', status: 'drifted', issues: [{
            id: 'webhooks-missing-public.orders.t', severity: 'warning', title: 'w',
            sql: { up: 'CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION touch();' },
          }],
        },
        {
          check: 'schema', status: 'drifted', issues: [{
            id: 'schema-create-function-2', severity: 'warning', title: 's',
            sql: {
              up: 'CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;\n'
                + 'CREATE TRIGGER t AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION touch();',
            },
          }],
        },
      ],
    } as Partial<ScanResult>))

    // Whichever runs second, the bundled one survives: losing it would lose the
    // function.
    expect(plan.sqlStatements.map(s => s.issueId)).toContain('schema-create-function-2')
  })

  it('still de-duplicates policies, which share the mechanism', () => {
    // Guard for issue #67 after generalising that fix to two kinds of object.
    const plan = planWork(makeScanResult({
      checks: [
        {
          check: 'schema', status: 'drifted', issues: [{
            id: 'schema-create-policy-1', severity: 'warning', title: 's',
            sql: { up: 'CREATE POLICY "read_own" ON "invoices" FOR SELECT USING (true);' },
          }],
        },
        {
          check: 'rls', status: 'drifted', issues: [{
            id: 'rls-missing-public.invoices.read_own', severity: 'critical', title: 'r',
            sql: { up: 'CREATE POLICY "read_own" ON "public"."invoices" FOR SELECT USING (true);' },
          }],
        },
      ],
    } as Partial<ScanResult>))

    expect(plan.sqlStatements.map(s => s.issueId)).toContain('schema-create-policy-1')
    expect(plan.skipped.find(s => s.check === 'rls')?.reason).toMatch(/policy/i)
  })
})

describe('planWork and manual-only findings with SQL', () => {
  it('skips them with their reason rather than running the SQL', () => {
    const plan = planWork(makeScanResult({
      checks: [{
        check: 'schema', status: 'drifted', durationMs: 0, issues: [
          { id: 'schema-alter-type-1', check: 'schema', severity: 'warning', description: 'd', title: 'Type altered: public.st',
            sql: { up: 'DROP TYPE IF EXISTS "st";', down: '' }, manualOnly: 'do it by hand' },
          { id: 'schema-create-view-2', check: 'schema', severity: 'warning', description: 'd', title: 'View missing: public.v',
            sql: { up: 'CREATE VIEW "v" AS SELECT 1;', down: '' } },
        ],
      }],
    }))
    expect(plan.sqlStatements.map(s => s.issueId)).toEqual(['schema-create-view-2'])
    expect(plan.skipped).toEqual([{ check: 'schema', issueId: 'schema-alter-type-1', reason: 'do it by hand' }])
  })
})

describe('planWork and drops something held back still uses', () => {
  function withLegacyTable(): ScanResult {
    return makeScanResult({
      checks: [{
        check: 'schema', status: 'drifted', durationMs: 0, issues: [
          {
            id: 'schema-drop-1', check: 'schema', severity: 'critical', description: 'Schema difference detected by @dbdiff/cli.', title: 'Extra table: public.legacy',
            sql: { up: 'DROP TABLE IF EXISTS "legacy";', down: 'CREATE TABLE "legacy" ("id" integer, "k" "legacy_kind");' },
          },
          {
            id: 'schema-drop-type-2', check: 'schema', severity: 'critical', description: 'Schema difference detected by @dbdiff/cli.', title: 'Extra type: public.legacy_kind',
            sql: { up: 'DROP TYPE IF EXISTS "legacy_kind";', down: `CREATE TYPE "legacy_kind" AS ENUM ('x');` },
          },
          {
            id: 'schema-drop-type-3', check: 'schema', severity: 'critical', description: 'Schema difference detected by @dbdiff/cli.', title: 'Extra type: public.unused',
            sql: { up: 'DROP TYPE IF EXISTS "unused";', down: `CREATE TYPE "unused" AS ENUM ('x');` },
          },
        ],
      }],
    })
  }

  it('holds back the type a held-back table still uses, and only that', () => {
    const plan = planWork(withLegacyTable())
    expect(plan.sqlStatements.map(s => s.issueId)).toEqual(['schema-drop-type-3'])
    expect(plan.skipped.find(s => s.issueId === 'schema-drop-type-2')?.reason).toMatch(/Still used by what schema-drop-1 keeps/)
  })

  it('holds back what a held-back drop keeps in turn', () => {
    // The column keeps its composite type, and the composite keeps its enum.
    const plan = planWork(makeScanResult({
      checks: [{
        check: 'schema', status: 'drifted', durationMs: 0, issues: [
          { id: 'schema-alter-1', check: 'schema', severity: 'warning', description: 'd', title: 'Table altered: public.t',
            sql: { up: 'ALTER TABLE "t" DROP COLUMN "v";', down: 'ALTER TABLE "t" ADD COLUMN "v" "c";' } },
          { id: 'schema-drop-type-2', check: 'schema', severity: 'critical', description: 'd', title: 'Extra type: public.c',
            sql: { up: 'DROP TYPE IF EXISTS "c";', down: 'CREATE TYPE "c" AS ("x" "e", "y" integer);' } },
          { id: 'schema-drop-type-3', check: 'schema', severity: 'critical', description: 'd', title: 'Extra type: public.e',
            sql: { up: 'DROP TYPE IF EXISTS "e";', down: `CREATE TYPE "e" AS ENUM ('a');` } },
        ],
      }],
    }))
    expect(plan.sqlStatements).toEqual([])
    expect(plan.skipped.map(s => s.issueId).sort()).toEqual(['schema-alter-1', 'schema-drop-type-2', 'schema-drop-type-3'])
  })

  it('holds back a sequence a held-back table\'s default still draws on', () => {
    // A default names its sequence only in a string literal, as pg_dump writes it.
    const plan = planWork(makeScanResult({
      checks: [{
        check: 'schema', status: 'drifted', durationMs: 0, issues: [
          { id: 'schema-drop-1', check: 'schema', severity: 'critical', description: 'd', title: 'Extra table: public.b',
            sql: { up: 'DROP TABLE "b";', down: "CREATE TABLE public.b (\n    id integer DEFAULT nextval('public.shared_seq'::regclass) NOT NULL\n);" } },
          { id: 'schema-alter-2', check: 'schema', severity: 'warning', description: 'd', title: 'Table altered: public.a',
            sql: { up: 'ALTER TABLE "a" ALTER COLUMN "id" DROP DEFAULT;\nALTER SEQUENCE "shared_seq" OWNED BY NONE;', down: `ALTER TABLE "a" ALTER COLUMN "id" SET DEFAULT nextval('shared_seq'::regclass);` } },
          { id: 'schema-drop-sequence-3', check: 'schema', severity: 'critical', description: 'd', title: 'Extra sequence: public.shared_seq',
            sql: { up: 'DROP SEQUENCE IF EXISTS "shared_seq";', down: 'CREATE SEQUENCE "shared_seq" START WITH 1000;' } },
        ],
      }],
    }))
    expect(plan.sqlStatements.map(s => s.issueId)).toEqual(['schema-alter-2'])
    expect(plan.skipped.find(s => s.issueId === 'schema-drop-sequence-3')?.reason).toMatch(/Still used by what schema-drop-1 keeps/)
  })

  it('drops both once destructive fixes are allowed', () => {
    const plan = planWork(withLegacyTable(), { allowDestructive: true })
    expect(plan.sqlStatements.map(s => s.issueId).sort()).toEqual(['schema-drop-1', 'schema-drop-type-2', 'schema-drop-type-3'])
  })
})

describe('planWork and deletes made through an API', () => {
  // A DELETE request removes a bucket or an Edge Function as surely as
  // DROP TABLE removes a table, but only SQL went through the destructive gate:
  // with an apiUrl, `diff --apply` deleted the target's extra bucket, and an
  // extra Edge Function, without --allow-destructive.
  const withDeletes = () => makeScanResult({
    checks: [
      { check: 'storage', status: 'drifted', durationMs: 0, issues: [
        { id: 'storage-extra-avatars', check: 'storage', severity: 'info', title: 'Extra bucket: avatars', description: 'd',
          action: { method: 'DELETE', url: 'https://api.example.com/storage/v1/bucket/avatars', headers: {}, label: 'Delete bucket "avatars"' } },
        { id: 'storage-missing-docs', check: 'storage', severity: 'warning', title: 'Missing bucket: docs', description: 'd',
          action: { method: 'POST', url: 'https://api.example.com/storage/v1/bucket', headers: {}, label: 'Create bucket "docs"', body: { id: 'docs' } } },
      ] },
      { check: 'edge-functions', status: 'drifted', durationMs: 0, issues: [
        { id: 'edge-extra-hello', check: 'edge-functions', severity: 'info', title: 'Extra Edge Function: hello', description: 'd',
          action: { method: 'DELETE', url: 'https://api.supabase.com/v1/projects/ref/functions/hello', headers: {}, label: 'Delete Edge Function "hello"' } },
      ] },
    ],
  })

  it('holds them back without --allow-destructive, and says why', () => {
    const plan = planWork(withDeletes())
    expect(plan.apiActions.map(a => a.issueId)).toEqual(['storage-missing-docs'])
    expect(plan.skipped.map(s => s.issueId).sort()).toEqual(['edge-extra-hello', 'storage-extra-avatars'])
    for (const s of plan.skipped) expect(s.reason).toMatch(/--allow-destructive/)
  })

  it('runs them with --allow-destructive', () => {
    const plan = planWork(withDeletes(), { allowDestructive: true })
    expect(plan.apiActions.map(a => a.issueId).sort()).toEqual(['edge-extra-hello', 'storage-extra-avatars', 'storage-missing-docs'])
  })
})

describe('planWork --only and a new table\'s default grants', () => {
  // Selecting a table's creation without its "default grants to take back"
  // left the table with the target's default privileges: a table the source
  // closed to anon arrived open to it.
  const withNewTable = () => makeScanResult({
    checks: [
      { check: 'schema', status: 'drifted', durationMs: 0, issues: [
        { id: 'schema-create-table-1', check: 'schema', severity: 'warning', title: 'Table missing: public.t_a', description: 'd',
          sql: { up: 'CREATE TABLE public.t_a (id int PRIMARY KEY, secret text);', down: '' } },
        { id: 'schema-create-table-2', check: 'schema', severity: 'warning', title: 'Table missing: public.t_b', description: 'd',
          sql: { up: 'CREATE TABLE "public"."t_b" (id int);', down: '' } },
        { id: 'schema-create-view-3', check: 'schema', severity: 'warning', title: 'View missing: public.v_a', description: 'd',
          sql: { up: 'CREATE VIEW public.v_a AS SELECT id FROM public.t_a;', down: '' } },
      ] },
      { check: 'roles', status: 'drifted', durationMs: 0, issues: [
        { id: 'roles-grant-default-anon.public.t_a', check: 'roles', severity: 'critical', title: 'Default grants to take back', description: 'd',
          sql: { up: 'REVOKE ALL ON public.t_a FROM anon;', down: '' } },
        { id: 'roles-grant-default-authenticated.public.t_a', check: 'roles', severity: 'critical', title: 'Default grants to take back', description: 'd',
          sql: { up: 'REVOKE ALL ON public.t_a FROM authenticated;', down: '' } },
        { id: 'roles-grant-default-anon.public.t_b', check: 'roles', severity: 'critical', title: 'Default grants to take back', description: 'd',
          sql: { up: 'REVOKE ALL ON public.t_b FROM anon;', down: '' } },
        { id: 'roles-grant-default-anon.public.v_a', check: 'roles', severity: 'critical', title: 'Default grants to take back', description: 'd',
          sql: { up: 'REVOKE ALL ON public.v_a FROM anon;', down: '' } },
      ] },
    ],
  })

  it('brings the selected table\'s default grants along, and no other table\'s', () => {
    const ids = planWork(withNewTable(), { only: ['schema-create-table-1'] }).sqlStatements.map(s => s.issueId)
    expect(ids).toEqual(expect.arrayContaining([
      'schema-create-table-1', 'roles-grant-default-anon.public.t_a', 'roles-grant-default-authenticated.public.t_a',
    ]))
    expect(ids).not.toContain('roles-grant-default-anon.public.t_b')
    expect(ids).not.toContain('schema-create-table-2')
  })

  it('does the same for quoted names and for views', () => {
    const ids = planWork(withNewTable(), { only: ['schema-create-table-2', 'schema-create-view-3'] }).sqlStatements.map(s => s.issueId)
    expect(ids).toEqual(expect.arrayContaining(['roles-grant-default-anon.public.t_b', 'roles-grant-default-anon.public.v_a']))
  })
})

describe('planWork and a fix whose finding says it is destructive', () => {
  // A webhook is a trigger, and dropping a trigger is usually routine; dropping
  // a webhook stops the target calling out. With the source unreadable, every
  // target webhook looked extra and --apply dropped them all without asking.
  const extraWebhook = () => makeScanResult({
    checks: [{ check: 'webhooks', status: 'drifted', durationMs: 0, issues: [
      { id: 'webhooks-extra-public.orders.orders_webhook', check: 'webhooks', severity: 'info', title: 'Extra webhook', description: 'd',
        destructive: 'removes a webhook', sql: { up: 'DROP TRIGGER IF EXISTS "orders_webhook" ON "public"."orders";', down: '' } },
    ] }],
  })

  it('holds it back without --allow-destructive, with the finding\'s reason', () => {
    const plan = planWork(extraWebhook())
    expect(plan.sqlStatements).toEqual([])
    expect(plan.skipped[0].reason).toMatch(/Destructive — removes a webhook; re-run with --allow-destructive/)
  })

  it('runs it with --allow-destructive', () => {
    expect(planWork(extraWebhook(), { allowDestructive: true }).sqlStatements).toHaveLength(1)
  })
})

describe('planWork --only and a new function\'s default grants', () => {
  // A function is executable by PUBLIC, and on Supabase by the API roles, the
  // moment it is created. Selecting its creation alone left a SECURITY DEFINER
  // function the source keeps closed open to the anon key.
  const withNewFunction = () => makeScanResult({
    checks: [
      { check: 'schema', status: 'drifted', durationMs: 0, issues: [
        { id: 'schema-create-function-1', check: 'schema', severity: 'warning', title: 'Function missing: public.admin_reset', description: 'd',
          sql: { up: 'CREATE OR REPLACE FUNCTION public.admin_reset(p integer)\n RETURNS integer\n LANGUAGE sql\n SECURITY DEFINER\nAS $function$SELECT p$function$;', down: '' } },
      ] },
      { check: 'roles', status: 'drifted', durationMs: 0, issues: [
        { id: 'roles-grant-default-PUBLIC.public.admin_reset(p integer)', check: 'roles', severity: 'critical', title: 'Default grants to take back', description: 'd',
          sql: { up: 'REVOKE EXECUTE ON FUNCTION "public"."admin_reset"(p integer) FROM PUBLIC;', down: '' } },
        { id: 'roles-grant-default-anon.public.admin_reset(p integer)', check: 'roles', severity: 'critical', title: 'Default grants to take back', description: 'd',
          sql: { up: 'REVOKE EXECUTE ON FUNCTION "public"."admin_reset"(p integer) FROM "anon";', down: '' } },
        { id: 'roles-grant-default-anon.public.other_fn()', check: 'roles', severity: 'critical', title: 'Default grants to take back', description: 'd',
          sql: { up: 'REVOKE EXECUTE ON FUNCTION "public"."other_fn"() FROM "anon";', down: '' } },
      ] },
    ],
  })

  it('brings the selected function\'s revokes along, and no other function\'s', () => {
    const ids = planWork(withNewFunction(), { only: ['schema-create-function-1'] }).sqlStatements.map(s => s.issueId)
    expect(ids).toEqual(expect.arrayContaining([
      'schema-create-function-1',
      'roles-grant-default-PUBLIC.public.admin_reset(p integer)',
      'roles-grant-default-anon.public.admin_reset(p integer)',
    ]))
    expect(ids).not.toContain('roles-grant-default-anon.public.other_fn()')
  })
})
