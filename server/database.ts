import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Photo, PhotoPage } from '../types/shared_types'
import { decodeCursor, encodeCursor, type PageOptions } from './pagination'

type PhotoRow = Omit<Photo, 'exif' | 'tags'> & { exif: string | null; tags: string | null; created_at: string | null }
export type PhotoUpdate = { id: string; partial: Partial<Photo> }

const columns = ['id', 'name', 'src', 'thumbnailSrc', 'previewSrc', 'previewWidth', 'previewHeight', 'width', 'height', 'date', 'exif', 'tags'] as const

export class PhotoDatabase {
  private db: Database

  constructor(private directory = path.join(process.cwd(), 'data')) {
    mkdirSync(directory, { recursive: true })
    this.db = new Database(path.join(directory, 'photos.db'), { create: true, strict: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        src TEXT NOT NULL,
        thumbnailSrc TEXT,
        width INTEGER,
        height INTEGER,
        date TEXT,
        exif TEXT,
        tags TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
    this.db.transaction(() => {
      const existing = new Set(this.db.query<{ name: string }, []>('PRAGMA table_info(photos)').all().map(row => row.name))
      for (const [name, type] of [['previewSrc', 'TEXT'], ['previewWidth', 'INTEGER'], ['previewHeight', 'INTEGER']]) {
        if (!existing.has(name!)) this.db.exec(`ALTER TABLE photos ADD COLUMN ${name} ${type}`)
      }
    }).immediate()
    this.db.exec("CREATE INDEX IF NOT EXISTS photos_order ON photos(COALESCE(date, '') DESC, COALESCE(created_at, '') DESC, id DESC)")
  }

  async migrateFromJson() {
    const legacy = Bun.file(path.join(this.directory, 'photos_db.json'))
    const count = this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM photos').get()!
    if (count.count || !(await legacy.exists())) return

    const photos: Photo[] = await legacy.json()
    // Finish the entire import before serving requests; a failed row rolls it all back.
    this.db.transaction(() => {
      for (const photo of photos) this.insert(photo)
    })()
    console.log(`Migrated ${photos.length} photos from JSON to SQLite`)
  }

  private mapRow(row: PhotoRow): Photo {
    return {
      id: row.id,
      name: row.name,
      src: row.src,
      thumbnailSrc: row.thumbnailSrc,
      previewSrc: row.previewSrc ?? undefined,
      previewWidth: row.previewWidth ?? undefined,
      previewHeight: row.previewHeight ?? undefined,
      width: row.width,
      height: row.height,
      date: row.date,
      exif: row.exif ? JSON.parse(row.exif) : undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
    }
  }

  list(): Photo[] {
    return this.db.query<PhotoRow, []>("SELECT * FROM photos ORDER BY COALESCE(date, '') DESC, COALESCE(created_at, '') DESC, id DESC")
      .all().map(row => this.mapRow(row))
  }

  page({ limit, cursor, tag }: PageOptions): PhotoPage {
    const conditions: string[] = []
    const values: (string | number)[] = []
    if (tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(photos.tags) WHERE value = ?)')
      values.push(tag)
    }
    if (cursor) {
      const after = decodeCursor(cursor, tag)
      conditions.push("(COALESCE(date, ''), COALESCE(created_at, ''), id) < (?, ?, ?)")
      values.push(after.date, after.created, after.id)
    }
    const rows = this.db.query<PhotoRow, (string | number)[]>(`
      SELECT * FROM photos ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY COALESCE(date, '') DESC, COALESCE(created_at, '') DESC, id DESC LIMIT ?
    `).all(...values, limit + 1)
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const last = selected.at(-1)
    return {
      photos: selected.map(row => this.mapRow(row)),
      nextCursor: hasMore && last ? encodeCursor({ date: last.date ?? '', created: last.created_at ?? '', id: last.id, tag: tag ?? null }) : null,
    }
  }

  tags(): string[] {
    return this.db.query<{ tag: string }, []>(`
      SELECT value AS tag, MAX(COALESCE(date, '')) AS latest
      FROM photos, json_each(photos.tags) WHERE json_each.type = 'text'
      GROUP BY value ORDER BY latest DESC, tag ASC
    `).all().map(row => row.tag)
  }

  version(): string {
    // data_version detects other connections; total_changes detects our own writes.
    const row = this.db.query<{ changes: number; data_version: number }, []>(
      'SELECT total_changes() AS changes, data_version FROM pragma_data_version',
    ).get()!
    return `${row.changes}:${row.data_version}`
  }

  get(id: string): Photo | undefined {
    const row = this.db.query<PhotoRow, [string]>('SELECT * FROM photos WHERE id = ?').get(id)
    return row ? this.mapRow(row) : undefined
  }

  insert(photo: Photo) {
    const values = columns.map(key => {
      const value = photo[key]
      return key === 'exif' || key === 'tags'
        ? value == null ? null : JSON.stringify(value)
        : value ?? null
    }) as (string | number | null)[]
    this.db.query(`INSERT INTO photos (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...values)
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM photos WHERE id = ?').run(id).changes > 0
  }

  updateMany(updates: PhotoUpdate[]) {
    this.db.transaction(() => {
      for (const { id, partial } of updates) {
        const keys = columns.filter(key => key !== 'id' && Object.hasOwn(partial, key))
        if (!keys.length) continue
        const values = keys.map(key => {
          const value = partial[key]
          return key === 'exif' || key === 'tags'
            ? value == null ? null : JSON.stringify(value)
            : value ?? null
        }) as (string | number | null)[]
        this.db.query(`UPDATE photos SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`)
          .run(...values, id)
      }
    })()
  }

  close() {
    this.db.close()
  }
}
