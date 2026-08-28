import type { Photo } from '../types/shared_types'

interface Snapshot {
  version: string
  json: string
  etag: string
}

export class PhotoListCache<T = Photo[]> {
  private cached?: Snapshot
  private pending?: Promise<Snapshot>

  constructor(private list: () => Promise<T>, private version: () => string) {}

  private async snapshot(): Promise<Snapshot> {
    while (true) {
      const version = this.version()
      if (this.cached?.version === version) return this.cached
      if (!this.pending) {
        this.pending = this.list().then(photos => {
          const json = JSON.stringify(photos)
          return { version, json, etag: `"${new Bun.CryptoHasher('sha256').update(json).digest('hex')}"` }
        }).finally(() => { this.pending = undefined })
      }
      const snapshot = await this.pending
      // A write during the async read must not publish a stale snapshot as current.
      if (snapshot.version === this.version()) {
        this.cached = snapshot
        return snapshot
      }
    }
  }

  async response(ifNoneMatch?: string): Promise<Response> {
    const { json, etag } = await this.snapshot()
    const matches = ifNoneMatch?.trim() === '*' || ifNoneMatch?.split(',')
      .some(tag => tag.trim().replace(/^W\//, '') === etag)
    const headers = {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'public, no-cache',
      ETag: etag,
    }
    return new Response(matches ? null : json, { status: matches ? 304 : 200, headers })
  }
}
