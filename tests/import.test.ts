import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Library } from '../server/library/service'
import { LocalObjects } from '../server/library/objects'
import { bitmap } from './helpers'

test('import keeps colliding names, continues after failures and skips unchanged source files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'picwall-import-'))
  try {
    const inputs = path.join(directory, 'inputs')
    await mkdir(inputs)
    const png = await new Bun.Image(bitmap(64, 32)).png().bytes()
    for (const name of ['a.png', 'b.png', 'same ?.png', 'same_?.png']) await Bun.write(path.join(inputs, name), png)
    await Bun.write(path.join(inputs, 'broken.png'), 'invalid image')
    const libraryRoot = path.join(directory, 'library')
    const run = async () => {
      const child = Bun.spawn([Bun.which('bun')!, '--no-env-file', path.resolve(import.meta.dir, '../scripts/import_photos.ts'), inputs, '--root', libraryRoot], {
        cwd: directory, env: { PATH: Bun.env.PATH, STORAGE_TYPE: 'local', IMAGE_CONCURRENCY: '2', IMAGE_QUEUE_SIZE: '0' },
        stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      })
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exitCode, stdout, stderr }
    }
    const first = await run()
    expect(first.exitCode).toBe(1)
    expect(first.stderr).toContain('broken.png')
    const library = new Library(libraryRoot, new LocalObjects(path.join(libraryRoot, 'objects')))
    try {
      expect(library.catalog.list()).toHaveLength(4)
      expect(library.catalog.assets()).toHaveLength(1)
      for (const photo of library.catalog.list()) {
        expect(photo.previewSrc).toBeDefined()
        expect((await library.getResponse(photo.previewSrc!.slice('/media/'.length)))?.status).toBe(200)
      }
    } finally { await library.close() }
    await Bun.file(path.join(inputs, 'broken.png')).delete()
    const again = await run()
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('Imported: 0; unchanged: 4')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 30_000)
