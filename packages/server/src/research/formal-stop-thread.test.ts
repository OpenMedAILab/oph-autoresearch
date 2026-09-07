import { expect, test } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { type FormalThreadFactory, stopFormalOciInThread } from './formal-oci-thread.ts'

test('formal cleanup keeps the authority heartbeat responsive until an explicit worker stop confirmation', async () => {
  for (const confirmed of [true, false]) {
    let ticks = 0
    const timer = setInterval(() => ticks++, 40)
    let input: unknown
    const factory: FormalThreadFactory = (data) => {
      input = data
      return new Worker(new URL('./formal-stop-thread.fixture.ts', import.meta.url), {
        workerData: { confirmed },
      })
    }
    try {
      const outcome = await stopFormalOciInThread({} as never, {} as never, factory)
      expect(outcome).toBe(confirmed)
      expect(ticks).toBeGreaterThanOrEqual(10)
      expect(input).toMatchObject({ cleanup: true, directory: '' })
    } finally {
      clearInterval(timer)
    }
  }
})

test('cleanup worker errors, missing responses, and malformed success cannot prove container termination', async () => {
  for (const event of ['error', 'exit', 'message'] as const) {
    let terminated = 0
    const outcome = await stopFormalOciInThread({} as never, {} as never, () => {
      const callbacks = new Map<string, (value: unknown) => void>()
      queueMicrotask(() =>
        callbacks.get(event)?.(event === 'message' ? { ok: true, valid: 'true' } : 0),
      )
      return {
        once(name: string, callback: (value: unknown) => void) {
          callbacks.set(name, callback)
          return this
        },
        terminate: async () => {
          terminated++
          return 0
        },
      } as never
    })
    expect(outcome).toBe(false)
    expect(terminated).toBe(1)
  }
})

test('actual cleanup worker rejects an unconfigured runtime instead of treating its exit as stopped', async () => {
  expect(await stopFormalOciInThread({} as never, {} as never)).toBe(false)
})
