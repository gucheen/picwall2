import { app, auth } from './app'
import { storage } from './storage'
import { loadStaticAssets } from './static-assets'

const assets = process.env.NODE_ENV === 'production' ? await loadStaticAssets() : undefined

const server = Bun.serve({
  routes: assets?.routes,
  fetch(request) {
    const pathname = new URL(request.url).pathname
    const reserved = ['/api', '/media', '/uploads', '/thumbnails', '/previews'].some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
    if (assets && ['GET', 'HEAD'].includes(request.method) && !reserved && !pathname.split('/').pop()?.includes('.')) {
      return assets.html(request)
    }
    return app.fetch(request)
  },
  port: Number(process.env.PORT || 3000),
  hostname: process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  // Leave room for multipart headers around the 50 MiB file limit.
  maxRequestBodySize: 51 * 1024 * 1024,
  development: false,
})

console.log(`Server running at ${server.url}`)

const recovery = storage.recover().catch(error => console.error('Library recovery failed:', error))
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await server.stop()
  await recovery
  await storage.close()
  auth.close()
  process.exit(0)
}

process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
