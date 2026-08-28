import { useEffect, useRef, useState, useId } from 'react'
import { motion } from 'motion/react'
import type { Photo } from '../../types/shared_types'
import { loadOriginalImage } from '../lib/image-loader'
import { detailSource, photoSrcSet } from '../lib/photo-sources'
import styles from './DetailView.module.css'
import { locationLabel, photoMapUrl } from '../../types/photo-metadata'

interface DetailViewProps {
  photo: Photo
  onClose: () => void
  onNext: () => void
  onPrev: () => void
  hasPrevious?: boolean
  hasNext?: boolean
  navigationError?: string | null
}

export default function DetailView({
  photo,
  onClose,
  onNext,
  onPrev,
  hasPrevious = true,
  hasNext = true,
  navigationError,
}: DetailViewProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [imgSrc, setImgSrc] = useState(detailSource(photo))
  const [originalId, setOriginalId] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<number | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    setImgSrc(detailSource(photo))
    setOriginalId(null)
    setLoadProgress(null)
    setLoadError('')
  }, [photo.id, photo.src, photo.thumbnailSrc, photo.previewSrc])

  useEffect(() => {
    if (originalId === photo.id && imgSrc !== photo.src) {
      return loadOriginalImage(photo.src, setImgSrc, setLoadProgress, message => {
        setLoadError(message)
        setOriginalId(null)
      })
    }
  }, [originalId, photo.id, photo.src])

  useEffect(() => {
    const element = dialog.current!
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    return () => {
      element.close()
      document.body.style.overflow = previousOverflow
    }
  }, [])

  return (
    <motion.dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose() }}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key === 'ArrowRight') { event.preventDefault(); if (hasNext) onNext() }
        if (event.key === 'ArrowLeft') { event.preventDefault(); if (hasPrevious) onPrev() }
      }}
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
              aria-label="Close photo"
              autoFocus
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
              aria-label="Previous photo"
              disabled={!hasPrevious}
              onClick={(e) => {
                e.stopPropagation()
                onPrev()
              }}
            >
              ‹
            </button>
            <button
              className={styles.navButtonRight}
              aria-label="Next photo"
              disabled={!hasNext}
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
              alt={photo.title || photo.name}
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
            <h2 id={titleId} className={styles.title}>{photo.title || photo.name}</h2>

            <div className={styles.groupContainer}>
              {photo.location && <div className={styles.metaGroup}>
                <div className={styles.label}>Location</div>
                <div className={styles.value}>{locationLabel(photo.location)}</div>
                {photo.location.name && photo.location.latitude !== undefined && <p className={styles.coordinates}>
                  {photo.location.latitude}, {photo.location.longitude}
                </p>}
                <a className={styles.mapLink} href={photoMapUrl(photo.location)} target="_blank" rel="noopener noreferrer">
                  {photo.location.latitude !== undefined ? 'View on Google Maps' : 'Search on Google Maps'} ↗
                </a>
              </div>}
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

          <div className={styles.sidebarActions}>
            {navigationError && <p role="alert">{navigationError}. Use Next photo to retry.</p>}
            {loadError && <p role="alert">{loadError}</p>}
            {detailSource(photo) !== photo.src && originalId !== photo.id && (
              <button className={styles.actionButton} onClick={() => { setLoadError(''); setOriginalId(photo.id) }}>
                {loadError ? 'Retry original' : 'Load original'}
              </button>
            )}
            <a className={styles.actionButton} href={photo.src} target="_blank" rel="noreferrer">Open original</a>
            <button onClick={onClose} className={styles.actionButton}>
              Close View
            </button>
          </div>
        </motion.div>
      </div>
    </motion.dialog>
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
