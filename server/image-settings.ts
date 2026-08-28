function integer(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}

export const imageConcurrency = integer('IMAGE_CONCURRENCY', 2, 1)
export const imageQueueSize = integer('IMAGE_QUEUE_SIZE', 8, 0)
export const imageMaxPixels = integer('IMAGE_MAX_PIXELS', 60_000_000, 1)
