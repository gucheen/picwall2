import { createLibrary } from './library/config'

export const storage = await createLibrary()
export const photoDatabase = storage.catalog
