import { parentPort, workerData } from 'node:worker_threads'
import type { FormalOciJobSpec } from './formal-job.ts'
import { FormalOciAdapter, type FormalOciAdministratorConfig } from './formal-oci.ts'

type Input = {
  config: FormalOciAdministratorConfig
  job: FormalOciJobSpec
  directory: string
  receipt?: Uint8Array
}

const port = parentPort
if (!port) throw new Error('formal OCI worker requires a parent port')

try {
  const input = workerData as Input
  const adapter = new FormalOciAdapter(input.config)
  if (input.receipt) {
    port.postMessage({
      ok: true,
      valid: adapter.verifyReceipt(input.job, input.directory, input.receipt),
    })
    process.exit(0)
  }
  const result = adapter.run(input.job, input.directory)
  const receipt =
    result.exitCode === 0 && result.cleanupConfirmed
      ? Buffer.from(`${JSON.stringify(adapter.evaluate(input.job, input.directory))}\n`)
      : null
  port.postMessage({ ok: true, result, receipt })
} catch (error) {
  port.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : 'formal OCI worker failed',
  })
}
