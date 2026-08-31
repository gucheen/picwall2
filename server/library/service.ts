import { inspectImage, processImage } from '../image'
import { imageConcurrency } from '../image-settings'
import { Catalog, validateMetadata, type Job, type Metadata } from './catalog'
import { originalKey, recipeId, sha256, validKey, type Asset, type Variant, variantKey } from './model'
import type { ObjectStore } from './objects'

export class ImportConflictError extends Error {}

export class Library {
  readonly catalog: Catalog
  private draining?: Promise<void>
  private wakeDrain?: () => void
  private recovering?: Promise<void>
  private rebuilding?: Promise<void>
  private closing?: Promise<void>
  private operations = new Set<Promise<string>>()
  private repair = new Set<string>()

  constructor(readonly root: string, readonly objects: ObjectStore) {
    this.catalog = new Catalog(root, objects.identity, key => objects.publicUrl?.(key) ?? '/media/' + key)
  }

  ingest(bytes: ArrayBuffer | Uint8Array, metadata: Metadata, source?: string, waitForProcessing = true): Promise<string> {
    if (this.closing) return Promise.reject(new Error('Library is closing'))
    const operation = this.ingestPhoto(bytes, metadata, source, waitForProcessing)
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  private async ingestPhoto(input: ArrayBuffer | Uint8Array, metadata: Metadata, source: string | undefined, waitForProcessing: boolean) {
    validateMetadata(metadata)
    if (source !== undefined && (!source || typeof source !== 'string')) throw new Error('Invalid import source')
    const bytes = new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input))
    const hash = sha256(bytes)
    const previous = source ? this.catalog.source(source) : null
    if (previous) {
      if (previous.hash !== hash) throw new ImportConflictError('Import source changed: ' + source)
      this.retryIncomplete(hash)
      await this.startProcessing(waitForProcessing)
      return previous.photo_id
    }
    const info = await inspectImage(bytes)
    const asset: Asset = { hash, original_key: originalKey(hash), mime: info.mime, bytes: bytes.byteLength,
      width: info.width, height: info.height, active_recipe: null, created_at: Date.now() }
    await this.objects.put(asset.original_key, bytes, asset.mime)
    const raced = source ? this.catalog.source(source) : null
    if (raced) {
      if (raced.hash !== hash) throw new ImportConflictError('Import source changed: ' + source)
      this.retryIncomplete(hash)
      await this.startProcessing(waitForProcessing)
      return raced.photo_id
    }
    const id = this.catalog.add(asset, metadata.preserveMetadata ? metadata : {
      ...metadata, exif: metadata.exif ?? info.exif, date: metadata.date ?? exifDate(info.exif?.date),
    }, recipeId, source)
    await this.startProcessing(waitForProcessing)
    return id
  }

  recover(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Library is closing'))
    if (this.recovering) return this.recovering
    const rebuilding = this.rebuilding
    this.recovering = (async () => {
      await rebuilding
      // A running worker must finish before abandoned jobs can be reset safely.
      while (this.draining) await this.draining
      this.catalog.db.transaction(() => {
        this.catalog.db.query("UPDATE jobs SET status='failed',error='Recipe is no longer available',updated_at=? WHERE recipe!=? AND status IN ('pending','running')")
          .run(Date.now(), recipeId)
        this.catalog.db.query(`UPDATE jobs SET status='complete',error=NULL,updated_at=? WHERE recipe!=? AND status!='complete'
          AND EXISTS (SELECT 1 FROM assets WHERE assets.hash=jobs.asset_hash AND active_recipe=?)`).run(Date.now(), recipeId, recipeId)
        this.catalog.db.query("UPDATE jobs SET status='pending',error=NULL,updated_at=? WHERE recipe=? AND status IN ('running','failed')")
          .run(Date.now(), recipeId)
        for (const asset of this.catalog.assets()) if (asset.active_recipe !== recipeId) this.catalog.enqueue(asset.hash, recipeId)
      })()
      await this.drain()
    })().finally(() => { this.recovering = undefined })
    return this.recovering
  }

  rebuild(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Library is closing'))
    if (this.rebuilding) return this.rebuilding
    const recovering = this.recovering
    this.rebuilding = (async () => {
      await recovering
      while (this.draining) await this.draining
      this.catalog.db.transaction(() => {
        for (const asset of this.catalog.assets()) {
          this.repair.add(asset.hash)
          this.catalog.enqueue(asset.hash, recipeId)
        }
      })()
      await this.drain()
    })().finally(() => { this.rebuilding = undefined })
    return this.rebuilding
  }

  private retryIncomplete(hash: string) {
    const job = this.catalog.db.query<{ status: string }, [string, string]>('SELECT status FROM jobs WHERE asset_hash=? AND recipe=?').get(hash, recipeId)
    if (this.catalog.asset(hash)?.active_recipe !== recipeId || job?.status === 'failed') this.catalog.enqueue(hash, recipeId)
  }

  private async drain(): Promise<void> {
    this.wakeDrain?.()
    this.draining ??= this.runPending().finally(() => { this.draining = undefined })
    await this.draining
    if (this.catalog.pendingJobs(recipeId, 1).length) await this.drain()
  }

  private startProcessing(wait: boolean): Promise<void> | undefined {
    const processing = this.drain()
    if (wait) return processing
    // The original and job are durable before responding; close() still waits for the worker.
    void processing.catch(error => console.error('Image processing stopped:', error))
  }

  private async runPending() {
    const active = new Set<Promise<void>>()
    try {
      for (;;) {
        const wake = Promise.withResolvers<void>()
        this.wakeDrain = wake.resolve
        while (active.size < imageConcurrency) {
          const job = this.catalog.pendingJobs(recipeId, 1)[0]
          if (!job) break
          const work = this.process(job).finally(() => { active.delete(work) })
          active.add(work)
        }
        if (!active.size) return
        await Promise.race([...active, wake.promise])
      }
    } finally {
      this.wakeDrain = undefined
      await Promise.allSettled(active)
    }
  }

  private async process(job: Job) {
    const claimed = this.catalog.db.query("UPDATE jobs SET status='running',attempts=attempts+1,error=NULL,updated_at=? WHERE asset_hash=? AND recipe=? AND status='pending'")
      .run(Date.now(), job.asset_hash, job.recipe).changes
    if (!claimed) return
    try {
      const asset = this.catalog.asset(job.asset_hash)!
      const bytes = await this.objects.read(asset.original_key)
      if (sha256(bytes) !== asset.hash) throw new Error('Original checksum mismatch: ' + asset.original_key)
      const processed = await processImage(bytes)
      const variants: Variant[] = []
      for (const kind of ['thumbnail', 'preview'] as const) {
        const data = kind === 'thumbnail' ? processed.thumbnailBuffer : processed.previewBuffer
        const checksum = sha256(data)
        const key = variantKey(asset.hash, kind, checksum)
        try { await this.objects.put(key, data, 'image/webp') }
        catch (cause) {
          if (!this.repair.has(asset.hash)) throw cause
          const existing = await this.objects.read(key)
          if (sha256(existing) === checksum) throw cause
          // Explicit rebuild may replace corrupt derived bytes, never original bytes.
          await this.objects.remove(key)
          await this.objects.put(key, data, 'image/webp')
        }
        variants.push({ asset_hash: asset.hash, recipe: recipeId, kind, object_key: key, checksum,
          bytes: data.byteLength, width: kind === 'thumbnail' ? processed.thumbnailWidth : processed.previewWidth,
          height: kind === 'thumbnail' ? processed.thumbnailHeight : processed.previewHeight, retired_at: null })
      }
      this.catalog.publish(asset.hash, recipeId, variants)
    } catch (error) {
      this.catalog.db.query("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE asset_hash=? AND recipe=?")
        .run((error instanceof Error ? error.message : String(error)).slice(0, 2000), Date.now(), job.asset_hash, job.recipe)
    } finally { this.repair.delete(job.asset_hash) }
  }

  async getResponse(key: string): Promise<Response | null> {
    if (!validKey(key)) return null
    const object = this.catalog.db.query<{ mime: string }, [string, string]>(`SELECT assets.mime FROM assets
      WHERE original_key=? AND EXISTS (SELECT 1 FROM photos WHERE photos.asset_hash=assets.hash AND deleted_at IS NULL)
      UNION ALL SELECT 'image/webp' AS mime FROM variants WHERE object_key=?
      AND EXISTS (SELECT 1 FROM photos WHERE photos.asset_hash=variants.asset_hash AND deleted_at IS NULL) LIMIT 1`).get(key, key)
    if (!object) return null
    const response = await this.objects.response(key, object.mime)
    if (response && response.status === 200) {
      response.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      response.headers.set('X-Content-Type-Options', 'nosniff')
      response.headers.set('ETag', '"' + (key.startsWith('originals/') ? key.split('/').at(-1) : key.slice(-69, -5)) + '"')
    }
    return response
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await Promise.allSettled([...this.operations])
        await this.recovering
        await this.rebuilding
        await this.draining
      } finally { this.catalog.close() }
    })()
    return this.closing
  }
}

function exifDate(value?: string) {
  if (!value) return undefined
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value)
  if (!match) return undefined
  const normalized = `${match[1]}-${match[2]}-${match[3]} ${match[4]}`
  return Number.isFinite(Date.parse(normalized.replace(' ', 'T'))) ? normalized : undefined
}
