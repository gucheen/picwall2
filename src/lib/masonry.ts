import type { Photo } from '../../types/shared_types'

export interface PlacedPhoto { photo: Photo; top: number; left: number; width: number; height: number }

export function layoutPhotos(photos: Photo[], width: number, count: number, gap = 16) {
  const columns: PlacedPhoto[][] = Array.from({ length: count }, () => [])
  const heights = new Array<number>(count).fill(0)
  const columnWidth = Math.max(1, (width - gap * (count - 1)) / count)
  for (const photo of photos) {
    const column = heights.indexOf(Math.min(...heights))
    const ratio = photo.width && photo.height && photo.width > 0 && photo.height > 0 ? photo.height / photo.width : 1
    const height = columnWidth * ratio
    columns[column]!.push({ photo, top: heights[column]!, left: column * (columnWidth + gap), width: columnWidth, height })
    heights[column]! += height + gap
  }
  return { columns, height: Math.max(0, ...heights) - (photos.length ? gap : 0) }
}

export function visiblePhotos(columns: PlacedPhoto[][], top: number, bottom: number, overscan = 800): PlacedPhoto[] {
  const visible: PlacedPhoto[] = []
  for (const column of columns) {
    let low = 0
    let high = column.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const item = column[middle]!
      if (item.top + item.height < top - overscan) low = middle + 1
      else high = middle
    }
    for (let index = low; index < column.length; index++) {
      const item = column[index]!
      if (item.top > bottom + overscan) break
      visible.push(item)
    }
  }
  return visible
}
