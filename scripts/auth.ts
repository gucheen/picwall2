import { AuthStore, authOrigin } from '../server/auth-store'

const [command, ...args] = process.argv.slice(2)
if (!['init', 'status', 'reset'].includes(command ?? '') || args.some(arg => arg !== '--confirm')
  || (command === 'reset' ? args.length !== 1 : args.length !== 0)) {
  console.error('Usage: bun run auth <init|status|reset --confirm>\nSet BASE_URL and optionally AUTH_ROOT in your environment. Stop the server before reset.')
  process.exit(1)
}
let store: AuthStore | undefined
try {
  const origin = authOrigin(process.env.BASE_URL)
  if (!origin) throw new Error('Set BASE_URL to the browser-facing origin first')
  store = new AuthStore(process.env.AUTH_ROOT ?? './data/auth', origin, command === 'reset')
  if (command === 'status') {
    console.log(JSON.stringify({ origin, credentials: store.list(), setupTokenActive: store.state().bootstrap_expires > Date.now() }, null, 2))
  } else {
    const secret = store.issueBootstrap(command === 'reset')
    console.log(`${command === 'reset' ? 'All passkeys, sessions and pending requests have been revoked.\n' : ''}Open ${origin}/login and enter this single-use setup token within 10 minutes:\n\n${secret}\n\nKeep this token private. Re-running init replaces an unused token. Register a backup passkey after setup.`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Authentication command failed')
  process.exitCode = 1
} finally { store?.close() }
