import { expect, test } from 'bun:test'
import { layoutPhotos, visiblePhotos } from '../src/lib/masonry'
import { detailSource, photoSrcSet } from '../src/lib/photo-sources'
import { selectEncoding } from '../server/static-assets'
import { photo } from './helpers'

test('masonry keeps page appends stable and bounds visible cards across a large collection', () => {
  const photos = Array.from({ length: 10_000 }, (_, index) => ({ ...photo(`${index}.jpg`), width: 600, height: index % 2 ? 400 : 800 }))
  const initial = layoutPhotos(photos.slice(0, 60), 1400, 4)
  const full = layoutPhotos(photos, 1400, 4)
  for (let index = 0; index < 4; index++) expect(full.columns[index]!.slice(0, initial.columns[index]!.length)).toEqual(initial.columns[index]!)
  const visible = visiblePhotos(full.columns, 20_000, 21_000)
  expect(visible.length).toBeGreaterThan(0)
  expect(visible.length).toBeLessThan(60)
  expect(visible.every(item => item.top <= 21_800 && item.top + item.height >= 19_200)).toBe(true)
  for (const column of full.columns) {
    expect(column.every((item, index) => index === 0 || item.top >= column[index - 1]!.top + column[index - 1]!.height + 16)).toBe(true)
  }
  expect(layoutPhotos([], 400, 1).height).toBe(0)
})

test('uses actual variant widths and keeps originals out of default detail loading', () => {
  const legacy = photo()
  expect(detailSource(legacy)).toBe(legacy.thumbnailSrc!)
  expect(photoSrcSet(legacy)).toBeUndefined()
  const current = { ...legacy, width: 2400, previewWidth: 800, previewSrc: '/previews/sample.webp' }
  expect(photoSrcSet(current)).toBe(`${legacy.thumbnailSrc} 600w, /previews/sample.webp 800w`)
  expect(detailSource(current)).toBe(current.previewSrc)
  expect(photoSrcSet({ ...current, width: 300, previewWidth: 300 })).toBeUndefined()
})

test('respects encoding preferences, explicit exclusions and identity fallback', () => {
  const encodings = ['br', 'gzip', 'identity'] as const
  expect(selectEncoding('br;q=0.5, gzip;q=1', [...encodings])).toBe('gzip')
  expect(selectEncoding('br;q=0, gzip;q=0', [...encodings])).toBe('identity')
  expect(selectEncoding('*;q=0', [...encodings])).toBeUndefined()
  expect(selectEncoding(null, [...encodings])).toBe('identity')
})
