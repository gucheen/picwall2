import { validKey } from './library/model'
import { InvalidImageError } from './image'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { getPhotosResponse, getPhotoPageResponse, getTagsResponse, savePhoto, deletePhoto, updatePhoto, updatePhotos } from './photos'
import { pageOptions, adminPageOptions, InvalidPageError } from './pagination'
import { QueueFullError } from './task-queue'
import { createAuth } from './auth'
import { storage, photoDatabase } from './storage'
import type { Photo } from '../types/shared_types'
import { normalizePhotoTitle, normalizePhotoLocation } from '../types/photo-metadata'
import { ImportConflictError } from './library/service'

const validId = (id: unknown): id is string => typeof id === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
const validTags = (tags: unknown): tags is string[] => Array.isArray(tags) && tags.length <= 100
  && tags.every(tag => typeof tag === 'string' && tag.length <= 256)

export const app = new Hono()
export const auth = createAuth({ baseURL: process.env.BASE_URL, directory: process.env.AUTH_ROOT })
const publicOrigin = process.env.BASE_URL ? new URL(process.env.BASE_URL).origin : undefined

// Middleware
app.use('*', secureHeaders())
app.use('*', csrf({ origin: publicOrigin ?? ((origin, c) => origin === new URL(c.req.url).origin) }))
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin')
    const expected = publicOrigin ?? new URL(c.req.url).origin
    if ((origin && origin !== expected) || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.text('Forbidden', 403)
  }
  await next()
})
app.use('/api/auth/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store')
  await next()
})

// Auth Routes
app.route('/api/auth', auth.routes)

// API Routes
app.get('/api/photos', c => {
  const query = c.req.query()
  if (!['limit', 'cursor', 'tag'].some(key => key in query)) return getPhotosResponse(c.req.header('If-None-Match'))
  try { return getPhotoPageResponse(pageOptions(query), c.req.header('If-None-Match')) }
  catch (error) {
    if (error instanceof InvalidPageError) return c.json({ error: error.message }, 400)
    throw error
  }
})
app.get('/api/tags', c => getTagsResponse(c.req.header('If-None-Match')))
app.get('/api/trash', auth.requireAuth, c => {
  try {
    const query = c.req.query()
    return c.json('limit' in query || 'cursor' in query ? photoDatabase.trashPage(adminPageOptions(query)) : photoDatabase.trash())
  } catch (error) {
    if (error instanceof InvalidPageError) return c.json({ error: error.message }, 400)
    throw error
  }
})
app.get('/api/jobs', auth.requireAuth, c => {
  try {
    const query = c.req.query()
    return c.json('limit' in query || 'cursor' in query ? photoDatabase.jobPage(adminPageOptions(query)) : photoDatabase.jobs())
  } catch (error) {
    if (error instanceof InvalidPageError) return c.json({ error: error.message }, 400)
    throw error
  }
})
app.post('/api/jobs/retry', auth.requireAuth, async c => {
  void storage.recover().catch(error => console.error('Library recovery failed:', error))
  return c.json({ success: true }, 202)
})

app.post('/api/upload', auth.requireAuth, async (c) => {
  try {
    const key = c.req.header('Idempotency-Key')
    if (key !== undefined && !validId(key)) return c.json({ error: 'Invalid upload key' }, 400)
    const id = await savePhoto(async () => {
      const body = await c.req.parseBody()
      const file = body['file']
      if (!(file instanceof File)) throw new InvalidImageError('No file uploaded')
      if (!file.type.startsWith('image/')) throw new InvalidImageError('Invalid file type. Only images are allowed.')
      if (file.size > 50 * 1024 * 1024) throw new InvalidImageError('File too large. Max size is 50MB.')
      return file
    }, c.req.raw.signal, key ? `upload:${key}` : undefined)
    const status = photoDatabase.get(id) ? 'ready' : 'pending'
    return c.json({ success: true, id, status }, status === 'ready' ? 200 : 202)
  } catch (error) {
    if (error instanceof ImportConflictError) return c.json({ error: 'Upload key already belongs to another file' }, 409)
    if (error instanceof InvalidImageError) return c.json({ error: error.message }, 400)
    if (error instanceof QueueFullError) {
      c.header('Retry-After', '2')
      return c.json({ error: error.message }, 503)
    }
    if (c.req.raw.signal.aborted) return c.body(null, 408)
    throw error
  }
})

app.delete('/api/photos/:id', auth.requireAuth, async (c) => {
  const id = c.req.param('id')
  if (!validId(id)) return c.json({ error: 'Invalid photo ID' }, 400)
  const success = await deletePhoto(id)

  if (success) {
    return c.json({ success: true })
  } else {
    return c.json({ error: 'Photo not found' }, 404)
  }
})

app.post('/api/photos/:id/restore', auth.requireAuth, c => {
  const id = c.req.param('id')
  if (!validId(id)) return c.json({ error: 'Invalid photo ID' }, 400)
  return photoDatabase.restore(id)
    ? c.json({ success: true })
    : c.json({ error: 'Deleted photo not found' }, 404)
})

app.patch('/api/photos/:id', auth.requireAuth, async (c) => {
  const id = c.req.param('id')
  if (!validId(id)) return c.json({ error: 'Invalid photo ID' }, 400)
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length
    || Object.keys(body).some(key => !['tags', 'title', 'location'].includes(key))) return c.json({ error: 'Invalid photo update' }, 400)
  const updates: Partial<Photo> = {}
  try {
    if (Object.hasOwn(body, 'tags')) {
      if (!validTags(body.tags)) return c.json({ error: 'Invalid tags' }, 400)
      updates.tags = body.tags
    }
    if (Object.hasOwn(body, 'title')) updates.title = normalizePhotoTitle(body.title)
    if (Object.hasOwn(body, 'location')) updates.location = normalizePhotoLocation(body.location)
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Invalid photo update' }, 400) }
  if (!photoDatabase.record(id) || photoDatabase.record(id)!.deleted_at !== null) return c.json({ error: 'Photo not found' }, 404)

  await updatePhoto(id, updates)
  return c.json({ success: true })
})

app.patch('/api/photos', auth.requireAuth, async (c) => {
  const body = await c.req.json<{ ids?: unknown, tags?: unknown }>().catch(() => null)

  if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 1000
    || !body.ids.every(validId) || !validTags(body.tags)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (body.ids.some(id => !photoDatabase.record(id) || photoDatabase.record(id)!.deleted_at !== null)) {
    return c.json({ error: 'Photo not found' }, 404)
  }

  const tags = body.tags
  await updatePhotos(body.ids.map(id => ({ id, partial: { tags } })))
  
  return c.json({ success: true })
})

app.get('/media/*', async c => {
  let key: string
  try { key = decodeURIComponent(c.req.path.slice('/media/'.length)) }
  catch { return c.text('Invalid object key', 400) }
  if (!validKey(key)) return c.text('Invalid object key', 400)
  const file = await storage.getResponse(key)
  if (!file) return c.notFound()
  c.res = file
  if (!file.headers.has('Cache-Control')) c.header('Cache-Control', 'public, immutable, max-age=31536000')
  return c.res
})

// Missing API or image paths must not fall through to the SPA document.
app.all('/api/*', c => c.notFound())
app.all('/media/*', c => c.notFound())
app.all('/uploads/*', c => c.notFound())
app.all('/thumbnails/*', c => c.notFound())
app.all('/previews/*', c => c.notFound())
