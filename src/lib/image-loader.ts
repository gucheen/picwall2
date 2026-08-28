// The returned cleanup owns the request and Blob URL, and must run on image change or unmount.
export function loadOriginalImage(
  src: string,
  onLoad: (url: string) => void,
  onProgress: (progress: number | null) => void,
): () => void {
  const xhr = new XMLHttpRequest()
  let objectUrl: string | undefined
  let disposed = false
  const finish = () => { if (!disposed) onProgress(null) }

  xhr.open('GET', src, true)
  xhr.responseType = 'blob'
  xhr.timeout = 60_000
  xhr.onprogress = event => {
    if (!disposed && event.lengthComputable && event.total > 0) {
      onProgress(Math.round(event.loaded / event.total * 100))
    }
  }
  xhr.onload = () => {
    if (disposed) return
    if (xhr.status === 200) {
      objectUrl = URL.createObjectURL(xhr.response)
      onLoad(objectUrl)
    }
    finish()
  }
  xhr.onerror = finish
  xhr.onabort = finish
  xhr.ontimeout = finish
  onProgress(0)
  xhr.send()

  return () => {
    if (disposed) return
    disposed = true
    xhr.onload = xhr.onprogress = xhr.onerror = xhr.onabort = xhr.ontimeout = null
    xhr.abort()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}
