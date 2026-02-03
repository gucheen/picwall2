import { motion } from 'framer-motion'
import type { Photo } from '../../types/shared_types'
import styles from './PhotoCard.module.css'

interface PhotoCardProps {
  photo: Photo
  onClick: (photo: Photo) => void
}

export default function PhotoCard({ photo, onClick }: PhotoCardProps) {
  const aspectRatio =
    photo.width && photo.height ? `${photo.width} / ${photo.height}` : undefined

  const displaySrc = photo.thumbnailSrc || photo.src

  return (
    <div
      className={`${styles.card} group`} /* Added group manually for legacy support or just in case, though modules handle hover via selector */
      onClick={() => onClick(photo)}
      style={{ aspectRatio }}
    >
      {/* <motion.img> supports layoutId for shared element transitions */}
      <motion.img
        layoutId={`image-${photo.id}`}
        src={displaySrc}
        alt={photo.name}
        className={styles.image}
        viewport={{ once: true }}
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        loading='lazy'
      />

      <div className={styles.overlay}>
        <p className={styles.info}>
          {photo.date ? photo.date : 'Unknown Date'}
          {photo.exif?.model && ` • ${photo.exif.model}`}
        </p>
      </div>
    </div>
  )
}
