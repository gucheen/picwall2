import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { secureHeaders } from 'hono/secure-headers'
import { getPhotos, savePhoto, deletePhoto } from './photos.js'
import * as auth from './auth.js'
import { storage } from './storage.js'

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
    // S3Adapter returns a stream/buffer differently now, adjust usage in storage.ts or here.
    // For Node adapter, returning a Response with Body init (stream/buffer) is fine.
    // Ensure storage.get returns something compatible with new Response().
    return new Response(file as any) 
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
    return new Response(file as any)
  }
  return c.notFound()
})

// Production: Serve static assets from dist/public (built by Vite)
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist/public' }))
  
  // SPA Fallback
  app.get('*', async (c) => {
     try {
       return c.html(await readFile('./dist/public/index.html', 'utf-8'))
     } catch(e) {
       return c.text('Not Found', 404)
     }
  })
}

const port = 3000
console.log(`Server running at http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port,
})
