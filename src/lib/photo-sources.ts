import type { Photo } from '../../types/shared_types'

export function photoSrcSet(photo: Photo): string | undefined {
  if (!photo.thumbnailSrc || !photo.previewSrc || !photo.width || !photo.previewWidth) return undefined
  const thumbnailWidth = Math.min(600, photo.width)
  if (photo.previewWidth <= thumbnailWidth) return undefined
  return `${photo.thumbnailSrc} ${thumbnailWidth}w, ${photo.previewSrc} ${photo.previewWidth}w`
}

export function detailSource(photo: Photo): string {
  return photo.previewSrc || photo.thumbnailSrc || photo.src
}
