import { describe, expect, it } from 'vitest'
import { readJsonArray, readJsonObject } from '../src/utils/http.js'

const answer = (body: string, status = 200) => new Response(body, { status })

describe('reading an API answer', () => {
  it('passes the expected shape through', async () => {
    expect(await readJsonArray(answer('[{"slug":"a"}]'), 'The list')).toEqual([{ slug: 'a' }])
    expect(await readJsonObject(answer('{"a":1}'), 'The config')).toEqual({ a: 1 })
  })

  it('names a body that is not JSON', async () => {
    await expect(readJsonArray(answer('<html>Bad gateway</html>', 200), 'The Edge Function list'))
      .rejects.toThrow('The Edge Function list answered HTTP 200 with a body that is not JSON')
  })

  it('names the wrong shape, with the message an API sent', async () => {
    await expect(readJsonArray(answer('{"message":"Unauthorized"}'), 'The list'))
      .rejects.toThrow('The list answered with an object saying "Unauthorized" where a list was expected')
    await expect(readJsonObject(answer('[1]'), 'The config'))
      .rejects.toThrow('where an object was expected')
    await expect(readJsonObject(answer('null'), 'The config')).rejects.toThrow('null')
  })
})
