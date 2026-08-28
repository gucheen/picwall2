export const sha256 = (bytes: string | Uint8Array | ArrayBuffer) =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

export const recipe = Object.freeze({
  version: 1,
  thumbnailWidth: 600,
  thumbnailQuality: 80,
  previewSize: 1600,
  previewQuality: 82,
  autoOrient: true,
  withoutEnlargement: true,
  filter: 'lanczos3',
  encoder: ['bun-image', Bun.version, Bun.Image.backend, process.platform, process.arch].join('-'),
})
export const recipeId = sha256(JSON.stringify(recipe))
export const originalKey = (hash: string) => ['originals', hash.slice(0, 2), hash.slice(2, 4), hash].join('/')
export const variantKey = (hash: string, kind: Variant['kind'], checksum: string, generation = recipeId) =>
  ['derived', hash, generation, kind + '-' + checksum + '.webp'].join('/')

export function validKey(key: string): boolean {
  const original = /^originals\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(key)
  return !!(original && original[3]!.startsWith(original[1]! + original[2]!))
    || /^derived\/[a-f0-9]{64}\/[a-f0-9]{64}\/(thumbnail|preview)-[a-f0-9]{64}\.webp$/.test(key)
}

export function verifyObject(key: string, bytes: Uint8Array) {
  if (!validKey(key)) throw new Error('Invalid object key')
  const expected = key.startsWith('originals/') ? key.split('/').at(-1)! : key.slice(-69, -5)
  if (sha256(bytes) !== expected) throw new Error('Object checksum does not match key: ' + key)
}

export interface Asset {
  hash: string
  original_key: string
  mime: string
  bytes: number
  width: number
  height: number
  active_recipe: string | null
  created_at: number
}

export interface Variant {
  asset_hash: string
  recipe: string
  kind: 'thumbnail' | 'preview'
  object_key: string
  checksum: string
  bytes: number
  width: number
  height: number
  retired_at: number | null
}
