import styles from './Admin.module.css'

export default function PageControls({ label, page, loading, error, hasNext, hasPrevious, next, previous, refresh, disabled = false }: {
  label: string; page: number; loading: boolean; error: string; hasNext: boolean; hasPrevious: boolean;
  next: () => void; previous: () => void; refresh: () => void; disabled?: boolean
}) {
  return <nav className={styles.pageControls} aria-label={`${label} pages`}>
    <button onClick={previous} disabled={disabled || loading || !hasPrevious}>Previous</button>
    <span>{label} · Page {page}{loading ? ' · Loading…' : ''}</span>
    <button onClick={next} disabled={disabled || loading || !hasNext}>Next</button>
    <button onClick={refresh} disabled={disabled || loading}>{error ? 'Retry' : 'Refresh'}</button>
    {error && <p role="alert">{error}</p>}
  </nav>
}
