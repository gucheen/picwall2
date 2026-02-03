import sharp from 'sharp'
import ExifReader from 'exifreader'
import type { Photo, PhotoExif } from '../types/shared_types'
import { parse, format } from 'date-fns'
import { storage } from './storage'

async function generateThumbnailBuffer(originalBuffer: ArrayBuffer | Buffer): Promise<Buffer | ArrayBuffer> {
  try {
    return await sharp(originalBuffer)
      .rotate() // Auto-rotate based on EXIF
      .resize(600, null, { withoutEnlargement: true })
      .avif({ quality: 75 })
      .toBuffer()
  } catch (err) {
    console.error(`Failed to generate thumbnail`, err)
    // Fallback? If sharp fails, we might just return the original if small enough? 
    // Or throw. Let's return original buffer if resizing fails, hoping it's displayable.
    return originalBuffer
  }
}

async function getImageInfo(
  fileBuffer: ArrayBuffer | Buffer,
): Promise<{ exif: PhotoExif; width?: number; height?: number } | undefined> {
  try {
    const tags = ExifReader.load(fileBuffer)

    const exif: PhotoExif = {
      make: tags['Make']?.description,
      model: tags['Model']?.description,
      lens: tags['LensModel']?.description,
      iso: tags['ISOSpeedRatings']?.value
        ? Number(tags['ISOSpeedRatings']?.value)
        : undefined,
      aperture: tags['FNumber']?.description,
      shutter: tags['ExposureTime']?.description,
      focalLength: tags['FocalLength']?.description,
      // Priority: DateTimeOriginal -> DateTime -> CreateDate
      date:
        tags['DateTimeOriginal']?.description ||
        tags['DateTime']?.description ||
        tags['CreateDate']?.description,
    }

    let width = tags['Image Width']?.value
      ? Number(tags['Image Width']?.value)
      : undefined
    let height = tags['Image Height']?.value
      ? Number(tags['Image Height']?.value)
      : undefined

    // Check Orientation to swap width/height if needed
    // Orientation values 5, 6, 7, 8 imply 90 or 270 rotation
    // 6 = Rotate 90 CW, 8 = Rotate 270 CW
    const orientation = tags['Orientation']?.value
    if (width && height && orientation) {
      const o = Number(orientation)
      if (o >= 5 && o <= 8) {
        [width, height] = [height, width]
      }
    }

    return { exif, width, height }
  } catch (error) {
    console.error(`Error reading EXIF:`, error)
    return undefined
  }
}

export async function getPhotos(): Promise<Photo[]> {
  return await storage.list()
}

// Helper to process image data in a separate scope to allow GC of the input buffer
async function processImage(file: File) {
  const buffer = await file.arrayBuffer()
  const thumbnailBuffer = await generateThumbnailBuffer(buffer)
  const info = await getImageInfo(buffer)
  return { thumbnailBuffer, info }
}

export async function savePhoto(file: File): Promise<string> {
  const fileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_')

  // Process image properties (Thumbnail, EXIF) first.
  // The large 'buffer' used inside processImage will be garbage collected
  // after this awaits, as it's not returned or used subsequently.
  const { thumbnailBuffer, info } = await processImage(file)

  const newPhoto: Photo = {
    id: fileName,
    name: fileName,
    src: `/uploads/${fileName}`,
    thumbnailSrc: `/thumbnails/thumb_${fileName}.avif`,
    width: info?.width,
    height: info?.height,
    exif: info?.exif,
    date: info?.exif?.date
      ? format(
        parse(info.exif.date, 'yyyy:MM:dd HH:mm:ss', new Date()),
        'yyyy-MM-dd HH:mm:ss',
      )
      : undefined,
  }

  // Stream the file directly to storage/S3.
  // We do NOT have the large 'buffer' in scope here, preventing memory spikes.
  await storage.save(fileName, file, thumbnailBuffer, newPhoto)

  return fileName
}

export async function deletePhoto(id: string): Promise<boolean> {
  return await storage.delete(id)
}
