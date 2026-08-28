import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server'
import { Hono } from 'hono'
import { createAuth } from '../server/auth'
import { AuthStore } from '../server/auth-store'

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest()
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

export class TestPasskey {
  readonly id = randomBytes(32).toString('base64url')
  readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  userHandle = ''
  counter = 0
  register(options: PublicKeyCredentialCreationOptionsJSON, origin: string, overrides: { origin?: string; rpID?: string; uv?: boolean; challenge?: string; crossOrigin?: boolean } = {}): RegistrationResponseJSON {
    this.userHandle = options.user.id
    const jwk = this.keys.publicKey.export({ format: 'jwk' })
    const publicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
    ]))
    const credentialId = Buffer.from(this.id, 'base64url')
    const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length)
    const authData = Buffer.concat([hash(overrides.rpID ?? options.rp.id!), Buffer.from([overrides.uv === false ? 0x41 : 0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credentialId, publicKey])
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: b64(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: overrides.challenge ?? options.challenge, origin: overrides.origin ?? origin, crossOrigin: overrides.crossOrigin ?? false }))),
        attestationObject: b64(isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
        transports: ['internal'],
      },
    }
  }
  authenticate(options: PublicKeyCredentialRequestOptionsJSON, origin: string, overrides: { origin?: string; rpID?: string; uv?: boolean; challenge?: string; userHandle?: string; counter?: number; crossOrigin?: boolean } = {}): AuthenticationResponseJSON {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: overrides.challenge ?? options.challenge, origin: overrides.origin ?? origin, crossOrigin: overrides.crossOrigin ?? false }))
    const counter = Buffer.alloc(4); counter.writeUInt32BE(overrides.counter ?? ++this.counter)
    const authData = Buffer.concat([hash(overrides.rpID ?? options.rpId!), Buffer.from([overrides.uv === false ? 0x01 : 0x05]), counter])
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), userHandle: overrides.userHandle ?? this.userHandle,
        signature: b64(sign('sha256', Buffer.concat([authData, hash(clientData)]), this.keys.privateKey)) },
    }
  }
}

export function authFixture(directory: string, origin = 'https://photos.example.test') {
  const store = new AuthStore(directory, origin)
  const auth = createAuth({ directory, baseURL: origin })
  const app = new Hono().route('/api/auth', auth.routes).get('/protected', auth.requireAuth, c => c.json({ authorized: true }))
  const post = (route: string, body: unknown = {}, cookie = '') => app.request(origin + '/api/auth/' + route, {
    method: 'POST', headers: { origin, cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const cookie = (response: Response, type: 'session' | 'ceremony') => response.headers.getSetCookie()
    .find(value => value.startsWith((origin.startsWith('https:') ? '__Host-' : '') + 'picwall_' + type + '='))?.split(';')[0] ?? ''
  async function enroll(key = new TestPasskey()) {
    const token = store.issueBootstrap()
    const begin = await post('bootstrap/options', { token })
    if (begin.status !== 200) throw new Error(await begin.text())
    const options = await begin.json()
    const response = await post('bootstrap/verify', { name: 'Test passkey', response: key.register(options, origin) }, cookie(begin, 'ceremony'))
    if (response.status !== 200) throw new Error(await response.text())
    return { key, token, cookie: cookie(response, 'session'), response }
  }
  async function authenticate(key: TestPasskey, kind: 'login' | 'reauth' = 'login', session = '') {
    const begin = await post(kind + '/options', {}, session)
    if (begin.status !== 200) throw new Error(await begin.text())
    const response = await post(kind + '/verify', { response: key.authenticate(await begin.json(), origin) }, [session, cookie(begin, 'ceremony')].filter(Boolean).join('; '))
    if (response.status !== 200) throw new Error(await response.text())
    return response
  }
  return { store, auth, app, origin, post, cookie, enroll, authenticate, close: () => { auth.close(); store.close() } }
}
