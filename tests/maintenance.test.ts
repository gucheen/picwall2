import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Library } from '../server/library/service'
import { LocalObjects } from '../server/library/objects'
import { originalKey, sha256 } from '../server/library/model'
import { backupLibrary, checkLibrary, duplicates, exportManifest, garbageCollect, migrateLibrary, restoreLibrary } from '../server/library/maintenance'
import { bitmap } from './helpers'

let directory: string
let library: Library
let png: Uint8Array<ArrayBuffer>

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'picwall-maintenance-'))
  const root = path.join(directory, 'library')
  library = new Library(root, new LocalObjects(path.join(root, 'objects')))
  png = new Uint8Array(await new Bun.Image(bitmap(64, 32)).png().bytes())
})

afterEach(async () => {
  await library.close()
  await rm(directory, { recursive: true, force: true })
})

test.each(['sqlite', 'json'])('migrates %s metadata without changing the source and can be rerun', async format => {
  const sourceRoot = path.join(directory, 'legacy')
  await mkdir(path.join(sourceRoot, 'data'), { recursive: true })
  await mkdir(path.join(sourceRoot, 'files/uploads'), { recursive: true })
  const legacy = {
    id: 'legacy.jpg', name: '中文 名称.jpg', src: '/uploads/legacy.jpg',
    thumbnailSrc: '/thumbnails/old.avif', width: 64, height: 32,
    tags: ['旅行', 'family'], exif: { model: 'Preserved Camera' }, date: '2020-03-04 05:06:07',
    created_at: '2021-02-03 04:05:06',
  }
  let sourceCatalog: string
  if (format === 'sqlite') {
    sourceCatalog = path.join(sourceRoot, 'data/photos.db')
    const old = new Database(sourceCatalog)
    old.exec('CREATE TABLE photos (id TEXT PRIMARY KEY,name TEXT,src TEXT,thumbnailSrc TEXT,width INTEGER,height INTEGER,tags TEXT,exif TEXT,date TEXT,created_at TEXT)')
    old.query('INSERT INTO photos VALUES (?,?,?,?,?,?,?,?,?,?)').run(legacy.id, legacy.name, legacy.src, legacy.thumbnailSrc,
      legacy.width, legacy.height, JSON.stringify(legacy.tags), JSON.stringify(legacy.exif), legacy.date, legacy.created_at)
    old.close()
  } else {
    sourceCatalog = path.join(sourceRoot, 'data/photos_db.json')
    await Bun.write(sourceCatalog, JSON.stringify([legacy]))
  }
  await Bun.write(path.join(sourceRoot, 'files/uploads/legacy.jpg'), png)
  const originalCatalog = await Bun.file(sourceCatalog).bytes()
  expect(await migrateLibrary(library, { sourceRoot })).toEqual({ imported: 1, skipped: 0, failures: [] })
  const migrated = library.catalog.list()[0]!
  expect(migrated.id).not.toBe(legacy.id)
  expect(migrated).toMatchObject({ name: legacy.name, tags: [...legacy.tags].sort(), exif: legacy.exif, date: legacy.date })
  expect(library.catalog.record(migrated.id)?.created_at).toBe(legacy.created_at)
  expect(await migrateLibrary(library, { sourceRoot })).toEqual({ imported: 0, skipped: 1, failures: [] })
  expect(library.catalog.list()).toHaveLength(1)
  expect(library.catalog.list()[0]?.id).toBe(migrated.id)
  expect(await Bun.file(sourceCatalog).bytes()).toEqual(originalCatalog)
  expect(await Bun.file(path.join(sourceRoot, 'files/uploads/legacy.jpg')).bytes()).toEqual(png)
  if (format === 'sqlite') {
    const changed = new Database(sourceCatalog)
    changed.query('UPDATE photos SET name=?').run('changed metadata.jpg')
    changed.close()
  } else await Bun.write(sourceCatalog, JSON.stringify([{ ...legacy, name: 'changed metadata.jpg' }]))
  const changed = await migrateLibrary(library, { sourceRoot })
  expect(changed.failures).toHaveLength(1)
  expect(library.catalog.get(migrated.id)?.name).toBe(legacy.name)
  expect(library.catalog.list()).toHaveLength(1)
})

test('manifest export refuses to overwrite existing files or live catalog files', async () => {
  await library.ingest(png, { name: 'export.png' })
  const destination = path.join(directory, 'manifest.json')
  await exportManifest(library, destination)
  const original = await Bun.file(destination).bytes()
  await expect(exportManifest(library, destination)).rejects.toThrow()
  expect(await Bun.file(destination).bytes()).toEqual(original)
  await expect(exportManifest(library, path.join(library.catalog.root, 'catalog.sqlite'))).rejects.toThrow()
  expect((await checkLibrary(library)).ok).toBe(true)
})

test('check distinguishes missing objects, corrupt bytes and unreferenced objects', async () => {
  await library.ingest(png, { name: 'check.png' })
  expect((await checkLibrary(library)).ok).toBe(true)
  const asset = library.catalog.assets()[0]!
  const missing = library.catalog.variants()[0]!.object_key
  await library.objects.remove(missing)
  await Bun.write(path.join(library.catalog.root, 'objects', asset.original_key), 'corrupt')
  const extra = Buffer.from('unreferenced')
  const orphan = originalKey(sha256(extra))
  await library.objects.put(orphan, extra, 'application/octet-stream')
  const result = await checkLibrary(library)
  expect(result.ok).toBe(false)
  expect(result.missing).toEqual([missing])
  expect(result.corrupt).toEqual([{ key: asset.original_key, error: expect.stringContaining('mismatch') }])
  expect(result.orphans).toEqual([orphan])
})

test('GC defaults to dry-run and protects active references, retained trash and recent orphans', async () => {
  const first = await library.ingest(png, { name: 'first.png' })
  const second = await library.ingest(png, { name: 'second.png' })
  const now = Date.now() + 15 * 86_400_000
  library.catalog.delete(first, now - 10 * 86_400_000)
  const asset = library.catalog.assets()[0]!
  const orphanBytes = Buffer.from('orphan')
  const orphan = originalKey(sha256(orphanBytes))
  await library.objects.put(orphan, orphanBytes, 'application/octet-stream')
  const recentBytes = Buffer.from('recent orphan')
  const recent = originalKey(sha256(recentBytes))
  await library.objects.put(recent, recentBytes, 'application/octet-stream')
  await utimes(path.join(library.catalog.root, 'objects', recent), new Date(now), new Date(now))

  const dry = await garbageCollect(library, { now })
  expect(dry).toMatchObject({ dryRun: true, photos: [first], assets: [], objects: [orphan], skippedRecentObjects: [recent] })
  expect(library.catalog.record(first)).toBeDefined()
  expect(await library.objects.read(orphan)).toEqual(orphanBytes)
  const applied = await garbageCollect(library, { now, apply: true })
  expect(applied.dryRun).toBe(false)
  expect(library.catalog.record(first)).toBeUndefined()
  expect(library.catalog.get(second)).toBeDefined()
  expect(await library.objects.read(asset.original_key)).toEqual(png)
  expect((await library.objects.list()).some(object => object.key === orphan)).toBe(false)
  library.catalog.delete(second, now - 86_400_000)
  expect((await garbageCollect(library, { now, apply: true })).assets).toEqual([])
  expect(library.catalog.record(second)).toBeDefined()
  await expect(garbageCollect(library, { retentionDays: 0, apply: true })).rejects.toThrow('at least 7 days')
  const expired = await garbageCollect(library, { now: now + 8 * 86_400_000, apply: true })
  expect(expired.assets).toEqual([asset.hash])
  expect(library.catalog.assets()).toEqual([])
  expect(await library.objects.list()).toEqual([])
})

test('backups preserve UUIDs, metadata and deleted records and restore regenerates derivatives', async () => {
  const first = await library.ingest(png, { name: '备份.png', title: '湖边日落', location: { name: '西湖', latitude: 30.2431, longitude: 120.15 },
    tags: ['旅行'], date: '2022-01-02 03:04:05', exif: { model: 'Camera' }, preserveMetadata: true })
  const second = await library.ingest(png, { name: 'copy.png', title: 'Deleted title', location: { name: 'Hangzhou' } })
  expect(duplicates(library)[0]?.photoIds.sort()).toEqual([first, second].sort())
  library.catalog.delete(second, 123456789)
  const manifest = library.catalog.manifest()
  const backup = path.join(directory, 'backup')
  await backupLibrary(library, backup)
  expect(await Bun.file(path.join(backup, 'catalog.sqlite')).exists()).toBe(true)
  expect((await Bun.file(path.join(backup, 'manifest.json')).json()).photos).toEqual(manifest.photos)
  const root = path.join(directory, 'restored')
  const restored = new Library(root, new LocalObjects(path.join(root, 'objects')))
  try {
    expect(await restoreLibrary(restored, backup)).toEqual({ assets: 1, photos: 2 })
    expect(restored.catalog.manifest().photos).toEqual(manifest.photos)
    expect(restored.catalog.variants()).toEqual([])
    await restored.recover()
    expect(restored.catalog.get(first)).toMatchObject(library.catalog.get(first)!)
    expect(restored.catalog.get(second)).toBeUndefined()
    expect(restored.catalog.record(second)?.deleted_at).toBe(123456789)
    expect((await checkLibrary(restored)).ok).toBe(true)
    await expect(restoreLibrary(restored, backup)).rejects.toThrow('empty')
  } finally { await restored.close() }
})

test('restores older manifests without title or location fields', async () => {
  const id = await library.ingest(png, { name: 'old.png', tags: ['keep'] })
  const backup = path.join(directory, 'old-backup')
  await backupLibrary(library, backup)
  const manifest = library.catalog.manifest()
  for (const photo of manifest.photos) { delete photo.title; delete photo.location }
  await Bun.write(path.join(backup, 'manifest.json'), JSON.stringify(manifest))
  const root = path.join(directory, 'restored-old')
  const restored = new Library(root, new LocalObjects(path.join(root, 'objects')))
  try {
    await restoreLibrary(restored, backup)
    await restored.recover()
    expect(restored.catalog.get(id)).toEqual(library.catalog.get(id))
  } finally { await restored.close() }
})

test('restore verifies every original before publishing any catalog records', async () => {
  await library.ingest(png, { name: 'source.png' })
  const backup = path.join(directory, 'backup')
  await backupLibrary(library, backup)
  await Bun.write(path.join(backup, 'objects', originalKey(sha256(png))), 'damaged backup')
  const root = path.join(directory, 'restored')
  const restored = new Library(root, new LocalObjects(path.join(root, 'objects')))
  try {
    await expect(restoreLibrary(restored, backup)).rejects.toThrow('verification failed')
    expect(restored.catalog.assets()).toEqual([])
    expect(restored.catalog.manifest().photos).toEqual([])
    expect(await restored.objects.list()).toEqual([])
  } finally { await restored.close() }
})
