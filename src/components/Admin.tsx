import { useState, useEffect } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './Admin.module.css'

export default function Admin() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [trash, setTrash] = useState<(Photo & { deleted_at: number })[]>([])
  const [jobs, setJobs] = useState<{ asset_hash: string; status: string; error: string | null }[]>([])
  const [notice, setNotice] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [user, setUser] = useState<{ name: string } | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{
    current: number
    total: number
    failed: number
  } | null>(null)

  // Fetch photos and auth status
  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        setUser(data.user || null)
        if (data.user) {
          fetchPhotos()
        } else {
          setLoading(false)
        }
      })
      .catch(() => {
        setUser(null)
        setLoading(false)
      })
  }, [])

  const fetchPhotos = () => {
    setLoading(true)
    Promise.all(['/api/photos', '/api/trash', '/api/jobs'].map(async endpoint => {
      const response = await fetch(endpoint)
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return response.json()
    }))
      .then(([photos, trash, jobs]) => {
        setPhotos(photos)
        setTrash(trash)
        setJobs(jobs.filter((job: { status: string }) => job.status !== 'complete'))
        setLoading(false)
        setSelectedIds(new Set()) // Reset selection
      })
      .catch((err) => {
        console.error('Failed to load photos', err)
        setNotice('Failed to load the library. Please refresh and try again.')
        setLoading(false)
      })
  }

  const processUploadQueue = async (files: File[]) => {
    setIsUploading(true)
    setUploadProgress({ current: 0, total: files.length, failed: 0 })

    let failedCount = 0
    let pendingCount = 0

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (!file) continue
      const formData = new FormData()
      formData.append('file', file)

      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        })

        if (!res.ok) {
          failedCount++
          console.error(`Upload failed for ${file.name}`)
        } else if ((await res.json()).status === 'pending') pendingCount++
      } catch (err) {
        console.error(err)
        failedCount++
      }

      setUploadProgress((prev) =>
        prev ? { ...prev, current: i + 1, failed: failedCount } : null,
      )
    }

    setIsUploading(false)
    setUploadProgress(null)
    fetchPhotos()

    setNotice(`Upload complete. ${files.length - failedCount} originals saved${pendingCount ? `; ${pendingCount} awaiting image processing` : ''}${failedCount ? `; ${failedCount} failed to upload` : ''}.`)
  }

  const handleFiles = (files: FileList | null) => {
    if (isUploading || !files || files.length === 0) return
    const fileArray = Array.from(files)
    processUploadQueue(fileArray)
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
        setPhotos(photos.filter((p) => p.id !== id))
        const newSelected = new Set(selectedIds)
        newSelected.delete(id)
        setSelectedIds(newSelected)
        fetchPhotos()
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
      fetchPhotos()
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
    if (selectedIds.size === 0) return

    const newTagsStr = prompt(
      'Enter tags for selected photos (comma separated):',
    )
    if (newTagsStr === null) return

    const newTags = newTagsStr
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    try {
      const res = await fetch('/api/photos', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: Array.from(selectedIds),
          tags: newTags,
        }),
      })

      if (res.ok) {
        // Optimistic update
        const updatedPhotos = photos.map((p) =>
          selectedIds.has(p.id) ? { ...p, tags: newTags } : p,
        )
        setPhotos(updatedPhotos)
        setSelectedIds(new Set())
        alert('Batch update successful')
      } else {
        alert('Batch update failed')
      }
    } catch (e) {
      console.error(e)
      alert('Batch update error')
    }
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
      {jobs.length > 0 && (
        <section className={styles.statusPanel} aria-label="Image processing">
          <h2>Image processing ({jobs.length})</h2>
          <p>These originals are saved. Photos appear in the gallery when their previews are ready.</p>
          <button className={styles.button} disabled={retrying} onClick={retryJobs}>
            {retrying ? 'Processing…' : 'Retry unfinished jobs'}
          </button>
          <ul>{jobs.map(job => <li key={job.asset_hash}>{job.status}{job.error ? `: ${job.error}` : ''}</li>)}</ul>
        </section>
      )}

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
                />
              </th>
              <th>Thumbnail</th>
              <th>Filename</th>
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
                    alt={photo.name}
                    className={styles.thumbnail}
                  />
                </td>
                <td>{photo.name}</td>
                <td>{photo.date || '-'}</td>
                <td>{photo.tags?.join(', ') || '-'}</td>
                <td>
                  <button
                    onClick={() => {
                      const currentTags = photo.tags?.join(', ') || ''
                      const newTagsStr = prompt(
                        'Enter tags (comma separated):',
                        currentTags,
                      )
                      if (newTagsStr !== null && newTagsStr !== currentTags) {
                        const newTags = newTagsStr
                          .split(',')
                          .map((t) => t.trim())
                          .filter(Boolean)
                        fetch(`/api/photos/${photo.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ tags: newTags }),
                        })
                          .then((res) => res.json())
                          .then((data) => {
                            if (data.success) {
                              const updatedPhotos = photos.map((p) =>
                                p.id === photo.id ? { ...p, tags: newTags } : p,
                              )
                              setPhotos(updatedPhotos)
                            } else {
                              alert('Failed to update tags')
                            }
                          })
                      }
                    }}
                    className={styles.editButton || styles.deleteButton}
                    style={{ marginRight: '8px' }}
                  >
                    Tags
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
      <section className={styles.statusPanel} aria-label="Trash">
        <h2>Trash ({trash.length})</h2>
        <p>Deleted photos remain recoverable until explicit garbage collection after the retention period.</p>
        {trash.map(photo => (
          <div className={styles.trashRow} key={photo.id}>
            <span>{photo.name}</span>
            <button className={styles.button} onClick={() => restorePhoto(photo.id)}>Restore</button>
          </div>
        ))}
      </section>
    </div>
  )
}
