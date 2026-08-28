import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PhotoDatabase } from '../server/database'
import { LocalAdapter, S3Adapter } from '../server/adapters'
import { PhotoListCache } from '../server/photo-cache'
import { photo } from './helpers'

let directory: string
let db: PhotoDatabase

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'picwall-storage-'))
  db = new PhotoDatabase(path.join(directory, 'data'))
})

afterEach(async () => {
  db.close()
  await rm(directory, { recursive: true, force: true })
})

describe('SQLite compatibility', () => {
  test('adds preview columns to the original schema without changing existing paths', async () => {
    const oldDirectory = path.join(directory, 'old')
    await mkdir(oldDirectory)
    const legacy = new Database(path.join(oldDirectory, 'photos.db'))
    legacy.exec(`CREATE TABLE photos (id TEXT PRIMARY KEY, name TEXT NOT NULL, src TEXT NOT NULL,
      thumbnailSrc TEXT, width INTEGER, height INTEGER, date TEXT, exif TEXT, tags TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`)
    legacy.query('INSERT INTO photos (id, name, src, thumbnailSrc) VALUES (?, ?, ?, ?)')
      .run('old.jpg', 'old.jpg', '/uploads/old.jpg', '/thumbnails/old.avif')
    legacy.close()
    const upgraded = new PhotoDatabase(oldDirectory)
    try {
      expect(upgraded.get('old.jpg')).toMatchObject({ src: '/uploads/old.jpg', thumbnailSrc: '/thumbnails/old.avif' })
      expect(upgraded.get('old.jpg')?.previewSrc).toBeUndefined()
      expect(upgraded.page({ limit: 1 }).photos).toHaveLength(1)
    } finally { upgraded.close() }
  })
  test('migrates legacy JSON before reads and preserves AVIF paths', async () => {
    await Bun.write(path.join(directory, 'data/photos_db.json'), JSON.stringify([photo('legacy.jpg', 'avif')]))
    await db.migrateFromJson()
    expect(db.list()).toHaveLength(1)
    expect(db.get('legacy.jpg')).toMatchObject(photo('legacy.jpg', 'avif'))
    await db.migrateFromJson()
    expect(db.list()).toHaveLength(1)
  })

  test('rolls back a failed JSON import', async () => {
    await Bun.write(path.join(directory, 'data/photos_db.json'), JSON.stringify([photo(), photo()]))
    await expect(db.migrateFromJson()).rejects.toThrow()
    expect(db.list()).toEqual([])
  })

  test('opens existing SQLite rows without rewriting metadata', () => {
    db.close()
    const existing = new Database(path.join(directory, 'data/photos.db'))
    existing.query(`INSERT INTO photos (id, name, src, thumbnailSrc, exif, tags, date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'existing.jpg', 'existing.jpg', '/uploads/existing.jpg', '/thumbnails/thumb_existing.jpg.avif',
      '{"model":"Camera"}', '["travel"]', '2025-01-01 12:00:00')
    existing.close()
    db = new PhotoDatabase(path.join(directory, 'data'))
    expect(db.get('existing.jpg')).toMatchObject({ exif: { model: 'Camera' }, tags: ['travel'], thumbnailSrc: '/thumbnails/thumb_existing.jpg.avif' })
  })

  test('binds missing optional values as NULL and updates tags atomically', () => {
    db.insert(photo('a.png'))
    db.insert(photo('b.png'))
    db.updateMany([{ id: 'a.png', partial: { tags: ['one'] } }, { id: 'b.png', partial: { tags: [] } }])
    expect(db.get('a.png')?.tags).toEqual(['one'])
    expect(db.get('b.png')?.tags).toEqual([])
    expect(() => db.updateMany([
      { id: 'a.png', partial: { tags: ['must rollback'] } },
      { id: 'b.png', partial: { name: undefined } },
    ])).toThrow()
    expect(db.get('a.png')?.tags).toEqual(['one'])
  })
})

describe('photo list cache', () => {
  test('shares reads and serialized JSON, with independent responses and conditional GETs', async () => {
    db.insert(photo())
    const storage = new LocalAdapter(db, directory)
    const list = spyOn(storage, 'list')
    const cache = new PhotoListCache(() => storage.list(), () => db.version())
    const responses = await Promise.all(Array.from({ length: 8 }, () => cache.response()))
    const etag = responses[0]!.headers.get('etag')!
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/)
    for (const response of responses) {
      expect(await response.json()).toEqual(db.list())
    }
    for (const header of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
      const response = await cache.response(header)
      expect(response.status).toBe(304)
      expect(await response.text()).toBe('')
      expect(response.headers.get('etag')).toBe(etag)
      expect(response.headers.get('cache-control')).toBe('public, no-cache')
    }
    const miss = await cache.response('"other"')
    expect(miss.status).toBe(200)
    expect(await miss.json()).toEqual(db.list())
    expect(list).toHaveBeenCalledTimes(1)
  })

  test('detects local and external commits and never exposes rolled-back updates', async () => {
    const cache = new PhotoListCache(async () => db.list(), () => db.version())
    const empty = await cache.response()
    db.insert(photo())
    const inserted = await cache.response(empty.headers.get('etag')!)
    expect(inserted.status).toBe(200)
    expect(await inserted.json()).toHaveLength(1)

    const external = new PhotoDatabase(path.join(directory, 'data'))
    try {
      external.updateMany([{ id: 'sample.png', partial: { tags: ['imported'] } }])
      const updated = await cache.response(inserted.headers.get('etag')!)
      expect(updated.status).toBe(200)
      expect((await updated.json())[0].tags).toEqual(['imported'])

      expect(() => db.updateMany([
        { id: 'sample.png', partial: { tags: ['rollback'] } },
        { id: 'sample.png', partial: { name: undefined } },
      ])).toThrow()
      expect((await cache.response(updated.headers.get('etag')!)).status).toBe(304)

      external.delete('sample.png')
      const deleted = await cache.response(updated.headers.get('etag')!)
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual([])
    } finally {
      external.close()
    }
  })

  test('retries a snapshot invalidated during a shared pending read', async () => {
    let version = 'before'
    const pending = Promise.withResolvers<ReturnType<PhotoDatabase['list']>>()
    const list = mock(() => pending.promise)
    const cache = new PhotoListCache(list, () => version)
    const first = cache.response()
    const second = cache.response()
    version = 'after'
    list.mockImplementation(async () => [photo('new.png')])
    pending.resolve([photo('old.png')])
    for (const response of await Promise.all([first, second])) {
      expect(await response.json()).toEqual([photo('new.png')])
    }
    expect(list).toHaveBeenCalledTimes(2)
  })

  test('a failed read does not poison subsequent requests', async () => {
    const list = mock(async (): Promise<ReturnType<PhotoDatabase['list']>> => { throw new Error('temporary failure') })
    const cache = new PhotoListCache(list, () => 'one')
    await expect(cache.response()).rejects.toThrow('temporary failure')
    list.mockImplementation(async () => [])
    expect(await (await cache.response()).json()).toEqual([])
  })
})

describe('cursor pages', () => {
  test('uses a stable order with equal dates and survives deletion of the cursor row', () => {
    for (const id of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']) db.insert({ ...photo(id), date: '2026-01-01 12:00:00' })
    const first = db.page({ limit: 2 })
    expect(first.photos.map(photo => photo.id)).toEqual(['e.png', 'd.png'])
    expect(first.nextCursor).not.toBeNull()
    db.delete('d.png')
    db.insert({ ...photo('new.png'), date: '2026-02-01 12:00:00' })
    const second = db.page({ limit: 2, cursor: first.nextCursor! })
    const third = db.page({ limit: 2, cursor: second.nextCursor! })
    expect([...second.photos, ...third.photos].map(photo => photo.id)).toEqual(['c.png', 'b.png', 'a.png'])
    expect(third.nextCursor).toBeNull()
  })

  test('filters exact tags, paginates missing dates and returns tags independently', () => {
    db.insert({ ...photo('a.png'), tags: ['a&b', 'shared'] })
    db.insert({ ...photo('b.png'), tags: ['a&b', 'shared'] })
    db.insert({ ...photo('c.png'), date: '2026-01-01 00:00:00', tags: ['latest'] })
    expect(db.tags()).toEqual(['latest', 'a&b', 'shared'])
    const page = db.page({ limit: 1, tag: 'a&b' })
    expect(page.photos[0]?.id).toBe('b.png')
    expect(db.page({ limit: 1, tag: 'a&b', cursor: page.nextCursor! }).photos[0]?.id).toBe('a.png')
    expect(db.page({ limit: 10, tag: 'a' }).photos).toEqual([])
    expect(() => db.page({ limit: 1, tag: 'latest', cursor: page.nextCursor! })).toThrow('changed tag filter')
  })
})

describe('local files', () => {
  test('persists and deletes optional previews alongside the original and thumbnail', async () => {
    const storage = new LocalAdapter(db, directory)
    const metadata = { ...photo(), previewSrc: '/previews/preview.webp', previewWidth: 1600, previewHeight: 900 }
    await storage.save(metadata.id, new Blob(['image']), new Blob(['thumb']), metadata, new Blob(['preview']))
    expect(db.get(metadata.id)).toMatchObject(metadata)
    expect(await (await storage.get('preview.webp', 'previews'))?.text()).toBe('preview')
    await storage.delete(metadata.id)
    expect(await storage.get('preview.webp', 'previews')).toBeNull()
  })
  test.each(['webp', 'avif'])('saves, serves and deletes the recorded %s thumbnail', async extension => {
    const storage = new LocalAdapter(db, path.join(directory, 'files'))
    const metadata = photo('sample.png', extension)
    await storage.save(metadata.id, new Blob(['original'], { type: 'image/png' }), Buffer.from('thumbnail'), metadata)
    const original = await storage.get(metadata.id, 'uploads')
    expect(original?.headers.get('content-type')).toBe('image/png')
    expect(await original?.text()).toBe('original')
    const name = `thumb_sample.png.${extension}`
    const thumbnail = await storage.get(name, 'thumbnails')
    expect(thumbnail?.headers.get('content-type')).toBe(`image/${extension}`)
    expect(await thumbnail?.text()).toBe('thumbnail')
    expect(await storage.delete(metadata.id)).toBe(true)
    expect(await storage.get(name, 'thumbnails')).toBeNull()
    expect(await storage.get(metadata.id, 'uploads')).toBeNull()
    expect(db.list()).toEqual([])
    expect(await storage.delete(metadata.id)).toBe(false)
  })

  test('rejects traversal even when called without HTTP routing', async () => {
    const storage = new LocalAdapter(db, directory)
    await expect(storage.get('../secret', 'uploads')).rejects.toThrow('Invalid filename')
    await expect(storage.delete('../secret')).rejects.toThrow('Invalid filename')
  })
})

describe('native S3 client', () => {
  test('uses signed requests, correct MIME types, streaming reads and recorded delete keys', async () => {
    const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>()
    const requests: { method: string; path: string; authorization: string | null }[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const key = new URL(request.url).pathname
        requests.push({ method: request.method, path: key, authorization: request.headers.get('authorization') })
        if (request.method === 'PUT') {
          objects.set(key, { bytes: new Uint8Array(await request.arrayBuffer()), type: request.headers.get('content-type')! })
          return new Response(null, { headers: { ETag: '"test"' } })
        }
        if (request.method === 'DELETE') {
          objects.delete(key)
          return new Response(null, { status: 204 })
        }
        const object = objects.get(key)
        if (!object) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        return new Response(request.method === 'HEAD' ? null : object.bytes, {
          headers: { 'Content-Type': object.type, 'Content-Length': String(object.bytes.length) },
        })
      },
    })
    try {
      const options = {
        endpoint: server.url.toString(), bucket: 'photos', region: 'auto',
        accessKeyId: 'test-key', secretAccessKey: 'test-secret',
      }
      const storage = new S3Adapter(db, options)
      const cdn = new S3Adapter(db, options, 'https://cdn.example.com')
      const signed = new S3Adapter(db, options, '', true)
      for (const extension of ['webp', 'avif']) {
        const metadata = { ...photo(`${extension}.png`, extension), previewSrc: `/previews/preview_${extension}.webp`, previewWidth: 1200, previewHeight: 800 }
        await storage.save(metadata.id, new Blob(['image'], { type: 'image/png' }), Buffer.from('thumbnail'), metadata, Buffer.from('preview'))
        expect(objects.get(`/photos/uploads/${metadata.id}`)?.type).toBe('image/png')
        const thumbnailKey = `/photos/thumbnails/thumb_${metadata.id}.${extension}`
        expect(objects.get(thumbnailKey)?.type).toBe(`image/${extension}`)
        expect((await cdn.list())[0]?.src).toBe(`https://cdn.example.com/uploads/${metadata.id}`)
        expect((await cdn.page({ limit: 1 })).photos[0]?.previewSrc).toBe(`https://cdn.example.com${metadata.previewSrc}`)
        const count = requests.length
        const redirected = await cdn.get(metadata.id, 'uploads')
        expect(redirected?.status).toBe(302)
        expect(redirected?.headers.get('location')).toBe(`https://cdn.example.com/uploads/${metadata.id}`)
        const presigned = await signed.get(metadata.id, 'uploads')
        const target = new URL(presigned!.headers.get('location')!)
        expect(target.searchParams.get('X-Amz-Expires')).toBe('300')
        expect(target.searchParams.has('X-Amz-Signature')).toBe(true)
        expect(presigned?.headers.get('cache-control')).toBe('private, no-store')
        expect(requests).toHaveLength(count)
        const response = await storage.get(`thumb_${metadata.id}.${extension}`, 'thumbnails')
        expect(response?.headers.get('content-type')).toBe(`image/${extension}`)
        expect(await response?.text()).toBe('thumbnail')
        expect(await storage.delete(metadata.id)).toBe(true)
        expect(objects.size).toBe(0)
      }
      expect(await storage.get('missing.jpg', 'uploads')).toBeNull()
      expect(requests.every(request => request.authorization?.startsWith('AWS4-HMAC-SHA256 '))).toBe(true)
    } finally {
      await server.stop(true)
    }
  })
})
