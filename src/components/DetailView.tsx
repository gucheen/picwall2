import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './DetailView.module.css'

interface DetailViewProps {
  photo: Photo
  onClose: () => void
}

export default function DetailView({ photo, onClose }: DetailViewProps) {
  /* New state for progressive loading */
  const [imgSrc, setImgSrc] = useState(photo.thumbnailSrc || photo.src)
  const [loadProgress, setLoadProgress] = useState<number | null>(null)

  // Preload full image if we started with thumbnail
  useEffect(() => {
    if (photo.thumbnailSrc && imgSrc !== photo.src) {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', photo.src, true)
      xhr.responseType = 'blob'

      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          const percentComplete = Math.round((event.loaded / event.total) * 100)
          setLoadProgress(percentComplete)
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
        if (imgSrc.startsWith('blob:')) {
          URL.revokeObjectURL(imgSrc)
        }
      }
    }
  }, [photo.src, photo.thumbnailSrc /* imgSrc omitted to avoid re-triggering unnecessary logic, though safe */])

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      // Cleanup blob URL if it exists when unmounting
      if (imgSrc.startsWith('blob:')) {
        URL.revokeObjectURL(imgSrc)
      }
      document.body.style.overflow = 'auto'
    }
  }, [])

  return (
    <div className={styles.fixedOverlay}>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
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
