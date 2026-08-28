import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAuth } from '../server/auth'
import { AuthStore, authOrigin, tokenHash } from '../server/auth-store'
import { authFixture, TestPasskey } from './auth-helpers'

let directory: string
let f: ReturnType<typeof authFixture>
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'picwall-auth-'))
  f = authFixture(directory)
})
afterEach(async () => { f.close(); await rm(directory, { recursive: true, force: true }) })
const sql = (statement: string) => { const db = new Database(path.join(directory, 'auth.sqlite')); try { db.exec(statement) } finally { db.close() } }
const protectedStatus = async (cookie: string) => (await f.app.request('/protected', { headers: { cookie } })).status

test('requires a CLI-issued token; no public or automatic first-admin registration', async () => {
  expect(await (await f.app.request('/api/auth/status')).json()).toEqual({ configured: true, initialized: false })
  for (const token of [undefined, '', '__proto__', 'a'.repeat(43)]) expect((await f.post('bootstrap/options', { token })).status).toBe(400)
  expect((await f.post('register/options')).status).toBe(401)
  expect((await f.post('reauth/options')).status).toBe(401)
  expect((await f.app.request('/api/auth/credentials')).status).toBe(401)
  const first = f.store.issueBootstrap()
  const second = f.store.issueBootstrap()
  expect(f.store.state().bootstrap_hash).toBe(tokenHash(second))
  expect((await f.post('bootstrap/options', { token: first })).status).toBe(400)
  expect((await f.post('bootstrap/options', { token: second })).status).toBe(200)
})

test('registers a real COSE key, persists hashed sessions and survives restart with private storage', async () => {
  const enrolled = await f.enroll()
  expect(await protectedStatus(enrolled.cookie)).toBe(200)
  expect(f.store.state().bootstrap_hash).toBeNull()
  expect(() => f.store.issueBootstrap()).toThrow('Already initialized')
  expect((await f.post('bootstrap/options', { token: enrolled.token })).status).toBe(400)
  const header = enrolled.response.headers.getSetCookie().find(value => value.startsWith('__Host-picwall_session='))!
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(header).toContain(flag)
  expect(header).not.toContain('Domain=')
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  expect((await stat(path.join(directory, 'auth.sqlite'))).mode & 0o777).toBe(0o600)
  const db = new Database(path.join(directory, 'auth.sqlite'), { readonly: true })
  try { expect(db.query<{ hash: string }, []>('SELECT hash FROM sessions').get()!.hash).toBe(tokenHash(enrolled.cookie.split('=')[1]!)) }
  finally { db.close() }
  f.close(); f = authFixture(directory)
  const saved = await readFile(path.join(directory, 'auth.sqlite'))
  expect(saved.includes(enrolled.token)).toBe(false)
  expect(saved.includes(enrolled.cookie.split('=')[1]!)).toBe(false)
  expect(await (await f.app.request('/api/auth/me', { headers: { cookie: enrolled.cookie } })).json()).toEqual({ user: { name: 'Administrator' } })
  const signedIn = await f.authenticate(enrolled.key)
  expect(await protectedStatus(f.cookie(signedIn, 'session'))).toBe(200)
  expect(f.store.credential(enrolled.key.id)!.counter).toBe(1)
})

test('bootstrap enrollment is atomic across concurrent browsers', async () => {
  const token = f.store.issueBootstrap()
  const starts = await Promise.all([f.post('bootstrap/options', { token }), f.post('bootstrap/options', { token })])
  const responses = await Promise.all(starts.map(async start => f.post('bootstrap/verify', {
    name: 'Admin', response: new TestPasskey().register(await start.json(), f.origin),
  }, f.cookie(start, 'ceremony'))))
  expect(responses.map(r => r.status).sort()).toEqual([200, 400])
  expect(f.store.list()).toHaveLength(1)
})

test('rejects wrong registration origin, RP ID, challenge, missing UV and cross-origin iframe ceremonies', async () => {
  const token = f.store.issueBootstrap()
  for (const override of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { challenge: 'wrong' }, { uv: false }, { crossOrigin: true }]) {
    const start = await f.post('bootstrap/options', { token })
    const response = await f.post('bootstrap/verify', { name: 'Bad key', response: new TestPasskey().register(await start.json(), f.origin, override) }, f.cookie(start, 'ceremony'))
    expect(response.status).toBe(400)
    expect(f.cookie(response, 'session')).toBe('')
    expect(f.store.list()).toHaveLength(0)
  }
})

test('requires valid signatures, UV, exact origin/RP/challenge and the single administrator user handle', async () => {
  const { key } = await f.enroll()
  for (const override of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { challenge: 'wrong' }, { uv: false }, { userHandle: 'other-admin' }, { crossOrigin: true }]) {
    const start = await f.post('login/options')
    const response = await f.post('login/verify', { response: key.authenticate(await start.json(), f.origin, override) }, f.cookie(start, 'ceremony'))
    expect(response.status).toBe(400)
    expect(f.cookie(response, 'session')).toBe('')
  }
  const start = await f.post('login/options')
  const forged = key.authenticate(await start.json(), f.origin)
  forged.response.signature = Buffer.alloc(70).toString('base64url')
  expect((await f.post('login/verify', { response: forged }, f.cookie(start, 'ceremony'))).status).toBe(400)
  expect(f.store.credential(key.id)!.counter).toBe(0)
})

test('rejects missing browser binding and concurrently replayed login responses', async () => {
  const { key } = await f.enroll()
  const start = await f.post('login/options')
  const body = { response: key.authenticate(await start.json(), f.origin) }
  expect((await f.post('login/verify', body)).status).toBe(400)
  expect((await f.post('login/verify', body, '__Host-picwall_ceremony=' + 'a'.repeat(43))).status).toBe(400)
  const results = await Promise.all([f.post('login/verify', body, f.cookie(start, 'ceremony')), f.post('login/verify', body, f.cookie(start, 'ceremony'))])
  expect(results.map(r => r.status).sort()).toEqual([200, 400])
  expect((await f.post('login/verify', body, f.cookie(start, 'ceremony'))).status).toBe(400)
})

test('consumes failed verification and does not confuse registration, login and reauthentication', async () => {
  const { key, cookie } = await f.enroll()
  let start = await f.post('login/options')
  const body = { response: key.authenticate(await start.json(), f.origin) }
  expect((await f.post('login/verify', { response: {} }, f.cookie(start, 'ceremony'))).status).toBe(400)
  expect((await f.post('login/verify', body, f.cookie(start, 'ceremony'))).status).toBe(400)
  start = await f.post('login/options')
  expect((await f.post('reauth/verify', { response: key.authenticate(await start.json(), f.origin) }, cookie + '; ' + f.cookie(start, 'ceremony'))).status).toBe(400)
  expect((await f.post('register/options', {}, cookie)).status).toBe(400)
})

test('expires bootstrap tokens, ceremonies, sessions and fresh authorization on the server', async () => {
  const { key, cookie } = await f.enroll()
  const start = await f.post('login/options')
  const response = key.authenticate(await start.json(), f.origin)
  await f.authenticate(key, 'reauth', cookie)
  let clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
  try { expect((await f.post('register/options', {}, cookie)).status).toBe(400) } finally { clock.mockRestore() }
  clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 24 * 3600_000)
  try {
    expect((await f.post('login/verify', { response }, f.cookie(start, 'ceremony'))).status).toBe(400)
    expect(await protectedStatus(cookie)).toBe(401)
  } finally { clock.mockRestore() }
  const token = f.store.issueBootstrap(true)
  sql('UPDATE auth_state SET bootstrap_expires = 1')
  expect((await f.post('bootstrap/options', { token })).status).toBe(400)
})

test('requires fresh proof to add/remove, protects the last key and revokes sessions of a removed key', async () => {
  const first = await f.enroll()
  const remove = (id: string) => f.app.request('/api/auth/credentials/' + id, { method: 'DELETE', headers: { origin: f.origin, cookie: first.cookie } })
  expect((await f.post('register/options', {}, first.cookie)).status).toBe(400)
  expect((await remove(first.key.id)).status).toBe(400)
  await f.authenticate(first.key, 'reauth', first.cookie)
  expect((await remove(first.key.id)).status).toBe(400)
  expect(f.store.list()).toHaveLength(1)
  const start = await f.post('register/options', {}, first.cookie)
  const backup = new TestPasskey()
  const options = await start.json()
  expect(options.excludeCredentials.map((key: { id: string }) => key.id)).toContain(first.key.id)
  const body = { name: 'Backup', response: backup.register(options, f.origin) }
  expect((await f.post('register/verify', body, first.cookie + '; ' + f.cookie(start, 'ceremony'))).status).toBe(200)
  expect((await f.post('register/options', {}, first.cookie)).status).toBe(400)
  const backupSession = f.cookie(await f.authenticate(backup), 'session')
  expect(await protectedStatus(backupSession)).toBe(200)
  await f.authenticate(first.key, 'reauth', first.cookie)
  expect((await remove(backup.id)).status).toBe(200)
  expect(await protectedStatus(backupSession)).toBe(401)
  expect(await protectedStatus(first.cookie)).toBe(200)
  const login = await f.post('login/options')
  expect((await f.post('login/verify', { response: backup.authenticate(await login.json(), f.origin) }, f.cookie(login, 'ceremony'))).status).toBe(400)
})

test('fresh registration permission is bound to the session that proved possession', async () => {
  const first = await f.enroll()
  const secondCookie = f.cookie(await f.authenticate(first.key), 'session')
  await f.authenticate(first.key, 'reauth', first.cookie)
  const start = await f.post('register/options', {}, first.cookie)
  const response = new TestPasskey().register(await start.json(), f.origin)
  expect((await f.post('register/verify', { name: 'Stolen', response }, secondCookie + '; ' + f.cookie(start, 'ceremony'))).status).toBe(400)
  expect(f.store.list()).toHaveLength(1)
})

test('reset revokes sessions and in-flight verification, even through an already open server connection', async () => {
  const first = await f.enroll()
  const start = await f.post('login/options')
  const previousUser = f.store.state().user_id
  const credential = f.store.credential(first.key.id)!
  const attempt = f.store.consume(tokenHash(f.cookie(start, 'ceremony').split('=')[1]!), 'login')!
  const other = new AuthStore(directory, f.origin)
  try { other.issueBootstrap(true) } finally { other.close() }
  expect(() => f.store.finishAuthentication(attempt, credential, 1)).toThrow()
  expect(f.store.state().user_id).not.toBe(previousUser)
  expect(f.store.list()).toHaveLength(0)
  expect(await protectedStatus(first.cookie)).toBe(401)
  expect((await f.post('login/verify', { response: first.key.authenticate(await start.json(), f.origin) }, f.cookie(start, 'ceremony'))).status).toBe(400)
  const replacement = await f.enroll()
  expect(await protectedStatus(replacement.cookie)).toBe(200)
})

test('rejects counter rollback but accepts synced passkeys whose counter stays zero', async () => {
  const { key } = await f.enroll()
  for (const [count, status] of [[0, 200], [0, 200], [1, 200], [1, 400], [0, 400]] as const) {
    const start = await f.post('login/options')
    const result = await f.post('login/verify', { response: key.authenticate(await start.json(), f.origin, { counter: count }) }, f.cookie(start, 'ceremony'))
    expect(result.status).toBe(status)
  }
  expect(f.store.credential(key.id)!.counter).toBe(1)
})

test('requires exact Origin and JSON, bounds request size, and rejects prototype or legacy cookies', async () => {
  const first = await f.enroll()
  for (const origin of ['', 'https://evil.example', 'null']) {
    expect((await f.app.request('/api/auth/login/options', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403)
  }
  expect((await f.app.request('/api/auth/login/options', { method: 'POST', headers: { origin: f.origin }, body: '{}' })).status).toBe(415)
  expect((await f.post('login/verify', { padding: 'x'.repeat(33000) })).status).toBe(413)
  for (const id of ['__proto__', 'constructor', 'toString', 'a'.repeat(43)]) {
    expect(await protectedStatus('__Host-picwall_session=' + id)).toBe(401)
    expect(await protectedStatus('session_id=' + id)).toBe(401)
  }
  expect((await f.app.request('/api/auth/logout', { headers: { cookie: first.cookie } })).status).toBe(404)
  expect((await f.post('logout', {}, first.cookie)).status).toBe(200)
  expect(await protectedStatus(first.cookie)).toBe(401)
  expect((await f.app.request('/api/auth/me')).headers.get('cache-control')).toBe('private, no-store')
})

test('bounds public ceremony creation and returns retry guidance', async () => {
  let response: Response | undefined
  for (let i = 0; i < 120; i++) {
    response = await f.post('login/options')
    expect(response.status).toBe(200)
  }
  response = await f.post('login/options')
  expect(response!.status).toBe(429)
  expect(response!.headers.get('retry-after')).toBe('60')
})

test('rolls back enrollment and emits no session cookie when persistence fails', async () => {
  sql("CREATE TRIGGER reject_sessions BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;")
  const token = f.store.issueBootstrap()
  const start = await f.post('bootstrap/options', { token })
  const result = await f.post('bootstrap/verify', { name: 'Admin', response: new TestPasskey().register(await start.json(), f.origin) }, f.cookie(start, 'ceremony'))
  expect(result.status).toBe(400)
  expect(f.cookie(result, 'session')).toBe('')
  expect(f.store.list()).toHaveLength(0)
  expect(f.store.bootstrapHash(token)).toBe(tokenHash(token))
})

test('revoking a credential or its session blocks a verification already in progress', async () => {
  const first = await f.enroll()
  const start = await f.post('login/options')
  const credential = f.store.credential(first.key.id)!
  const attempt = f.store.consume(tokenHash(f.cookie(start, 'ceremony').split('=')[1]!), 'login')!
  sql('PRAGMA foreign_keys = ON; DELETE FROM credentials')
  expect(() => f.store.finishAuthentication(attempt, credential, 1)).toThrow()
  expect(await protectedStatus(first.cookie)).toBe(401)
  const second = await f.enroll()
  await f.authenticate(second.key, 'reauth', second.cookie)
  const registration = await f.post('register/options', {}, second.cookie)
  const body = { name: 'Backup', response: new TestPasskey().register(await registration.json(), f.origin) }
  await f.post('logout', {}, second.cookie)
  expect((await f.post('register/verify', body, second.cookie + '; ' + f.cookie(registration, 'ceremony'))).status).toBe(401)
  expect(f.store.list()).toHaveLength(1)
})

test('replacing a setup token blocks verification that has already consumed its challenge', async () => {
  const token = f.store.issueBootstrap()
  const start = await f.post('bootstrap/options', { token })
  const attempt = f.store.consume(tokenHash(f.cookie(start, 'ceremony').split('=')[1]!), 'bootstrap')!
  f.store.issueBootstrap()
  expect(() => f.store.finishRegistration(attempt, { id: 'test', publicKey: new Uint8Array(), counter: 0 }, 'Expired enrollment')).toThrow()
  expect(f.store.list()).toHaveLength(0)
})

test('validates origin configuration and refuses accidental origin changes', async () => {
  for (const value of ['http://photos.example.test', 'https://u:p@photos.example.test', 'https://photos.example.test/path', 'https://photos.example.test?key=value', 'https://photos.example.test/#x']) {
    expect(() => authOrigin(value)).toThrow()
  }
  expect(authOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
  expect(() => new AuthStore(directory, 'https://other.example')).toThrow('BASE_URL changed')
  const disabled = createAuth({})
  try {
    expect(await (await disabled.routes.request('/status')).json()).toEqual({ configured: false, initialized: false })
    expect(await (await disabled.routes.request('/me')).json()).toEqual({ user: null })
  } finally { disabled.close() }
})

test('CLI requires explicit reset confirmation and never prints a saved setup token in status', async () => {
  const command = async (...args: string[]) => {
    const child = Bun.spawn([Bun.which('bun')!, '--no-env-file', path.resolve(import.meta.dir, '../scripts/auth.ts'), ...args], {
      env: { PATH: Bun.env.PATH, BASE_URL: f.origin, AUTH_ROOT: directory }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { out, err, code }
  }
  expect((await command('init')).code).toBe(0)
  const initialized = await command('init')
  const token = initialized.out.match(/\n([\w-]{43})\n/)![1]!
  expect(f.store.bootstrapHash(token)).toBe(tokenHash(token))
  const status = await command('status')
  expect(status.code).toBe(0)
  expect(status.out).not.toContain(token)
  const first = await f.enroll()
  expect((await command('init')).code).toBe(1)
  expect((await command('reset')).code).toBe(1)
  expect(await protectedStatus(first.cookie)).toBe(200)
  expect((await command('reset', '--confirm')).code).toBe(0)
  expect(await protectedStatus(first.cookie)).toBe(401)
})
