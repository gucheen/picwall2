import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Catalog } from '../server/library/catalog'
import { originalKey, recipeId, sha256 } from '../server/library/model'
import { adminPageOptions } from '../server/pagination'

let directory: string
let catalog: Catalog
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'picwall-admin-pages-'))
  catalog = new Catalog(directory, 'test')
  catalog.db.transaction(() => {
    for (let index = 0; index < 130; index++) {
      const hash = sha256(String(index))
      const id = catalog.add({ hash, original_key: originalKey(hash), mime: 'image/png', bytes: 1,
        width: 1, height: 1, active_recipe: null, created_at: 0 }, { name: `${index}.png` }, recipeId)
      catalog.delete(id, 1000)
      if (index % 3 === 0) catalog.db.query("UPDATE jobs SET status='complete' WHERE asset_hash=?").run(hash)
    }
  })()
})
afterEach(async () => { catalog.close(); await rm(directory, { recursive: true, force: true }) })

test('trash pages stay bounded and continue after the cursor photo is restored', () => {
  const first = catalog.trashPage({ limit: 60 })
  expect(first.items).toHaveLength(60)
  catalog.restore(first.items.at(-1)!.id)
  const second = catalog.trashPage({ limit: 60, cursor: first.nextCursor! })
  const third = catalog.trashPage({ limit: 60, cursor: second.nextCursor! })
  expect(second.items).toHaveLength(60)
  expect(third.items).toHaveLength(10)
  expect(third.nextCursor).toBeNull()
  expect(new Set([...first.items, ...second.items, ...third.items].map(photo => photo.id)).size).toBe(130)
})

test('job pages exclude completed jobs and expose counts without loading their records', () => {
  const first = catalog.jobPage({ limit: 60 })
  expect(first.items).toHaveLength(60)
  expect(first.counts).toEqual({ pending: 86, running: 0, failed: 0, complete: 44 })
  expect(first.items.every(job => job.status !== 'complete')).toBe(true)
  const last = first.items.at(-1)!
  catalog.db.query("UPDATE jobs SET status='complete' WHERE asset_hash=? AND recipe=?").run(last.asset_hash, last.recipe)
  const second = catalog.jobPage({ limit: 60, cursor: first.nextCursor! })
  expect(second.items).toHaveLength(26)
  expect(second.nextCursor).toBeNull()
  expect(new Set([...first.items, ...second.items].map(job => job.asset_hash)).size).toBe(86)
})

test('rejects malformed, cross-resource cursors and unbounded requests', () => {
  for (const limit of ['0', '101', 'no', '1.5']) expect(() => adminPageOptions({ limit })).toThrow()
  expect(() => catalog.trashPage({ limit: 60, cursor: '' })).toThrow()
  expect(() => catalog.jobPage({ limit: 60, cursor: 'bad' })).toThrow()
  expect(() => catalog.jobPage({ limit: 60, cursor: catalog.trashPage({ limit: 1 }).nextCursor! })).toThrow()
  expect(() => catalog.trashPage({ limit: 60, cursor: catalog.jobPage({ limit: 1 }).nextCursor! })).toThrow()
})
