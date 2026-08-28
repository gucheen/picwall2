import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { authFixture } from '../auth-helpers'
import { bitmap } from '../helpers'
import { loadStaticAssets } from '../../server/static-assets'
import { recipeId } from '../../server/library/model'

// This loopback-only fixture owns a temporary catalog and never uses deployment credentials or data.
const directory = await mkdtemp(path.join(tmpdir(), 'picwall-browser-'))
let handler: (request: Request) => Response | Promise<Response> = () => new Response('Starting', { status: 503 })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => handler(request) })
Object.assign(process.env, {
  NODE_ENV: 'development', STORAGE_TYPE: 'local', BASE_URL: server.url.origin,
  LIBRARY_ROOT: path.join(directory, 'library'), AUTH_ROOT: path.join(directory, 'auth'),
  IMAGE_CONCURRENCY: '2', IMAGE_QUEUE_SIZE: '4',
})
const enrollment = authFixture(process.env.AUTH_ROOT!, server.url.origin)
const session = (await enrollment.enroll()).cookie
enrollment.close()
const { app, auth } = await import('../../server/app')
const { storage } = await import('../../server/storage')
const png = new Uint8Array(await new Bun.Image(bitmap(120, 80)).png().bytes())
const first = await storage.ingest(png, { name: 'fixture.png' })
const asset = storage.catalog.assets()[0]!
storage.catalog.delete(first)
for (let i = 1; i <= 135; i++) {
  const id = storage.catalog.add(asset, {
    name: `photo-${String(i).padStart(3, '0')}.png`, title: `Photo ${String(i).padStart(3, '0')}`,
    date: `2026-01-01 12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
    tags: [i % 2 ? 'odd' : 'even'],
  }, recipeId)
  if (i > 130) storage.catalog.delete(id)
}
const assets = await loadStaticAssets()
const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, 'checks.ts')], target: 'browser', minify: false })
if (!build.success) throw new AggregateError(build.logs, 'Browser checks build failed')
const checks = await build.outputs[0]!.text()
const requests: { method: string; path: string; uploadKey?: string | null }[] = []
let originalFailed = false
let uploadBusy = false
handler = async request => {
  const url = new URL(request.url)
  if (url.origin !== server.url.origin) return new Response('Invalid origin', { status: 403 })
  if (url.pathname === '/__test') return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PicWall browser regression</title></head>
    <body><h1>Isolated browser regression</h1><p>Temporary test photos only. Restart the fixture for a fresh run.</p>
    <button id="run">Run browser checks</button><a href="/" target="_blank">Open gallery</a> · <a href="/admin" target="_blank">Open admin</a>
    <ol id="results"></ol><iframe id="app" title="Test app" style="width:100%;height:700px;border:1px solid #555"></iframe>
    <script type="module" src="/__test/checks.js"></script></body></html>`,
    { headers: { 'Content-Type': 'text/html', 'Set-Cookie': `${session}; Path=/; HttpOnly; SameSite=Strict`, 'Cache-Control': 'no-store' } })
  if (url.pathname === '/__test/checks.js') return new Response(checks, { headers: { 'Content-Type': 'text/javascript' } })
  if (url.pathname === '/__test/image.png') return new Response(png, { headers: { 'Content-Type': 'image/png' } })
  if (url.pathname === '/__test/requests') return Response.json(requests)
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('.js')) {
    requests.push({ method: request.method, path: url.pathname + url.search, uploadKey: request.headers.get('Idempotency-Key') })
  }
  if (url.pathname.startsWith('/media/originals/') && !originalFailed) {
    originalFailed = true
    return new Response('Simulated first original download failure', { status: 503 })
  }
  if (url.pathname === '/api/upload' && !uploadBusy) {
    uploadBusy = true
    return Response.json({ error: 'Simulated busy queue' }, { status: 503, headers: { 'Retry-After': '1' } })
  }
  if (url.pathname === '/api/photos' && url.searchParams.get('tag') === 'odd') await Bun.sleep(150)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return app.fetch(request)
  const route = assets.routes[url.pathname]
  if (route && (request.method === 'GET' || request.method === 'HEAD')) return route[request.method](request)
  return assets.html(request)
}

console.log(`Browser regression: ${server.url.origin}/__test`)
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await server.stop(true)
  await storage.close()
  auth.close()
  await rm(directory, { recursive: true, force: true })
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
setTimeout(shutdown, 30 * 60_000).unref()
