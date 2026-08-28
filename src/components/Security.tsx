import { useEffect, useState } from 'react'
import { authenticate, authRequest, passkeyError, registerPasskey } from '../lib/passkeys'
import styles from './Security.module.css'

interface Keys { credentials: { id: string; name: string; created_at: number }[]; current: string }
export default function Security() {
  const [keys, setKeys] = useState<Keys>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refresh = async () => setKeys(await authRequest<Keys>('credentials'))
  useEffect(() => { refresh().catch(error => setError(passkeyError(error))) }, [])
  async function action(operation: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await operation() }
    catch (error) { setError(passkeyError(error)) }
    finally { setBusy(false) }
  }
  async function remove(id: string, name: string) {
    if (!window.confirm(`Remove “${name}”? Sessions signed in with this passkey will also be revoked.`)) return
    setVerified(false)
    await action(async () => {
      await authenticate('reauth')
      const result = await authRequest<{ signedOut: boolean }>('credentials/' + encodeURIComponent(id), undefined, 'DELETE')
      if (result.signedOut) window.location.assign('/login')
      else { await refresh(); setNotice('Passkey removed and its sessions revoked.') }
    })
  }
  return <main className={styles.page}>
    <a href="/admin" className={styles.back}>← Photo management</a>
    <section className={styles.card}>
      <p className={styles.eyebrow}>PICWALL · SECURITY</p>
      <h1>Your passkeys</h1>
      <p>Keep a backup on another device or security key. Changing passkeys requires a fresh verification.</p>
      {!keys && !error && <p>Loading…</p>}
      {keys && <>
        <ul className={styles.keys}>{keys.credentials.map(key => <li key={key.id}>
          <div><strong>{key.name}</strong><span>Added {new Date(key.created_at).toLocaleDateString()}{key.id === keys.current ? ' · This session' : ''}</span></div>
          <button className={styles.secondary} disabled={busy || keys.credentials.length === 1} onClick={() => remove(key.id, key.name)}>Remove</button>
        </li>)}</ul>
        {keys.credentials.length === 1 && <p className={styles.hint}>Your last passkey cannot be removed. Add a backup first.</p>}
        <form className={styles.form} onSubmit={event => {
          event.preventDefault()
          void action(async () => {
            if (!verified) { await authenticate('reauth'); setVerified(true); setNotice('Verified. Create your new passkey within one minute.'); return }
            setVerified(false)
            await registerPasskey('register', name.trim())
            setName(''); await refresh(); setNotice('Backup passkey added.')
          })
        }}>
          <label>New passkey name<input value={name} onChange={event => setName(event.target.value)} required maxLength={80} disabled={busy} placeholder="e.g. Backup security key" /></label>
          <button disabled={busy || keys.credentials.length >= 10}>{busy ? 'Waiting for your passkey…' : verified ? 'Create new passkey' : 'Verify to add a passkey'}</button>
        </form>
        <p className={styles.hint}>Up to 10 passkeys. If all are lost, stop the service and use the auth reset command on the server.</p>
        <button className={styles.secondary} disabled={busy} onClick={() => action(async () => { await authRequest('logout', {}); window.location.assign('/') })}>Sign out</button>
      </>}
      {error && <p className={styles.error} role="alert">{error} {!keys && <a href="/login">Sign in</a>}</p>}
      {notice && <p className={styles.hint} role="status">{notice}</p>}
    </section>
  </main>
}
