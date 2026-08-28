import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Library } from '../server/library/service'
import { LocalObjects, S3Objects } from '../server/library/objects'
import { originalKey, recipeId, sha256 } from '../server/library/model'
import { bitmap } from './helpers'

let directory: string
let library: Library
let objects: LocalObjects
let png: Uint8Array<ArrayBuffer>

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'picwall-library-'))
  objects = new LocalObjects(path.join(directory, 'objects'))
  library = new Library(directory, objects)
  png = new Uint8Array(await new Bun.Image(bitmap(64, 32)).png().bytes())
})

afterEach(async () => {
  await library.close()
  await rm(directory, { recursive: true, force: true })
})

describe('content-addressed library', () => {
  test('same names get independent UUIDs and different original objects without overwriting', async () => {
    const changed = new Uint8Array(await new Bun.Image(bitmap(48, 24)).png().bytes())
    const first = await library.ingest(png, { name: '同名 照片.png', tags: ['first'] })
    const second = await library.ingest(changed, { name: '同名 照片.png', tags: ['second'] })
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(second).not.toBe(first)
    expect(library.catalog.list()).toHaveLength(2)
    expect(library.catalog.get(first)).toMatchObject({ name: '同名 照片.png', tags: ['first'], width: 64 })
    expect(library.catalog.get(second)).toMatchObject({ name: '同名 照片.png', tags: ['second'], width: 48 })
    expect(await objects.read(originalKey(sha256(png)))).toEqual(png)
    expect(await objects.read(originalKey(sha256(changed)))).toEqual(changed)
  })

  test('identical bytes share the asset and variants while photo metadata stays independent', async () => {
    const ids = await Promise.all(['旅行.png', 'second.png', '旅行.png'].map((name, index) =>
      library.ingest(png, { name, tags: [String(index)] })))
    expect(new Set(ids).size).toBe(3)
    expect(library.catalog.assets()).toHaveLength(1)
    expect(library.catalog.variants()).toHaveLength(2)
    expect((await objects.list()).filter(object => object.key.startsWith('originals/'))).toHaveLength(1)
    for (const [index, id] of ids.entries()) expect(library.catalog.get(id)?.tags).toEqual([String(index)])
  })

  test('soft deletion protects shared media and restoration keeps UUID, tags and metadata', async () => {
    const first = await library.ingest(png, { name: 'one.png', tags: ['keep'], date: '2025-01-02 03:04:05' })
    const second = await library.ingest(png, { name: 'two.png' })
    const before = library.catalog.get(first)!
    const keys = [before.src, before.thumbnailSrc!, before.previewSrc!].map(src => src.slice('/media/'.length))
    expect(library.catalog.delete(first)).toBe(true)
    expect(library.catalog.delete(first)).toBe(false)
    expect(library.catalog.get(first)).toBeUndefined()
    expect(library.catalog.list().map(photo => photo.id)).toEqual([second])
    for (const key of keys) expect((await library.getResponse(key))?.status).toBe(200)
    expect(library.catalog.delete(second)).toBe(true)
    expect(library.catalog.trash()).toHaveLength(2)
    for (const key of keys) {
      expect(await library.getResponse(key)).toBeNull()
      expect((await objects.read(key)).length).toBeGreaterThan(0)
    }
    expect(library.catalog.restore(first)).toBe(true)
    expect(library.catalog.get(first)).toEqual(before)
    for (const key of keys) expect((await library.getResponse(key))?.status).toBe(200)
  })

  test('rejects undecodable input before registering photos, jobs or objects', async () => {
    await expect(library.ingest(Buffer.from('not a picture'), { name: 'broken.png' })).rejects.toThrow()
    expect(library.catalog.assets()).toEqual([])
    expect(library.catalog.jobs()).toEqual([])
    expect(library.catalog.list()).toEqual([])
    expect(await objects.list()).toEqual([])
  })

  test('records failed work durably and recovers an interrupted job after reopening', async () => {
    const write = objects.put.bind(objects)
    const failed = spyOn(objects, 'put').mockImplementation(async (key, bytes, mime) => {
      if (key.includes('/preview-')) throw new Error('simulated disk failure')
      return write(key, bytes, mime)
    })
    const id = await library.ingest(png, { name: 'recover.png', tags: ['preserved'] })
    expect(library.catalog.get(id)).toBeUndefined()
    expect(library.catalog.record(id)?.name).toBe('recover.png')
    expect(library.catalog.jobs()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('simulated disk failure') })
    expect(await objects.read(originalKey(sha256(png)))).toEqual(png)
    expect(library.catalog.variants()).toEqual([])
    library.catalog.db.query("UPDATE jobs SET status='running'").run()
    failed.mockRestore()
    await library.close()
    library = new Library(directory, objects)
    await library.recover()
    expect(library.catalog.get(id)).toMatchObject({ name: 'recover.png', tags: ['preserved'] })
    expect(library.catalog.asset(sha256(png))?.active_recipe).toBe(recipeId)
    expect(library.catalog.variants()).toHaveLength(2)
    await library.recover()
    expect(library.catalog.list()).toHaveLength(1)
    expect(library.catalog.variants()).toHaveLength(2)
  })

  test('publishes a photo and both variants only after all immutable writes succeed', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const write = objects.put.bind(objects)
    const blocked = spyOn(objects, 'put').mockImplementation(async (key, bytes, mime) => {
      if (key.includes('/preview-')) { entered.resolve(); await release.promise }
      return write(key, bytes, mime)
    })
    const ingest = library.ingest(png, { name: 'atomic.png' })
    try {
      await entered.promise
      expect(library.catalog.list()).toEqual([])
      expect(library.catalog.variants()).toEqual([])
      expect(library.catalog.asset(sha256(png))?.active_recipe).toBeNull()
    } finally { release.resolve() }
    const id = await ingest
    blocked.mockRestore()
    const photo = library.catalog.get(id)!
    expect(photo.thumbnailSrc).toBeDefined()
    expect(photo.previewSrc).toBeDefined()
    for (const variant of library.catalog.variants()) expect(sha256(await objects.read(variant.object_key))).toBe(variant.checksum)
  })

  test('enforces one writer and releases the lock on orderly shutdown', async () => {
    expect(() => new Library(directory, objects)).toThrow(/in use|locked/i)
    await library.close()
    library = new Library(directory, objects)
    const id = await library.ingest(png, { name: 'unlocked.png' })
    expect(library.catalog.get(id)?.name).toBe('unlocked.png')
  })

  test('the writer lock spans processes and is released automatically after a crash', async () => {
    await library.close()
    const script = `import { Catalog } from ${JSON.stringify(path.resolve(import.meta.dir, '../server/library/catalog.ts'))};
      const catalog = new Catalog(process.argv[1], 'local');
      console.log('LOCKED'); setInterval(() => catalog.version(), 60000);`
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script, directory], {
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    })
    try {
      const reader = child.stdout.getReader()
      try {
        const first = await reader.read()
        expect(new TextDecoder().decode(first.value)).toContain('LOCKED')
      } finally { reader.releaseLock() }
      expect(() => new Library(directory, objects)).toThrow(/in use|locked/i)
    } finally { child.kill('SIGKILL'); await child.exited }
    library = new Library(directory, objects)
    expect(library.catalog.assets()).toEqual([])
  })

  test('rebuild repairs derived bytes but never rewrites a corrupt original or unpublishes ready photos', async () => {
    const id = await library.ingest(png, { name: 'rebuild.png', tags: ['keep'] })
    const photo = library.catalog.get(id)!
    const variant = library.catalog.variants()[0]!
    await Bun.write(path.join(objects.directory, variant.object_key), 'broken derived bytes')
    await library.rebuild()
    expect(sha256(await objects.read(variant.object_key))).toBe(variant.checksum)
    expect(library.catalog.get(id)).toEqual(photo)
    const variants = library.catalog.variants()
    const original = originalKey(sha256(png))
    await Bun.write(path.join(objects.directory, original), 'damaged original')
    await library.rebuild()
    expect(await Bun.file(path.join(objects.directory, original)).text()).toBe('damaged original')
    expect(library.catalog.jobs()[0]?.status).toBe('failed')
    expect(library.catalog.get(id)).toEqual(photo)
    expect(library.catalog.variants()).toEqual(variants)
  })

  test('rejects conflicting immutable writes and removes temporary publish files', async () => {
    const key = originalKey(sha256(png))
    await Promise.all(Array.from({ length: 4 }, () => objects.put(key, png, 'image/png')))
    await expect(objects.put(key, Buffer.from('different'), 'image/png')).rejects.toThrow(/hash|checksum|Corrupt/i)
    expect(await objects.read(key)).toEqual(png)
    expect(await readdir(path.dirname(path.join(objects.directory, key)))).toEqual([sha256(png)])
    await expect(objects.read('../outside')).rejects.toThrow('Invalid object key')
  })

  test('S3 writes conditionally, follows all list pages and signs isolated object URLs', async () => {
    const prefix = 'test-library/'
    const bytes = [Buffer.from('first original'), Buffer.from('second original')]
    const keys = bytes.map(value => originalKey(sha256(value)))
    const stored = new Map<string, Uint8Array<ArrayBuffer>>()
    const puts: Request[] = []
    const lists: URL[] = []
    let malformedList: 'outside' | 'truncated' | undefined
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.searchParams.get('list-type') === '2') {
          lists.push(url)
          const second = url.searchParams.has('continuation-token')
          const key = malformedList === 'outside' ? 'uploads/private.png' : prefix + keys[second ? 1 : 0]!
          const next = !second && malformedList !== 'truncated' ? '<NextContinuationToken>page-two</NextContinuationToken>' : ''
          return new Response(`<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>photos</Name><Prefix>${prefix}</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${!second}</IsTruncated>${next}<Contents><Key>${key}</Key><LastModified>2025-01-01T00:00:00.000Z</LastModified><ETag>"example"</ETag><Size>${bytes[second ? 1 : 0]!.length}</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`, { headers: { 'Content-Type': 'application/xml' } })
        }
        if (request.method === 'PUT') {
          puts.push(request)
          stored.set(url.pathname, new Uint8Array(await request.arrayBuffer()))
          return new Response(null, { status: puts.length === 2 ? 412 : 200 })
        }
        if (request.method === 'DELETE') { stored.delete(url.pathname); return new Response(null, { status: 204 }) }
        const value = stored.get(url.pathname)
        if (!value) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        return new Response(request.method === 'HEAD' ? null : value, {
          headers: { 'Content-Length': String(value.length), 'Content-Type': 'image/png' },
        })
      },
    })
    try {
      const options = { endpoint: server.url.toString(), bucket: 'photos', region: 'auto', accessKeyId: 'test-key', secretAccessKey: 'test-secret' }
      for (const invalid of ['', '../', 'uploads/', 'thumbnails/', 'previews/', 'no-slash']) {
        expect(() => new S3Objects(options, invalid)).toThrow('isolated directory')
      }
      const s3 = new S3Objects(options, prefix)
      for (const [index, key] of keys.entries()) await s3.put(key, bytes[index]!, 'image/png')
      expect(puts).toHaveLength(2)
      for (const request of puts) {
        expect(request.headers.get('if-none-match')).toBe('*')
        expect(new URL(request.url).searchParams.has('X-Amz-Signature')).toBe(true)
        expect(new URL(request.url).pathname).toStartWith('/photos/' + prefix)
      }
      await s3.put(keys[0]!, bytes[0]!, 'image/png')
      expect(puts).toHaveLength(2)
      expect((await s3.list()).map(object => object.key)).toEqual(keys)
      expect(lists.map(url => url.searchParams.get('prefix'))).toEqual([prefix, prefix])
      expect(lists[1]!.searchParams.get('continuation-token')).toBe('page-two')
      expect(await (await s3.response(keys[0]!, 'image/png'))?.text()).toBe('first original')
      const signed = new S3Objects(options, prefix, '', true)
      const redirect = await signed.response(keys[0]!, 'image/png')
      expect(redirect?.status).toBe(302)
      const location = new URL(redirect!.headers.get('location')!)
      expect(location.searchParams.get('X-Amz-Expires')).toBe('300')
      expect(location.searchParams.has('X-Amz-Signature')).toBe(true)
      expect(redirect?.headers.get('cache-control')).toBe('private, no-store')
      const cdn = new S3Objects(options, prefix, 'https://cdn.example.test')
      expect((await cdn.response(keys[0]!, 'image/png'))?.headers.get('location')).toBe('https://cdn.example.test/' + prefix + keys[0])
      await s3.remove(keys[0]!)
      expect(await signed.response(keys[0]!, 'image/png')).toBeNull()
      malformedList = 'outside'
      await expect(s3.list()).rejects.toThrow('outside the isolated prefix')
      malformedList = 'truncated'
      await expect(s3.list()).rejects.toThrow('Incomplete S3 listing')
    } finally { await server.stop(true) }
  })
})
