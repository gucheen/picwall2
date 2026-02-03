import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { getPhotos, savePhoto, deletePhoto } from './photos'
import frontendApp from '../src/index.html'
import * as auth from './auth'
import { storage } from './storage'


const app = new Hono()

// Middleware
app.use('*', csrf())
app.use('*', secureHeaders())

// Helper for safe filename validation
function isValidFilename(filename: string): boolean {
  // Allow alphanumeric, dot, dash, underscore. 
  // explicitly reject ".." to prevent traversal
  return /^[a-zA-Z0-9._-]+$/.test(filename) && !filename.includes('..')
}

// Auth Routes
app.get('/api/auth/login', auth.login)
app.get('/api/auth/callback', auth.callback)
app.get('/api/auth/logout', auth.logout)
app.get('/api/auth/me', auth.me)

// API Routes
app.get('/api/photos', async (c) => {
  const photos = await getPhotos()
  return c.json(photos)
})

app.post('/api/upload', auth.requireAuth, async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']

  if (file instanceof File) {
    // Validate File Type
    if (!file.type.startsWith('image/')) {
      return c.json(
        { error: 'Invalid file type. Only images are allowed.' },
        400,
      )
    }

    // Validate File Size (50MB)
    if (file.size > 50 * 1024 * 1024) {
      return c.json({ error: 'File too large. Max size is 50MB.' }, 400)
    }

    const fileName = await savePhoto(file)
    return c.json({ success: true, fileName })
  }

  return c.json({ error: 'No file uploaded' }, 400)
})

app.delete('/api/photos/:id', auth.requireAuth, async (c) => {
  const id = c.req.param('id')
  const success = await deletePhoto(id)

  if (success) {
    return c.json({ success: true })
  } else {
    return c.json({ error: 'Failed to delete photo' }, 500)
  }
})

// Serve Static Files (Uploads & Thumbnails)
app.get('/uploads/:filename', async (c) => {
  const filename = c.req.param('filename')

  if (!isValidFilename(filename)) {
    return c.text('Invalid filename', 400)
  }

  const file = await storage.get(filename, 'uploads')

  if (file) {
    c.header('Cache-Control', 'public, immutable, max-age=31536000')
    return new Response(file)
  }
  return c.notFound()
})

app.get('/thumbnails/:filename', async (c) => {
  const filename = c.req.param('filename')

  if (!isValidFilename(filename)) {
    return c.text('Invalid filename', 400)
  }

  const file = await storage.get(filename, 'thumbnails')

  if (file) {
    c.header('Cache-Control', 'public, immutable, max-age=31536000')
    return new Response(file)
  }
  return c.notFound()
})

Bun.serve({
  routes: {
    '/': frontendApp,         // React app for all other routes
    '/admin': frontendApp,
  },
  fetch: app.fetch,
  development: process.env.NODE_ENV !== 'production' ? {
    hmr: false,
  } : false,
})

console.log('Server running at http://localhost:3000')
