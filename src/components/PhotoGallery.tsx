import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { Photo } from '../../types/shared_types'
import { usePhotoPages } from '../lib/use-photo-pages'
import VirtualPhotoGrid from './VirtualPhotoGrid'
import DetailView from './DetailView'
import styles from './PhotoWall.module.css'

export default function PhotoGallery({ tag }: { tag: string | null }) {
  const { photos, loading, error, hasMore, loadMore } = usePhotoPages(tag)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const navigation = useRef(0)
  const restoreFocus = useRef<string | null>(null)
  const [navigating, setNavigating] = useState(false)
  const select = useCallback((photo: Photo) => { navigation.current++; setSelectedId(photo.id) }, [])
  const selectedIndex = photos.findIndex(photo => photo.id === selectedId)
  const selected = photos[selectedIndex]

  useEffect(() => {
    if (!hasMore || loading || error || !sentinel.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore()
    }, { rootMargin: '800px' })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [hasMore, loading, error, loadMore])

  return <>
    <VirtualPhotoGrid photos={photos} selectedId={selectedId} onSelect={select} />
    <div ref={sentinel} className={styles.pageControls}>
      {loading && <div className={styles.spinner} role="status" aria-label="Loading photos" />}
      {error && <p role="alert">{error}</p>}
      {!loading && hasMore && <button className={styles.uploadLabel} onClick={() => void loadMore()}>{error ? 'Retry' : 'Load more'}</button>}
      {!loading && !error && photos.length === 0 && <p>No photos found.</p>}
    </div>
    <AnimatePresence onExitComplete={() => {
      // Wait for the modal to leave the top layer before focusing the otherwise inert gallery.
      requestAnimationFrame(() => {
        if (restoreFocus.current) document.getElementById(`photo-card-${restoreFocus.current}`)?.focus({ preventScroll: true })
      })
    }}>
      {selected && <DetailView photo={selected}
        hasPrevious={selectedIndex > 0} hasNext={!navigating && (selectedIndex < photos.length - 1 || hasMore)}
        navigationError={error}
        onClose={() => { navigation.current++; restoreFocus.current = selected.id; setSelectedId(null); setNavigating(false) }}
        onPrev={() => { navigation.current++; setNavigating(false); if (selectedIndex > 0) setSelectedId(photos[selectedIndex - 1]!.id) }}
        onNext={async () => {
          const request = ++navigation.current
          if (selectedIndex < photos.length - 1) setSelectedId(photos[selectedIndex + 1]!.id)
          else if (hasMore) {
            setNavigating(true)
            const next = await loadMore()
            if (request === navigation.current) {
              setNavigating(false)
              if (next[0]) setSelectedId(next[0].id)
            }
          }
        }} />}
    </AnimatePresence>
  </>
}
