import { describe, expect, test } from 'bun:test'
import { processImage, InvalidImageError } from '../server/image'
import { bitmap, withOrientation } from './helpers'

describe('native WebP thumbnails', () => {
  test.each(['png', 'jpeg', 'webp'] as const)('resizes %s to 600px and retains original dimensions', async format => {
    const input = await new Bun.Image(bitmap(1200, 800))[format]().buffer()
    const { thumbnailBuffer, info } = await processImage(input)
    expect(await new Bun.Image(thumbnailBuffer).metadata()).toEqual({ width: 600, height: 400, format: 'webp' })
    expect(info).toMatchObject({ width: 1200, height: 800 })
  })

  test('does not enlarge small images', async () => {
    const { thumbnailBuffer, previewBuffer, previewWidth, previewHeight } = await processImage(bitmap(32, 20))
    expect(await new Bun.Image(thumbnailBuffer).metadata()).toEqual({ width: 32, height: 20, format: 'webp' })
    expect(await new Bun.Image(previewBuffer).metadata()).toMatchObject({ width: 32, height: 20 })
    expect([previewWidth, previewHeight]).toEqual([32, 20])
  })

  test('fits a portrait preview inside 1600px and rejects input over the pixel budget', async () => {
    const input = bitmap(1200, 2400)
    const result = await processImage(input)
    expect([result.previewWidth, result.previewHeight]).toEqual([800, 1600])
    expect(await new Bun.Image(result.previewBuffer).metadata()).toMatchObject({ width: 800, height: 1600 })
    await expect(processImage(input, 1_000_000)).rejects.toBeInstanceOf(InvalidImageError)
  })

  test.each([5, 6, 7, 8])('applies EXIF orientation %i before resize', async orientation => {
    const jpeg = await new Bun.Image(bitmap(1200, 800)).jpeg().bytes()
    const { thumbnailBuffer, info } = await processImage(withOrientation(jpeg, orientation))
    expect(info).toMatchObject({ width: 800, height: 1200 })
    expect(await new Bun.Image(thumbnailBuffer).metadata()).toEqual({ width: 600, height: 900, format: 'webp' })
  })

  test('rejects corrupt data instead of storing it as a thumbnail', async () => {
    await expect(processImage(Buffer.from('not an image'))).rejects.toBeInstanceOf(InvalidImageError)
  })
})
