import type { PhotoLocation } from './shared_types'

export const photoTextLimit = 200

export function normalizePhotoTitle(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > photoTextLimit) throw new Error('Title must be at most 200 characters')
  return value.trim() || null
}

export function normalizePhotoLocation(value: unknown): PhotoLocation | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid location')
  const location = value as Record<string, unknown>
  if (Object.keys(location).some(key => !['name', 'latitude', 'longitude'].includes(key))) throw new Error('Invalid location field')
  if (location.name !== undefined && (typeof location.name !== 'string' || location.name.length > photoTextLimit)) {
    throw new Error('Location name must be at most 200 characters')
  }
  const name = typeof location.name === 'string' ? location.name.trim() : ''
  const { latitude, longitude } = location
  if (latitude === undefined && longitude === undefined) return name ? { name } : null
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Enter both latitude (-90 to 90) and longitude (-180 to 180)')
  }
  return { ...(name ? { name } : {}), latitude, longitude }
}

export function locationLabel(location: PhotoLocation): string {
  return location.name || `${location.latitude}, ${location.longitude}`
}

export function photoMapUrl(location: PhotoLocation): string {
  const query = location.latitude !== undefined && location.longitude !== undefined
    ? `${location.latitude},${location.longitude}` : location.name!
  return `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query })}`
}
