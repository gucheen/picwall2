import { expect, mock, test } from 'bun:test'
import { forEachConcurrent, QueueFullError, TaskQueue } from '../server/task-queue'

test('bounds active jobs and pending work, then starts waiters in FIFO order', async () => {
  const queue = new TaskQueue(2, 2)
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
  const started: number[] = []
  const jobs = gates.map((gate, index) => queue.run(async () => {
    started.push(index)
    await gate.promise
    return index
  }))
  expect(started).toEqual([0, 1])
  const rejected = mock(async () => 5)
  await expect(queue.run(rejected)).rejects.toBeInstanceOf(QueueFullError)
  expect(rejected).not.toHaveBeenCalled()
  gates[1]!.resolve()
  expect(await jobs[1]).toBe(1)
  expect(started).toEqual([0, 1, 2])
  gates[0]!.resolve()
  await jobs[0]
  expect(started).toEqual([0, 1, 2, 3])
  gates[2]!.resolve()
  gates[3]!.resolve()
  expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3])
})

test('releases the slot after both async rejection and synchronous throws', async () => {
  const queue = new TaskQueue(1, 1)
  const gate = Promise.withResolvers<void>()
  const failed = queue.run(() => gate.promise)
  const next = queue.run(async () => 'next')
  gate.reject(new Error('failed'))
  await expect(failed).rejects.toThrow('failed')
  expect(await next).toBe('next')
  await expect(queue.run(() => { throw new Error('sync') })).rejects.toThrow('sync')
  expect(await queue.run(async () => 'recovered')).toBe('recovered')
})

test('cancelling a waiter frees queue space without running its file reader', async () => {
  const queue = new TaskQueue(1, 1)
  const gate = Promise.withResolvers<void>()
  const active = queue.run(() => gate.promise)
  const abort = new AbortController()
  const readFile = mock(async () => 'cancelled')
  const cancelled = queue.run(readFile, abort.signal)
  abort.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  const next = queue.run(async () => 'next')
  gate.resolve()
  await active
  expect(await next).toBe('next')
  expect(readFile).not.toHaveBeenCalled()
  await expect(queue.run(readFile, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(readFile).not.toHaveBeenCalled()
})

test('aborting an active job does not release its slot before the work settles', async () => {
  const queue = new TaskQueue(1, 1)
  const gate = Promise.withResolvers<void>()
  const abort = new AbortController()
  const active = queue.run(() => gate.promise, abort.signal)
  abort.abort()
  const work = mock(async () => 'next')
  const next = queue.run(work)
  expect(work).not.toHaveBeenCalled()
  gate.resolve()
  await active
  expect(await next).toBe('next')
})

test('allows disabling waiting and rejects invalid limits', async () => {
  for (const [concurrency, size] of [[0, 1], [1.5, 1], [1, -1], [1, NaN]]) {
    expect(() => new TaskQueue(concurrency!, size!)).toThrow()
  }
  const queue = new TaskQueue(1, 0)
  const gate = Promise.withResolvers<void>()
  const active = queue.run(() => gate.promise)
  await expect(queue.run(async () => {})).rejects.toBeInstanceOf(QueueFullError)
  gate.resolve()
  await active
})

test('directory workers pull files lazily without overflowing the upload queue', async () => {
  const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>())
  const started: number[] = []
  const complete = forEachConcurrent([0, 1, 2, 3, 4], 2, async index => {
    started.push(index)
    await gates[index]!.promise
  })
  expect(started).toEqual([0, 1])
  for (const gate of gates) gate.resolve()
  await complete
  expect(started).toEqual([0, 1, 2, 3, 4])
})
