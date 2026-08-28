export interface UploadItem { file: File; key: string }
export interface UploadResult { item: UploadItem; error?: string; pending?: boolean }

export async function uploadPhotos(items: UploadItem[], onResult: (result: UploadResult) => void, signal: AbortSignal) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++]!
      try {
        if (!item.file.type.startsWith('image/')) throw new Error('Only image files are supported.')
        if (item.file.size > 50 * 1024 * 1024) throw new Error('The file exceeds 50 MB.')
        const result = await upload(item, signal)
        if (!signal.aborted) onResult({ item, pending: result.status === 'pending' })
      } catch (error) {
        if (!signal.aborted) onResult({ item, error: error instanceof Error ? error.message : 'Upload failed. Please retry.' })
      }
    }
  }))
}

async function upload(item: UploadItem, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    let retry = 1000 * 2 ** attempt
    try {
      const form = new FormData()
      form.append('file', item.file)
      const response = await fetch('/api/upload', { method: 'POST', headers: { 'Idempotency-Key': item.key }, body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
      if (response.ok) return await response.json() as { status: 'ready' | 'pending' }
      const result = await response.json().catch(() => null)
      if (![429, 503].includes(response.status) || attempt >= 2) throw new UploadError(result?.error || `Upload failed (${response.status}).`)
      const header = response.headers.get('Retry-After')
      const delay = header ? /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now() : retry
      if (Number.isFinite(delay)) retry = Math.max(retry, delay)
      if (retry > 30_000) throw new UploadError('The server is busy. Please retry later.')
    } catch (error) {
      if (signal.aborted || error instanceof UploadError || attempt >= 2) throw error
    }
    await pause(retry, signal)
  }
}

class UploadError extends Error {}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const cancel = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}
