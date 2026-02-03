import { S3Client, S3File, BunFile } from 'bun'
import path from 'path'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import type { Photo } from '../types/shared_types'
import { compareDesc } from 'date-fns'

const dbPath = path.join(process.cwd(), 'data', 'photos_db.json')

export interface StorageAdapter {
    list(): Promise<Photo[]>
    save(filename: string, original: ArrayBuffer, thumbnail: ArrayBuffer, metadata: Photo): Promise<void>
    delete(id: string): Promise<boolean>
    get(filename: string, type: 'uploads' | 'thumbnails'): Promise<BunFile | S3File | null>
}

// --- Local Adapter ---
class LocalAdapter implements StorageAdapter {
    private uploadsDir = path.join(process.cwd(), 'public', 'uploads')
    private thumbnailsDir = path.join(process.cwd(), 'public', 'thumbnails')

    constructor() {
        this.ensureDirs()
    }

    private async ensureDirs() {
        if (!(await Bun.file(this.uploadsDir).exists())) {
            await mkdir(this.uploadsDir, { recursive: true })
        }
        if (!(await Bun.file(this.thumbnailsDir).exists())) {
            await mkdir(this.thumbnailsDir, { recursive: true })
        }
    }

    async list(): Promise<Photo[]> {
        // For Local, we re-scan directories to be robust
        // This requires re-reading EXIF which is slow, but consistent with original "Local" behavior
        // Ideally we'd optimize, but let's stick to correctness first.
        // To avoid circular dependency, we might need to pass an "ExifReader" or do it here.
        // Getting EXIF here duplicates logic from photos.ts. 
        // BETTER: photos.ts passes the "Read Info" function? Or LocalAdapter just returns filenames?
        // Architecture decision: Adapter returns Photo objects.
        // So LocalAdapter needs to be able to read EXIF.
        // Let's rely on cached db.json even for local? 
        // Original implementation did NOT have db.json.
        // Let's import the helper functions if needed, or better, implement a simpler list 
        // that relies on the caller to enrich? No, `getPhotos` expects `Photo[]`.

        // RE-IMPLEMENTING "Fast-enough" Local list:
        // We will try to read `photos_db.json` locally too! This unifies the architecture.
        // If `photos_db.json` missing, we can regenerate it (self-healing), but for now start empty or try to migrate.
        // MIGRATION: If we switch to Local with DB, we should probably scan once.
        // Let's use `photos_db.json` for Local too. It's much better.

        const dbFile = Bun.file(dbPath)
        if (await dbFile.exists()) {
            try {
                return await dbFile.json()
            } catch (e) {
                console.error("Local DB read error", e)
            }
        }
        return []
    }

    async save(filename: string, original: ArrayBuffer | Buffer, thumbnail: ArrayBuffer | Buffer, metadata: Photo): Promise<void> {
        await this.ensureDirs()
        await Bun.write(path.join(this.uploadsDir, filename), original)
        await Bun.write(path.join(this.thumbnailsDir, `thumb_${filename}.avif`), thumbnail)

        // Update DB
        const dbFile = Bun.file(dbPath)
        let photos: Photo[] = []
        if (await dbFile.exists()) {
            try { photos = await dbFile.json() } catch { }
        }
        photos.push(metadata)
        photos.sort((a, b) => a.date && b.date ? compareDesc(a.date, b.date) : 0)
        await Bun.write(dbPath, JSON.stringify(photos, null, 2))
    }

    async delete(id: string): Promise<boolean> {
        try {
            const original = path.join(this.uploadsDir, id)
            const thumb = path.join(this.thumbnailsDir, `thumb_${id}.avif`)

            if (await Bun.file(original).exists()) await unlink(original)
            if (await Bun.file(thumb).exists()) await unlink(thumb)

            // Update DB
            const dbFile = Bun.file(dbPath)
            if (await dbFile.exists()) {
                let photos = await dbFile.json() as Photo[]
                photos = photos.filter(p => p.id !== id)
                await Bun.write(dbPath, JSON.stringify(photos, null, 2))
            }
            return true
        } catch (e) {
            console.error("Local delete failed", e)
            return false
        }
    }

    async get(filename: string, type: 'uploads' | 'thumbnails'): Promise<BunFile | null> {
        const folder = type === 'uploads' ? this.uploadsDir : this.thumbnailsDir
        const file = Bun.file(path.join(folder, filename))
        return (await file.exists()) ? file : null
    }
}

// --- S3 Adapter ---
class S3Adapter implements StorageAdapter {
    private client: S3Client

    constructor() {
        this.client = new S3Client({
            accessKeyId: Bun.env.S3_ACCESS_KEY_ID,
            secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY,
            bucket: Bun.env.S3_BUCKET,
            endpoint: Bun.env.S3_ENDPOINT,
        })
    }

    async list(): Promise<Photo[]> {
        // Use local DB even for S3
        const dbFile = Bun.file(dbPath)
        if (await dbFile.exists()) {
            try {
                const data = await dbFile.json()
                return data.map(item => {
                    return {
                        ...item,
                        thumbnailSrc: new URL(item.thumbnailSrc, Bun.env.S3_CDN_URL!).toString(),
                        src: new URL(item.src, Bun.env.S3_CDN_URL!).toString(),
                    }
                })
            } catch (e) { console.error("Local DB read error (S3 mode)", e) }
        }
        return []
    }

    async save(filename: string, original: ArrayBuffer | Buffer, thumbnail: ArrayBuffer | Buffer, metadata: Photo): Promise<void> {
        await this.client.write(`uploads/${filename}`, original)
        await this.client.write(`thumbnails/thumb_${filename}.avif`, thumbnail)

        // Update Local DB
        const dbFile = Bun.file(dbPath)
        let photos: Photo[] = []
        if (await dbFile.exists()) {
            try { photos = await dbFile.json() } catch { }
        }
        photos.push(metadata)
        photos.sort((a, b) => a.date && b.date ? compareDesc(a.date, b.date) : 0)
        await Bun.write(dbPath, JSON.stringify(photos, null, 2))
    }

    async delete(id: string): Promise<boolean> {
        try {
            const original = this.client.file(`uploads/${id}`)
            const thumbAvif = this.client.file(`thumbnails/thumb_${id}.avif`)

            if (await original.exists()) await original.delete()
            if (await thumbAvif.exists()) await thumbAvif.delete()

            // Update Local DB
            const dbFile = Bun.file(dbPath)
            if (await dbFile.exists()) {
                let photos = await dbFile.json() as Photo[]
                photos = photos.filter(p => p.id !== id)
                await Bun.write(dbPath, JSON.stringify(photos, null, 2))
            }
            return true
        } catch (e) {
            console.error("S3 delete error", e)
            return false
        }
    }

    async get(filename: string, type: 'uploads' | 'thumbnails'): Promise<S3File | null> {
        const file = this.client.file(`${type}/${filename}`)
        return (await file.exists()) ? file : null
    }
}

// --- Factory ---
const type = Bun.env.STORAGE_TYPE === 's3' ? 's3' : 'local'
console.log(`Using Storage Adapter: ${type.toUpperCase()}`)

export const storage = type === 's3' ? new S3Adapter() : new LocalAdapter()
