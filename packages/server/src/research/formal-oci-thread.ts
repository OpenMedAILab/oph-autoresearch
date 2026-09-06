import { Worker } from 'node:worker_threads'
import type { FormalOciJobSpec } from './formal-job.ts'
import type { FormalOciAdministratorConfig } from './formal-oci.ts'

export type FormalThreadResult = {
  ok: boolean
  error?: string
  result?: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; cleanupConfirmed: boolean }
  receipt?: Uint8Array | null
}
type Thread = Pick<Worker, 'once' | 'terminate'>
export type FormalThreadFactory = (data: unknown) => Thread

function valid(value: unknown): value is FormalThreadResult {
  if (!value || typeof value !== 'object') return false
  const row = value as FormalThreadResult
  return row.ok === false || Boolean(row.ok && row.result && row.receipt instanceof Uint8Array)
}

export function runFormalOciInThread(
  config: FormalOciAdministratorConfig,
  job: FormalOciJobSpec,
  directory: string,
  factory: FormalThreadFactory = (data) =>
    new Worker(new URL('./formal-oci-worker.ts', import.meta.url), { workerData: data }),
): Promise<FormalThreadResult> {
  return new Promise((resolve) => {
    const worker = factory({ config, job, directory })
    let settled = false
    const finish = (result: FormalThreadResult) => {
      if (settled) return
      settled = true
      void worker.terminate().catch(() => {})
      resolve(result)
    }
    worker.once('message', (message: unknown) =>
      finish(
        valid(message)
          ? message
          : { ok: false, error: 'formal OCI worker returned an invalid result' },
      ),
    )
    worker.once('error', () => finish({ ok: false, error: 'formal OCI worker crashed' }))
    worker.once('exit', (code) =>
      finish({ ok: false, error: `formal OCI worker exited without a result (${code})` }),
    )
  })
}
