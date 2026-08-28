import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { uploadPhotos, type UploadResult } from '../src/lib/upload-queue'

const preconnect = fetch.preconnect
afterEach(() => { mock.restore() })
const items = () => Array.from({ length: 5 }, (_, i) => ({ key: `key-${i}`, file: new File(['png'], `${i}.png`, { type: 'image/png' }) }))

test('uploads at most two files concurrently and continues after a permanent failure', async () => {
  let active = 0
  let peak = 0
  spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 1))
    active--
    return (init?.headers as Record<string, string>)['Idempotency-Key'] === 'key-2'
      ? Response.json({ error: 'Unsupported image' }, { status: 400 })
      : Response.json({ status: 'pending' }, { status: 202 })
  }, { preconnect }))
  const results: UploadResult[] = []
  await uploadPhotos(items(), result => results.push(result), new AbortController().signal)
  expect(peak).toBe(2)
  expect(results).toHaveLength(5)
  expect(results.filter(result => result.error)).toHaveLength(1)
  expect(results.filter(result => result.pending)).toHaveLength(4)
})

test('transient errors retry the same idempotency key', async () => {
  const keys: string[] = []
  spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
    keys.push((init!.headers as Record<string, string>)['Idempotency-Key']!)
    if (keys.length === 1) throw new TypeError('Connection lost after saving')
    return Response.json({ status: 'ready' })
  }, { preconnect }))
  const results: UploadResult[] = []
  await uploadPhotos(items().slice(0, 1), result => results.push(result), new AbortController().signal)
  expect(keys).toEqual(['key-0', 'key-0'])
  expect(results).toHaveLength(1)
  expect(results[0]?.error).toBeUndefined()
})

test('aborting a batch stops scheduling files and suppresses stale results', async () => {
  const controller = new AbortController()
  const request = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => {
    controller.abort()
    return Response.json({ status: 'pending' })
  }, { preconnect }))
  const result = mock(() => {})
  await uploadPhotos(items(), result, controller.signal)
  expect(request).toHaveBeenCalledTimes(1)
  expect(result).not.toHaveBeenCalled()
})
