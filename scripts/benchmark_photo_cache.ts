import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Catalog } from '../server/library/catalog'
import { originalKey, recipeId, sha256, variantKey } from '../server/library/model'
import { PhotoListCache } from '../server/photo-cache'

const count = Number(process.argv[2] ?? 10_000)
const iterations = Number(process.argv[3] ?? 200)
if (![count, iterations].every(value => Number.isSafeInteger(value) && value > 0)) {
  throw new Error('Usage: bun scripts/benchmark_photo_cache.ts [photo-count] [iterations] (positive integers)')
}

const directory = await mkdtemp(path.join(tmpdir(), 'picwall-cache-bench-'))
const db = new Catalog(directory, 'synthetic-benchmark')

try {
  db.db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const hash = sha256(String(index))
      db.add({ hash, original_key: originalKey(hash), mime: 'image/jpeg', bytes: 1,
        width: 6000, height: 4000, active_recipe: null, created_at: Date.now() }, {
        name: `${index}.jpg`, date: '2026-08-28 12:00:00', tags: ['travel', 'landscape'],
        exif: { make: 'Camera', model: 'Sample', iso: 100, aperture: 'f/8', shutter: '1/250', focalLength: '35 mm' },
      }, recipeId)
      db.publish(hash, recipeId, (['thumbnail', 'preview'] as const).map(kind => ({
        asset_hash: hash, recipe: recipeId, kind, object_key: variantKey(hash, kind, hash), checksum: hash,
        bytes: 1, width: kind === 'thumbnail' ? 600 : 1600, height: kind === 'thumbnail' ? 400 : 1067, retired_at: null,
      })))
    }
  })()
  const cache = new PhotoListCache(async () => db.list(), () => db.version())
  const initial = await cache.response()
  const etag = initial.headers.get('etag')!
  await initial.arrayBuffer()

  async function measure(request: () => Promise<Response>) {
    for (let index = 0; index < 20; index++) await (await request()).arrayBuffer()
    Bun.gc(true)
    const times: number[] = []
    let bodyBytes = 0
    for (let index = 0; index < iterations; index++) {
      const start = performance.now()
      bodyBytes = (await (await request()).arrayBuffer()).byteLength
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    return {
      medianMs: Number(times[Math.floor(times.length / 2)]!.toFixed(3)),
      p95Ms: Number(times[Math.ceil(times.length * 0.95) - 1]!.toFixed(3)),
      bodyBytes,
    }
  }

  console.log(JSON.stringify({
    bun: Bun.version, photos: count, iterations,
    scope: 'Synthetic metadata, in-process response generation and body consumption; no network or image decoding',
    uncached: await measure(async () => Response.json(db.list())),
    cached: await measure(() => cache.response()),
    revalidated: await measure(() => cache.response(etag)),
    firstPage: await measure(async () => Response.json(db.page({ limit: 60 }))),
  }, null, 2))
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
