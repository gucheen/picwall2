import { useEffect, useState } from 'react'
import { browserSupportsWebAuthn } from '@simplewebauthn/browser'
import { authenticate, authRequest, passkeyError, registerPasskey } from '../lib/passkeys'
import styles from './Security.module.css'

export default function Login() {
  const [status, setStatus] = useState<{ configured: boolean; initialized: boolean }>()
  const [token, setToken] = useState('')
  const [name, setName] = useState('My passkey')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const supported = browserSupportsWebAuthn() && window.isSecureContext
  useEffect(() => {
    authRequest<{ configured: boolean; initialized: boolean }>('status').then(setStatus).catch(error => setError(passkeyError(error)))
  }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (status?.initialized) await authenticate('login')
      else await registerPasskey('bootstrap', name.trim(), token.trim())
      setToken('')
      window.location.assign('/admin')
    } catch (error) { setError(passkeyError(error)) }
    finally { setBusy(false) }
  }
  return <main className={styles.page}>
    <a href="/" className={styles.back}>← Gallery</a>
    <section className={styles.card}>
      <p className={styles.eyebrow}>PICWALL · ADMIN</p>
      <h1>{status?.initialized ? 'Welcome back' : 'Set up your passkey'}</h1>
      {!status && !error && <p>Loading…</p>}
      {status && !status.configured && <p>Admin login is not configured. Set BASE_URL on the server first.</p>}
      {status?.configured && <>
        <p>{status.initialized ? 'Use your device lock, password manager or security key to sign in.' : 'Run bun run auth init on the server, then enter the one-time token below. Setup tokens expire after 10 minutes.'}</p>
        {!supported && <p role="alert">Passkeys require a compatible browser and HTTPS (or localhost for development).</p>}
        <form onSubmit={submit} className={styles.form}>
          {!status.initialized && <>
            <label>Setup token<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} required maxLength={43} disabled={busy} /></label>
            <label>Passkey name<input value={name} onChange={event => setName(event.target.value)} autoComplete="off" required maxLength={80} disabled={busy} placeholder="e.g. Phone or security key" /></label>
          </>}
          <button disabled={busy || !supported}>{busy ? 'Waiting for your passkey…' : status.initialized ? 'Sign in with a passkey' : 'Create admin passkey'}</button>
        </form>
        <p className={styles.hint}>{status.initialized ? 'Lost every passkey? Recovery requires access to the server. There is no password or email fallback.' : 'After setup, add a backup passkey in Security settings to avoid losing access.'}</p>
      </>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  </main>
}
