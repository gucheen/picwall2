import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

export async function authRequest<T>(route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch('/api/auth/' + route, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store',
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Authentication request failed')
  return data as T
}

export async function authenticate(kind: 'login' | 'reauth') {
  const optionsJSON = await authRequest<Parameters<typeof startAuthentication>[0]['optionsJSON']>(kind + '/options', {})
  const response = await startAuthentication({ optionsJSON })
  await authRequest(kind + '/verify', { response })
}

export async function registerPasskey(kind: 'bootstrap' | 'register', name: string, token?: string) {
  const optionsJSON = await authRequest<Parameters<typeof startRegistration>[0]['optionsJSON']>(kind + '/options', { token })
  const response = await startRegistration({ optionsJSON })
  await authRequest(kind + '/verify', { response, name })
}

export function passkeyError(error: unknown) {
  if (error instanceof Error && error.name === 'NotAllowedError') return 'Passkey request cancelled or timed out. You can try again.'
  if (error instanceof Error && error.name === 'InvalidStateError') return 'This passkey is already registered. Choose another device or security key.'
  return error instanceof Error ? error.message : 'Passkey request failed. Please try again.'
}
