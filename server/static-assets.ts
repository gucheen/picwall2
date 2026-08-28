import path from 'node:path'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

type Encoding = 'br' | 'gzip' | 'identity'
type Handler = (request: Request) => Response

export function selectEncoding(header: string | null, available: Encoding[]): Encoding | undefined {
  if (!header) return 'identity'
  const qualities = new Map(header.toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';')
    const q = params.find(param => param.trim().startsWith('q='))
    const value = q ? Number(q.trim().slice(2)) : 1
    return [name!, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0] as const
  }))
  const quality = (encoding: Encoding) => qualities.get(encoding)
    ?? (encoding === 'identity' ? qualities.get('*') === 0 ? 0 : 1 : qualities.get('*') ?? 0)
  return available.filter(encoding => quality(encoding) > 0).sort((a, b) => quality(b) - quality(a))[0]
}

export async function loadStaticAssets(directory = './dist') {
  // Compute middleware headers once; native asset routes bypass Hono on each request.
  const secured = await new Hono().use(secureHeaders()).get('/', c => c.body(null, 204)).request('/')
  const names: string[] = await Bun.file(path.join(directory, 'assets.json')).json()
  const routes: Record<string, { GET: Handler; HEAD: Handler }> = {}
  let html: Handler | undefined
  for (const name of names) {
    const file = Bun.file(path.join(directory, 'public', name))
    const variants = new Map<Encoding, { bytes: Uint8Array<ArrayBuffer>; etag: string }>()
    for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz'], ['identity', '']] as const) {
      const variant = Bun.file(`${file.name}${suffix}`)
      if (!(await variant.exists())) continue
      const bytes = await variant.bytes()
      const etag = `"${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}"`
      variants.set(encoding, { bytes, etag })
    }
    const serve: Handler = request => {
      const headers = new Headers(secured.headers)
      headers.set('Vary', 'Accept-Encoding')
      const encoding = selectEncoding(request.headers.get('Accept-Encoding'), [...variants.keys()])
      if (!encoding) return new Response(null, { status: 406, headers })
      const { bytes, etag } = variants.get(encoding)!
      headers.set('Content-Type', file.type)
      headers.set('Cache-Control', /-[a-z0-9]{8,}\.(js|css)$/i.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache')
      headers.set('ETag', etag)
      if (encoding !== 'identity') headers.set('Content-Encoding', encoding)
      const unchanged = request.headers.get('If-None-Match')?.split(',')
        .some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)
      if (unchanged) return new Response(null, { status: 304, headers })
      headers.set('Content-Length', String(bytes.byteLength))
      return new Response(request.method === 'HEAD' ? null : bytes, { headers })
    }
    routes[`/${name}`] = { GET: serve, HEAD: serve }
    if (name === 'index.html') html = serve
  }
  if (!html) throw new Error('Missing built index.html')
  routes['/'] = routes['/admin'] = { GET: html, HEAD: html }
  return { routes, html }
}
