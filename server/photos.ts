import type { Photo, PhotoPage } from '../types/shared_types'
import type { PageOptions } from './pagination'
import { storage, photoDatabase } from './storage'
import { InvalidImageError } from './image'
import { PhotoListCache } from './photo-cache'
import { TaskQueue } from './task-queue'
import { imageConcurrency, imageQueueSize } from './image-settings'

const photoList = new PhotoListCache(async () => photoDatabase.list(), () => photoDatabase.version())
const tags = new PhotoListCache(async () => photoDatabase.tags(), () => photoDatabase.version())
const pages = new Map<string, PhotoListCache<PhotoPage>>()
let pagesVersion = ''
const imageQueue = new TaskQueue(imageConcurrency, imageQueueSize)

export function getPhotosResponse(ifNoneMatch?: string): Promise<Response> {
  return photoList.response(ifNoneMatch)
}

export function getTagsResponse(ifNoneMatch?: string) { return tags.response(ifNoneMatch) }

export function getPhotoPageResponse(options: PageOptions, ifNoneMatch?: string) {
  const version = photoDatabase.version()
  if (version !== pagesVersion) { pages.clear(); pagesVersion = version }
  const key = JSON.stringify(options)
  const cache = pages.get(key) ?? new PhotoListCache(async () => photoDatabase.page(options), () => photoDatabase.version())
  pages.delete(key)
  pages.set(key, cache)
  if (pages.size > 64) pages.delete(pages.keys().next().value!)
  return cache.response(ifNoneMatch)
}

// Defer body parsing and file reads until admission; callers must not preload the buffer.
export function savePhoto(readFile: () => Promise<File>, signal?: AbortSignal, source?: string): Promise<string> {
  return imageQueue.run(async () => {
    const file = await readFile()
    signal?.throwIfAborted()
    return savePhotoFile(file, signal, source)
  }, signal)
}

async function savePhotoFile(file: File, signal?: AbortSignal, source?: string): Promise<string> {
  if (!file.name.trim() || file.name.length > 1024) throw new InvalidImageError('Invalid filename')
  const buffer = await file.arrayBuffer()
  signal?.throwIfAborted()
  return storage.ingest(buffer, { name: file.name }, source, false)
}

export async function deletePhoto(id: string): Promise<boolean> {
  return photoDatabase.delete(id)
}

export async function updatePhoto(id: string, updates: Partial<Photo>): Promise<void> {
  photoDatabase.updateMany([{ id, partial: updates }])
}

export async function updatePhotos(updates: { id: string, partial: Partial<Photo> }[]): Promise<void> {
  photoDatabase.updateMany(updates)
}
