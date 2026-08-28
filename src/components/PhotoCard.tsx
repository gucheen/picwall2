import { memo } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './PhotoCard.module.css'
import { motion } from 'motion/react'
import { photoSrcSet } from '../lib/photo-sources'
import { locationLabel } from '../../types/photo-metadata'

interface PhotoCardProps {
  photo: Photo
  onClick: (photo: Photo) => void
}

const PhotoCard = memo(function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const aspectRatio =
    photo.width && photo.height ? `${photo.width} / ${photo.height}` : '1 / 1'

  const displaySrc = photo.thumbnailSrc || photo.src

  return (
    <div
      id={`photo-card-${photo.id}`}
      className={styles.card}
      onClick={() => onClick(photo)}
      style={{ aspectRatio }}
    >
      <motion.img
        src={displaySrc}
        srcSet={photoSrcSet(photo)}
        sizes="(min-width: 1600px) 380px, (min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
        decoding="async"
        alt={photo.title || photo.name}
        className={styles.image}
        loading="lazy"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
      />

      <div className={`${styles.overlay} ${photo.title || photo.location ? styles.hasCaption : ''}`}>
        {photo.title && <p className={styles.title}>{photo.title}</p>}
        {photo.location && <p className={styles.location}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" />
          </svg>
          <span>{locationLabel(photo.location)}</span>
        </p>}
        <p className={styles.info}>
          {photo.date ? photo.date : 'Unknown Date'}
          {photo.exif?.model && ` • ${photo.exif.model}`}
        </p>
      </div>
    </div>
  )
})

export default PhotoCard
