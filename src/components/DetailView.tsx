import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { Photo } from '../../types/shared_types'
import { loadOriginalImage } from '../lib/image-loader'
import { detailSource, photoSrcSet } from '../lib/photo-sources'
import styles from './DetailView.module.css'

interface DetailViewProps {
  photo: Photo
  onClose: () => void
  onNext: () => void
  onPrev: () => void
}

export default function DetailView({
  photo,
  onClose,
  onNext,
  onPrev,
}: DetailViewProps) {
  const [imgSrc, setImgSrc] = useState(detailSource(photo))
  const [originalId, setOriginalId] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<number | null>(null)

  useEffect(() => {
    setImgSrc(detailSource(photo))
    setOriginalId(null)
    setLoadProgress(null)
  }, [photo.id, photo.src, photo.thumbnailSrc, photo.previewSrc])

  useEffect(() => {
    if (originalId === photo.id && imgSrc !== photo.src) {
      return loadOriginalImage(photo.src, setImgSrc, setLoadProgress)
    }
  }, [originalId, photo.id, photo.src])

  // Lock body scroll
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  // Keyboard navigation
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
    <motion.div
      className={styles.fixedOverlay}
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Backdrop */}
      <div className={styles.backdrop} onClick={onClose} />

      <div className={styles.container}>
        {/* Main Image Container */}
        <div className={styles.imageArea}>
          <div
            className={styles.imageWrapper}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {/* Close Button Overlay */}
            <button
              className={styles.imageCloseButton}
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
            >
              ×
            </button>
            {/* Nav Handlers Overlay */}
            <button
              className={styles.navButtonLeft}
              onClick={(e) => {
                e.stopPropagation()
                onPrev()
              }}
            >
              ‹
            </button>
            <button
              className={styles.navButtonRight}
              onClick={(e) => {
                e.stopPropagation()
                onNext()
              }}
            >
              ›
            </button>

            {loadProgress !== null && (
              <div className={styles.progressOverlay}>
                <div className={styles.progressText}>{loadProgress}%</div>
              </div>
            )}

            <img
              src={imgSrc}
              srcSet={originalId === photo.id ? undefined : photoSrcSet(photo)}
              sizes="(min-width: 768px) calc(100vw - 384px), calc(100vw - 32px)"
              decoding="async"
              alt={photo.name}
              className={styles.image}
              width={photo.width}
              height={photo.height}
            />
          </div>
        </div>

        {/* Metadata Sidebar */}
        <motion.div
          className={styles.sidebar}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{
            type: 'tween',
            duration: 0.16,
            ease: 'easeOut',
            delay: 0.3,
          }}
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
                    {photo.tags.map((tag) => (
                      <a
                        key={tag}
                        href={`/?tag=${encodeURIComponent(tag)}`}
                        className={styles.tagChip}
                      >
                        {tag}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {detailSource(photo) !== photo.src && originalId !== photo.id && (
            <button className={styles.closeButton} onClick={() => setOriginalId(photo.id)}>
              Load original
            </button>
          )}
          <a className={styles.closeButton} href={photo.src} target="_blank" rel="noreferrer">Open original</a>
          <button onClick={onClose} className={styles.closeButton}>
            Close View
          </button>
        </motion.div>
      </div>
    </motion.div>
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
