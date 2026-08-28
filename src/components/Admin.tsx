import { useState, useEffect, useRef } from 'react'
import type { Photo, TrashedPhoto, ImageJob, JobPage } from '../../types/shared_types'
import styles from './Admin.module.css'
import PhotoEditor from './PhotoEditor'
import { locationLabel } from '../../types/photo-metadata'
import { updatePhotoTags } from '../lib/batch-tags'
import { useAdminPage } from '../lib/use-admin-page'
import PageControls from './PageControls'
import { uploadPhotos, type UploadItem, type UploadResult } from '../lib/upload-queue'

export default function Admin() {
  const [notice, setNotice] = useState('')
  const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [tagging, setTagging] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [failedUploads, setFailedUploads] = useState<UploadResult[]>([])
  const uploadController = useRef<AbortController | null>(null)
  const photoVersion = useRef<string | null>(null)
  const [user, setUser] = useState<{ name: string } | null>(null)
  const photoPage = useAdminPage<Photo>('/api/photos', 'photos', !!user)
  const trashPage = useAdminPage<TrashedPhoto>('/api/trash', 'items', !!user)
  const jobPage = useAdminPage<ImageJob, JobPage>('/api/jobs', 'items', !!user)
  const { items: photos, setItems: setPhotos } = photoPage
  const { items: trash } = trashPage
  const { items: jobs } = jobPage
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{
    current: number
    total: number
    failed: number
  } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/auth/me', { signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        if (controller.signal.aborted) return
        setUser(data.user || null)
        setLoading(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) { setUser(null); setLoading(false) }
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const visible = new Set(photos.map(photo => photo.id))
    setSelectedIds(previous => new Set([...previous].filter(id => visible.has(id))))
  }, [photos])

  useEffect(() => () => { uploadController.current?.abort() }, [])

  useEffect(() => {
    const version = jobPage.details?.photoVersion
    if (version === undefined) return
    if (photoVersion.current !== null && photoVersion.current !== version) photoPage.refresh()
    photoVersion.current = version
  }, [jobPage.details?.photoVersion, photoPage.refresh])

  const counts = jobPage.details?.counts
  useEffect(() => {
    if (!user || jobPage.loading || !isUploading && !retrying && !(counts && counts.pending + counts.running)) return
    const timer = setTimeout(jobPage.refresh, 2000)
    return () => clearTimeout(timer)
  }, [user, isUploading, retrying, counts, jobPage.loading, jobPage.refresh])

  const fetchPhotos = () => {
    photoPage.refresh()
    jobPage.refresh()
  }

  const processUploadQueue = async (items: UploadItem[]) => {
    if (uploadController.current) return
    const controller = new AbortController()
    uploadController.current = controller
    setIsUploading(true)
    setFailedUploads([])
    setUploadProgress({ current: 0, total: items.length, failed: 0 })
    let current = 0
    let failedCount = 0
    let pendingCount = 0
    await uploadPhotos(items, result => {
      current++
      if (result.error) {
        failedCount++
        setFailedUploads(previous => [...previous, result])
      } else if (result.pending) pendingCount++
      setUploadProgress({ current, total: items.length, failed: failedCount })
    }, controller.signal)
    uploadController.current = null
    if (controller.signal.aborted) return
    setIsUploading(false)
    setUploadProgress(null)
    fetchPhotos()
    setNotice(`Upload complete. ${items.length - failedCount} originals saved${pendingCount ? `; ${pendingCount} accepted for image processing` : ''}${failedCount ? `; ${failedCount} failed to upload` : ''}.`)
  }

  const handleFiles = (files: FileList | null) => {
    if (isUploading || !files || files.length === 0) return
    const fileArray = Array.from(files)
    void processUploadQueue(fileArray.map(file => ({ file, key: crypto.randomUUID() })))
  }

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files)
    // Reset input value so same files can be selected again if needed
    e.target.value = ''
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Move this photo to trash? It can be restored until maintenance permanently removes it.')) return

    try {
      const res = await fetch(`/api/photos/${id}`, {
        method: 'DELETE',
      })

      if (res.ok) {
        setPhotos(previous => previous.filter(photo => photo.id !== id))
        trashPage.refresh()
      } else {
        alert('Delete failed')
      }
    } catch (err) {
      console.error(err)
      alert('Delete error')
    }
  }

  const restorePhoto = async (id: string) => {
    try {
      const response = await fetch(`/api/photos/${id}/restore`, { method: 'POST' })
      if (!response.ok) throw new Error('Restore failed')
      trashPage.setItems(previous => previous.filter(photo => photo.id !== id))
      photoPage.refresh()
    } catch { setNotice('Could not restore the photo. Please try again.') }
  }

  const retryJobs = async () => {
    setRetrying(true)
    try {
      const response = await fetch('/api/jobs/retry', { method: 'POST' })
      if (!response.ok) throw new Error('Retry failed')
      fetchPhotos()
    } catch { setNotice('Could not retry image processing. Please try again.') }
    finally { setRetrying(false) }
  }

  const toggleSelection = (id: string, shiftKey: boolean = false) => {
    const newSelected = new Set(selectedIds)

    if (shiftKey && lastSelectedId && lastSelectedId !== id) {
      const lastIndex = photos.findIndex((p) => p.id === lastSelectedId)
      const currentIndex = photos.findIndex((p) => p.id === id)

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex)
        const end = Math.max(lastIndex, currentIndex)

        for (let i = start; i <= end; i++) {
          const p = photos[i]
          if (p) {
            newSelected.add(p.id)
          }
        }
      }
    } else {
      if (newSelected.has(id)) {
        newSelected.delete(id)
      } else {
        newSelected.add(id)
      }
    }

    setSelectedIds(newSelected)
    setLastSelectedId(id)
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === photos.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(photos.map((p) => p.id)))
    }
  }

  const handleBatchTags = async () => {
    if (selectedIds.size === 0 || tagging) return

    const newTagsStr = prompt(
      'Enter tags for selected photos (comma separated):',
    )
    if (newTagsStr === null) return

    const newTags = newTagsStr
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    setTagging(true)
    try {
      await updatePhotoTags(Array.from(selectedIds), newTags, ids => {
        const saved = new Set(ids)
        setPhotos(previous => previous.map(photo => saved.has(photo.id) ? { ...photo, tags: newTags } : photo))
        setSelectedIds(previous => new Set([...previous].filter(id => !saved.has(id))))
      })
      setNotice('Batch tags saved.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update tags. Please retry.')
    } finally { setTagging(false) }
  }

  if (loading) return <div className={styles.loading}>Loading...</div>

  if (!user) {
    return (
      <div className={styles.container}>
        <h1>Admin Access Required</h1>
        <a
          href="/login"
          className={styles.button}
          style={{ display: 'inline-block' }}
        >
          Sign in with a passkey
        </a>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Photo Management</h1>
        <div className={styles.actions}>
          <a href="/admin/security" className={styles.link}>Security</a>
          {selectedIds.size > 0 && (
            <button
              onClick={handleBatchTags}
              disabled={tagging}
              className={styles.button}
              style={{
                marginRight: '1rem',
                backgroundColor: '#555',
                color: '#fff',
              }}
            >
              Batch Tags ({selectedIds.size})
            </button>
          )}
          <a href="/" className={styles.link}>
            View Site
          </a>
          <div className={styles.uploadWrapper}>
            <div
              className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                type="file"
                id="upload"
                accept="image/*"
                multiple
                className={styles.fileInput}
                onChange={handleUpload}
                disabled={isUploading}
              />
              <label htmlFor="upload" className={styles.uploadLabel}>
                {isUploading ? 'Uploading...' : 'Click or Drag Photos'}
              </label>
              {uploadProgress && (
                <div className={styles.progressContainer}>
                  <div>
                    Uploading {uploadProgress.current} / {uploadProgress.total}
                  </div>
                  <div className={styles.progressBar}>
                    <div
                      className={styles.progressFill}
                      style={{
                        width: `${(uploadProgress.current / uploadProgress.total) * 100}%`,
                      }}
                    />
                  </div>
                  {uploadProgress.failed > 0 && (
                    <div style={{ color: '#ff4444' }}>
                      {uploadProgress.failed} failed
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {notice && <p role="status">{notice}</p>}
      {failedUploads.length > 0 && <section className={styles.statusPanel} aria-label="Failed uploads">
        <h2>Failed uploads ({failedUploads.length})</h2>
        <ul>{failedUploads.map(result => <li key={result.item.key}>{result.item.file.name}: {result.error}</li>)}</ul>
        <button className={styles.button} disabled={isUploading} onClick={() => void processUploadQueue(failedUploads.map(result => result.item))}>Retry failed uploads</button>
      </section>}
        <section className={styles.statusPanel} aria-label="Image processing">
          <h2>Image processing</h2>
          {counts && <p role="status">{counts.pending} queued · {counts.running} processing · {counts.failed} failed</p>}
          <p>These originals are saved. Photos appear in the gallery when their previews are ready.</p>
          <button className={styles.button} disabled={retrying} onClick={retryJobs}>
            {retrying ? 'Processing…' : 'Retry unfinished jobs'}
          </button>
          <ul>{jobs.map(job => <li key={`${job.asset_hash}:${job.recipe}`}>{job.status}{job.error ? `: ${job.error}` : ''}</li>)}</ul>
          {!jobs.length && !jobPage.loading && !jobPage.error && <p>No unfinished jobs on this page.</p>}
          <PageControls label="Jobs" {...jobPage} />
        </section>

      <PageControls label="Photos" {...photoPage} disabled={tagging} />
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={
                    photos.length > 0 && selectedIds.size === photos.length
                  }
                  onChange={toggleSelectAll}
                  disabled={tagging}
                  aria-label="Select all photos on this page"
                />
              </th>
              <th>Thumbnail</th>
              <th>Title / Filename</th>
              <th>Location</th>
              <th>Date</th>
              <th>Tags</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {photos.map((photo) => (
              <tr
                key={photo.id}
                style={{
                  backgroundColor: selectedIds.has(photo.id)
                    ? 'rgba(255,255,255,0.05)'
                    : 'transparent',
                }}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(photo.id)}
                    disabled={tagging}
                    aria-label={`Select ${photo.title || photo.name}`}
                    onClick={(e) =>
                      toggleSelection(
                        photo.id,
                        (e.nativeEvent as MouseEvent).shiftKey,
                      )
                    }
                    onChange={() => {}} // Handle click instead for modifier keys
                  />
                </td>
                <td>
                  <img
                    src={photo.thumbnailSrc || photo.src}
                    alt={photo.title || photo.name}
                    className={styles.thumbnail}
                    loading="lazy"
                    decoding="async"
                  />
                </td>
                <td className={styles.photoDescription}>
                  {photo.title && <strong>{photo.title}</strong>}
                  <span>{photo.name}</span>
                </td>
                <td className={styles.location}>{photo.location ? locationLabel(photo.location) : '—'}</td>
                <td>{photo.date || '-'}</td>
                <td>{photo.tags?.join(', ') || '-'}</td>
                <td>
                  <button
                    onClick={() => setEditingPhoto(photo)}
                    className={styles.editButton}
                    style={{ marginRight: '8px' }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(photo.id)}
                    className={styles.deleteButton}
                  >
                    Move to trash
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!photos.length && !photoPage.loading && !photoPage.error && <p>No photos on this page.</p>}
      <section className={styles.statusPanel} aria-label="Trash">
        <h2>Trash</h2>
        <p>Deleted photos remain recoverable until explicit garbage collection after the retention period.</p>
        {trash.map(photo => (
          <div className={styles.trashRow} key={photo.id}>
            <span>{photo.name}</span>
            <button className={styles.button} onClick={() => restorePhoto(photo.id)}>Restore</button>
          </div>
        ))}
        <PageControls label="Trash" {...trashPage} />
      </section>
      {editingPhoto && <PhotoEditor key={editingPhoto.id} photo={editingPhoto} onClose={() => setEditingPhoto(null)}
        onSaved={updated => {
          setPhotos(previous => previous.map(photo => photo.id === updated.id ? updated : photo))
          setEditingPhoto(null)
          setNotice('Photo details saved.')
        }} />}
    </div>
  )
}
