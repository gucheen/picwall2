import ExifReader from 'exifreader'
import type { PhotoExif } from '../types/shared_types'
import { imageMaxPixels } from './image-settings'
import { recipe } from './library/model'

export class InvalidImageError extends Error {}

export async function inspectImage(buffer: ArrayBuffer | Uint8Array, maxPixels = imageMaxPixels) {
  try {
    const dimensions = await new Bun.Image(buffer, { autoOrient: true, maxPixels }).metadata()
    if (!Number.isSafeInteger(dimensions.width) || dimensions.width < 1
      || !Number.isSafeInteger(dimensions.height) || dimensions.height < 1
      || dimensions.width * dimensions.height > maxPixels) throw new Error('Invalid dimensions')
    const info = dimensions.format === 'bmp' || dimensions.format === 'gif' ? undefined : await getImageInfo(buffer)
    return {
      mime: dimensions.format === 'jpeg' ? 'image/jpeg' : 'image/' + dimensions.format,
      width: info?.width ?? dimensions.width,
      height: info?.height ?? dimensions.height,
      exif: info?.exif,
    }
  } catch (cause) {
    throw new InvalidImageError(`Invalid, unsupported or oversized image. Use a supported image within ${maxPixels} pixels.`, { cause })
  }
}

export async function processImage(buffer: ArrayBuffer | Uint8Array, maxPixels = imageMaxPixels) {
  let thumbnailBuffer: Uint8Array
  let previewBuffer: Uint8Array
  let previewWidth: number
  let previewHeight: number
  let dimensions: Bun.Image.Metadata
  let thumbnailWidth: number
  let thumbnailHeight: number
  try {
    const image = new Bun.Image(buffer, { autoOrient: true, maxPixels })
    dimensions = await image.metadata()
    const thumbnail = image.resize(recipe.thumbnailWidth, undefined, { withoutEnlargement: true, filter: 'lanczos3' })
      .webp({ quality: recipe.thumbnailQuality })
    thumbnailBuffer = await thumbnail.bytes()
    thumbnailWidth = thumbnail.width
    thumbnailHeight = thumbnail.height
    const preview = new Bun.Image(buffer, { autoOrient: true, maxPixels })
      .resize(recipe.previewSize, recipe.previewSize, { fit: 'inside', withoutEnlargement: true, filter: 'lanczos3' })
      .webp({ quality: recipe.previewQuality })
    previewBuffer = await preview.bytes()
    previewWidth = preview.width
    previewHeight = preview.height
  } catch (cause) {
    throw new InvalidImageError(`Invalid, unsupported or oversized image. Use JPEG, PNG, WebP, GIF or BMP within ${maxPixels} pixels.`, { cause })
  }
  const info = dimensions.format === 'bmp' || dimensions.format === 'gif' ? undefined : await getImageInfo(buffer)
  return {
    thumbnailBuffer,
    thumbnailWidth,
    thumbnailHeight,
    previewBuffer,
    previewWidth,
    previewHeight,
    info: {
      exif: info?.exif,
      width: info?.width ?? dimensions.width,
      height: info?.height ?? dimensions.height,
    },
  }
}

async function getImageInfo(
  fileBuffer: ArrayBuffer | Uint8Array,
): Promise<{ exif: PhotoExif; width?: number; height?: number } | undefined> {
  try {
    const tags = ExifReader.load(fileBuffer instanceof Uint8Array ? Buffer.from(fileBuffer) : fileBuffer)

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
