import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Photo } from '../../types/shared_types'
import { layoutPhotos, visiblePhotos } from '../lib/masonry'
import PhotoCard from './PhotoCard'
import styles from './PhotoWall.module.css'

export default function VirtualPhotoGrid({ photos, selectedId, onSelect }: {
  photos: Photo[]; selectedId: string | null; onSelect: (photo: Photo) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, columns: 1, top: 0, bottom: 0 })
  useLayoutEffect(() => {
    const node = container.current!
    let frame = 0
    const measure = () => {
      const rect = node.getBoundingClientRect()
      const width = window.innerWidth
      setViewport({ width: rect.width, columns: width >= 1280 ? 4 : width >= 1024 ? 3 : width >= 640 ? 2 : 1,
        top: -rect.top, bottom: window.innerHeight - rect.top })
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(node)
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [])
  const layout = useMemo(() => layoutPhotos(photos, viewport.width, viewport.columns), [photos, viewport.width, viewport.columns])
  const visible = viewport.width ? visiblePhotos(layout.columns, viewport.top, viewport.bottom) : []

  useEffect(() => {
    if (!selectedId) return
    const item = layout.columns.flat().find(item => item.photo.id === selectedId)
    const node = container.current
    if (!item || !node) return
    const top = node.getBoundingClientRect().top + item.top
    if (top < 80 || top + item.height > window.innerHeight) {
      window.scrollTo({ top: Math.max(0, window.scrollY + top - 100), behavior: 'instant' })
    }
  }, [selectedId, layout])

  return <main ref={container} className={styles.masonryGrid} style={{ height: layout.height }}>
    {visible.map(item => <div key={item.photo.id} style={{ position: 'absolute', top: item.top, left: item.left, width: item.width, height: item.height }}>
      <PhotoCard photo={item.photo} onClick={onSelect} />
    </div>)}
  </main>
}
