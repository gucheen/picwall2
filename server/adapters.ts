import { S3Client, type S3Options } from 'bun'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Photo, PhotoPage } from '../types/shared_types'
import type { PageOptions } from './pagination'
import { PhotoDatabase, type PhotoUpdate } from './database'

type ImageData = ArrayBuffer | Uint8Array | Blob
type FileKind = 'uploads' | 'thumbnails' | 'previews'

export interface StorageAdapter {
  list(): Promise<Photo[]>
  page(options: PageOptions): Promise<PhotoPage>
  save(filename: string, original: ImageData, thumbnail: ImageData, metadata: Photo, preview?: ImageData): Promise<void>
  delete(id: string): Promise<boolean>
  get(filename: string, type: FileKind): Promise<Response | null>
  update(id: string, partial: Partial<Photo>): Promise<void>
  updateMany(updates: PhotoUpdate[]): Promise<void>
}

export function isValidFilename(filename: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(filename) && !filename.includes('..')
}

function validateFilename(filename: string) {
  if (!isValidFilename(filename)) throw new Error('Invalid filename')
}

function thumbnailName(photo: Photo): string {
  // Existing rows keep their AVIF filenames; new uploads record their WebP path.
  const filename = photo.thumbnailSrc
    ? path.posix.basename(new URL(photo.thumbnailSrc, 'http://localhost').pathname)
    : `thumb_${photo.id}.avif`
  validateFilename(filename)
  return filename
}

function previewName(photo: Photo): string | undefined {
  if (!photo.previewSrc) return undefined
  const filename = path.posix.basename(new URL(photo.previewSrc, 'http://localhost').pathname)
  validateFilename(filename)
  return filename
}

function photoFiles(photo: Photo): [FileKind, string][] {
  const files: [FileKind, string][] = [['uploads', photo.id], ['thumbnails', thumbnailName(photo)]]
  const preview = previewName(photo)
  if (preview) files.push(['previews', preview])
  return files
}

abstract class MetadataAdapter {
  constructor(protected db: PhotoDatabase) {}

  async list(): Promise<Photo[]> {
    return this.db.list()
  }

  async page(options: PageOptions): Promise<PhotoPage> {
    return this.db.page(options)
  }

  async update(id: string, partial: Partial<Photo>) {
    this.db.updateMany([{ id, partial }])
  }

  async updateMany(updates: PhotoUpdate[]) {
    this.db.updateMany(updates)
  }
}

export class LocalAdapter extends MetadataAdapter implements StorageAdapter {
  constructor(db: PhotoDatabase, private directory = path.join(process.cwd(), 'files')) {
    super(db)
  }

  async save(filename: string, original: ImageData, thumbnail: ImageData, metadata: Photo, preview?: ImageData) {
    validateFilename(filename)
    const thumb = thumbnailName(metadata)
    const previewFile = previewName(metadata)
    if (previewFile && !preview) throw new Error('Preview bytes are required when recording a preview path')
    await mkdir(path.join(this.directory, 'uploads'), { recursive: true })
    await mkdir(path.join(this.directory, 'thumbnails'), { recursive: true })
    await Bun.write(path.join(this.directory, 'uploads', filename), original)
    await Bun.write(path.join(this.directory, 'thumbnails', thumb), thumbnail)
    if (previewFile && preview) {
      await mkdir(path.join(this.directory, 'previews'), { recursive: true })
      await Bun.write(path.join(this.directory, 'previews', previewFile), preview)
    }
    this.db.insert(metadata)
  }

  async delete(id: string): Promise<boolean> {
    validateFilename(id)
    const photo = this.db.get(id)
    if (!photo) return false
    try {
      for (const [kind, filename] of photoFiles(photo)) {
        const file = Bun.file(path.join(this.directory, kind, filename))
        if (await file.exists()) await file.delete()
      }
      return this.db.delete(id)
    } catch (error) {
      console.error('Delete failed', error)
      return false
    }
  }

  async get(filename: string, type: FileKind): Promise<Response | null> {
    validateFilename(filename)
    const file = Bun.file(path.join(this.directory, type, filename))
    return await file.exists() ? new Response(file) : null
  }
}

export class S3Adapter extends MetadataAdapter implements StorageAdapter {
  private client: S3Client

  constructor(db: PhotoDatabase, options: S3Options, private cdnUrl = '', private presignedReads = false) {
    super(db)
    this.client = new S3Client(options)
  }

  override async list(): Promise<Photo[]> {
    return this.withCdn(this.db.list())
  }

  override async page(options: PageOptions): Promise<PhotoPage> {
    const page = this.db.page(options)
    return { ...page, photos: this.withCdn(page.photos) }
  }

  private withCdn(photos: Photo[]): Photo[] {
    if (!this.cdnUrl) return photos
    return photos.map(photo => ({
      ...photo,
      src: new URL(photo.src, this.cdnUrl).toString(),
      thumbnailSrc: photo.thumbnailSrc ? new URL(photo.thumbnailSrc, this.cdnUrl).toString() : undefined,
      previewSrc: photo.previewSrc ? new URL(photo.previewSrc, this.cdnUrl).toString() : undefined,
    }))
  }

  async save(filename: string, original: ImageData, thumbnail: ImageData, metadata: Photo, preview?: ImageData) {
    validateFilename(filename)
    const thumb = thumbnailName(metadata)
    const previewFile = previewName(metadata)
    if (previewFile && !preview) throw new Error('Preview bytes are required when recording a preview path')
    await this.client.file(`uploads/${filename}`).write(original, {
      type: original instanceof Blob && original.type ? original.type : Bun.file(filename).type,
    })
    await this.client.file(`thumbnails/${thumb}`).write(thumbnail, { type: Bun.file(thumb).type })
    if (previewFile && preview) await this.client.file(`previews/${previewFile}`).write(preview, { type: 'image/webp' })
    this.db.insert(metadata)
  }

  async delete(id: string): Promise<boolean> {
    validateFilename(id)
    const photo = this.db.get(id)
    if (!photo) return false
    try {
      for (const [kind, filename] of photoFiles(photo)) await this.client.file(`${kind}/${filename}`).delete()
      return this.db.delete(id)
    } catch (error) {
      console.error('S3 delete failed', error)
      return false
    }
  }

  async get(filename: string, type: FileKind): Promise<Response | null> {
    validateFilename(filename)
    if (this.cdnUrl || this.presignedReads) {
      const location = this.cdnUrl
        ? new URL(`/${type}/${filename}`, this.cdnUrl).toString()
        : this.client.file(`${type}/${filename}`).presign({ expiresIn: 300, method: 'GET' })
      // Expiring signed URLs must never inherit the immutable image cache policy.
      return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'private, no-store' } })
    }
    const file = this.client.file(`${type}/${filename}`)
    if (!(await file.exists())) return null
    return new Response(file.stream(), { headers: { 'Content-Type': Bun.file(filename).type } })
  }
}
