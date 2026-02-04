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

export interface Photo {
  id: string
  src: string
  name: string
  width?: number
  height?: number
  exif?: PhotoExif
  date?: string
  thumbnailSrc?: string
  tags?: string[]
}
