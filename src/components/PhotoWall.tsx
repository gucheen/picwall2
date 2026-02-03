import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
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
  const columns = Array.from({ length: numColumns }, () => [] as Photo[])
  photos.forEach((photo, index) => {
    columns[index % numColumns]!.push(photo)
  })

  if (loading)
    return (
      <div
        style={{
          color: '#fff',
          textAlign: 'center',
          marginTop: '20vh',
        }}
      >
        Loading...
      </div>
    )

  return (
    <div className={styles.container}>
      {/* Header / Upload */}
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <h1 className={styles.title}>PicWall</h1>
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
                  onClick={() => setSelectedId(photo.id)}
                />
              ))}
            </div>
          ))}
      </main>

      {photos.length === 0 && (
        <div className={styles.emptyState}>
          No photos yet. Upload one to get started.
        </div>
      )}

      {/* Detail View Modal */}
      <AnimatePresence>
        {selectedId && selectedPhoto && (
          <DetailView
            key={selectedId}
            photo={selectedPhoto}
            onClose={() => setSelectedId(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
