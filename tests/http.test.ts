import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { bitmap } from './helpers'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type { Photo } from '../types/shared_types'
import { sha256 } from '../server/library/model'
import { authFixture } from './auth-helpers'

const root = path.resolve(import.meta.dir, '..')
let directory: string
let process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
let base: string
let cookie: string
const admin = { name: 'Administrator' }

async function waitForProcessing() {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { counts } = await (await fetch(new URL('/api/jobs?limit=1', base), { headers: { cookie } })).json()
    if (counts.pending + counts.running === 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Image processing did not finish')
}

beforeAll(async () => {
  const build = Bun.spawn([Bun.which('bun')!, 'scripts/build.ts'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
  })
  if (await build.exited !== 0) throw new Error(await new Response(build.stderr).text())
  directory = await mkdtemp(path.join(tmpdir(), 'picwall-http-'))
  await symlink(path.join(root, 'dist'), path.join(directory, 'dist'), 'dir')
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = reservation.port!
  base = reservation.url.toString()
  await reservation.stop(true)
  const auth = authFixture(path.join(directory, 'auth'), new URL(base).origin)
  try { cookie = (await auth.enroll()).cookie } finally { auth.close() }
  process = Bun.spawn([Bun.which('bun')!, '--no-env-file', path.join(root, 'dist/server/index.js')], {
    cwd: directory,
    env: {
      PATH: Bun.env.PATH, NODE_ENV: 'production', STORAGE_TYPE: 'local', PORT: String(port), HOST: '127.0.0.1',
      IMAGE_CONCURRENCY: '1', IMAGE_QUEUE_SIZE: '1',
      LIBRARY_ROOT: path.join(directory, 'library'),
      AUTH_ROOT: path.join(directory, 'auth'),
      BASE_URL: new URL(base).origin,
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
  })
  const reader = process.stdout.getReader()
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`Server exited: ${output}\n${await new Response(process.stderr).text()}`)
      output += new TextDecoder().decode(value)
      const url = output.match(/Server running at (http:\/\/[^\s]+)/)?.[1]
      if (url) { base = url; break }
    }
  } finally {
    reader.releaseLock()
  }
}, 60_000)

afterAll(async () => {
  if (process) {
    process.kill()
    await process.exited
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('production serves the SPA, JS, CSS and favicon with security headers', async () => {
  for (const route of ['/', '/admin', '/login', '/admin/security', '/unknown-page']) {
    const response = await fetch(new URL(route, base))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const html = await response.text()
    expect(html).toContain('id="root"')
    for (const match of html.matchAll(/(?:src|href)="(\/[^\"]+)"/g)) {
      const asset = await fetch(new URL(match[1]!, base))
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).not.toContain('text/html')
      await asset.arrayBuffer()
    }
  }
  for (const route of ['/api/missing', '/uploads/missing.png', '/thumbnails/missing.webp', '/missing.js']) {
    expect((await fetch(new URL(route, base))).status).toBe(404)
  }
  const licenses = await fetch(new URL('/licenses.txt', base))
  expect(licenses.status).toBe(200)
  const notices = await licenses.text()
  for (const name of ['PicWall2', 'react@', 'react-dom@', 'motion@', 'wouter@', 'exifreader@', 'MPL-2.0', '@simplewebauthn/server@', '@simplewebauthn/browser@']) {
    expect(notices).toContain(name)
  }
})

test('loads persisted sessions before requests and protects mutations', async () => {
  const me = await fetch(new URL('/api/auth/me', base), { headers: { cookie, origin: new URL(base).origin } })
  expect(await me.json()).toEqual({ user: admin })
  expect(me.headers.get('cache-control')).toBe('private, no-store')
  const unauthorized = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { origin: new URL(base).origin } })
  expect(unauthorized.status).toBe(401)
  const crossSite = await fetch(new URL('/api/upload', base), {
    method: 'POST', headers: { cookie, origin: 'https://other.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1',
  })
  expect(crossSite.status).toBe(403)
})

test('rejects forged prototype sessions on every administrative route', async () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const headers = { cookie: 'picwall_session=' + id, origin: new URL(base).origin }
    for (const route of ['/api/trash', '/api/jobs']) {
      expect((await fetch(new URL(route, base), { headers })).status).toBe(401)
    }
    expect(await (await fetch(new URL('/api/auth/me', base), { headers })).json()).toEqual({ user: null })
    expect((await fetch(new URL('/api/upload', base), { method: 'POST', headers })).status).toBe(401)
  }
})

test('rejects cross-origin JSON mutations and GET logout', async () => {
  expect((await fetch(new URL('/api/photos', base), {
    method: 'PATCH', headers: { cookie, origin: 'https://other.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [], tags: [] }),
  })).status).toBe(403)
  expect((await fetch(new URL('/api/auth/logout', base), { headers: { cookie } })).status).toBe(404)
})

test('serves precompressed static variants with correct negotiation, validators and HEAD', async () => {
  const html = await (await fetch(base)).text()
  const assetPath = html.match(/src="([^\"]+\.js)"/)![1]!
  const asset = new URL(assetPath, base)
  const identity = await fetch(asset, { headers: { 'Accept-Encoding': 'identity' }, decompress: false })
  const original = await identity.arrayBuffer()
  expect(identity.headers.get('cache-control')).toContain('immutable')
  for (const encoding of ['br', 'gzip']) {
    const response = await fetch(asset, { headers: { 'Accept-Encoding': encoding }, decompress: false })
    expect(response.headers.get('content-encoding')).toBe(encoding)
    expect(response.headers.get('vary')).toBe('Accept-Encoding')
    const bytes = await response.arrayBuffer()
    expect(bytes.byteLength).toBeLessThan(original.byteLength)
    expect(encoding === 'br' ? brotliDecompressSync(bytes) : gunzipSync(bytes)).toEqual(Buffer.from(original))
    const etag = response.headers.get('etag')!
    expect(etag).not.toBe(identity.headers.get('etag'))
    const unchanged = await fetch(asset, { headers: { 'Accept-Encoding': encoding, 'If-None-Match': etag } })
    expect(unchanged.status).toBe(304)
    const head = await fetch(asset, { method: 'HEAD', headers: { 'Accept-Encoding': encoding } })
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(await head.text()).toBe('')
  }
  expect((await fetch(base)).headers.get('cache-control')).toBe('no-cache')
  expect((await fetch(asset, { headers: { 'Accept-Encoding': 'identity;q=0, *;q=0' } })).status).toBe(406)
})

test('uploads UUID photos, reads variants, updates tags and soft-deletes media', async () => {
  const empty = await fetch(new URL('/api/photos', base))
  const emptyETag = empty.headers.get('etag')!
  expect(await empty.json()).toEqual([])
  const png = await new Bun.Image(bitmap(1200, 800)).png().blob()
  const form = new FormData()
  form.set('file', new File([png], 'test photo.png', { type: 'image/png' }))
  const upload = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { cookie, origin: new URL(base).origin }, body: form })
  expect(upload.status).toBe(202)
  const uploaded = await upload.json()
  expect(uploaded).toEqual({ success: true, id: expect.any(String), status: 'pending' })
  await waitForProcessing()
  expect(uploaded.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  const id: string = uploaded.id
  const list = await fetch(new URL('/api/photos', base), { headers: { 'If-None-Match': emptyETag } })
  expect(list.status).toBe(200)
  expect(list.headers.get('cache-control')).toBe('public, no-cache')
  const etag = list.headers.get('etag')!
  const photos: Photo[] = await list.json()
  const unchanged = await fetch(new URL('/api/photos', base), { headers: { 'If-None-Match': `W/${etag}` } })
  expect(unchanged.status).toBe(304)
  expect(unchanged.headers.get('etag')).toBe(etag)
  expect(unchanged.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await unchanged.text()).toBe('')
  expect(photos[0]).toMatchObject({ id, name: 'test photo.png', width: 1200, height: 800 })
  expect(photos[0]!.src).toMatch(/^\/media\/originals\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/)
  expect(photos[0]!.thumbnailSrc).toMatch(/^\/media\/derived\/[a-f0-9]{64}\/[a-f0-9]{64}\/thumbnail-[a-f0-9]{64}\.webp$/)
  const preview = await fetch(new URL(photos[0]!.previewSrc!, base))
  expect(preview.headers.get('content-type')).toBe('image/webp')
  expect(await new Bun.Image(await preview.arrayBuffer()).metadata()).toMatchObject({ width: 1200, height: 800 })
  const thumbnail = await fetch(new URL(photos[0]!.thumbnailSrc!, base))
  expect(thumbnail.headers.get('content-type')).toBe('image/webp')
  expect(thumbnail.headers.get('cache-control')).toContain('immutable')
  expect(thumbnail.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await new Bun.Image(await thumbnail.arrayBuffer()).metadata()).toEqual({ width: 600, height: 400, format: 'webp' })
  const update = await fetch(new URL('/api/photos', base), {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id], tags: ['trip'] }),
  })
  expect(update.status).toBe(200)
  const batchList = await fetch(new URL('/api/photos', base), { headers: { 'If-None-Match': etag } })
  expect(batchList.status).toBe(200)
  const changed: Photo[] = await batchList.json()
  expect(changed[0]?.tags).toEqual(['trip'])
  const singleUpdate = await fetch(new URL(`/api/photos/${id}`, base), {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ tags: ['single'] }),
  })
  expect(singleUpdate.status).toBe(200)
  const singleList = await fetch(new URL('/api/photos', base), { headers: { 'If-None-Match': batchList.headers.get('etag')! } })
  expect(singleList.status).toBe(200)
  expect((await singleList.json())[0].tags).toEqual(['single'])
  const tags = await fetch(new URL('/api/tags', base))
  expect(await tags.json()).toEqual(['single'])
  const page = await fetch(new URL('/api/photos?limit=1&tag=single', base))
  expect(await page.json()).toMatchObject({ photos: [{ id }], nextCursor: null })
  expect((await fetch(new URL('/api/photos?limit=1&tag=single', base), { headers: { 'If-None-Match': page.headers.get('etag')! } })).status).toBe(304)
  const deleted = await fetch(new URL(`/api/photos/${id}`, base), { method: 'DELETE', headers: { cookie, origin: new URL(base).origin } })
  expect(deleted.status).toBe(200)
  const finalList = await fetch(new URL('/api/photos', base), { headers: { 'If-None-Match': singleList.headers.get('etag')! } })
  expect(finalList.status).toBe(200)
  expect(await finalList.json()).toEqual([])
  expect((await fetch(new URL(photos[0]!.src, base))).status).toBe(404)
  expect((await fetch(new URL(photos[0]!.thumbnailSrc!, base))).status).toBe(404)
  expect((await fetch(new URL(photos[0]!.previewSrc!, base))).status).toBe(404)
  const changedTags = await fetch(new URL('/api/tags', base), { headers: { 'If-None-Match': tags.headers.get('etag')! } })
  expect(changedTags.status).toBe(200)
  expect(await changedTags.json()).toEqual([])
})

test('rejects malformed pagination without changing the legacy list contract', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=no', 'cursor=bad', 'limit=1.5']) {
    expect((await fetch(new URL(`/api/photos?${query}`, base))).status).toBe(400)
  }
  expect(Array.isArray(await (await fetch(new URL('/api/photos', base))).json())).toBe(true)
  for (const endpoint of ['/api/trash', '/api/jobs']) {
    for (const query of ['limit=0', 'limit=101', 'cursor=bad']) {
      expect((await fetch(new URL(`${endpoint}?${query}`, base), { headers: { cookie } })).status).toBe(400)
    }
    const response = await fetch(new URL(`${endpoint}?limit=1`, base), { headers: { cookie } })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const page = await response.json()
    expect(page.items.length).toBeLessThanOrEqual(1)
    expect(page.nextCursor === null || typeof page.nextCursor === 'string').toBe(true)
  }
})

test('edits public title and location independently, validates mutations, and invalidates list and page caches', async () => {
  const form = new FormData()
  form.set('file', new File([await new Bun.Image(bitmap(64, 32)).png().blob()], 'caption.png', { type: 'image/png' }))
  const uploaded = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { cookie, origin: new URL(base).origin }, body: form })
  expect(uploaded.status).toBe(202)
  const { id } = await uploaded.json()
  await waitForProcessing()
  const endpoint = new URL(`/api/photos/${id}`, base)
  const patch = (body: unknown) => fetch(endpoint, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const list = await fetch(new URL('/api/photos', base))
  const original = (await list.json())[0]
  const page = await fetch(new URL('/api/photos?limit=1', base))
  await page.text()
  expect((await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"blocked"}' })).status).toBe(401)
  const location = { name: '西湖', latitude: 30.2431, longitude: 120.15 }
  expect((await patch({ title: '  湖边日落  ', location, tags: ['travel'] })).status).toBe(200)
  const changed = await fetch(new URL('/api/photos', base), { headers: { 'If-None-Match': list.headers.get('etag')! } })
  expect(changed.status).toBe(200)
  expect((await changed.json())[0]).toMatchObject({ ...original, title: '湖边日落', location, tags: ['travel'] })
  const changedPage = await fetch(new URL('/api/photos?limit=1', base), { headers: { 'If-None-Match': page.headers.get('etag')! } })
  expect(changedPage.status).toBe(200)
  expect((await changedPage.json()).photos[0]).toMatchObject({ title: '湖边日落', location })
  expect((await patch({ title: 'New title' })).status).toBe(200)
  expect((await patch({ location: { name: '  Hangzhou  ' } })).status).toBe(200)
  for (const body of [null, [], {}, 'text', { name: 'rename.png' }, { title: 42 }, { title: 'x'.repeat(201) },
    { title: 'Must not save', location: { latitude: 1 } }, { location: { latitude: 0, longitude: 181 } },
    { location: { latitude: '30', longitude: 120 } }, { location: { name: 'x', url: 'https://example.com' } }]) {
    expect((await patch(body)).status).toBe(400)
  }
  expect((await (await fetch(new URL('/api/photos', base))).json())[0]).toMatchObject({
    name: 'caption.png', title: 'New title', location: { name: 'Hangzhou' }, tags: ['travel'],
  })
  expect((await patch({ location: { latitude: 0, longitude: 0 } })).status).toBe(200)
  expect((await (await fetch(new URL('/api/photos', base))).json())[0].location).toEqual({ latitude: 0, longitude: 0 })
  expect((await patch({ title: '', location: null })).status).toBe(200)
  const cleared = (await (await fetch(new URL('/api/photos', base))).json())[0]
  expect(cleared.title).toBeUndefined()
  expect(cleared.location).toBeUndefined()
  expect(cleared.tags).toEqual(['travel'])
  expect((await fetch(endpoint, { method: 'DELETE', headers: { cookie, origin: new URL(base).origin } })).status).toBe(200)
  expect((await patch({ title: 'Deleted photo' })).status).toBe(404)
})

test('same Unicode names keep distinct IDs and shared media survives trash and restoration', async () => {
  const png = await new Bun.Image(bitmap(96, 48)).png().blob()
  const ids: string[] = []
  for (let index = 0; index < 2; index++) {
    const form = new FormData()
    form.set('file', new File([png], '旅行 照片.png', { type: 'image/png' }))
    const response = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { cookie, origin: new URL(base).origin }, body: form })
    expect([200, 202]).toContain(response.status)
    ids.push((await response.json()).id)
  }
  await waitForProcessing()
  expect(new Set(ids).size).toBe(2)
  const photos: Photo[] = await (await fetch(new URL('/api/photos', base))).json()
  expect(photos).toHaveLength(2)
  expect(photos.map(photo => photo.name)).toEqual(['旅行 照片.png', '旅行 照片.png'])
  expect(photos[0]?.src).toBe(photos[1]?.src)
  for (const route of ['/api/trash', '/api/jobs']) expect((await fetch(new URL(route, base))).status).toBe(401)
  expect((await fetch(new URL(`/api/photos/${ids[0]}/restore`, base), { method: 'POST', headers: { origin: new URL(base).origin } })).status).toBe(401)
  for (const tags of [[17], [null], ['x'.repeat(257)]]) {
    const response = await fetch(new URL(`/api/photos/${ids[0]}`, base), {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }),
    })
    expect(response.status).toBe(400)
  }
  expect((await fetch(new URL(`/api/photos/${ids[0]}`, base), { method: 'DELETE', headers: { cookie, origin: new URL(base).origin } })).status).toBe(200)
  expect((await fetch(new URL(photos[0]!.src, base))).status).toBe(200)
  const trash = await (await fetch(new URL('/api/trash', base), { headers: { cookie, origin: new URL(base).origin } })).json()
  expect(trash.find((photo: Photo) => photo.id === ids[0])).toMatchObject({ name: '旅行 照片.png', deleted_at: expect.any(Number) })
  expect((await fetch(new URL(`/api/photos/${ids[0]}/restore`, base), { method: 'POST', headers: { cookie, origin: new URL(base).origin } })).status).toBe(200)
  expect(await (await fetch(new URL('/api/photos', base))).json()).toHaveLength(2)
  for (const id of ids) expect((await fetch(new URL(`/api/photos/${id}`, base), { method: 'DELETE', headers: { cookie, origin: new URL(base).origin } })).status).toBe(200)
  expect((await fetch(new URL(photos[0]!.src, base))).status).toBe(404)
})

test('returns 202 for a saved original with failed derivatives and retries it without reuploading', async () => {
  const png = new Uint8Array(await new Bun.Image(bitmap(80, 40)).png().bytes())
  const hash = sha256(png)
  const derived = path.join(directory, 'library/objects/derived')
  await mkdir(derived, { recursive: true })
  const blocker = path.join(derived, hash)
  await Bun.write(blocker, 'simulated unavailable derivative directory')
  const form = new FormData()
  form.set('file', new File([png], 'pending.png', { type: 'image/png' }))
  const response = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { cookie, origin: new URL(base).origin }, body: form })
  expect(response.status).toBe(202)
  const result = await response.json()
  expect(result).toEqual({ success: true, id: expect.any(String), status: 'pending' })
  await waitForProcessing()
  expect(await (await fetch(new URL('/api/photos', base))).json()).toEqual([])
  const jobs = await (await fetch(new URL('/api/jobs', base), { headers: { cookie, origin: new URL(base).origin } })).json()
  expect(jobs.find((job: { asset_hash: string }) => job.asset_hash === hash)).toMatchObject({ status: 'failed' })
  await rm(blocker)
  expect((await fetch(new URL('/api/jobs/retry', base), { method: 'POST', headers: { cookie, origin: new URL(base).origin } })).status).toBe(202)
  await waitForProcessing()
  const photos: Photo[] = await (await fetch(new URL('/api/photos', base))).json()
  expect(photos).toHaveLength(1)
  expect(photos[0]).toMatchObject({ id: result.id, name: 'pending.png', previewSrc: expect.any(String) })
  expect((await fetch(new URL(`/api/photos/${result.id}`, base), { method: 'DELETE', headers: { cookie, origin: new URL(base).origin } })).status).toBe(200)
})

test('rejects corrupt images without writing metadata', async () => {
  const form = new FormData()
  form.set('file', new File(['invalid'], 'broken.png', { type: 'image/png' }))
  const response = await fetch(new URL('/api/upload', base), { method: 'POST', headers: { cookie, origin: new URL(base).origin }, body: form })
  expect(response.status).toBe(400)
  expect(await (await fetch(new URL('/api/photos', base))).json()).toEqual([])
})

test('upload keys make concurrent requests and retries idempotent and reject changed files', async () => {
  const key = crypto.randomUUID()
  const bytes = await new Bun.Image(bitmap(91, 47)).png().blob()
  const send = (blob: Blob, uploadKey: string = key) => {
    const form = new FormData()
    form.set('file', new File([blob], 'retry.png', { type: 'image/png' }))
    return fetch(new URL('/api/upload', base), { method: 'POST', headers: { cookie, origin: new URL(base).origin, 'Idempotency-Key': uploadKey }, body: form })
  }
  const [first, second] = await Promise.all([send(bytes), send(bytes)])
  const { id } = await first.json()
  expect((await second.json()).id).toBe(id)
  await waitForProcessing()
  const photos: Photo[] = await (await fetch(new URL('/api/photos', base))).json()
  expect(photos.filter(photo => photo.id === id)).toHaveLength(1)
  const changed = await new Bun.Image(bitmap(92, 47)).png().blob()
  expect((await send(changed)).status).toBe(409)
  expect((await send(bytes, 'invalid')).status).toBe(400)
  await fetch(new URL(`/api/photos/${id}`, base), { method: 'DELETE', headers: { cookie } })
})

test('rejects excess uploads before reading their bodies and frees slots on disconnect', async () => {
  const url = new URL(base)
  const sockets: Socket[] = []
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const requests = Array.from({ length: 3 }, () => new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) })
      sockets.push(socket)
      let response = ''
      socket.on('error', reject)
      socket.on('data', chunk => {
        response += chunk.toString()
        if (response.includes('\r\n\r\n')) resolve(response)
      })
      socket.on('connect', () => {
        socket.write([
          'POST /api/upload HTTP/1.1', `Host: ${url.host}`, `Origin: ${url.origin}`, `Cookie: ${cookie}`,
          'Content-Type: multipart/form-data; boundary=slow-upload', 'Content-Length: 100000',
          'Connection: close', '', '--slow-upload\r\n',
        ].join('\r\n'))
      })
    }))
    const response = await Promise.race([
      Promise.any(requests),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Upload admission waited for the request body')), 5_000)
      }),
    ])
    expect(response).toMatch(/^HTTP\/1.1 503 /)
    expect(response.toLowerCase()).toContain('retry-after: 2')
  } finally {
    clearTimeout(timeout)
    for (const socket of sockets) socket.destroy()
  }

  // Disconnect notifications are asynchronous; probe until both abandoned jobs leave the queue.
  let status = 503
  for (let attempt = 0; attempt < 100 && status === 503; attempt++) {
    const response = await fetch(new URL('/api/upload', base), {
      method: 'POST', headers: { cookie, origin: url.origin }, body: new FormData(),
    })
    status = response.status
    await response.text()
  }
  expect(status).toBe(400)
}, 15_000)
