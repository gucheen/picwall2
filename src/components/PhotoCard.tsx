import { memo } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './PhotoCard.module.css'
import { motion } from 'motion/react'

interface PhotoCardProps {
  photo: Photo
  onClick: (photo: Photo) => void
}

const PhotoCard = memo(function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const aspectRatio =
    photo.width && photo.height ? `${photo.width} / ${photo.height}` : undefined

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
        alt={photo.name}
        className={styles.image}
        loading="lazy"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
      />

      <div className={styles.overlay}>
        <p className={styles.info}>
          {photo.date ? photo.date : 'Unknown Date'}
          {photo.exif?.model && ` • ${photo.exif.model}`}
        </p>
      </div>
    </div>
  )
})

export default PhotoCard
