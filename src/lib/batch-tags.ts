export async function updatePhotoTags(ids: string[], tags: string[], onSaved: (ids: string[]) => void) {
  const unique = [...new Set(ids)]
  for (let offset = 0; offset < unique.length; offset += 1000) {
    const batch = unique.slice(offset, offset + 1000)
    const response = await fetch('/api/photos', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: batch, tags }),
    })
    if (!response.ok) throw new Error(`Could not update tags (${response.status}). Unsaved photos remain selected; please retry.`)
    onSaved(batch)
  }
}
