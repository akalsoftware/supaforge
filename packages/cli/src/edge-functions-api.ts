/**
 * Edge Function inventory from a self-hosted Supabase Studio.
 *
 * Studio serves the same shape as the hosted Management API:
 *
 *   GET /api/v1/projects/{ref}/functions              -> [{ slug, name, version, ... }]
 *   GET /api/v1/projects/{ref}/functions/{slug}/body  -> multipart, one part per module
 *
 * Preferred over reading the functions directory because it works remotely,
 * with no volume mount or shell access to the host.
 *
 * Two things it is NOT behind:
 *  - the Kong gateway `apiUrl` points at, which 401s on this path
 *  - any authentication at all, on the versions checked — so a publicly routed
 *    Studio exposes function *source* to anyone. Worth knowing before exposing
 *    one.
 */
import { createHash } from 'node:crypto'
import type { FunctionInventory } from './edge-functions-fs'
import { readJsonArray } from './utils/http.js'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

interface StudioFunction {
  slug: string
  name?: string
  version?: number
  status?: string
}

/** Self-hosted Studio always uses this project ref unless told otherwise. */
export const DEFAULT_SELF_HOSTED_REF = 'default'

function base(studioUrl: string, ref: string): string {
  return `${studioUrl.replace(/\/+$/, '')}/api/v1/projects/${encodeURIComponent(ref)}/functions`
}

/** One `file` part of a multipart body. */
interface MultipartFile {
  name: string
  body: string
}

/**
 * Parse multipart/form-data by hand.
 *
 * Response.formData() rejects Studio's body with "Failed to parse body as
 * FormData" even though it is well formed — correct Content-Type, correct
 * delimiters, proper closing boundary. undici is strict about details like the
 * extended `filename*=UTF-8''...` parameter Studio emits alongside `filename`.
 *
 * Rather than depend on how tolerant a particular undici build happens to be —
 * this has to work identically on Node 18 through 25 — the format is parsed
 * directly. It is small and fully specified.
 */
export function parseMultipart(contentType: string, body: string): MultipartFile[] {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim()
  if (!boundary) return []

  const files: MultipartFile[] = []
  // Sections are delimited by "--" + boundary, per RFC 7578.
  for (const section of body.split(`--${boundary}`)) {
    const split = section.indexOf('\r\n\r\n')
    if (split === -1) continue

    const headers = section.slice(0, split)
    if (!/name="file"/i.test(headers)) continue

    // Prefer the plain filename; the extended form is the same value encoded.
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1] ?? 'index.ts'
    // Trim the CRLF that precedes the next delimiter.
    const content = section.slice(split + 4).replace(/\r\n$/, '')
    files.push({ name: filename, body: content })
  }
  return files
}

/**
 * Hash a function's modules the same way the filesystem inventory does — sorted
 * by path, hashing path then contents — so an inventory taken over HTTP is
 * directly comparable with one taken from a directory.
 *
 * The metadata part is deliberately excluded: it carries a deployment_id that
 * is regenerated on every deploy, so including it would report drift between
 * two byte-identical functions.
 */
async function hashFunctionBody(res: Response): Promise<{ hash: string; fileCount: number }> {
  const files = parseMultipart(res.headers.get('content-type') ?? '', await res.text())
  files.sort((a, b) => a.name.localeCompare(b.name))

  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.name)
    hash.update('\0')
    hash.update(file.body)
    hash.update('\0')
  }
  return { hash: hash.digest('hex'), fileCount: files.length }
}

export async function inventoryFunctionsViaStudio(
  studioUrl: string,
  ref: string,
  fetchFn: FetchFn,
): Promise<FunctionInventory[]> {
  const listRes = await fetchFn(base(studioUrl, ref))
  if (!listRes.ok) {
    throw new Error(`Studio functions API returned ${listRes.status} for ${studioUrl}`)
  }
  const listed = await readJsonArray<StudioFunction>(listRes, `The Studio functions API at ${studioUrl}`)

  const out: FunctionInventory[] = []
  for (const fn of listed) {
    if (!fn?.slug) continue
    const bodyRes = await fetchFn(`${base(studioUrl, ref)}/${encodeURIComponent(fn.slug)}/body`)
    if (!bodyRes.ok) {
      // Listed but unreadable: still report it exists, with no hash to compare.
      out.push({ slug: fn.slug, hash: '', fileCount: 0 })
      continue
    }
    const { hash, fileCount } = await hashFunctionBody(bodyRes)
    out.push({ slug: fn.slug, hash, fileCount })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}
