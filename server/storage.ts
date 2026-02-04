import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import path from 'node:path'
import { mkdir, unlink, access, stat, readFile, writeFile } from 'node:fs/promises'
import type { Photo } from '../types/shared_types.js'
import { compareDesc } from 'date-fns'

const dbPath = path.join(process.cwd(), 'data', 'photos_db.json')

// Helper to check file existence
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath)
        return true
    } catch {
        return false
    }
}

export interface StorageAdapter {
    list(): Promise<Photo[]>
    save(filename: string, original: ArrayBuffer | Buffer | Blob, thumbnail: ArrayBuffer | Buffer, metadata: Photo): Promise<void>
    delete(id: string): Promise<boolean>
    get(filename: string, type: 'uploads' | 'thumbnails'): Promise<Buffer | ReadableStream | null> // Return compatible with Response body
    get(filename: string, type: 'uploads' | 'thumbnails'): Promise<Buffer | ReadableStream | null> // Return compatible with Response body
    update(id: string, partial: Partial<Photo>): Promise<void>
    updateMany(updates: { id: string, partial: Partial<Photo> }[]): Promise<void>
}

// --- Local Adapter ---
class LocalAdapter implements StorageAdapter {
    private uploadsDir = path.join(process.cwd(), 'files', 'uploads')
    private thumbnailsDir = path.join(process.cwd(), 'files', 'thumbnails')

    constructor() {
        this.ensureDirs()
    }

    private async ensureDirs() {
        if (!(await fileExists(this.uploadsDir))) {
            await mkdir(this.uploadsDir, { recursive: true })
        }
        if (!(await fileExists(this.thumbnailsDir))) {
            await mkdir(this.thumbnailsDir, { recursive: true })
        }
    }

    async list(): Promise<Photo[]> {
        if (await fileExists(dbPath)) {
            try {
                const content = await readFile(dbPath, 'utf-8')
                return JSON.parse(content)
            } catch (e) {
                console.error("Local DB read error", e)
            }
        }
        return []
    }

    async save(filename: string, original: ArrayBuffer | Buffer | Blob, thumbnail: ArrayBuffer | Buffer, metadata: Photo): Promise<void> {
        await this.ensureDirs()
        
        // Convert Blob to Buffer if needed
        let originalBuf: Buffer | Uint8Array
        if (original instanceof Blob) {
            originalBuf = Buffer.from(await original.arrayBuffer())
        } else if (original instanceof ArrayBuffer) {
           originalBuf = Buffer.from(original)
        } else {
            originalBuf = original
        }

        // Ensure thumbnail is Buffer
        const thumbnailBuf = Buffer.isBuffer(thumbnail) ? thumbnail : Buffer.from(thumbnail)

        await writeFile(path.join(this.uploadsDir, filename), originalBuf)
        await writeFile(path.join(this.thumbnailsDir, `thumb_${filename}.avif`), thumbnailBuf)

        // Update DB
        let photos: Photo[] = await this.list()
        photos.push(metadata)
        photos.sort((a, b) => a.date && b.date ? compareDesc(a.date, b.date) : 0)
        await writeFile(dbPath, JSON.stringify(photos, null, 2))
    }

    async delete(id: string): Promise<boolean> {
        try {
            const original = path.join(this.uploadsDir, id)
            const thumb = path.join(this.thumbnailsDir, `thumb_${id}.avif`)

            if (await fileExists(original)) await unlink(original)
            if (await fileExists(thumb)) await unlink(thumb)

            // Update DB
            let photos = await this.list()
            photos = photos.filter(p => p.id !== id)
            await writeFile(dbPath, JSON.stringify(photos, null, 2))
            
            return true
        } catch (e) {
            console.error("Local delete failed", e)
            return false
        }
    }

    async get(filename: string, type: 'uploads' | 'thumbnails'): Promise<Buffer | null> {
        const folder = type === 'uploads' ? this.uploadsDir : this.thumbnailsDir
        const filePath = path.join(folder, filename)
        if (await fileExists(filePath)) {
            return await readFile(filePath)
        }
        return null
    }

    async update(id: string, partial: Partial<Photo>): Promise<void> {
        return this.updateMany([{ id, partial }])
    }

    async updateMany(updates: { id: string, partial: Partial<Photo> }[]): Promise<void> {
        if (await fileExists(dbPath)) {
            try {
                let photos: Photo[] = JSON.parse(await readFile(dbPath, 'utf-8'))
                let hasChanges = false

                updates.forEach(({ id, partial }) => {
                    const index = photos.findIndex(p => p.id === id)
                    if (index !== -1) {
                        photos[index] = { ...photos[index], ...partial } as Photo
                        hasChanges = true
                    }
                })

                if (hasChanges) {
                    await writeFile(dbPath, JSON.stringify(photos, null, 2))
                }
            } catch (e) {
                console.error("Local DB update error", e)
            }
        }
    }
}

// --- S3 Adapter ---
class S3Adapter implements StorageAdapter {
    private client: S3Client
    private bucket: string
    private endpoint: string
    private cdnUrl: string

    constructor() {
        this.client = new S3Client({
            region: 'auto', // Cloudflare R2 or Generic S3 often needs a region
            endpoint: process.env.S3_ENDPOINT,
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY_ID!,
                secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
            }
        })
        this.bucket = process.env.S3_BUCKET!
        this.endpoint = process.env.S3_ENDPOINT!
        this.cdnUrl = process.env.S3_CDN_URL ?? ''
    }

    async list(): Promise<Photo[]> {
        // Use local DB even for S3
        if (await fileExists(dbPath)) {
            try {
                const content = await readFile(dbPath, 'utf-8')
                const data = JSON.parse(content)
                return data.map((item: Photo) => {
                    if (this.cdnUrl) {
                        const base = this.cdnUrl!;
                         return {
                            ...item,
                            thumbnailSrc: item.thumbnailSrc ? new URL(item.thumbnailSrc, base).toString() : undefined,
                            src: new URL(item.src, base).toString(),
                        }
                    }
                    return item
                })
            } catch (e) { console.error("Local DB read error (S3 mode)", e) }
        }
        return []
    }

    async save(filename: string, original: ArrayBuffer | Buffer | Blob, thumbnail: ArrayBuffer | Buffer, metadata: Photo): Promise<void> {
        // Convert Blob to Buffer/Uint8Array for upload
        let body: Buffer | Uint8Array
        if (original instanceof Blob) {
             body = Buffer.from(await original.arrayBuffer())
        } else if (original instanceof ArrayBuffer) {
             body = Buffer.from(original)
        } else {
             body = original
        }

        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: `uploads/${filename}`,
            Body: body,
            ContentType: 'image/jpeg' // Or detect mime type?
        }))

        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: `thumbnails/thumb_${filename}.avif`,
            Body: Buffer.isBuffer(thumbnail) ? thumbnail : Buffer.from(thumbnail),
            ContentType: 'image/avif'
        }))

        // Update Local DB
        let photos: Photo[] = []
        if (await fileExists(dbPath)) {
            try { photos = JSON.parse(await readFile(dbPath, 'utf-8')) } catch { }
        }
        photos.push(metadata)
        photos.sort((a, b) => a.date && b.date ? compareDesc(a.date, b.date) : 0)
        await writeFile(dbPath, JSON.stringify(photos, null, 2))
    }

    async delete(id: string): Promise<boolean> {
        try {
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: `uploads/${id}`
            }))
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: `thumbnails/thumb_${id}.avif`
            }))

            // Update Local DB
            if (await fileExists(dbPath)) {
                let photos = JSON.parse(await readFile(dbPath, 'utf-8')) as Photo[]
                photos = photos.filter(p => p.id !== id)
                await writeFile(dbPath, JSON.stringify(photos, null, 2))
            }
            return true
        } catch (e) {
            console.error("S3 delete error", e)
            return false
        }
    }

    async get(filename: string, type: 'uploads' | 'thumbnails'): Promise<ReadableStream | null> {
         try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: `${type}/${filename}`
            })
            const response = await this.client.send(command)
            // response.Body is a stream in Node.js
            return response.Body as unknown as ReadableStream
         } catch (e) {
             return null
         }
    }

    async update(id: string, partial: Partial<Photo>): Promise<void> {
        return this.updateMany([{ id, partial }])
    }

    async updateMany(updates: { id: string, partial: Partial<Photo> }[]): Promise<void> {
        if (await fileExists(dbPath)) {
            try {
                let photos: Photo[] = JSON.parse(await readFile(dbPath, 'utf-8'))
                let hasChanges = false

                updates.forEach(({ id, partial }) => {
                    const index = photos.findIndex(p => p.id === id)
                    if (index !== -1) {
                        photos[index] = { ...photos[index], ...partial } as Photo
                        hasChanges = true
                    }
                })

                if (hasChanges) {
                    await writeFile(dbPath, JSON.stringify(photos, null, 2))
                }
            } catch (e) {
                console.error("S3 DB update error", e)
            }
        }
    }
}

// --- Factory ---
const type = process.env.STORAGE_TYPE === 's3' ? 's3' : 'local'
console.log(`Using Storage Adapter: ${type.toUpperCase()}`)

export const storage = type === 's3' ? new S3Adapter() : new LocalAdapter()
