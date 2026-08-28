import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Photo, PhotoPage } from '../../types/shared_types'
import { normalizePhotoTitle, normalizePhotoLocation } from '../../types/photo-metadata'
import { decodeCursor, encodeCursor, type PageOptions } from '../pagination'
import type { Asset, Variant } from './model'

export interface PhotoRecord {
  id: string; asset_hash: string; name: string; date: string | null; exif: string | null;
  title: string | null; location: string | null;
  created_at: string; deleted_at: number | null; metadata_locked: number
}
export interface Job {
  asset_hash: string; recipe: string; status: 'pending' | 'running' | 'failed' | 'complete';
  attempts: number; error: string | null; updated_at: number
}
export interface Metadata {
  id?: string; name: string; date?: string; exif?: Photo['exif']; tags?: string[];
  title?: Photo['title']; location?: Photo['location'];
  created_at?: string; deleted_at?: number | null; preserveMetadata?: boolean
}
export interface Manifest {
  version: 2; exported_at: string; assets: Asset[]; variants: Variant[];
  photos: (Omit<PhotoRecord, 'title' | 'location'> & Partial<Pick<PhotoRecord, 'title' | 'location'>> & { tags: string[] })[]
}
interface PhotoView extends PhotoRecord {
  original_key: string; width: number; height: number; thumbnail_key: string | null; preview_key: string | null;
  preview_width: number | null; preview_height: number | null; tag_json: string
}
const visible = 'photos.deleted_at IS NULL AND assets.active_recipe IS NOT NULL'
const ordering = "COALESCE(photos.date,'') DESC,photos.created_at DESC,photos.id DESC"
const photoQuery = `SELECT photos.*,assets.original_key,assets.width,assets.height,
  thumbnail.object_key AS thumbnail_key,preview.object_key AS preview_key,
  preview.width AS preview_width,preview.height AS preview_height,
  (SELECT json_group_array(tag) FROM (SELECT tag FROM photo_tags WHERE photo_id=photos.id ORDER BY tag)) AS tag_json
  FROM photos JOIN assets ON assets.hash=photos.asset_hash
  LEFT JOIN variants thumbnail ON thumbnail.asset_hash=assets.hash AND thumbnail.recipe=assets.active_recipe AND thumbnail.kind='thumbnail' AND thumbnail.retired_at IS NULL
  LEFT JOIN variants preview ON preview.asset_hash=assets.hash AND preview.recipe=assets.active_recipe AND preview.kind='preview' AND preview.retired_at IS NULL`

export class Catalog {
  readonly db!: Database
  private lock: Database
  private closed = false

  constructor(readonly root: string, identity: string) {
    mkdirSync(root, { recursive: true })
    this.lock = new Database(path.join(root, 'writer-lock.sqlite'), { create: true })
    try { this.lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;') }
    catch (cause) {
      this.lock.close()
      throw new Error('Library is in use. Stop the server before running maintenance.', { cause })
    }
    try {
      this.db = new Database(path.join(root, 'catalog.sqlite'), { create: true, strict: true })
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
      if (![0, 2, 3].includes(version)) throw new Error('Unsupported catalog version: ' + version)
      this.db.transaction(() => {
        if (version === 2) this.db.exec('ALTER TABLE photos ADD COLUMN title TEXT; ALTER TABLE photos ADD COLUMN location TEXT;')
        this.db.exec(schema)
      })()
      const previous = this.setting('object-store')
      if (previous && previous !== identity) throw new Error('Object store does not match this catalog')
      this.setSetting('object-store', identity)
    } catch (error) { this.db!?.close(); this.lock.close(); throw error }
  }
  setting(key: string) { return this.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key=?').get(key)?.value }
  setSetting(key: string, value: string) { this.db.query('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value) }
  asset(hash: string) { return this.db.query<Asset, [string]>('SELECT * FROM assets WHERE hash=?').get(hash) ?? undefined }
  assets() { return this.db.query<Asset, []>('SELECT * FROM assets ORDER BY hash').all() }
  variants() { return this.db.query<Variant, []>('SELECT * FROM variants ORDER BY asset_hash,recipe,kind').all() }
  jobs() { return this.db.query<Job, []>('SELECT * FROM jobs ORDER BY updated_at,asset_hash').all() }
  pendingJobs(generation: string, limit: number) {
    return this.db.query<Job, [string, number]>("SELECT * FROM jobs WHERE recipe=? AND status='pending' ORDER BY updated_at,asset_hash LIMIT ?").all(generation, limit)
  }
  record(id: string) { return this.db.query<PhotoRecord, [string]>('SELECT * FROM photos WHERE id=?').get(id) ?? undefined }
  source(source: string) { return this.db.query<{ photo_id: string; hash: string }, [string]>('SELECT photo_id,hash FROM imports WHERE source=?').get(source) }
  enqueue(hash: string, generation: string) {
    this.db.query("INSERT INTO jobs VALUES (?,?,'pending',0,NULL,?) ON CONFLICT(asset_hash,recipe) DO UPDATE SET status='pending',error=NULL,updated_at=excluded.updated_at WHERE jobs.status!='running'")
      .run(hash, generation, Date.now())
  }
  add(asset: Asset, metadata: Metadata, generation: string, source?: string) {
    const id = metadata.id ?? crypto.randomUUID()
    validateMetadata(metadata)
    this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO assets VALUES (?,?,?,?,?,?,?,?)').run(
        asset.hash, asset.original_key, asset.mime, asset.bytes, asset.width, asset.height, null, asset.created_at)
      const location = metadata.location === undefined ? null : normalizePhotoLocation(metadata.location)
      this.db.query(`INSERT INTO photos (id,asset_hash,name,date,exif,created_at,deleted_at,metadata_locked,title,location)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, asset.hash, metadata.name,
        metadata.date ?? null, metadata.exif ? JSON.stringify(metadata.exif) : null,
        metadata.created_at ?? new Date().toISOString(), metadata.deleted_at ?? null, metadata.preserveMetadata ? 1 : 0,
        metadata.title === undefined ? null : normalizePhotoTitle(metadata.title), location ? JSON.stringify(location) : null)
      this.updateTags(id, metadata.tags ?? [])
      if (this.asset(asset.hash)!.active_recipe !== generation) this.enqueue(asset.hash, generation)
      if (source) this.db.query('INSERT INTO imports VALUES (?,?,?)').run(source, id, asset.hash)
    })()
    return id
  }
  publish(hash: string, generation: string, variants: Variant[]) {
    if (variants.length !== 2 || new Set(variants.map(v => v.kind)).size !== 2
      || variants.some(v => v.asset_hash !== hash || v.recipe !== generation)) throw new Error('Incomplete variant publication')
    this.db.transaction(() => {
      const now = Date.now()
      this.db.query('UPDATE variants SET retired_at=? WHERE asset_hash=? AND recipe!=? AND retired_at IS NULL').run(now, hash, generation)
      for (const v of variants) this.db.query(`INSERT INTO variants VALUES (?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(asset_hash,recipe,kind) DO UPDATE SET object_key=excluded.object_key,checksum=excluded.checksum,
        bytes=excluded.bytes,width=excluded.width,height=excluded.height,retired_at=NULL`).run(
        hash, generation, v.kind, v.object_key, v.checksum, v.bytes, v.width, v.height)
      this.db.query('UPDATE assets SET active_recipe=? WHERE hash=?').run(generation, hash)
      this.db.query("UPDATE jobs SET status='complete',error=NULL,updated_at=? WHERE asset_hash=? AND recipe=?").run(now, hash, generation)
      this.db.query("UPDATE jobs SET status='complete',error=NULL,updated_at=? WHERE asset_hash=? AND recipe!=? AND status!='complete'")
        .run(now, hash, generation)
    })()
  }
  updateMany(updates: { id: string; partial: Partial<Photo> }[]) {
    this.db.transaction(() => {
      for (const { id, partial } of updates) {
        if (!this.record(id)) throw new Error('Photo not found')
        if (Object.hasOwn(partial, 'title')) this.db.query('UPDATE photos SET title=? WHERE id=?')
          .run(normalizePhotoTitle(partial.title), id)
        if (Object.hasOwn(partial, 'location')) {
          const location = normalizePhotoLocation(partial.location)
          this.db.query('UPDATE photos SET location=? WHERE id=?').run(location ? JSON.stringify(location) : null, id)
        }
        if (Object.hasOwn(partial, 'tags')) this.updateTags(id, partial.tags ?? [])
        if (Object.hasOwn(partial, 'name')) {
          if (typeof partial.name !== 'string' || !partial.name.length || partial.name.length > 4096) throw new Error('Invalid photo name')
          this.db.query('UPDATE photos SET name=? WHERE id=?').run(partial.name, id)
        }
        if (Object.hasOwn(partial, 'date')) {
          if (partial.date !== undefined && typeof partial.date !== 'string') throw new Error('Invalid photo date')
          this.db.query('UPDATE photos SET date=?,metadata_locked=1 WHERE id=?').run(partial.date ?? null, id)
        }
        if (Object.hasOwn(partial, 'exif')) this.db.query('UPDATE photos SET exif=?,metadata_locked=1 WHERE id=?')
          .run(partial.exif == null ? null : JSON.stringify(partial.exif), id)
      }
    })()
  }
  delete(id: string, now = Date.now()) { return this.db.query('UPDATE photos SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(now, id).changes > 0 }
  restore(id: string) { return this.db.query('UPDATE photos SET deleted_at=NULL WHERE id=? AND deleted_at IS NOT NULL').run(id).changes > 0 }
  version() {
    const row = this.db.query<{ changes: number; data_version: number }, []>('SELECT total_changes() AS changes,data_version FROM pragma_data_version').get()!
    return `${row.changes}:${row.data_version}`
  }
  close() {
    if (this.closed) return
    this.closed = true
    try { this.db.close() } finally { this.lock.close() }
  }
  get(id: string, includeDeleted = false): Photo | undefined {
    const record = this.db.query<PhotoView, [string]>(`${photoQuery} WHERE photos.id=? AND assets.active_recipe IS NOT NULL
      ${includeDeleted ? '' : 'AND photos.deleted_at IS NULL'}`).get(id)
    return record ? this.map(record) : undefined
  }
  list(): Photo[] {
    return this.db.query<PhotoView, []>(`${photoQuery} WHERE ${visible} ORDER BY ${ordering}`)
      .all().map(record => this.map(record))
  }
  page({ limit, cursor, tag }: PageOptions): PhotoPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page limit')
    const conditions = [visible]
    const values: (string | number)[] = []
    if (tag) { conditions.push('EXISTS (SELECT 1 FROM photo_tags WHERE photo_id=photos.id AND tag=?)'); values.push(tag) }
    if (cursor) {
      const after = decodeCursor(cursor, tag)
      conditions.push("(COALESCE(photos.date,''),photos.created_at,photos.id)<(?,?,?)")
      values.push(after.date, after.created, after.id)
    }
    const records = this.db.query<PhotoView, (string | number)[]>(`${photoQuery} WHERE ${conditions.join(' AND ')} ORDER BY ${ordering} LIMIT ?`)
      .all(...values, limit + 1)
    const selected = records.slice(0, limit)
    const last = selected.at(-1)
    return { photos: selected.map(record => this.map(record)), nextCursor: records.length > limit && last
      ? encodeCursor({ date: last.date ?? '', created: last.created_at, id: last.id, tag: tag ?? null }) : null }
  }
  tags(): string[] {
    return this.db.query<{ tag: string }, []>(`SELECT photo_tags.tag,MAX(COALESCE(photos.date,'')) AS latest FROM photo_tags
      JOIN photos ON photos.id=photo_tags.photo_id JOIN assets ON assets.hash=photos.asset_hash WHERE ${visible}
      GROUP BY photo_tags.tag ORDER BY latest DESC,photo_tags.tag`).all().map(row => row.tag)
  }
  trash(): (Photo & { deleted_at: number })[] {
    return this.db.query<PhotoView, []>(`${photoQuery} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC,photos.id`).all()
      .map(record => ({ ...this.map(record), deleted_at: record.deleted_at! }))
  }
  manifest(): Manifest {
    return { version: 2, exported_at: new Date().toISOString(), assets: this.assets(), variants: this.variants(),
      photos: this.db.query<PhotoRecord & { tag_json: string }, []>(`SELECT photos.*,
        (SELECT json_group_array(tag) FROM (SELECT tag FROM photo_tags WHERE photo_id=photos.id ORDER BY tag)) AS tag_json
        FROM photos ORDER BY id`).all().map(({ tag_json, ...row }) => ({ ...row, tags: JSON.parse(tag_json) })) }
  }
  private map(record: PhotoView): Photo {
    return { id: record.id, name: record.name, src: '/media/' + record.original_key, width: record.width, height: record.height,
      title: record.title ?? undefined, location: record.location ? JSON.parse(record.location) : undefined,
      thumbnailSrc: record.thumbnail_key ? '/media/' + record.thumbnail_key : undefined,
      previewSrc: record.preview_key ? '/media/' + record.preview_key : undefined,
      previewWidth: record.preview_width ?? undefined, previewHeight: record.preview_height ?? undefined,
      date: record.date ?? undefined, exif: record.exif ? JSON.parse(record.exif) : undefined, tags: JSON.parse(record.tag_json) }
  }
  private updateTags(id: string, tags: string[]) {
    if (!Array.isArray(tags) || tags.length > 100 || tags.some(tag => typeof tag !== 'string' || tag.length > 256)) throw new Error('Invalid tags')
    this.db.query('DELETE FROM photo_tags WHERE photo_id=?').run(id)
    for (const tag of new Set(tags.filter(tag => tag.trim()))) {
      this.db.query('INSERT OR IGNORE INTO tags VALUES (?)').run(tag)
      this.db.query('INSERT INTO photo_tags VALUES (?,?)').run(id, tag)
    }
  }
}

export function validateMetadata(metadata: Metadata) {
  if (!metadata || typeof metadata.name !== 'string' || !metadata.name || metadata.name.length > 4096) throw new Error('Invalid photo name')
  if (metadata.title !== undefined) normalizePhotoTitle(metadata.title)
  if (metadata.location !== undefined) normalizePhotoLocation(metadata.location)
  if (metadata.id !== undefined && (typeof metadata.id !== 'string' || !metadata.id || metadata.id.length > 512)) throw new Error('Invalid photo ID')
  if (metadata.date !== undefined && typeof metadata.date !== 'string') throw new Error('Invalid photo date')
  if (metadata.created_at !== undefined && (typeof metadata.created_at !== 'string' || !Number.isFinite(Date.parse(metadata.created_at)))) throw new Error('Invalid creation date')
  if (metadata.deleted_at != null && (!Number.isSafeInteger(metadata.deleted_at) || metadata.deleted_at < 0)) throw new Error('Invalid deletion date')
  if (metadata.tags !== undefined && (!Array.isArray(metadata.tags) || metadata.tags.length > 100
    || metadata.tags.some(tag => typeof tag !== 'string' || tag.length > 256))) throw new Error('Invalid tags')
}

const schema = [
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS assets (hash TEXT PRIMARY KEY, original_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, active_recipe TEXT, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, asset_hash TEXT NOT NULL REFERENCES assets(hash), name TEXT NOT NULL, date TEXT, exif TEXT, created_at TEXT NOT NULL, deleted_at INTEGER, metadata_locked INTEGER NOT NULL DEFAULT 0, title TEXT, location TEXT)',
  'CREATE INDEX IF NOT EXISTS photos_asset ON photos(asset_hash)',
  "CREATE INDEX IF NOT EXISTS photos_order ON photos(COALESCE(date,'') DESC,created_at DESC,id DESC) WHERE deleted_at IS NULL",
  'CREATE TABLE IF NOT EXISTS tags (name TEXT PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS photo_tags (photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE, tag TEXT NOT NULL REFERENCES tags(name), PRIMARY KEY(photo_id,tag))',
  'CREATE INDEX IF NOT EXISTS tags_photo ON photo_tags(tag,photo_id)',
  "CREATE TABLE IF NOT EXISTS variants (asset_hash TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE, recipe TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('thumbnail','preview')), object_key TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, retired_at INTEGER, PRIMARY KEY(asset_hash,recipe,kind))",
  "CREATE TABLE IF NOT EXISTS jobs (asset_hash TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE, recipe TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','failed','complete')), attempts INTEGER NOT NULL, error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(asset_hash,recipe))",
  'CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(recipe,status,updated_at,asset_hash)',
  'CREATE TABLE IF NOT EXISTS imports (source TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE, hash TEXT NOT NULL)',
  'PRAGMA user_version=3',
].join(';')
