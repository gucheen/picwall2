import { useEffect, useState } from 'react'
import { useSearchParams } from 'wouter'
import PhotoGallery from './PhotoGallery'
import styles from './PhotoWall.module.css'

export default function PhotoWall() {
  const [search, setSearch] = useSearchParams()
  const tag = search.get('tag') || null
  const [tags, setTags] = useState<string[]>([])
  const [user, setUser] = useState<{ name: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/tags', { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Failed to load tags')
      return response.json()
    }).then(setTags).catch(() => {})
    fetch('/api/auth/me', { signal: controller.signal }).then(response => response.json())
      .then(data => setUser(data.user || null)).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [tag])

  return <div className={styles.container}>
    <header className={styles.header}>
      <div className={styles.headerContent}>
        <a href="/"><h1 className={styles.title}>PicWall</h1></a>
        <div className={styles.headerTags}>
          <button className={`${styles.tagLink} ${!tag ? styles.tagLinkActive : ''}`} onClick={() => setSearch(new URLSearchParams())}>All</button>
          {tags.map(value => <button key={value} className={`${styles.tagLink} ${tag === value ? styles.tagLinkActive : ''}`}
            onClick={() => setSearch(new URLSearchParams({ tag: value }))}>#{value}</button>)}
        </div>
        <a href={user ? '/admin' : '/login'} className={styles.uploadLabel}>{user ? 'Admin Dashboard' : 'Sign In'}</a>
      </div>
    </header>
    <PhotoGallery key={tag ?? ''} tag={tag} />
  </div>
}
