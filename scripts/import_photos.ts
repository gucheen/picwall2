import { readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createLibrary } from '../server/library/config'
import type { Library } from '../server/library/service'

let library: Library | undefined
try {
  const args = process.argv.slice(2)
  const directory = await realpath(args[0] && !args[0].startsWith('--') ? args.shift()! : './photos')
  let root: string | undefined
  if (args.length) {
    if (args.shift() !== '--root' || !args[0] || args[0].startsWith('--')) throw new Error('Usage: bun scripts/import_photos.ts [directory] [--root library]')
    root = path.resolve(args.shift()!)
  }
  if (args.length) throw new Error('Unexpected import arguments')
  library = await createLibrary(root)
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(entry.name))
    .map(entry => entry.name).sort()
  let skipped = 0
  let imported = 0
  let failed = 0
  for (const name of files) {
    try {
      const filename = path.join(directory, name)
      const source = 'file:' + filename
      const previous = library.catalog.source(source)
      const id = await library.ingest(await Bun.file(filename).bytes(), { name }, source)
      if (previous) { skipped++; console.log(`Unchanged: ${name}`) }
      else { imported++; console.log(`Imported: ${name} (${id})`) }
      const hash = library.catalog.record(id)!.asset_hash
      const job = library.catalog.db.query<{ error: string | null }, [string]>(
        "SELECT error FROM jobs WHERE asset_hash=? AND status='failed' LIMIT 1").get(hash)
      if (job) throw new Error('Original saved; derivative failed: ' + job.error)
    } catch (error) {
      failed++
      process.exitCode = 1
      console.error(`Failed to import ${name}:`, error)
    }
  }
  console.log(`Import completed. Imported: ${imported}; unchanged: ${skipped}; failed: ${failed}`)
} catch (error) {
  process.exitCode = 1
  console.error('Import failed:', error)
} finally {
  await library?.close()
}
