export class QueueFullError extends Error {
  constructor() { super('Image processing queue is full. Please retry shortly.') }
}

export class TaskQueue {
  private active = 0
  private pending: (() => void)[] = []

  constructor(private concurrency: number, private maxPending: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1
      || !Number.isSafeInteger(maxPending) || maxPending < 0) {
      throw new Error('Queue concurrency must be a positive integer and queue size a non-negative integer')
    }
  }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.active >= this.concurrency && this.pending.length >= this.maxPending) {
      return Promise.reject(new QueueFullError())
    }

    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = this.pending.indexOf(start)
        if (index !== -1) this.pending.splice(index, 1)
        reject(signal!.reason)
      }
      const start = () => {
        signal?.removeEventListener('abort', cancel)
        this.active++
        void (async () => {
          try {
            signal?.throwIfAborted()
            resolve(await work())
          } catch (error) {
            reject(error)
          } finally {
            this.active--
            this.pending.shift()?.()
          }
        })()
      }

      if (this.active < this.concurrency) start()
      else {
        this.pending.push(start)
        signal?.addEventListener('abort', cancel, { once: true })
      }
    })
  }
}

export async function forEachConcurrent<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer')
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}
