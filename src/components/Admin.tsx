import { useState, useEffect } from 'react'
import type { Photo } from '../../types/shared_types'
import styles from './Admin.module.css'

export default function Admin() {
    const [photos, setPhotos] = useState<Photo[]>([])
    const [loading, setLoading] = useState(true)
    const [isUploading, setIsUploading] = useState(false)
    const [user, setUser] = useState<any>(null)

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
            } else {
                alert('Delete failed')
            }
        } catch (err) {
            console.error(err)
            alert('Delete error')
        }
    }

    if (loading) return <div className={styles.loading}>Loading...</div>

    if (!user) {
        return (
            <div className={styles.container}>
                <h1>Admin Access Required</h1>
                <a href="/api/auth/login" className={styles.button}>
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
                            <th>Thumbnail</th>
                            <th>Filename</th>
                            <th>Date</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {photos.map((photo) => (
                            <tr key={photo.id}>
                                <td>
                                    <img
                                        src={photo.thumbnailSrc || photo.src}
                                        alt={photo.name}
                                        className={styles.thumbnail}
                                    />
                                </td>
                                <td>{photo.name}</td>
                                <td>{photo.date || '-'}</td>
                                <td>
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
