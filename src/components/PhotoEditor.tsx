import { useEffect, useRef, useState } from 'react'
import type { Photo, PhotoLocation } from '../../types/shared_types'
import { normalizePhotoLocation, normalizePhotoTitle, photoMapUrl, photoTextLimit } from '../../types/photo-metadata'
import styles from './PhotoEditor.module.css'

export default function PhotoEditor({ photo, onClose, onSaved }: {
  photo: Photo
  onClose: () => void
  onSaved: (photo: Photo) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(photo.title ?? '')
  const [name, setName] = useState(photo.location?.name ?? '')
  const [latitude, setLatitude] = useState(photo.location?.latitude?.toString() ?? '')
  const [longitude, setLongitude] = useState(photo.location?.longitude?.toString() ?? '')
  const [tags, setTags] = useState(photo.tags?.join(', ') ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current!
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    element.showModal()
    titleInput.current?.focus()
    return () => { element.close(); document.body.style.overflow = overflow }
  }, [])

  const readLocation = () => normalizePhotoLocation({
    name,
    ...(latitude.trim() ? { latitude: Number(latitude) } : {}),
    ...(longitude.trim() ? { longitude: Number(longitude) } : {}),
  })
  let previewLocation: PhotoLocation | null = null
  try { previewLocation = readLocation() } catch { /* Incomplete coordinates have no map preview. */ }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving) return
    setError('')
    try {
      const updates = {
        title: normalizePhotoTitle(title),
        location: readLocation(),
        tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))],
      }
      setSaving(true)
      const response = await fetch(`/api/photos/${photo.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save this photo. Please try again.')
      onSaved({ ...photo, ...updates })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save this photo. Please try again.')
    } finally { setSaving(false) }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="photo-editor-title"
    onCancel={event => { event.preventDefault(); if (!saving) onClose() }}>
    <form onSubmit={save}>
      <div className={styles.header}>
        <h2 id="photo-editor-title">Edit photo</h2>
        <button type="button" className={styles.close} onClick={onClose} disabled={saving} aria-label="Close editor">×</button>
      </div>
      <div className={styles.photo}>
        <img src={photo.thumbnailSrc || photo.src} alt={photo.title || photo.name} />
        <span>{photo.name}</span>
      </div>
      <fieldset className={styles.fields} disabled={saving}>
        <label>Title
          <input ref={titleInput} value={title} onChange={event => setTitle(event.target.value)} maxLength={photoTextLimit} placeholder="Give this photo a title" />
        </label>
        <label>Location name
          <input value={name} onChange={event => setName(event.target.value)} maxLength={photoTextLimit} placeholder="e.g. West Lake, Hangzhou" aria-describedby="location-help" />
        </label>
        <div className={styles.coordinates}>
          <label>Latitude
            <input type="number" step="any" min="-90" max="90" value={latitude} required={longitude !== ''}
              onChange={event => setLatitude(event.target.value)} placeholder="30.2431" aria-describedby="location-help" />
          </label>
          <label>Longitude
            <input type="number" step="any" min="-180" max="180" value={longitude} required={latitude !== ''}
              onChange={event => setLongitude(event.target.value)} placeholder="120.1500" aria-describedby="location-help" />
          </label>
        </div>
        <p id="location-help" className={styles.hint}>Optional. Add both coordinates (WGS84) for an exact pin; a name alone opens a map search. Saved locations are public.</p>
        {previewLocation && <a className={styles.mapLink} href={photoMapUrl(previewLocation)} target="_blank" rel="noopener noreferrer">
          {previewLocation.latitude !== undefined ? 'Preview pin on Google Maps' : 'Search on Google Maps'} ↗
        </a>}
        <label>Tags
          <input value={tags} onChange={event => setTags(event.target.value)} placeholder="travel, landscape" />
        </label>
        <p className={styles.hint}>Separate tags with commas. Leave fields blank to remove them.</p>
      </fieldset>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="submit" className={styles.save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  </dialog>
}
