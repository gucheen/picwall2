import { useState, useEffect } from 'react'
import { AnimatePresence } from 'motion/react'
import type { Photo } from '../../types/shared_types'
import PhotoCard from './PhotoCard'
import DetailView from './DetailView'
import styles from './PhotoWall.module.css'

export default function PhotoWall() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/photos')
      .then((res) => res.json())
      .then((data) => {
        setPhotos(data)
        setLoading(false)
      })
      .catch((err) => {
        console.error('Failed to load photos', err)
        setLoading(false)
      })
  }, [])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [numColumns, setNumColumns] = useState(1)
  const [mounted, setMounted] = useState(false)
  const [user, setUser] = useState<any>(null) // Auth User

  const selectedPhoto = photos.find((p) => p.id === selectedId)

  // Check Auth
  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => setUser(data.user || null))
      .catch(() => setUser(null))
  }, [])

  // Match CSS breakpoints
  useEffect(() => {
    const updateColumns = () => {
      const width = window.innerWidth
      if (width >= 1280) setNumColumns(4)
      else if (width >= 1024) setNumColumns(3)
      else if (width >= 640) setNumColumns(2)
      else setNumColumns(1)
      setMounted(true)
    }

    updateColumns()
    window.addEventListener('resize', updateColumns)
    return () => window.removeEventListener('resize', updateColumns)
  }, [])

  // Distribute photos into columns (Left-to-Right, then Top-to-Bottom order)
  const [tag, setTag] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('tag')) {
      setTag(params.get('tag'))
    }
  }, [])

  const filteredPhotos = tag
    ? photos.filter((p) => p.tags && p.tags.includes(tag))
    : photos

  /* Shortest-column-first distribution */
  const columns = Array.from({ length: numColumns }, () => [] as Photo[])
  const columnHeights = new Array(numColumns).fill(0)

  filteredPhotos.forEach((photo) => {
    // Find column with minimum height
    const minHeight = Math.min(...columnHeights)
    const colIndex = columnHeights.indexOf(minHeight)

    columns[colIndex]!.push(photo)

    // Estimate height. Default assumption 1.0 aspect ratio if missing
    // We only care about relative height, so we divide height by width (inverse of aspect ratio)
    // or just 1 if undefined.
    const aspectRatio =
      photo.width && photo.height ? photo.height / photo.width : 1

    columnHeights[colIndex] += aspectRatio
  })

  /* Removed direction state */

  // Scroll current photo into view when selected changes
  useEffect(() => {
    if (selectedId) {
      const el = document.getElementById(`photo-card-${selectedId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [selectedId])

  return (
    <div className={styles.container}>
      {/* ... header and grid ... */}

      {/* Header / Upload */}
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <a href="/">
            <h1 className={styles.title}>PicWall</h1>
          </a>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
            }}
          >
            {user ? (
              <>
                <a href="/admin" className={styles.uploadLabel}>
                  Admin Dashboard
                </a>
              </>
            ) : (
              <a href="/api/auth/login" className={styles.uploadLabel}>
                Sign In
              </a>
            )}
            {/* Sign Out link kept as part of Admin or Auth logic, but here we just link to dashboard or login */}
          </div>
        </div>
      </header>

      {/* Grid */}
      <main className={styles.masonryGrid}>
        {mounted &&
          columns.map((colPhotos, colIndex) => (
            <div key={colIndex} className={styles.gridColumn}>
              {colPhotos.map((photo) => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  onClick={() => {
                    setSelectedId(photo.id)
                  }}
                />
              ))}
            </div>
          ))}
      </main>

      {loading && (
        <div className={styles.loadingContainer}>
          <div className={styles.spinner}></div>
        </div>
      )}

      {!loading && photos.length === 0 && (
        <div className={styles.emptyState}>
          No photos yet. Upload one to get started.
        </div>
      )}

      {/* Detail View Modal */}
      <AnimatePresence>
        {selectedId && selectedPhoto && (
          <DetailView
            photo={selectedPhoto}
            onClose={() => {
              setSelectedId(null)
            }}
            onNext={() => {
              const currentIndex = filteredPhotos.findIndex(
                (p) => p.id === selectedId,
              )
              if (currentIndex < filteredPhotos.length - 1) {
                const nextPhoto = filteredPhotos[currentIndex + 1]
                if (!nextPhoto) return
                setSelectedId(nextPhoto.id)
              }
            }}
            onPrev={() => {
              const currentIndex = filteredPhotos.findIndex(
                (p) => p.id === selectedId,
              )
              if (currentIndex > 0) {
                const prevPhoto = filteredPhotos[currentIndex - 1]
                if (!prevPhoto) return
                setSelectedId(prevPhoto.id)
              }
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
