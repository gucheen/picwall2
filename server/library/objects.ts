import { mkdir, open, link, unlink, readdir, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { S3Client, type S3Options } from 'bun'
import { sha256, validKey, verifyObject } from './model'

export interface StoredObject { key: string; bytes: number; modified: number }
export interface ObjectStore {
  identity: string
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>
  read(key: string): Promise<Uint8Array>
  response(key: string, mime: string): Promise<Response | null>
  list(): Promise<StoredObject[]>
  remove(key: string): Promise<void>
  temporary?(): Promise<StoredObject[]>
  removeTemporary?(key: string): Promise<void>
}

export class LocalObjects implements ObjectStore {
  identity = 'local'
  constructor(readonly directory: string) {}

  private async filename(key: string, create = false, temporary = false) {
    if (!(temporary ? validTemporaryKey(key) : validKey(key))) throw new Error('Invalid object key')
    if (create) await mkdir(this.directory, { recursive: true })
    if (!(await lstat(this.directory)).isDirectory()) throw new Error('Object root must not be a symlink')
    const root = await realpath(this.directory)
    let parent = root
    for (const part of key.split('/').slice(0, -1)) {
      parent = path.join(parent, part)
      if (create) await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error })
      if (!(await lstat(parent)).isDirectory()) throw new Error('Object directory must not contain symlinks')
    }
    const filename = path.join(root, key)
    const stat = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (stat && !stat.isFile()) throw new Error('Invalid object file')
    return filename
  }

  async put(key: string, bytes: Uint8Array, _mime: string) {
    verifyObject(key, bytes)
    const filename = await this.filename(key, true)
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp'
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      // Publish without replacing an existing immutable object.
      await link(temporary, filename).catch(async error => {
        if (error.code !== 'EEXIST') throw error
        if (sha256(await this.read(key)) !== sha256(bytes)) throw new Error('Corrupt existing object: ' + key)
      })
      const directory = await open(path.dirname(filename), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  async read(key: string) { return Bun.file(await this.filename(key)).bytes() }
  async response(key: string, mime: string) {
    try {
      const file = Bun.file(await this.filename(key))
      return await file.exists() ? new Response(file, { headers: { 'Content-Type': mime } }) : null
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  async remove(key: string) {
    try { await unlink(await this.filename(key)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  list() { return this.scan(validKey) }
  temporary() { return this.scan(validTemporaryKey) }
  async removeTemporary(key: string) {
    try { await unlink(await this.filename(key, false, true)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  private async scan(include: (key: string) => boolean) {
    const objects: StoredObject[] = []
    const root = await lstat(this.directory).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (!root) return objects
    if (!root.isDirectory()) throw new Error('Object root must not be a symlink')
    const walk = async (directory: string, prefix = '') => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return []; throw error
      })
      for (const entry of entries) {
        const key = prefix + entry.name
        if (entry.isSymbolicLink()) throw new Error('Symlink in object storage: ' + key)
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), key + '/')
        else if (entry.isFile() && include(key)) {
          const stat = await lstat(path.join(directory, entry.name))
          objects.push({ key, bytes: stat.size, modified: stat.mtimeMs })
        }
      }
    }
    await walk(this.directory)
    return objects
  }
}

function validTemporaryKey(key: string) {
  const match = /^(.*)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.exec(key)
  return !!match && validKey(match[1]!)
}

export class S3Objects implements ObjectStore {
  readonly client: S3Client
  readonly identity: string
  constructor(options: S3Options, readonly prefix = 'library-v2/', private cdn = '', private presign = false) {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(prefix)
      || /^(uploads|thumbnails|previews)\//.test(prefix)) throw new Error('S3_PREFIX must be an isolated directory ending in /')
    this.client = new S3Client(options)
    this.identity = JSON.stringify({ endpoint: options.endpoint, bucket: options.bucket, prefix })
  }
  private file(key: string) {
    if (!validKey(key)) throw new Error('Invalid object key')
    return this.client.file(this.prefix + key)
  }
  async put(key: string, bytes: Uint8Array, mime: string) {
    verifyObject(key, bytes)
    const file = this.file(key)
    if (await file.exists()) {
      if (sha256(await file.arrayBuffer()) !== sha256(bytes)) throw new Error('Corrupt existing object: ' + key)
      return
    }
    // Conditional PUT also protects immutable objects from writers in another process.
    const response = await fetch(file.presign({ expiresIn: 300, method: 'PUT', type: mime }), {
      method: 'PUT', headers: { 'Content-Type': mime, 'If-None-Match': '*' }, body: new Uint8Array(bytes),
    })
    if (!response.ok && response.status !== 412) {
      await response.body?.cancel()
      throw new Error('S3 object write failed: HTTP ' + response.status)
    }
    await response.body?.cancel()
    if (sha256(await this.read(key)) !== sha256(bytes)) throw new Error('Object write verification failed: ' + key)
  }
  async read(key: string) { return new Uint8Array(await this.file(key).arrayBuffer()) }
  async response(key: string, mime: string) {
    const file = this.file(key)
    if (!(await file.exists())) return null
    if (this.cdn || this.presign) {
      const location = this.cdn ? this.cdn.replace(/\/$/, '') + '/' + this.prefix + key
        : file.presign({ expiresIn: 300, method: 'GET' })
      return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'private, no-store' } })
    }
    return new Response(file.stream(), { headers: { 'Content-Type': mime } })
  }
  async remove(key: string) { await this.file(key).delete() }
  async list() {
    const objects: StoredObject[] = []
    let continuationToken: string | undefined
    do {
      const page = await this.client.list({ prefix: this.prefix, continuationToken, maxKeys: 1000 })
      for (const item of page.contents ?? []) {
        if (!item.key.startsWith(this.prefix)) throw new Error('S3 returned an object outside the isolated prefix')
        const key = item.key.slice(this.prefix.length)
        if (validKey(key)) objects.push({ key, bytes: item.size ?? 0, modified: item.lastModified ? Date.parse(item.lastModified) : NaN })
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
      if (page.isTruncated && !continuationToken) throw new Error('Incomplete S3 listing')
    } while (continuationToken)
    return objects
  }
}
