import type { Photo } from '../types/shared_types'

export function photo(id = 'sample.png', extension = 'webp'): Photo {
  return { id, name: id, src: `/uploads/${id}`, thumbnailSrc: `/thumbnails/thumb_${id}.${extension}` }
}

export function bitmap(width: number, height: number): Buffer {
  const stride = Math.ceil(width * 3 / 4) * 4
  const bytes = Buffer.alloc(54 + stride * height)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(stride * height, 34)
  bytes.fill(128, 54)
  return bytes
}

export function withOrientation(jpeg: Uint8Array, orientation: number): Buffer {
  const exif = Buffer.alloc(36)
  exif.writeUInt16BE(0xffe1, 0)
  exif.writeUInt16BE(34, 2)
  exif.write('Exif\0\0', 4, 'binary')
  exif.write('II', 10)
  exif.writeUInt16LE(42, 12)
  exif.writeUInt32LE(8, 14)
  exif.writeUInt16LE(1, 18)
  exif.writeUInt16LE(0x112, 20)
  exif.writeUInt16LE(3, 22)
  exif.writeUInt32LE(1, 24)
  exif.writeUInt16LE(orientation, 28)
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)])
}
