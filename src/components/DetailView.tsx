import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './DetailView.module.css'

interface DetailViewProps {
  photo: Photo
  onClose: () => void
  onNext: () => void
  onPrev: () => void
}

const transitionSettings = {
  type: 'spring' as const,
  stiffness: 300,
  damping: 30
}

export default function DetailView({ photo, onClose, onNext, onPrev }: DetailViewProps) {
  /* New state for progressive loading */
  const [imgSrc, setImgSrc] = useState(photo.thumbnailSrc || photo.src)
  const [loadProgress, setLoadProgress] = useState<number | null>(null)

  // Reset img src when photo changes
  useEffect(() => {
    setImgSrc(photo.thumbnailSrc || photo.src)
    setLoadProgress(null)
  }, [photo.id])

  // Preload full image if we started with thumbnail
  useEffect(() => {
    if (photo.thumbnailSrc && imgSrc !== photo.src) {
        // ... (omitted similar logic, but ensuring it runs on new photo)
        // Since we reset imgSrc in the effect above, this effect logic needs to be robust.
        // Simplified loader for this change:
      const img = new Image()
      img.src = photo.src
      img.onload = () => {
          setImgSrc(photo.src)
          setLoadProgress(null)
      }
      // If we want progress we need xhr. Let's keep the XHR pattern but make sure it cleans up.
      
      const xhr = new XMLHttpRequest()
      xhr.open('GET', photo.src, true)
      xhr.responseType = 'blob'
      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          setLoadProgress(Math.round((event.loaded / event.total) * 100))
        }
      }
      xhr.onload = () => {
        if (xhr.status === 200) {
          const blobUrl = URL.createObjectURL(xhr.response)
          setImgSrc(blobUrl)
          setLoadProgress(null)
        }
      }
      xhr.send()
      return () => {
          xhr.abort()
          if (imgSrc.startsWith('blob:')) URL.revokeObjectURL(imgSrc)
      }
    }
  }, [photo.src, photo.id]) // Depend on ID to re-run

  // ... (Lock body scroll effect same as before) ...
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      if (imgSrc.startsWith('blob:')) URL.revokeObjectURL(imgSrc)
      document.body.style.overflow = 'auto'
    }
  }, [])

  // Keyboard navigation (Same as before)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') onNext()
      if (e.key === 'ArrowLeft') onPrev()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onNext, onPrev])

  return (
    <div className={styles.fixedOverlay} onClick={onClose}>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
        onClick={onClose}
        className={styles.backdrop}
      />

      <div className={styles.container}>
        {/* Main Image Container */}
        <div className={styles.imageArea}>
          <div
            className={styles.imageWrapper}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
             {/* Nav Handlers Overlay */}
            <button className={styles.navButtonLeft} onClick={(e) => { e.stopPropagation(); onPrev(); }}>
                ‹
            </button>
            <button className={styles.navButtonRight} onClick={(e) => { e.stopPropagation(); onNext(); }}>
                ›
            </button>
            
            {loadProgress !== null && (
              <div className={styles.progressOverlay}>
                <div className={styles.progressText}>{loadProgress}%</div>
              </div>
            )}
            
            <motion.img
              layoutId={`image-${photo.id}`}
              src={imgSrc}
              alt={photo.name}
              className={styles.image}
              width={photo.width}
              height={photo.height}
              transition={transitionSettings}
            />
          </div>
        </div>

        {/* Metadata Sidebar (Lightroom Style) */}
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{
            type: 'tween',
            ease: 'easeOut',
            duration: 0.3,
          }}
          className={styles.sidebar}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          <div className={styles.sidebarContent}>
            <h2 className={styles.title}>Info</h2>

            <div className={styles.groupContainer}>
              <MetaGroup
                label="Camera"
                value={photo.exif?.model || 'Unknown Camera'}
              />
              <MetaGroup
                label="Lens"
                value={photo.exif?.lens || 'Unknown Lens'}
              />

              <div className={styles.metaGrid}>
                <MetaGroup label="ISO" value={photo.exif?.iso?.toString()} />
                <MetaGroup label="Aperture" value={photo.exif?.aperture} />
                <MetaGroup label="Shutter" value={photo.exif?.shutter} />
                <MetaGroup
                  label="Focal Length"
                  value={photo.exif?.focalLength}
                />
              </div>

              <MetaGroup
                label="Date"
                value={photo.date ? photo.date : undefined}
              />
              <MetaGroup label="Filename" value={photo.name} />
              
              {photo.tags && photo.tags.length > 0 && (
                  <div className={styles.metaGroup}>
                      <div className={styles.label}>Tags</div>
                      <div className={styles.tagsWrapper}>
                          {photo.tags.map(tag => (
                              <a key={tag} href={`/?tag=${tag}`} className={styles.tagChip}>
                                  {tag}
                              </a>
                          ))}
                      </div>
                  </div>
              )}
            </div>
          </div>

          <button onClick={onClose} className={styles.closeButton}>
            Close View
          </button>
        </motion.div>
      </div>
    </div>
  )
}

function MetaGroup({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className={styles.metaGroup}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
    </div>
  )
}
