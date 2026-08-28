import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { updatePhotoTags } from '../src/lib/batch-tags'

afterEach(() => { mock.restore() })
const preconnect = fetch.preconnect

test('splits large selections into bounded batches and reports only saved IDs', async () => {
  const sizes: number[] = []
  spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
    sizes.push(JSON.parse(init!.body as string).ids.length)
    return Response.json({ success: true })
  }, { preconnect }))
  const saved: string[] = []
  const ids = Array.from({ length: 2501 }, (_, i) => String(i))
  await updatePhotoTags([...ids, ids[0]!], ['travel'], batch => saved.push(...batch))
  expect(sizes).toEqual([1000, 1000, 501])
  expect(saved).toEqual(ids)
})

test('stops on failure without reporting the failed or remaining batches as saved', async () => {
  let calls = 0
  spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response(null, { status: ++calls === 1 ? 200 : 503 }), { preconnect }))
  const saved: string[] = []
  await expect(updatePhotoTags(Array.from({ length: 2501 }, (_, i) => String(i)), [], batch => saved.push(...batch)))
    .rejects.toThrow('Unsaved photos remain selected')
  expect(calls).toBe(2)
  expect(saved).toHaveLength(1000)
})
