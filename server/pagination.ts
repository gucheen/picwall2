export interface PageOptions { limit: number; cursor?: string; tag?: string }
export interface PhotoCursor { date: string; created: string; id: string; tag: string | null }
export class InvalidPageError extends Error {}

export function decodeCursor(cursor: string, tag?: string): PhotoCursor {
  try {
    if (cursor.length > 4096 || !/^[\w-]+$/.test(cursor)) throw new Error()
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (value.v !== 1 || typeof value.date !== 'string' || typeof value.created !== 'string'
      || typeof value.id !== 'string' || value.tag !== (tag ?? null)) throw new Error()
    return value
  } catch { throw new InvalidPageError('Invalid cursor or changed tag filter') }
}

export function encodeCursor(cursor: PhotoCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString('base64url')
}

export function pageOptions(query: Record<string, string>): PageOptions {
  const limit = Number(query.limit ?? 60)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidPageError('limit must be between 1 and 100')
  const tag = query.tag || undefined
  if (tag && tag.length > 256) throw new InvalidPageError('Tag is too long')
  const cursor = query.cursor
  if (cursor !== undefined) decodeCursor(cursor, tag)
  return { limit, tag, cursor }
}
