import { expect, test } from 'bun:test'
import { Worker } from 'node:worker_threads'
import { type FormalThreadFactory, runFormalOciInThread } from './formal-oci-thread.ts'

const invoke = (factory?: FormalThreadFactory) =>
  runFormalOciInThread({} as never, {} as never, '/tmp', factory)

test('formal OCI thread keeps the outer heartbeat alive during real CPU work', async () => {
  let heartbeats = 0
  const timer = setInterval(() => heartbeats++, 100)
  try {
    const result = await invoke(
      () => new Worker(new URL('./formal-oci-thread.fixture.ts', import.meta.url)),
    )
    expect(result.ok).toBe(true)
    expect(result.receipt).toBeInstanceOf(Uint8Array)
    expect(heartbeats).toBeGreaterThanOrEqual(10)
  } finally {
    clearInterval(timer)
  }
})

test('formal OCI thread fails closed for an error or an exit without a message', async () => {
  for (const event of ['error', 'exit'] as const) {
    const result = await invoke(() => {
      const callbacks = new Map<string, (value: never) => void>()
      queueMicrotask(() =>
        callbacks.get(event)?.(event === 'exit' ? (0 as never) : (new Error('boom') as never)),
      )
      return {
        once(name: string, callback: (value: never) => void) {
          callbacks.set(name, callback)
          return this
        },
        terminate: async () => 0,
      } as never
    })
    expect(result.ok).toBe(false)
  }
})

test('formal OCI thread rejects a success without a receipt', async () => {
  const result = await invoke(() => {
    const callbacks = new Map<string, (value: never) => void>()
    queueMicrotask(() => callbacks.get('message')?.({ ok: true, result: { exitCode: 0 } } as never))
    return {
      once(name: string, callback: (value: never) => void) {
        callbacks.set(name, callback)
        return this
      },
      terminate: async () => 0,
    } as never
  })
  expect(result.ok).toBe(false)
})
