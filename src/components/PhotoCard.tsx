import { memo } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './PhotoCard.module.css'
import { motion } from 'motion/react'
import { photoSrcSet } from '../lib/photo-sources'

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
