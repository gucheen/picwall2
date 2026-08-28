import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { loadOriginalImage } from '../src/lib/image-loader'

class FakeXHR {
  static requests: FakeXHR[] = []
  status = 200
  response = new Blob(['image'], { type: 'image/png' })
  responseType = ''
  timeout = 0
  onload: (() => void) | null = null
  onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  open = mock((_method: string, _url: string, _async: boolean) => {})
  send = mock(() => {})
  abort = mock(() => { this.onabort?.() })
  constructor() { FakeXHR.requests.push(this) }
}

const originalXHR = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest')

beforeEach(() => {
  FakeXHR.requests = []
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXHR })
})

afterEach(() => {
  mock.restore()
  if (originalXHR) Object.defineProperty(globalThis, 'XMLHttpRequest', originalXHR)
  else Reflect.deleteProperty(globalThis, 'XMLHttpRequest')
})

test('keeps the displayed Blob URL alive until cleanup and revokes it exactly once', () => {
  const create = spyOn(URL, 'createObjectURL').mockReturnValue('blob:original')
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const loaded = mock((_src: string) => {})
  const progress = mock((_progress: number | null) => {})
  const cleanup = loadOriginalImage('/uploads/photo.png', loaded, progress)
  const xhr = FakeXHR.requests[0]!
  expect(xhr.open).toHaveBeenCalledWith('GET', '/uploads/photo.png', true)
  expect(xhr.responseType).toBe('blob')
  expect(progress).toHaveBeenLastCalledWith(0)
  xhr.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 })
  expect(progress).toHaveBeenLastCalledWith(50)
  xhr.onload?.()
  expect(create).toHaveBeenCalledWith(xhr.response)
  expect(loaded).toHaveBeenLastCalledWith('blob:original')
  expect(progress).toHaveBeenLastCalledWith(null)
  expect(revoke).not.toHaveBeenCalled()
  cleanup()
  cleanup()
  expect(xhr.abort).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalledWith('blob:original')
})

test('switching images cancels the old request and ignores late load/progress callbacks', () => {
  const create = spyOn(URL, 'createObjectURL').mockReturnValue('blob:new')
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const loaded = mock((_src: string) => {})
  const progress = mock((_progress: number | null) => {})
  const cleanupOld = loadOriginalImage('/old.png', loaded, progress)
  const old = FakeXHR.requests[0]!
  const lateLoad = old.onload!
  const lateProgress = old.onprogress!
  cleanupOld()
  const cleanupNew = loadOriginalImage('/new.png', loaded, progress)
  lateLoad()
  lateProgress({ lengthComputable: true, loaded: 100, total: 100 })
  expect(progress).toHaveBeenLastCalledWith(0)
  expect(loaded).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(old.onload).toBeNull()
  FakeXHR.requests[1]!.onload?.()
  expect(loaded).toHaveBeenCalledTimes(1)
  cleanupNew()
  expect(revoke).toHaveBeenCalledWith('blob:new')
})

test.each(['http', 'error', 'timeout', 'abort'] as const)('clears download progress after %s failure without a Blob URL', event => {
  const create = spyOn(URL, 'createObjectURL').mockReturnValue('blob:unused')
  const loaded = mock((_src: string) => {})
  const progress = mock((_progress: number | null) => {})
  const cleanup = loadOriginalImage('/broken.png', loaded, progress)
  const xhr = FakeXHR.requests[0]!
  if (event === 'http') {
    xhr.status = 404
    xhr.onload?.()
  } else xhr[`on${event}`]?.()
  expect(progress).toHaveBeenLastCalledWith(null)
  expect(loaded).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  cleanup()
})
