import { useCallback, useEffect, useRef, useState } from 'react'
import type { Photo, PhotoPage } from '../../types/shared_types'

export function usePhotoPages(tag: string | null) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const session = useRef<{ controller: AbortController; cursor?: string | null; pending?: Promise<Photo[]> } | null>(null)

  const loadMore = useCallback((): Promise<Photo[]> => {
    const current = session.current
    if (!current || current.controller.signal.aborted || current.cursor === null) return Promise.resolve([])
    if (current.pending) return current.pending
    const query = new URLSearchParams({ limit: '60' })
    if (tag) query.set('tag', tag)
    if (current.cursor) query.set('cursor', current.cursor)
    setLoading(true)
    setError(null)
    current.pending = (async () => {
      try {
        const response = await fetch(`/api/photos?${query}`, { signal: current.controller.signal })
        if (!response.ok) throw new Error('Failed to load photos')
        const page: PhotoPage = await response.json()
        if (current.controller.signal.aborted) return []
        current.cursor = page.nextCursor
        setPhotos(previous => {
          const ids = new Set(previous.map(photo => photo.id))
          return previous.concat(page.photos.filter(photo => !ids.has(photo.id)))
        })
        setHasMore(page.nextCursor !== null)
        return page.photos
      } catch (error) {
        if (!current.controller.signal.aborted) setError(error instanceof Error ? error.message : 'Failed to load photos')
        return []
      } finally {
        current.pending = undefined
        if (!current.controller.signal.aborted) setLoading(false)
      }
    })()
    return current.pending
  }, [tag])

  useEffect(() => {
    const current = { controller: new AbortController() }
    session.current = current
    setPhotos([])
    setHasMore(true)
    void loadMore()
    return () => current.controller.abort()
  }, [loadMore])
  return { photos, loading, error, hasMore, loadMore }
}
