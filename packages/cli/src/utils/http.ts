/**
 * Reading an HTTP API's answer without trusting it.
 *
 * `await res.json() as T[]` assumed both that the body was JSON and that it
 * had the shape asked for. A proxy's HTML error page, a 200 carrying
 * `{ "message": ... }`, or an API that changed its shape then failed far from
 * here as "x.map is not a function". These say what came back instead.
 */

/** The status, with its text when the server sent one (HTTP/2 sends none). */
export function httpStatus(res: Response): string {
  return [res.status, res.statusText].filter(Boolean).join(' ') || 'with no status'
}

/** The body as JSON, or an error naming `what`. */
export async function readJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new Error(`${what} answered HTTP ${httpStatus(res)} with a body that is not JSON`)
  }
}

export async function readJsonArray<T>(res: Response, what: string): Promise<T[]> {
  const value = await readJson(res, what)
  if (!Array.isArray(value)) throw new Error(`${what} answered with ${shapeOf(value)} where a list was expected`)
  return value as T[]
}

export async function readJsonObject(res: Response, what: string): Promise<Record<string, unknown>> {
  const value = await readJson(res, what)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} answered with ${shapeOf(value)} where an object was expected`)
  }
  return value as Record<string, unknown>
}

function shapeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a list'
  if (typeof value === 'object') {
    const message = (value as { message?: unknown }).message
    return typeof message === 'string' ? `an object saying "${message.slice(0, 120)}"` : 'an object'
  }
  return `a ${typeof value}`
}
