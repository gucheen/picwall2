import { useState, useEffect } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './Admin.module.css'

export default function Admin() {
    const [photos, setPhotos] = useState<Photo[]>([])
    const [loading, setLoading] = useState(true)
    const [isUploading, setIsUploading] = useState(false)
    const [user, setUser] = useState<any>(null)
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [lastSelectedId, setLastSelectedId] = useState<string | null>(null)

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
        fetch('/api/photos')
            .then((res) => res.json())
            .then((data) => {
                setPhotos(data)
                setLoading(false)
                setSelectedIds(new Set()) // Reset selection
            })
            .catch((err) => {
                console.error('Failed to load photos', err)
                setLoading(false)
            })
    }

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files?.length) return

        setIsUploading(true)
        const file = e.target.files[0] as File
        const formData = new FormData()
        formData.append('file', file)

        try {
            const res = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            })

            if (res.ok) {
                fetchPhotos()
            } else {
                alert('Upload failed or Unauthorized')
            }
        } catch (err) {
            console.error(err)
            alert('Upload error')
        } finally {
            setIsUploading(false)
        }
    }

    const handleDelete = async (id: string) => {
        if (!confirm('Are you sure you want to delete this photo?')) return

        try {
            const res = await fetch(`/api/photos/${id}`, {
                method: 'DELETE',
            })

            if (res.ok) {
                setPhotos(photos.filter((p) => p.id !== id))
                const newSelected = new Set(selectedIds)
                newSelected.delete(id)
                setSelectedIds(newSelected)
            } else {
                alert('Delete failed')
            }
        } catch (err) {
            console.error(err)
            alert('Delete error')
        }
    }
    
    const toggleSelection = (id: string, shiftKey: boolean = false) => {
        const newSelected = new Set(selectedIds)
        
        if (shiftKey && lastSelectedId && lastSelectedId !== id) {
             const lastIndex = photos.findIndex(p => p.id === lastSelectedId)
             const currentIndex = photos.findIndex(p => p.id === id)
             
             if (lastIndex !== -1 && currentIndex !== -1) {
                 const start = Math.min(lastIndex, currentIndex)
                 const end = Math.max(lastIndex, currentIndex)
                 
                 for (let i = start; i <= end; i++) {
                     if (photos[i]) {
                         newSelected.add(photos[i].id)
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
            setSelectedIds(new Set(photos.map(p => p.id)))
        }
    }

    const handleBatchTags = async () => {
        if (selectedIds.size === 0) return
        
        const newTagsStr = prompt('Enter tags for selected photos (comma separated):')
        if (newTagsStr === null) return

        const newTags = newTagsStr.split(',').map(t => t.trim()).filter(Boolean)
        
        try {
            const res = await fetch('/api/photos', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    ids: Array.from(selectedIds), 
                    tags: newTags 
                })
            })
            
            if (res.ok) {
                // Optimistic update
                const updatedPhotos = photos.map(p => 
                    selectedIds.has(p.id) ? { ...p, tags: newTags } : p
                )
                setPhotos(updatedPhotos)
                setSelectedIds(new Set())
                alert('Batch update successful')
            } else {
                alert('Batch update failed')
            }
        } catch(e) {
            console.error(e)
            alert('Batch update error')
        }
    }

    if (loading) return <div className={styles.loading}>Loading...</div>

    if (!user) {
        return (
            <div className={styles.container}>
                <h1>Admin Access Required</h1>
                <a href="/api/auth/login" className={styles.button} style={{ display: 'inline-block' }}>
                    Login with PocketID
                </a>
            </div>
        )
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h1>Photo Management</h1>
                <div className={styles.actions}>
                   {selectedIds.size > 0 && (
                        <button 
                            onClick={handleBatchTags} 
                            className={styles.button}
                            style={{ marginRight: '1rem', backgroundColor: '#555', color: '#fff' }}
                        >
                            Batch Tags ({selectedIds.size})
                        </button>
                    )}
                    <a href="/" className={styles.link}>
                        View Site
                    </a>
                    <div className={styles.uploadWrapper}>
                        <input
                            type="file"
                            id="upload"
                            accept="image/*"
                            className={styles.fileInput}
                            onChange={handleUpload}
                            disabled={isUploading}
                        />
                        <label
                            htmlFor="upload"
                            className={`${styles.button} ${isUploading ? styles.disabled : ''}`}
                        >
                            {isUploading ? 'Uploading...' : 'Upload New Photo'}
                        </label>
                    </div>
                </div>
            </div>

            <div className={styles.tableWrapper}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                             <th>
                                <input 
                                    type="checkbox" 
                                    checked={photos.length > 0 && selectedIds.size === photos.length}
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
                            <tr key={photo.id} style={{ backgroundColor: selectedIds.has(photo.id) ? 'rgba(255,255,255,0.05)' : 'transparent' }}>
                                <td>
                                    <input 
                                        type="checkbox" 
                                        checked={selectedIds.has(photo.id)}
                                        onClick={(e) => toggleSelection(photo.id, (e.nativeEvent as MouseEvent).shiftKey)}
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
                                            const newTagsStr = prompt('Enter tags (comma separated):', currentTags)
                                            if (newTagsStr !== null && newTagsStr !== currentTags) {
                                                const newTags = newTagsStr.split(',').map(t => t.trim()).filter(Boolean)
                                                fetch(`/api/photos/${photo.id}`, {
                                                    method: 'PATCH',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ tags: newTags }),
                                                })
                                                .then(res => res.json())
                                                .then(data => {
                                                    if (data.success) {
                                                        const updatedPhotos = photos.map(p => 
                                                            p.id === photo.id ? { ...p, tags: newTags } : p
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
                                        Delete
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
