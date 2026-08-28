import { Database } from 'bun:sqlite'
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs'
import path from 'node:path'
import type { WebAuthnCredential } from '@simplewebauthn/server'

export const sessionLifetime = 7 * 24 * 60 * 60
export const ceremonyLifetime = 5 * 60
const bootstrapLifetime = 10 * 60
const token = () => randomBytes(32).toString('base64url')
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
export const validToken = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{43}$/.test(value)

export class AuthError extends Error {}
function ensure(value: unknown, message = 'Invalid or expired authentication request'): asserts value {
  if (!value) throw new AuthError(message)
}

interface State { epoch: string; user_id: string; origin: string; bootstrap_hash: string | null; bootstrap_expires: number }
export interface Session { hash: string; credential_id: string; expires_at: number; fresh_until: number }
export type CeremonyKind = 'bootstrap' | 'register' | 'login' | 'reauth'
export interface Ceremony {
  hash: string; kind: CeremonyKind; challenge: string; epoch: string; expires_at: number
  session_hash: string | null; bootstrap_hash: string | null
}
interface CredentialRow { id: string; name: string; public_key: Uint8Array; counter: number; transports: string; created_at: number }

export function authOrigin(value: string | undefined) {
  if (!value) return undefined
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('BASE_URL must be an HTTPS origin (HTTP is allowed only on loopback)')
  }
  return url.origin
}

export class AuthStore {
  private db: Database
  constructor(directory: string, readonly origin: string, allowReset = false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const file = path.join(directory, 'auth.sqlite')
    closeSync(openSync(file, 'a', 0o600))
    chmodSync(file, 0o600)
    this.db = new Database(file, { strict: true })
    try {
      this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS auth_state (
          id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL, user_id TEXT NOT NULL, origin TEXT NOT NULL,
          bootstrap_hash TEXT, bootstrap_expires INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS credentials (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
          transports TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          hash TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL, fresh_until INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS ceremonies (
          hash TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL, epoch TEXT NOT NULL,
          expires_at INTEGER NOT NULL, session_hash TEXT, bootstrap_hash TEXT);`)
      this.db.query('INSERT OR IGNORE INTO auth_state(id, epoch, user_id, origin) VALUES (1, ?, ?, ?)').run(token(), token(), origin)
      if (!allowReset && this.state().origin !== origin) throw new Error('BASE_URL changed. Restore the original origin or run auth reset --confirm to enroll new passkeys.')
    } catch (error) { this.db.close(); throw error }
  }

  state() { return this.db.query<State, []>('SELECT * FROM auth_state WHERE id = 1').get()! }
  close() { this.db.close() }
  list() {
    return this.db.query<Pick<CredentialRow, 'id' | 'name' | 'created_at'>, []>('SELECT id, name, created_at FROM credentials ORDER BY created_at, id').all()
  }
  credential(id: string): WebAuthnCredential | undefined {
    const row = this.db.query<CredentialRow, [string]>('SELECT * FROM credentials WHERE id = ?').get(id)
    return row ? { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) } : undefined
  }
  session(hash: string | undefined): Session | undefined {
    if (!hash || this.state().origin !== this.origin) return undefined
    return this.db.query<Session, [string, number]>('SELECT * FROM sessions WHERE hash = ? AND expires_at > ?').get(hash, Date.now()) ?? undefined
  }
  logout(hash: string | undefined) {
    if (hash) this.db.query('DELETE FROM sessions WHERE hash = ?').run(hash)
  }
  private prune() {
    this.db.query('DELETE FROM ceremonies WHERE expires_at <= ?').run(Date.now())
    this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  }
  issueBootstrap(reset = false) {
    return this.db.transaction(() => {
      if (!reset) ensure(this.list().length === 0, 'Already initialized; use a registered passkey or explicit offline reset')
      if (reset) {
        this.db.exec('DELETE FROM sessions; DELETE FROM credentials; DELETE FROM ceremonies;')
        this.db.query('UPDATE auth_state SET epoch = ?, user_id = ?, origin = ? WHERE id = 1').run(token(), token(), this.origin)
      }
      const secret = token()
      this.db.query('UPDATE auth_state SET bootstrap_hash = ?, bootstrap_expires = ? WHERE id = 1')
        .run(tokenHash(secret), Date.now() + bootstrapLifetime * 1000)
      this.db.query("DELETE FROM ceremonies WHERE kind = 'bootstrap'").run()
      return secret
    }).immediate()
  }
  bootstrapHash(secret: unknown) {
    const state = this.state()
    ensure(validToken(secret) && state.origin === this.origin && this.list().length === 0
      && state.bootstrap_expires > Date.now() && tokenHash(secret) === state.bootstrap_hash, 'Invalid or expired setup token')
    return state.bootstrap_hash!
  }

  begin(kind: CeremonyKind, challenge: string, epoch: string, previous: string | undefined, sessionHash?: string, bootstrapHash?: string) {
    return this.db.transaction(() => {
      this.prune()
      const state = this.state()
      ensure(state.origin === this.origin && state.epoch === epoch)
      if (previous) this.db.query('DELETE FROM ceremonies WHERE hash = ?').run(previous)
      ensure(this.db.query<{ count: number }, []>('SELECT count(*) AS count FROM ceremonies').get()!.count < 1000, 'Too many pending requests; try again later')
      if (kind === 'register' || kind === 'reauth') ensure(this.session(sessionHash))
      if (kind === 'register') { this.consumeFresh(sessionHash); ensure(this.list().length < 10, 'At most 10 passkeys may be registered') }
      if (kind === 'bootstrap') ensure(bootstrapHash && state.bootstrap_hash === bootstrapHash && state.bootstrap_expires > Date.now() && this.list().length === 0)
      const secret = token()
      this.db.query('INSERT INTO ceremonies VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tokenHash(secret), kind, challenge, epoch, Date.now() + ceremonyLifetime * 1000, sessionHash ?? null, bootstrapHash ?? null)
      return secret
    }).immediate()
  }

  consume(secret: string | undefined, kind: CeremonyKind, sessionHash?: string) {
    return this.db.transaction(() => {
      const attempt = this.db.query<Ceremony, [string]>('DELETE FROM ceremonies WHERE hash = ? RETURNING *').get(secret ?? '')
      // Commit consumption even on a malformed response; one challenge must never reach verification twice.
      if (!attempt || attempt.kind !== kind || attempt.expires_at <= Date.now()
        || attempt.epoch !== this.state().epoch || (attempt.session_hash ?? undefined) !== sessionHash) return undefined
      return attempt
    }).immediate()
  }
  private checkAttempt(attempt: Ceremony) {
    const state = this.state()
    ensure(state.origin === this.origin && state.epoch === attempt.epoch && attempt.expires_at > Date.now())
    if (attempt.session_hash) ensure(this.session(attempt.session_hash))
  }
  private newSession(credentialId: string, previous?: string) {
    this.prune()
    this.logout(previous)
    // Keep storage bounded without allowing unauthenticated clients to evict sessions.
    this.db.exec('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 99)')
    const secret = token()
    this.db.query('INSERT INTO sessions(hash, credential_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(secret), credentialId, Date.now() + sessionLifetime * 1000)
    return secret
  }
  finishRegistration(attempt: Ceremony, credential: WebAuthnCredential, name: string, previous?: string) {
    return this.db.transaction(() => {
      this.checkAttempt(attempt)
      ensure(attempt.kind === 'bootstrap' || attempt.kind === 'register')
      ensure(this.list().length < 10 && !this.credential(credential.id), 'Passkey already exists or the limit has been reached')
      if (attempt.kind === 'bootstrap') {
        const state = this.state()
        ensure(this.list().length === 0 && state.bootstrap_hash === attempt.bootstrap_hash && state.bootstrap_expires > Date.now())
        this.db.query('UPDATE auth_state SET bootstrap_hash = NULL, bootstrap_expires = 0 WHERE id = 1').run()
        this.db.query("DELETE FROM ceremonies WHERE kind = 'bootstrap'").run()
      }
      this.db.query('INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?)')
        .run(credential.id, name, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), Date.now())
      return attempt.kind === 'bootstrap' ? this.newSession(credential.id, previous) : undefined
    }).immediate()
  }
  finishAuthentication(attempt: Ceremony, credential: WebAuthnCredential, counter: number, previous?: string) {
    return this.db.transaction(() => {
      this.checkAttempt(attempt)
      ensure(attempt.kind === 'login' || attempt.kind === 'reauth')
      // Recheck after asynchronous signature verification, including concurrent revocation and counter updates.
      const current = this.credential(credential.id)
      ensure(current && current.counter === credential.counter && Buffer.from(current.publicKey).equals(Buffer.from(credential.publicKey)))
      this.db.query('UPDATE credentials SET counter = ? WHERE id = ?').run(counter, credential.id)
      if (attempt.kind === 'reauth') {
        this.db.query('UPDATE sessions SET fresh_until = ? WHERE hash = ?').run(Date.now() + 60_000, attempt.session_hash!)
        return undefined
      }
      return this.newSession(credential.id, previous)
    }).immediate()
  }
  private consumeFresh(hash: string | undefined) {
    const session = this.session(hash)
    ensure(session && session.fresh_until > Date.now(), 'Verify a passkey again before changing security settings')
    this.db.query('UPDATE sessions SET fresh_until = 0 WHERE hash = ?').run(hash!)
  }
  remove(id: string, sessionHash: string | undefined) {
    this.db.transaction(() => {
      this.consumeFresh(sessionHash)
      ensure(this.list().length > 1, 'Add a backup passkey before removing the last one')
      ensure(this.credential(id), 'Passkey not found')
      this.db.query('DELETE FROM credentials WHERE id = ?').run(id)
    }).immediate()
  }
}
