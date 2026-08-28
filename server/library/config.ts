import path from 'node:path'
import { lstat, mkdir, realpath, readdir } from 'node:fs/promises'
import { Library } from './service'
import { LocalObjects, S3Objects } from './objects'

export async function createLibrary(root = process.env.LIBRARY_ROOT || path.join(process.cwd(), 'data', 'library-v2'), allowLegacy = false) {
  const requested = path.resolve(root)
  if (await exists(requested) && (await lstat(requested)).isSymbolicLink()) throw new Error('Library root must not be a symlink')
  const directory = await resolveLocation(requested)
  const data = await resolveLocation(path.resolve(process.cwd(), 'data'))
  const files = await resolveLocation(path.resolve(process.cwd(), 'files'))
  if (directory === files || directory.startsWith(files + path.sep)) throw new Error('Library root must not use a legacy object directory')
  for (const name of ['uploads', 'thumbnails', 'previews']) {
    const legacy = path.join(data, name)
    if (directory === legacy || directory.startsWith(legacy + path.sep)) throw new Error('Library root must not use a legacy object directory')
  }
  if (directory === data) throw new Error('LIBRARY_ROOT must be a separate directory, not the legacy data directory')
  const catalogExists = await exists(path.join(directory, 'catalog.sqlite'))
  if (!allowLegacy && !catalogExists) {
    const legacy = await Promise.all(['photos.db', 'photos_db.json'].map(name => exists(path.join(data, name))))
    const legacyObjects = await Promise.all(['uploads', 'thumbnails', 'previews'].map(name =>
      readdir(path.join(files, name)).then(entries => entries.length > 0).catch(error => {
        if (error.code === 'ENOENT') return false
        throw error
      })))
    if (legacy.some(Boolean) || legacyObjects.some(Boolean)) throw new Error('Legacy library detected. Run an explicit library migration or select an empty environment before starting; no legacy files were changed.')
  }
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Library root must not be a symlink')
  const type = process.env.STORAGE_TYPE || 'local'
  if (type !== 'local' && type !== 's3') throw new Error('STORAGE_TYPE must be local or s3')
  const objects = type === 's3' ? new S3Objects({
    region: process.env.S3_REGION || 'auto', endpoint: process.env.S3_ENDPOINT || undefined,
    bucket: required('S3_BUCKET'), accessKeyId: required('S3_ACCESS_KEY_ID'), secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    sessionToken: process.env.S3_SESSION_TOKEN || undefined,
  }, process.env.S3_PREFIX || 'library-v2/', process.env.S3_CDN_URL || '', process.env.S3_PRESIGNED_READS === 'true')
    : new LocalObjects(path.join(directory, 'objects'))
  return new Library(directory, objects)
}

async function exists(filename: string) {
  try { await lstat(filename); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(name + ' is required for S3 storage')
  return value
}

async function resolveLocation(directory: string): Promise<string> {
  try { return await realpath(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return path.join(await resolveLocation(path.dirname(directory)), path.basename(directory))
  }
}
