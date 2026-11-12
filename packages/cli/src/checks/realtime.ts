import { dropEquivalentPolicyChanges, defaultCanonicalizer } from '../utils/policy-equivalence.js'
import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { quoteName } from '../utils/sql'
import { Check, readOrAbsent, type CheckContext } from './base'
import { DEFAULT_IGNORE_SCHEMAS } from '../defaults'
import {
  diffSchemaPolicies, schemaPolicySql, type SchemaPolicy,
} from '../utils/schema-policies'

interface RealtimePublication {
  pubname: string
  schemaname: string
  tablename: string
}

export class RealtimeCheck extends Check {
  readonly name = 'realtime' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchPublications(ctx.source.dbUrl),
      this.fetchPublications(ctx.target.dbUrl),
    ])
    const publicationIssues = diffPublications(source, target)

    // Realtime Authorization policies live on realtime.messages and decide who
    // may join which channel. They are written by the user, but the realtime
    // schema is excluded from the main RLS layer because its other tables are
    // product-managed — so nothing compared them at all. A policy relaxed from
    // `topic LIKE 'user:%'` to `true` reported no drift.
    const [srcPolicies, tgtPolicies] = await Promise.all([
      this.fetchPolicies(ctx.source.dbUrl),
      this.fetchPolicies(ctx.target.dbUrl),
    ])
    const policyIssues = await dropEquivalentPolicyChanges(
      diffSchemaPolicies(srcPolicies, tgtPolicies, {
        schema: 'realtime',
        check: 'realtime',
        idPrefix: 'realtime-policy',
        label: 'realtime authorization',
      }),
      ctx,
      defaultCanonicalizer(this.queryFn),
      'realtime',
    )

    return [...publicationIssues, ...policyIssues]
  }

  private async fetchPolicies(dbUrl: string): Promise<SchemaPolicy[]> {
    // No realtime schema at all — nothing to compare.
    return readOrAbsent(async () => await this.queryFn(dbUrl, schemaPolicySql('realtime')) as unknown as SchemaPolicy[], [])
  }

  private async fetchPublications(dbUrl: string): Promise<RealtimePublication[]> {
    return readOrAbsent(async () => await this.queryFn(dbUrl, PUBLICATION_SQL) as unknown as RealtimePublication[], [])
  }
}

/**
 * Every publication and the tables in it.
 *
 * `supabase_realtime` used to be excluded here, with a second query defined
 * for it that nothing ever called (issue #90). That is the publication
 * Supabase Realtime actually uses: enabling Realtime on a table means adding
 * it to this publication, so excluding it hid the only Realtime drift most
 * projects will ever have. Publishing a table in dev and not in production
 * reported clean.
 *
 * Its *presence* is not drift — every Supabase project has it — and nothing
 * reports it as such, because both sides have it. Its table list is the whole
 * point.
 */
/**
 * The publication Supabase Realtime keeps for itself. Its members are
 * `realtime.messages_YYYY_MM_DD`, daily partitions the Realtime service
 * creates and drops on its own schedule, so two projects always differ on it
 * and no fix can apply; a snapshot recording that day's partitions could not
 * be restored anywhere else, and rolled the whole restore back.
 */
export const PLATFORM_PUBLICATIONS = ['supabase_realtime_messages_publication']

/**
 * Every publication and the tables in it — but not the platform's own
 * publications, nor member tables in a schema the platform owns. One query for
 * both the check and the snapshot, so the two agree on what Realtime state is.
 */
export const PUBLICATION_SQL = `
  SELECT p.pubname, pt.schemaname, pt.tablename
  FROM pg_publication p
  LEFT JOIN pg_publication_tables pt
         ON p.pubname = pt.pubname
        AND pt.schemaname <> ALL (${sqlTextArray(DEFAULT_IGNORE_SCHEMAS)})
  WHERE p.pubname <> ALL (${sqlTextArray(PLATFORM_PUBLICATIONS)})
  ORDER BY p.pubname, pt.schemaname, pt.tablename
`

function sqlTextArray(values: string[]): string {
  return `ARRAY[${values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')}]::text[]`
}

function pubTableKey(pub: RealtimePublication): string {
  return `${pub.pubname}.${pub.schemaname}.${pub.tablename}`
}

export function diffPublications(source: RealtimePublication[], target: RealtimePublication[]): DriftIssue[] {
  const issues: DriftIssue[] = []

  // Diff publication-level presence
  const sourcePubs = new Set(source.map(p => p.pubname))
  const targetPubs = new Set(target.map(p => p.pubname))

  for (const pubname of sourcePubs) {
    if (!targetPubs.has(pubname)) {
      const tables = source.filter(p => p.pubname === pubname && p.tablename)
      issues.push({
        id: `realtime-missing-pub-${pubname}`,
        check: 'realtime',
        severity: 'warning',
        title: `Missing publication: ${pubname}`,
        description: `Publication "${pubname}" exists in source but not in target.`,
        sourceValue: tables,
        sql: {
          up: `CREATE PUBLICATION ${quoteName(pubname)}${tables.length > 0 ? ` FOR TABLE ${tables.map(t => `${quoteName(t.schemaname)}.${quoteName(t.tablename)}`).join(', ')}` : ''};`,
          down: `DROP PUBLICATION IF EXISTS ${quoteName(pubname)};`,
        },
      })
    }
  }

  for (const pubname of targetPubs) {
    if (!sourcePubs.has(pubname)) {
      // Every Supabase project has supabase_realtime, empty until a table is
      // enabled for Realtime, so a source without it (plain PostgreSQL) is not
      // drift. What it streams is: those tables' changes reach clients, so
      // each is reported, though the source publishes none of them.
      if (pubname === 'supabase_realtime') {
        for (const t of target.filter(p => p.pubname === pubname && p.tablename)) {
          const fqn = `${t.schemaname}.${t.tablename}`
          issues.push({
            id: `realtime-extra-table-${pubname}-${fqn}`,
            check: 'realtime',
            severity: 'warning',
            title: `Extra published table: ${fqn} in ${pubname}`,
            description: `Table "${fqn}" streams its changes to Realtime clients in target, but source publishes nothing for Realtime.`,
            sql: {
              up: `ALTER PUBLICATION ${quoteName(pubname)} DROP TABLE ${quoteName(t.schemaname)}.${quoteName(t.tablename)};`,
              down: `ALTER PUBLICATION ${quoteName(pubname)} ADD TABLE ${quoteName(t.schemaname)}.${quoteName(t.tablename)};`,
            },
          })
        }
        continue
      }
      issues.push({
        id: `realtime-extra-pub-${pubname}`,
        check: 'realtime',
        severity: 'info',
        title: `Extra publication: ${pubname}`,
        description: `Publication "${pubname}" exists in target but not in source.`,
      })
    }
  }

  // Diff table membership within shared publications
  const sharedPubs = [...sourcePubs].filter(p => targetPubs.has(p))
  for (const pubname of sharedPubs) {
    const sourceTables = new Set(
      source.filter(p => p.pubname === pubname && p.tablename).map(p => `${p.schemaname}.${p.tablename}`),
    )
    const targetTables = new Set(
      target.filter(p => p.pubname === pubname && p.tablename).map(p => `${p.schemaname}.${p.tablename}`),
    )

    for (const fqn of sourceTables) {
      if (!targetTables.has(fqn)) {
        issues.push({
          id: `realtime-missing-table-${pubname}-${fqn}`,
          check: 'realtime',
          severity: 'warning',
          title: `Table not published: ${fqn} in ${pubname}`,
          description: `Table "${fqn}" is published in source publication "${pubname}" but not in target.`,
          sql: {
            up: `ALTER PUBLICATION ${quoteName(pubname)} ADD TABLE ${fqn};`,
            down: `ALTER PUBLICATION ${quoteName(pubname)} DROP TABLE ${fqn};`,
          },
        })
      }
    }

    for (const fqn of targetTables) {
      if (!sourceTables.has(fqn)) {
        issues.push({
          id: `realtime-extra-table-${pubname}-${fqn}`,
          check: 'realtime',
          severity: 'info',
          title: `Extra published table: ${fqn} in ${pubname}`,
          description: `Table "${fqn}" is published in target publication "${pubname}" but not in source.`,
        })
      }
    }
  }

  return issues
}

