export interface PhotoExif {
  make?: string
  model?: string
  lens?: string
  iso?: number
  aperture?: string
  shutter?: string
  focalLength?: string
  date?: string
}

export interface PhotoLocation {
  name?: string
  latitude?: number
  longitude?: number
}

export interface Photo {
  id: string
  src: string
  name: string
  title?: string | null
  location?: PhotoLocation | null
  width?: number
  height?: number
  exif?: PhotoExif
  date?: string
  thumbnailSrc?: string
  previewSrc?: string
  previewWidth?: number
  previewHeight?: number
  tags?: string[]
}

export interface PhotoPage {
  photos: Photo[]
  nextCursor: string | null
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

export type TrashedPhoto = Photo & { deleted_at: number }
export interface ImageJob {
  asset_hash: string
  recipe: string
  status: 'pending' | 'running' | 'failed' | 'complete'
  attempts: number
  error: string | null
  updated_at: number
}

export interface JobPage extends CursorPage<ImageJob> {
  counts: Record<ImageJob['status'], number>
  photoVersion: string
}
