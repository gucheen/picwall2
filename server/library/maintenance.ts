import { Database } from 'bun:sqlite'
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Photo } from '../../types/shared_types'
import { normalizePhotoLocation, normalizePhotoTitle } from '../../types/photo-metadata'
import { validateMetadata, type Manifest, type Metadata } from './catalog'
import type { Library } from './service'
import { LocalObjects } from './objects'
import { originalKey, recipeId, sha256 } from './model'

export interface LegacyPhoto extends Photo { created_at?: string | null }
export interface MigrationOptions {
  sourceRoot: string
  readOriginal?: (photo: LegacyPhoto) => Promise<Uint8Array>
}
export interface MigrationResult { imported: number; skipped: number; failures: { source: string; error: string }[] }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const within = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep)
async function resolvedDestination(directory: string): Promise<string> {
  const absolute = path.resolve(directory)
  try { return await realpath(absolute) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return path.join(await resolvedDestination(path.dirname(absolute)), path.basename(absolute))
  }
}

export async function validateMigrationDestination(sourceDirectory: string, targetDirectory: string) {
  const sourceRoot = await realpath(sourceDirectory)
  const destination = await resolvedDestination(targetDirectory)
  if (sourceRoot === destination || within(destination, sourceRoot)
    || within(path.join(sourceRoot, 'files'), destination) || destination === path.join(sourceRoot, 'data')) {
    throw new Error('Migration requires a separate destination, not legacy data/ itself or any path inside files/')
  }
}

export async function validateRestoreDestination(sourceDirectory: string, targetDirectory: string) {
  const source = await realpath(sourceDirectory)
  const target = await resolvedDestination(targetDirectory)
  if (within(source, target) || within(target, source)) throw new Error('Restore requires an isolated library root')
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
function validateExif(value: unknown) {
  if (value == null) return
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid EXIF object')
  const exif = value as Record<string, unknown>
  for (const key of ['make', 'model', 'lens', 'aperture', 'shutter', 'focalLength', 'date']) {
    if (exif[key] !== undefined && typeof exif[key] !== 'string') throw new Error('Invalid EXIF field: ' + key)
  }
  if (exif.iso !== undefined && (typeof exif.iso !== 'number' || !Number.isFinite(exif.iso))) throw new Error('Invalid EXIF ISO')
}

function legacyPhoto(value: unknown): LegacyPhoto {
  if (!value || typeof value !== 'object') throw new Error('Invalid legacy photo row')
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(row.id) || row.id.includes('..')) {
    throw new Error('Invalid legacy original filename: ' + String(row.id))
  }
  if (typeof row.name !== 'string') throw new Error('Missing legacy photo name: ' + row.id)
  const tags = typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags
  const exif = typeof row.exif === 'string' ? JSON.parse(row.exif) : row.exif
  if (tags != null && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))) {
    throw new Error('Invalid legacy tags: ' + row.id)
  }
  validateExif(exif)
  for (const column of ['date', 'created_at']) {
    if (row[column] != null && typeof row[column] !== 'string') throw new Error('Invalid legacy ' + column + ': ' + row.id)
  }
  return { ...row, tags: tags ?? undefined, exif: exif ?? undefined } as unknown as LegacyPhoto
}

export async function readLegacy(sourceRoot: string): Promise<LegacyPhoto[]> {
  const directory = path.join(await realpath(sourceRoot), 'data')
  const sqlite = path.join(directory, 'photos.db')
  let values: unknown[] | undefined
  if (await Bun.file(sqlite).exists()) {
    const database = new Database(sqlite, { readonly: true, strict: true })
    try { values = database.query('SELECT * FROM photos ORDER BY id').all() }
    finally { database.close() }
  }
  if (!values?.length && await Bun.file(path.join(directory, 'photos_db.json')).exists()) {
    const json: unknown = await Bun.file(path.join(directory, 'photos_db.json')).json()
    if (!Array.isArray(json)) throw new Error('Legacy photos_db.json must contain an array')
    values = json
  }
  if (!values) throw new Error('No legacy data/photos.db or data/photos_db.json in ' + sourceRoot)
  const photos = values.map(legacyPhoto)
  if (new Set(photos.map(photo => photo.id)).size !== photos.length) throw new Error('Duplicate IDs in legacy catalog')
  return photos
}

export async function migrateLibrary(library: Library, options: MigrationOptions): Promise<MigrationResult> {
  const sourceRoot = await realpath(options.sourceRoot)
  await validateMigrationDestination(sourceRoot, library.catalog.root)
  const photos = await readLegacy(sourceRoot)
  const readOriginal = options.readOriginal ?? (async (photo: LegacyPhoto) => {
    const directory = await realpath(path.join(sourceRoot, 'files', 'uploads'))
    const filename = await realpath(path.join(directory, photo.id))
    if (!within(directory, filename)) throw new Error('Original escapes legacy uploads directory: ' + photo.id)
    return Bun.file(filename).bytes()
  })
  library.catalog.db.exec(`CREATE TABLE IF NOT EXISTS migration_journal (
    source TEXT PRIMARY KEY, status TEXT NOT NULL, photo_id TEXT, hash TEXT, error TEXT,
    updated_at INTEGER NOT NULL, metadata_checksum TEXT
  )`)
  const journal = library.catalog.db.query(`INSERT INTO migration_journal VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET status=excluded.status,photo_id=excluded.photo_id,
    hash=excluded.hash,error=excluded.error,updated_at=excluded.updated_at,
    metadata_checksum=excluded.metadata_checksum`)
  const result: MigrationResult = { imported: 0, skipped: 0, failures: [] }
  for (const photo of photos) {
    const source = 'legacy:' + sourceRoot + ':' + photo.id
    const metadata: Metadata = {
      name: photo.name, tags: photo.tags, date: photo.date ?? undefined, exif: photo.exif,
      created_at: photo.created_at ?? undefined, preserveMetadata: true,
    }
    const metadataChecksum = sha256(JSON.stringify(canonical({ ...metadata, tags: [...new Set(metadata.tags ?? [])].sort() })))
    const previous = library.catalog.source(source)
    const previousJournal = library.catalog.db.query<{ metadata_checksum: string | null }, [string]>(
      'SELECT metadata_checksum FROM migration_journal WHERE source=?').get(source)
    const journalChecksum = previous && previousJournal?.metadata_checksum ? previousJournal.metadata_checksum : metadataChecksum
    try {
      if (previous && journalChecksum !== metadataChecksum) {
        throw new Error('Legacy metadata changed since migration began; reconcile it explicitly: ' + photo.id)
      }
      const bytes = await readOriginal(photo)
      const hash = sha256(bytes)
      journal.run(source, 'pending', previous?.photo_id ?? null, hash, null, Date.now(), metadataChecksum)
      const id = await library.ingest(bytes, metadata, source)
      const record = library.catalog.record(id)
      const asset = record && library.catalog.asset(record.asset_hash)
      if (!asset || asset.hash !== hash || sha256(await library.objects.read(asset.original_key)) !== hash) {
        throw new Error('Migrated original verification failed: ' + photo.id)
      }
      journal.run(source, 'complete', id, hash, null, Date.now(), metadataChecksum)
      if (previous) result.skipped++; else result.imported++
      const failed = library.catalog.db.query<{ error: string | null }, [string]>(
        "SELECT error FROM jobs WHERE asset_hash=? AND status='failed' LIMIT 1").get(hash)
      if (failed) result.failures.push({ source, error: 'Original migrated; derivative failed: ' + failed.error })
    } catch (error) {
      const message = errorText(error)
      journal.run(source, 'failed', null, null, message, Date.now(), journalChecksum)
      result.failures.push({ source, error: message })
    }
  }
  return result
}

export async function checkLibrary(library: Library) {
  const missing: string[] = []
  const corrupt: { key: string; error: string }[] = []
  const catalogErrors: string[] = []
  for (const row of library.catalog.db.query<Record<string, unknown>, []>('PRAGMA integrity_check').all()) {
    if (row.integrity_check !== 'ok') catalogErrors.push(String(row.integrity_check))
  }
  for (const row of library.catalog.db.query('PRAGMA foreign_key_check').all()) catalogErrors.push(JSON.stringify(row))
  const objects = await library.objects.list()
  const present = new Set(objects.map(object => object.key))
  const expected = new Map<string, { checksum: string; bytes: number }>()
  for (const asset of library.catalog.assets()) expected.set(asset.original_key, { checksum: asset.hash, bytes: asset.bytes })
  for (const variant of library.catalog.variants()) expected.set(variant.object_key, { checksum: variant.checksum, bytes: variant.bytes })
  for (const [key, expectedObject] of expected) {
    if (!present.has(key)) { missing.push(key); continue }
    try {
      const bytes = await library.objects.read(key)
      if (bytes.byteLength !== expectedObject.bytes || sha256(bytes) !== expectedObject.checksum) {
        corrupt.push({ key, error: 'SHA-256 or byte length mismatch' })
      }
    } catch (error) { corrupt.push({ key, error: errorText(error) }) }
  }
  const orphans = objects.filter(object => !expected.has(object.key)).map(object => object.key)
  const temporary = (await library.objects.temporary?.() ?? []).map(object => object.key)
  const jobs = library.catalog.jobs().filter(job => job.status !== 'complete')
  const variants = library.catalog.variants()
  const completeRecipes = new Set<string>()
  const kinds = new Map<string, Set<string>>()
  for (const variant of variants) {
    if (variant.retired_at !== null) continue
    const key = variant.asset_hash + ':' + variant.recipe
    const presentKinds = kinds.get(key) ?? new Set<string>()
    presentKinds.add(variant.kind)
    kinds.set(key, presentKinds)
    if (presentKinds.has('thumbnail') && presentKinds.has('preview')) completeRecipes.add(key)
  }
  const unreadyAssets = library.catalog.assets().filter(asset => !asset.active_recipe || !completeRecipes.has(asset.hash + ':' + asset.active_recipe))
    .map(asset => asset.hash)
  return { ok: !missing.length && !corrupt.length && !catalogErrors.length && !orphans.length && !jobs.length && !unreadyAssets.length,
    missing, corrupt, orphans, catalogErrors, temporary, jobs, unreadyAssets }
}

export function duplicates(library: Library) {
  const groups = new Map<string, string[]>()
  for (const photo of library.catalog.manifest().photos) {
    if (photo.deleted_at !== null) continue
    const ids = groups.get(photo.asset_hash) ?? []
    ids.push(photo.id)
    groups.set(photo.asset_hash, ids)
  }
  return [...groups].filter(([, ids]) => ids.length > 1).map(([hash, photoIds]) => ({ hash, photoIds }))
}

export async function garbageCollect(library: Library, options: { apply?: boolean; retentionDays?: number; now?: number } = {}) {
  const retentionDays = options.retentionDays ?? 7
  if (!Number.isFinite(retentionDays) || retentionDays < 7) throw new Error('GC retention must be at least 7 days')
  const cutoff = (options.now ?? Date.now()) - retentionDays * 86_400_000
  const manifest = library.catalog.manifest()
  const activeRecipes = new Map(manifest.assets.map(asset => [asset.hash, asset.active_recipe]))
  const objects = await library.objects.list()
  const temporary = await library.objects.temporary?.() ?? []
  const photos = manifest.photos.filter(photo => photo.deleted_at !== null && photo.deleted_at <= cutoff)
  const removedPhotos = new Set(photos.map(photo => photo.id))
  const retainedAssets = new Set(manifest.photos.filter(photo => !removedPhotos.has(photo.id)).map(photo => photo.asset_hash))
  const assets = manifest.assets.filter(asset => !retainedAssets.has(asset.hash) && asset.created_at <= cutoff)
  const removedAssets = new Set(assets.map(asset => asset.hash))
  const variants = manifest.variants.filter(variant => removedAssets.has(variant.asset_hash)
    || (variant.retired_at !== null && variant.retired_at <= cutoff
      && activeRecipes.get(variant.asset_hash) !== variant.recipe))
  const removedVariants = new Set(variants.map(variant => variant.object_key))
  const protectedKeys = new Set([
    ...manifest.assets.filter(asset => !removedAssets.has(asset.hash)).map(asset => asset.original_key),
    ...manifest.variants.filter(variant => !removedVariants.has(variant.object_key)).map(variant => variant.object_key),
  ])
  const unreferenced = objects.filter(object => !protectedKeys.has(object.key))
  const removable = unreferenced.filter(object => Number.isFinite(object.modified) && object.modified <= cutoff)
  const result = {
    dryRun: !options.apply, photos: photos.map(photo => photo.id), assets: assets.map(asset => asset.hash),
    variants: variants.map(variant => variant.object_key), objects: removable.map(object => object.key),
    skippedRecentObjects: unreferenced.filter(object => !Number.isFinite(object.modified) || object.modified > cutoff).map(object => object.key),
    temporary: temporary.filter(object => Number.isFinite(object.modified) && object.modified <= cutoff).map(object => object.key),
    skippedRecentTemporary: temporary.filter(object => !Number.isFinite(object.modified) || object.modified > cutoff).map(object => object.key),
  }
  if (options.apply) {
    // Commit reference removals first; an interrupted object deletion leaves safe orphans for the next run.
    library.catalog.db.transaction(() => {
      for (const id of result.photos) library.catalog.db.query('DELETE FROM photos WHERE id=?').run(id)
      for (const key of result.variants) library.catalog.db.query('DELETE FROM variants WHERE object_key=?').run(key)
      for (const hash of result.assets) library.catalog.db.query('DELETE FROM assets WHERE hash=?').run(hash)
    })()
    for (const key of result.objects) await library.objects.remove(key)
    for (const key of result.temporary) {
      if (!library.objects.removeTemporary) throw new Error('Object store cannot remove temporary objects')
      await library.objects.removeTemporary(key)
    }
  }
  return result
}

async function atomicJson(filename: string, value: unknown) {
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true })
  const temporary = filename + '.' + crypto.randomUUID() + '.tmp'
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync() }
    finally { await file.close() }
    await link(temporary, filename)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

export async function exportManifest(library: Library, destination: string) {
  await mkdir(path.dirname(path.resolve(destination)), { recursive: true })
  const target = path.join(await realpath(path.dirname(path.resolve(destination))), path.basename(destination))
  if (within(await realpath(library.catalog.root), target)) throw new Error('Manifest output must be outside the library root')
  await atomicJson(destination, library.catalog.manifest())
}

export async function backupLibrary(library: Library, destination: string) {
  const target = await resolvedDestination(destination)
  const root = await realpath(library.catalog.root)
  if (within(root, target) || within(target, root)) throw new Error('Backup destination must be outside the library root')
  await mkdir(path.dirname(target), { recursive: true })
  await mkdir(target)
  const manifest = library.catalog.manifest()
  const originals = new LocalObjects(path.join(target, 'objects'))
  await mkdir(originals.directory)
  for (const asset of manifest.assets) {
    const bytes = await library.objects.read(asset.original_key)
    if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.hash) throw new Error('Cannot back up corrupt original: ' + asset.hash)
    await originals.put(asset.original_key, bytes, asset.mime)
  }
  library.catalog.db.query('VACUUM INTO ?').run(path.join(target, 'catalog.sqlite'))
  const snapshot = new Database(path.join(target, 'catalog.sqlite'), { readonly: true })
  try {
    const check = snapshot.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all()
    if (check.some(row => row.integrity_check !== 'ok')) throw new Error('Backup catalog integrity check failed')
  } finally { snapshot.close() }
  // The manifest is the completion marker; failed backups cannot be used for restore.
  await atomicJson(path.join(target, 'manifest.json'), manifest)
}

function validateManifest(value: unknown): asserts value is Manifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid manifest')
  const manifest = value as Manifest
  if (manifest.version !== 2 || !Array.isArray(manifest.assets) || !Array.isArray(manifest.photos)
    || !Array.isArray(manifest.variants)) throw new Error('Unsupported manifest')
  const hashes = new Set<string>()
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.hash !== 'string' || !/^[a-f0-9]{64}$/.test(asset.hash)
      || asset.original_key !== originalKey(asset.hash) || hashes.has(asset.hash)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || typeof asset.mime !== 'string'
      || !Number.isFinite(asset.width) || !Number.isFinite(asset.height) || !Number.isFinite(asset.created_at)) {
      throw new Error('Invalid or duplicate manifest asset')
    }
    hashes.add(asset.hash)
  }
  const ids = new Set<string>()
  for (const photo of manifest.photos) {
    if (!photo || typeof photo.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(photo.id)
      || ids.has(photo.id) || !hashes.has(photo.asset_hash)
      || typeof photo.name !== 'string' || typeof photo.created_at !== 'string'
      || (photo.date !== null && typeof photo.date !== 'string')
      || (photo.deleted_at !== null && !Number.isFinite(photo.deleted_at))
      || !Array.isArray(photo.tags) || photo.tags.length > 100 || photo.tags.some(tag => typeof tag !== 'string' || tag.length > 256)
      || (photo.exif !== null && typeof photo.exif !== 'string')
      || (photo.location != null && typeof photo.location !== 'string')) throw new Error('Invalid or duplicate manifest photo')
    const exif: unknown = photo.exif !== null ? JSON.parse(photo.exif) : undefined
    if (exif !== undefined && (!exif || typeof exif !== 'object' || Array.isArray(exif))) throw new Error('Invalid manifest EXIF')
    validateExif(exif)
    validateMetadata({ id: photo.id, name: photo.name, date: photo.date ?? undefined,
      title: photo.title, location: photo.location != null ? JSON.parse(photo.location) : undefined,
      exif: exif as Photo['exif'], tags: photo.tags, created_at: photo.created_at, deleted_at: photo.deleted_at })
    ids.add(photo.id)
  }
}

export async function restoreLibrary(library: Library, backupDirectory: string): Promise<{ assets: number; photos: number }> {
  const source = await realpath(backupDirectory)
  await validateRestoreDestination(source, library.catalog.root)
  if (library.catalog.assets().length || library.catalog.manifest().photos.length || (await library.objects.list()).length) {
    throw new Error('Restore destination must have an empty catalog and object store')
  }
  const manifest: unknown = await Bun.file(path.join(source, 'manifest.json')).json()
  validateManifest(manifest)
  const originals = new LocalObjects(path.join(source, 'objects'))
  for (const asset of manifest.assets) {
    const bytes = await originals.read(asset.original_key)
    if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.hash) throw new Error('Backup original verification failed: ' + asset.hash)
  }
  for (const asset of manifest.assets) {
    const bytes = await originals.read(asset.original_key)
    if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.hash) throw new Error('Backup changed during restore: ' + asset.hash)
    await library.objects.put(asset.original_key, bytes, asset.mime)
    if (sha256(await library.objects.read(asset.original_key)) !== asset.hash) throw new Error('Restored original verification failed: ' + asset.hash)
  }
  library.catalog.db.transaction(() => {
    for (const asset of manifest.assets) {
      library.catalog.db.query(`INSERT INTO assets
        (hash,original_key,mime,bytes,width,height,active_recipe,created_at) VALUES (?,?,?,?,?,?,NULL,?)`)
        .run(asset.hash, asset.original_key, asset.mime, asset.bytes, asset.width, asset.height, asset.created_at)
      library.catalog.enqueue(asset.hash, recipeId)
    }
    for (const photo of manifest.photos) {
      const location = normalizePhotoLocation(photo.location == null ? null : JSON.parse(photo.location))
      library.catalog.db.query(`INSERT INTO photos
        (id,asset_hash,name,date,exif,created_at,deleted_at,metadata_locked,title,location) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(photo.id, photo.asset_hash, photo.name, photo.date, photo.exif, photo.created_at, photo.deleted_at, photo.metadata_locked ? 1 : 0,
          normalizePhotoTitle(photo.title ?? null), location ? JSON.stringify(location) : null)
      for (const tag of new Set(photo.tags)) {
        library.catalog.db.query('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(tag)
        library.catalog.db.query('INSERT INTO photo_tags(photo_id,tag) VALUES (?,?)').run(photo.id, tag)
      }
    }
  })()
  return { assets: manifest.assets.length, photos: manifest.photos.length }
}
