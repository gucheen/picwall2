import { Hono, type Context, type Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from '@simplewebauthn/server'
import { AuthError, AuthStore, authOrigin, tokenHash, validToken, ceremonyLifetime, sessionLifetime } from './auth-store'

export function createAuth(options: { baseURL?: string; directory?: string }) {
  const origin = authOrigin(options.baseURL)
  const rpID = origin ? new URL(origin).hostname : undefined
  const secure = origin?.startsWith('https:') ?? false
  const store = origin ? new AuthStore(options.directory ?? './data/auth', origin) : undefined
  const sessionCookie = secure ? '__Host-picwall_session' : 'picwall_session'
  const ceremonyCookie = secure ? '__Host-picwall_ceremony' : 'picwall_ceremony'
  const cookieOptions = { httpOnly: true, secure, sameSite: 'Strict' as const, path: '/' }
  const routes = new Hono()
  const hashCookie = (c: Context, name: string) => {
    const value = getCookie(c, name)
    return validToken(value) ? tokenHash(value) : undefined
  }
  const currentSession = (c: Context) => store?.session(hashCookie(c, sessionCookie))
  const requireAuth = async (c: Context, next: Next) => {
    c.header('Cache-Control', 'private, no-store')
    if (!currentSession(c)) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  }
  const setSession = (c: Context, secret: string | undefined) => {
    if (secret) setCookie(c, sessionCookie, secret, { ...cookieOptions, maxAge: sessionLifetime })
  }
  let windowStart = 0
  let requests = 0
  const configured = () => !!store && store.state().origin === origin
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!configured()) return c.json({ error: 'Authentication is not configured' }, 503)
      if (c.req.header('Origin') !== origin || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'Forbidden' }, 403)
      if (c.req.method === 'POST' && c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ error: 'JSON required' }, 415)
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = 0 }
      if (++requests > 120) { c.header('Retry-After', '60'); return c.json({ error: 'Too many requests; try again in a minute' }, 429) }
    }
    await next()
  })
  routes.use('*', bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: 'Authentication request too large' }, 413) }))
  routes.onError((error, c) => {
    if (error instanceof AuthError) return c.json({ error: error.message }, 400)
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400)
    console.error('Authentication request failed')
    return c.json({ error: 'Authentication failed' }, 500)
  })
  routes.get('/me', c => c.json({ user: currentSession(c) ? { name: 'Administrator' } : null }))
  routes.get('/status', c => c.json({ configured: configured(), initialized: !!store?.list().length }))
  routes.use('*', async (c, next) => {
    if (!store || store.state().origin !== origin) return c.json({ error: 'Authentication is not configured; set BASE_URL and initialize using the CLI' }, 503)
    await next()
  })
  routes.post('/logout', c => {
    store!.logout(hashCookie(c, sessionCookie))
    deleteCookie(c, sessionCookie, cookieOptions)
    return c.json({ success: true })
  })
  routes.get('/credentials', requireAuth, c => c.json({ credentials: store!.list(), current: currentSession(c)!.credential_id }))
  routes.delete('/credentials/:id', requireAuth, c => {
    store!.remove(c.req.param('id')!, hashCookie(c, sessionCookie))
    const signedOut = !currentSession(c)
    if (signedOut) deleteCookie(c, sessionCookie, cookieOptions)
    return c.json({ success: true, signedOut })
  })

  for (const kind of ['bootstrap', 'register', 'login', 'reauth'] as const) {
    const registration = kind === 'bootstrap' || kind === 'register'
    const authenticated = kind === 'register' || kind === 'reauth'
    if (authenticated) routes.use('/' + kind + '/*', requireAuth)
    routes.post('/' + kind + '/options', async c => {
      const state = store!.state()
      const bootstrapHash = kind === 'bootstrap' ? store!.bootstrapHash((await c.req.json())?.token) : undefined
      const optionsJSON = registration
        ? await generateRegistrationOptions({
          rpName: 'PicWall', rpID: rpID!, userName: 'Administrator', userID: Buffer.from(state.user_id, 'base64url'),
          attestationType: 'none', timeout: ceremonyLifetime * 1000,
          supportedAlgorithmIDs: [-8, -7, -257],
          excludeCredentials: store!.list().map(({ id }) => ({ id })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        })
        : await generateAuthenticationOptions({ rpID: rpID!, userVerification: 'required', timeout: ceremonyLifetime * 1000 })
      const secret = store!.begin(kind, optionsJSON.challenge, state.epoch, hashCookie(c, ceremonyCookie),
        authenticated ? hashCookie(c, sessionCookie) : undefined, bootstrapHash)
      setCookie(c, ceremonyCookie, secret, { ...cookieOptions, maxAge: ceremonyLifetime })
      return c.json(optionsJSON)
    })
    routes.post('/' + kind + '/verify', async c => {
      const attempt = store!.consume(hashCookie(c, ceremonyCookie), kind, authenticated ? hashCookie(c, sessionCookie) : undefined)
      deleteCookie(c, ceremonyCookie, cookieOptions)
      if (!attempt) throw new AuthError('Invalid or expired authentication request; please try again')
      const body = await c.req.json()
      try {
        if (!body || typeof body !== 'object') throw new AuthError('Invalid authentication response')
        const clientData = JSON.parse(Buffer.from(body.response?.response?.clientDataJSON ?? '', 'base64url').toString('utf8'))
        if (clientData.crossOrigin === true || clientData.topOrigin && clientData.topOrigin !== origin) throw new AuthError('Cross-origin passkey requests are not allowed')
        if (registration) {
          if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) throw new AuthError('Give this passkey a name (1–80 characters)')
          const result = await verifyRegistrationResponse({
            response: body.response as RegistrationResponseJSON, expectedChallenge: attempt.challenge,
            expectedOrigin: origin!, expectedRPID: rpID!, requireUserVerification: true,
            supportedAlgorithmIDs: [-8, -7, -257],
          })
          if (!result.verified) throw new AuthError('Passkey verification failed')
          setSession(c, store!.finishRegistration(attempt, result.registrationInfo.credential, body.name.trim(), hashCookie(c, sessionCookie)))
        } else {
          const response = body.response as AuthenticationResponseJSON
          const credential = typeof response?.id === 'string' ? store!.credential(response.id) : undefined
          if (!credential || response.response?.userHandle !== store!.state().user_id) throw new AuthError('Passkey verification failed')
          const result = await verifyAuthenticationResponse({
            response, credential, expectedChallenge: attempt.challenge, expectedOrigin: origin!, expectedRPID: rpID!, requireUserVerification: true,
          })
          if (!result.verified) throw new AuthError('Passkey verification failed')
          setSession(c, store!.finishAuthentication(attempt, credential, result.authenticationInfo.newCounter, hashCookie(c, sessionCookie)))
        }
        return c.json({ success: true })
      } catch (error) {
        if (error instanceof AuthError) throw error
        throw new AuthError('Passkey verification failed; please try again')
      }
    })
  }
  return { routes, requireAuth, close: () => store?.close() }
}
