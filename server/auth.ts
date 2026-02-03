import { Context, Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

// Environment variables should be loaded by Bun automatically from .env.local
const CLIENT_ID = Bun.env.POCKETID_CLIENT_ID!
const CLIENT_SECRET = Bun.env.POCKETID_CLIENT_SECRET!
const ISSUER = Bun.env.POCKETID_ISSUER! // e.g., https://auth.example.com
const BASE_URL = Bun.env.BASE_URL || 'http://localhost:3000'
const REDIRECT_URI = `${BASE_URL}/api/auth/callback`
const ADMIN_EMAIL = Bun.env.ADMIN_EMAIL!

// Simple in-memory session store (dictionary) for demonstration.
// In production, use Redis or a database if scaling horizontally.
// Key: SessionID, Value: UserInfo
let sessions: Record<string, any> = {}

// Load sessions from file on startup
const SESSION_FILE = './.sessions.json'

async function loadSessions() {
  try {
    if (await Bun.file(SESSION_FILE).exists()) {
      const data = await Bun.file(SESSION_FILE).json()
      sessions = data
      console.log(`Loaded ${Object.keys(sessions).length} sessions from disk.`)
    }
  } catch (e) {
    console.error('Failed to load sessions:', e)
  }
}

async function saveSessions() {
  try {
    await Bun.write(SESSION_FILE, JSON.stringify(sessions, null, 2))
  } catch (e) {
    console.error('Failed to save sessions:', e)
  }
}

// Initial load
loadSessions()

export async function login(c: Context) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
  })
  return c.redirect(`${ISSUER}/authorize?${params.toString()}`)
}

export async function callback(c: Context) {
  const code = c.req.query('code')
  if (!code) return c.text('No code provided', 400)

  // Exchange code for token
  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  })

  try {
    const tokenRes = await fetch(`${ISSUER}/api/oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams,
    })

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', tokenRes.status)
      return c.text('Token exchange failed', 500)
    }

    const tokens = await tokenRes.json()

    if (!tokens.access_token) throw new Error('No access token')

    // Get User Info
    const userRes = await fetch(`${ISSUER}/api/oidc/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })

    if (!userRes.ok) {
      console.error('User info failed:', userRes.status)
      return c.text('User info failed', 500)
    }

    const user = await userRes.json()

    // Check if Admin
    if (user.email !== ADMIN_EMAIL) {
      return c.text('Unauthorized: Not Admin', 403)
    }

    // Create Session
    const sessionId = Bun.randomUUIDv7()
    sessions[sessionId] = user
    await saveSessions()

    setCookie(c, 'session_id', sessionId, {
      httpOnly: true,
      secure: Bun.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      path: '/',
      maxAge: 3600 * 24 * 7, // 7 days
    })

    return c.redirect('/')
  } catch (err) {
    console.error(err)
    return c.text('Authentication Failed', 500)
  }
}

export async function logout(c: Context) {
  const sessionId = getCookie(c, 'session_id')
  if (sessionId) {
    delete sessions[sessionId]
    await saveSessions()
  }
  deleteCookie(c, 'session_id')
  return c.redirect('/')
}

export async function me(c: Context) {
  const sessionId = getCookie(c, 'session_id')
  if (!sessionId || !sessions[sessionId]) {
    return c.json({ user: null })
  }
  return c.json({ user: sessions[sessionId] })
}

export async function requireAuth(c: Context, next: Next) {
  const sessionId = getCookie(c, 'session_id')
  if (!sessionId || !sessions[sessionId]) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  // Proceed
  c.set('user', sessions[sessionId])
  await next()
}
