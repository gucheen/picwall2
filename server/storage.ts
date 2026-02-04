import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import path from 'node:path'
import { mkdir, unlink, access, readFile, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import type { Photo } from '../types/shared_types.js'

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
    private db: Database.Database
    private uploadsDir = path.join(process.cwd(), 'files', 'uploads')
    private thumbnailsDir = path.join(process.cwd(), 'files', 'thumbnails')

    constructor() {
        this.ensureDirs()
        const dbDir = path.join(process.cwd(), 'data')
        this.db = new Database(path.join(dbDir, 'photos.db'))
        this.init()
    }

    private async ensureDirs() {
        if (!(await fileExists(this.uploadsDir))) {
            await mkdir(this.uploadsDir, { recursive: true })
        }
        if (!(await fileExists(this.thumbnailsDir))) {
            await mkdir(this.thumbnailsDir, { recursive: true })
        }
    }

    private init() {
        // Create table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                src TEXT NOT NULL,
                thumbnailSrc TEXT,
                width INTEGER,
                height INTEGER,
                date TEXT,
                exif TEXT, -- JSON string
                tags TEXT, -- JSON string
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `)

        // Migrate from JSON if empty
        const count = this.db.prepare('SELECT COUNT(*) as count FROM photos').get() as { count: number }
        if (count.count === 0) {
            this.migrateFromJson()
        }
    }

    private async migrateFromJson() {
        if (await fileExists(dbPath)) {
            try {
                const content = await readFile(dbPath, 'utf-8')
                const photos: Photo[] = JSON.parse(content)
                const insert = this.db.prepare(`
                    INSERT INTO photos (id, name, src, thumbnailSrc, width, height, date, exif, tags)
                    VALUES (@id, @name, @src, @thumbnailSrc, @width, @height, @date, @exif, @tags)
                `)

                const transaction = this.db.transaction((photos: Photo[]) => {
                    for (const photo of photos) {
                        insert.run({
                            id: photo.id,
                            name: photo.name,
                            src: photo.src,
                            thumbnailSrc: photo.thumbnailSrc,
                            width: photo.width,
                            height: photo.height,
                            date: photo.date,
                            exif: photo.exif ? JSON.stringify(photo.exif) : null,
                            tags: photo.tags ? JSON.stringify(photo.tags) : null
                        })
                    }
                })

                transaction(photos)
                console.log(`Migrated ${photos.length} photos from JSON to SQLite`)
            } catch (e) {
                console.error("Migration failed", e)
            }
        }
    }

    async list(): Promise<Photo[]> {
        const rows = this.db.prepare('SELECT * FROM photos ORDER BY date DESC, created_at DESC').all() as any[]
        return rows.map(this.mapRowToPhoto)
    }

    private mapRowToPhoto(row: any): Photo {
        return {
            id: row.id,
            name: row.name,
            src: row.src,
            thumbnailSrc: row.thumbnailSrc,
            width: row.width,
            height: row.height,
            date: row.date,
            exif: row.exif ? JSON.parse(row.exif) : undefined,
            tags: row.tags ? JSON.parse(row.tags) : undefined
        }
    }

    async save(filename: string, original: ArrayBuffer | Buffer | Blob, thumbnail: ArrayBuffer | Buffer, metadata: Photo): Promise<void> {
        await this.ensureDirs()

        // Write files
        // Convert Blob to Buffer if needed
        let originalBuf: Buffer | Uint8Array
        if (original instanceof Blob) {
            originalBuf = Buffer.from(await original.arrayBuffer())
        } else if (original instanceof ArrayBuffer) {
           originalBuf = Buffer.from(original)
        } else {
            originalBuf = original
        }

        const thumbnailBuf = Buffer.isBuffer(thumbnail) ? thumbnail : Buffer.from(thumbnail)

        await writeFile(path.join(this.uploadsDir, filename), originalBuf)
        await writeFile(path.join(this.thumbnailsDir, `thumb_${filename}.avif`), thumbnailBuf)

        // Insert DB
        const stmt = this.db.prepare(`
            INSERT INTO photos (id, name, src, thumbnailSrc, width, height, date, exif, tags)
            VALUES (@id, @name, @src, @thumbnailSrc, @width, @height, @date, @exif, @tags)
        `)

        stmt.run({
            id: metadata.id,
            name: metadata.name,
            src: metadata.src,
            thumbnailSrc: metadata.thumbnailSrc,
            width: metadata.width,
            height: metadata.height,
            date: metadata.date,
            exif: metadata.exif ? JSON.stringify(metadata.exif) : null,
            tags: metadata.tags ? JSON.stringify(metadata.tags) : null
        })
    }

    async delete(id: string): Promise<boolean> {
        try {
            const original = path.join(this.uploadsDir, id)
            const thumb = path.join(this.thumbnailsDir, `thumb_${id}.avif`)

            if (await fileExists(original)) await unlink(original)
            if (await fileExists(thumb)) await unlink(thumb)

            const info = this.db.prepare('DELETE FROM photos WHERE id = ?').run(id)
            return info.changes > 0
        } catch (e) {
            console.error("Delete failed", e)
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
        const transaction = this.db.transaction((updates) => {
            for (const { id, partial } of updates) {
                // Dynamically build update query
                const keys = Object.keys(partial)
                if (keys.length === 0) continue

                const setClause = keys.map(k => `${k} = @${k}`).join(', ')
                const stmt = this.db.prepare(`UPDATE photos SET ${setClause} WHERE id = @id`)
                
                const params: any = { id }
                for (const k of keys) {
                    const val = (partial as any)[k]
                    if (k === 'exif' || k === 'tags') {
                        params[k] = val ? JSON.stringify(val) : null
                    } else {
                        params[k] = val
                    }
                }
                stmt.run(params)
            }
        })
        transaction(updates)
    }
}
class S3Adapter implements StorageAdapter {
    private client: S3Client
    private bucket: string
    private endpoint: string
    private cdnUrl: string
    private db: Database.Database

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

        // Initialize SQLite DB (shared with local adapter logic for consistency)
        const dbDir = path.join(process.cwd(), 'data')
        this.db = new Database(path.join(dbDir, 'photos.db'))
        this.init()
    }

    private init() {
        // Create table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                src TEXT NOT NULL,
                thumbnailSrc TEXT,
                width INTEGER,
                height INTEGER,
                date TEXT,
                exif TEXT, -- JSON string
                tags TEXT, -- JSON string
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `)

        // Migrate from JSON if empty
        const count = this.db.prepare('SELECT COUNT(*) as count FROM photos').get() as { count: number }
        if (count.count === 0) {
            this.migrateFromJson()
        }
    }

    private async migrateFromJson() {
        if (await fileExists(dbPath)) {
            try {
                const content = await readFile(dbPath, 'utf-8')
                const photos: Photo[] = JSON.parse(content)
                const insert = this.db.prepare(`
                    INSERT INTO photos (id, name, src, thumbnailSrc, width, height, date, exif, tags)
                    VALUES (@id, @name, @src, @thumbnailSrc, @width, @height, @date, @exif, @tags)
                `)

                const transaction = this.db.transaction((photos: Photo[]) => {
                    for (const photo of photos) {
                        insert.run({
                            id: photo.id,
                            name: photo.name,
                            src: photo.src,
                            thumbnailSrc: photo.thumbnailSrc,
                            width: photo.width,
                            height: photo.height,
                            date: photo.date,
                            exif: photo.exif ? JSON.stringify(photo.exif) : null,
                            tags: photo.tags ? JSON.stringify(photo.tags) : null
                        })
                    }
                })

                transaction(photos)
                console.log(`Migrated ${photos.length} photos from JSON to SQLite (S3 Mode)`)
            } catch (e) {
                console.error("Migration failed", e)
            }
        }
    }

    async list(): Promise<Photo[]> {
        const rows = this.db.prepare('SELECT * FROM photos ORDER BY date DESC, created_at DESC').all() as any[]
        const photos = rows.map(this.mapRowToPhoto)

        if (this.cdnUrl) {
            const base = this.cdnUrl!;
            return photos.map(item => ({
                ...item,
                thumbnailSrc: item.thumbnailSrc ? new URL(item.thumbnailSrc, base).toString() : undefined,
                src: new URL(item.src, base).toString(),
            }))
        }
        return photos
    }

    private mapRowToPhoto(row: any): Photo {
        return {
            id: row.id,
            name: row.name,
            src: row.src,
            thumbnailSrc: row.thumbnailSrc,
            width: row.width,
            height: row.height,
            date: row.date,
            exif: row.exif ? JSON.parse(row.exif) : undefined,
            tags: row.tags ? JSON.parse(row.tags) : undefined
        }
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

        // Insert DB
        const stmt = this.db.prepare(`
            INSERT INTO photos (id, name, src, thumbnailSrc, width, height, date, exif, tags)
            VALUES (@id, @name, @src, @thumbnailSrc, @width, @height, @date, @exif, @tags)
        `)

        stmt.run({
            id: metadata.id,
            name: metadata.name,
            src: metadata.src,
            thumbnailSrc: metadata.thumbnailSrc,
            width: metadata.width,
            height: metadata.height,
            date: metadata.date,
            exif: metadata.exif ? JSON.stringify(metadata.exif) : null,
            tags: metadata.tags ? JSON.stringify(metadata.tags) : null
        })
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

            const info = this.db.prepare('DELETE FROM photos WHERE id = ?').run(id)
            return info.changes > 0
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
        const transaction = this.db.transaction((updates) => {
            for (const { id, partial } of updates) {
                // Dynamically build update query
                const keys = Object.keys(partial)
                if (keys.length === 0) continue

                const setClause = keys.map(k => `${k} = @${k}`).join(', ')
                const stmt = this.db.prepare(`UPDATE photos SET ${setClause} WHERE id = @id`)
                
                const params: any = { id }
                for (const k of keys) {
                    const val = (partial as any)[k]
                    if (k === 'exif' || k === 'tags') {
                        params[k] = val ? JSON.stringify(val) : null
                    } else {
                        params[k] = val
                    }
                }
                stmt.run(params)
            }
        })
        transaction(updates)
    }
}

// --- Factory ---
const type = process.env.STORAGE_TYPE === 's3' ? 's3' : 'local'
console.log(`Using Storage Adapter: ${type.toUpperCase()}`)

export const storage = type === 's3' ? new S3Adapter() : new LocalAdapter()
