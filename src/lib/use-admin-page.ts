import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'

export function useAdminPage<T, Details = unknown>(endpoint: string, field: 'items' | 'photos', enabled: boolean) {
  const [items, setItems] = useState<T[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [details, setDetails] = useState<Details | null>(null)
  const controller = useRef<AbortController | null>(null)
  const updateItems = useCallback((update: SetStateAction<T[]>) => {
    // A response started before a successful mutation must not overwrite the local result.
    controller.current?.abort()
    setLoading(false)
    setItems(update)
  }, [])
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const cursor = cursors.at(-1)

  useEffect(() => {
    if (!enabled) return
    const request = new AbortController()
    controller.current = request
    const query = new URLSearchParams({ limit: '60' })
    if (cursor) query.set('cursor', cursor)
    setLoading(true)
    setError('')
    void fetch(`${endpoint}?${query}`, { signal: request.signal }).then(async response => {
      if (!response.ok) throw new Error(`Could not load this page (${response.status}). Please retry.`)
      const page = await response.json()
      if (request.signal.aborted) return
      setItems(page[field])
      setNextCursor(page.nextCursor)
      setDetails(page)
    }).catch(error => {
      if (!request.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load this page.')
    }).finally(() => { if (!request.signal.aborted) setLoading(false) })
    return () => request.abort()
  }, [enabled, endpoint, field, cursor, revision])

  const navigate = (previous: boolean) => {
    if (loading || previous && cursors.length === 1 || !previous && !nextCursor) return
    controller.current?.abort()
    setItems([])
    setNextCursor(null)
    setCursors(history => previous ? history.slice(0, -1) : [...history, nextCursor!])
  }

  return { items, setItems: updateItems, details, loading, error, refresh, page: cursors.length,
    hasNext: nextCursor !== null, hasPrevious: cursors.length > 1,
    next: () => navigate(false), previous: () => navigate(true) }
}
