import type { DriftIssue, SyncAction } from '../types/drift'
import { Check, CheckSkipped, type CheckContext } from './base'
import { SUPABASE_MGMT_API } from '../constants'
import { inventoryFunctions, type FunctionInventory } from '../edge-functions-fs'
import { inventoryFunctionsViaStudio, DEFAULT_SELF_HOSTED_REF } from '../edge-functions-api'
import { httpStatus, readJsonArray } from '../utils/http.js'

interface EdgeFunction {
  slug: string
  name: string
  version: number
  status: string
  created_at: string
  updated_at: string
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class EdgeFunctionsCheck extends Check {
  readonly name = 'edge-functions' as const

  constructor(private fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const sourceRef = ctx.source.projectRef
    const targetRef = ctx.target.projectRef
    const sourceKey = ctx.source.accessToken
    const targetKey = ctx.target.accessToken

    // Self-hosted has no "list functions" management endpoint, so the API path
    // cannot work there (issue #41: building the hosted URL anyway failed with
    // a bare `Unauthorized`, which reads as a fixable credentials problem).
    //
    // What self-hosted does have is the directory the functions are mounted
    // from, so if both environments name one, compare those instead.
    // Self-hosted Studio serves the same functions API shape as the hosted
    // Management API, so prefer it: it works remotely, needs no volume mount,
    // and returns module contents rather than just names. It is not behind the
    // Kong gateway apiUrl points at, hence its own field.
    // Each side resolves independently, so a live instance can be compared
    // against a checkout: both produce the same inventory shape and hash their
    // modules identically, which is the whole point of sharing the format.
    const [source, target] = await Promise.all([
      this.resolveInventory(ctx.source),
      this.resolveInventory(ctx.target),
    ])
    if (source && target) {
      if (source.length === 0 && target.length === 0) {
        throw new CheckSkipped('no Edge Functions found in either environment')
      }
      return diffFunctionInventories(source, target)
    }

    if (ctx.source.apiUrl || ctx.target.apiUrl) {
      throw new CheckSkipped(
        'Edge Functions comparison needs a source to read from on self-hosted. '
        + 'Set "studioUrl" on both environments (preferred — Studio serves '
        + '/api/v1/projects/{ref}/functions), or "functionsPath" to compare the '
        + 'mounted directories instead.',
      )
    }

    if (!sourceRef || !targetRef || !sourceKey || !targetKey) {
      throw new CheckSkipped('no projectRef or accessToken configured')
    }

    const [hostedSource, hostedTarget] = await Promise.all([
      this.listFunctions(sourceRef, sourceKey),
      this.listFunctions(targetRef, targetKey),
    ])

    return diffFunctions(hostedSource, hostedTarget, targetRef, targetKey)
  }

  /**
   * Where this environment's functions can be read from, or null if nowhere.
   *
   * Studio is preferred: it works remotely and returns module contents. The
   * directory is the fallback for when Studio is not reachable.
   */
  private async resolveInventory(
    env: CheckContext['source'],
  ): Promise<FunctionInventory[] | null> {
    if (env.studioUrl) {
      return inventoryFunctionsViaStudio(
        env.studioUrl, env.projectRef ?? DEFAULT_SELF_HOSTED_REF, this.fetchFn,
      )
    }
    if (env.functionsPath) return inventoryFunctions(env.functionsPath)
    return null
  }

  private async listFunctions(projectRef: string, accessToken: string): Promise<EdgeFunction[]> {
    const url = `${SUPABASE_MGMT_API}/${encodeURIComponent(projectRef)}/functions`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Failed to list functions for ${projectRef}: HTTP ${httpStatus(res)}`)
    return readJsonArray<EdgeFunction>(res, `The Edge Function list of ${projectRef}`)
  }
}

function makeDeleteAction(slug: string, targetRef: string, targetKey: string): SyncAction {
  return {
    method: 'DELETE',
    url: `${SUPABASE_MGMT_API}/${encodeURIComponent(targetRef)}/functions/${encodeURIComponent(slug)}`,
    headers: { Authorization: `Bearer ${targetKey}` },
    label: `Delete Edge Function "${slug}" from target`,
  }
}

function diffFunctions(
  source: EdgeFunction[],
  target: EdgeFunction[],
  targetRef: string,
  targetKey: string,
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(f => [f.slug, f]))
  const targetMap = new Map(target.map(f => [f.slug, f]))

  for (const [slug, f] of sourceMap) {
    if (!targetMap.has(slug)) {
      issues.push({
        id: `edge-fn-missing-${slug}`,
        check: 'edge-functions',
        severity: 'warning',
        title: `Missing Edge Function: ${slug}`,
        description: `Function "${f.name}" (${slug}) exists in source but not in target. Deploy it via "supabase functions deploy ${slug}" against the target project.`,
        sourceValue: f,
        // Cannot auto-deploy: source code is not available via the Management API.
        // User must deploy from their local supabase/functions/ directory.
      })
    }
  }

  for (const [slug, f] of targetMap) {
    if (!sourceMap.has(slug)) {
      issues.push({
        id: `edge-fn-extra-${slug}`,
        check: 'edge-functions',
        severity: 'info',
        title: `Extra Edge Function: ${slug}`,
        description: `Function "${f.name}" (${slug}) exists in target but not in source.`,
        targetValue: f,
        action: makeDeleteAction(slug, targetRef, targetKey),
      })
    }
  }

  for (const [slug, sf] of sourceMap) {
    const tf = targetMap.get(slug)
    if (tf && sf.version !== tf.version) {
      issues.push({
        id: `edge-fn-version-${slug}`,
        check: 'edge-functions',
        severity: 'warning',
        title: `Version mismatch: ${slug}`,
        description: `Function "${slug}" is at version ${sf.version} in source but version ${tf.version} in target. Redeploy via "supabase functions deploy ${slug}" against the target project.`,
        sourceValue: sf,
        targetValue: tf,
        // Cannot auto-deploy: source code is not available via the Management API.
      })
    }
  }

  return issues
}

/**
 * Compare two inventories, from either source — Studio's API or the filesystem
 * both hash modules the same way, so the two are directly comparable.
 *
 * Neither side can be fixed automatically: deploying a function needs the
 * Supabase CLI and, on self-hosted, a restart of edge-runtime. So every issue
 * carries guidance rather than a SyncAction — reporting a fix that cannot be
 * applied is worse than admitting there is not one.
 */
function diffFunctionInventories(
  source: FunctionInventory[],
  target: FunctionInventory[],
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(f => [f.slug, f]))
  const targetMap = new Map(target.map(f => [f.slug, f]))

  for (const [slug, sf] of sourceMap) {
    if (targetMap.has(slug)) continue
    issues.push({
      id: `edge-fn-missing-${slug}`,
      check: 'edge-functions',
      severity: 'warning',
      title: `Missing Edge Function: ${slug}`,
      description: `Function "${slug}" (${sf.fileCount} file(s)) exists in source but not in target. `
        + `Deploy it with: supabase functions deploy ${slug}`,
      sourceValue: { slug, fileCount: sf.fileCount },
    })
  }

  for (const [slug, tf] of targetMap) {
    if (sourceMap.has(slug)) continue
    issues.push({
      id: `edge-fn-extra-${slug}`,
      check: 'edge-functions',
      severity: 'info',
      title: `Extra Edge Function: ${slug}`,
      description: `Function "${slug}" exists in target but not in source. `
        + `Remove it with: supabase functions delete ${slug}`,
      targetValue: { slug, fileCount: tf.fileCount },
    })
  }

  for (const [slug, sf] of sourceMap) {
    const tf = targetMap.get(slug)
    if (!tf || tf.hash === sf.hash) continue
    issues.push({
      id: `edge-fn-changed-${slug}`,
      check: 'edge-functions',
      severity: 'warning',
      title: `Edge Function differs: ${slug}`,
      description: `Function "${slug}" has different contents in source and target. `
        + `Redeploy with: supabase functions deploy ${slug}`,
      // Hashes, not source: the point is that they differ, and function code
      // can contain secrets that have no business in a drift report.
      sourceValue: { slug, sha256: sf.hash.slice(0, 12) },
      targetValue: { slug, sha256: tf.hash.slice(0, 12) },
    })
  }

  return issues
}
