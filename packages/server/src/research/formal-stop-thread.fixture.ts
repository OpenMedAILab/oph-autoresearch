import { parentPort, workerData } from 'node:worker_threads'

// A real busy worker substitutes only the external OCI command; this is not OCI admission.
const until = performance.now() + 700
let value = 0
while (performance.now() < until) value = Math.imul(value + 1, 2654435761)
parentPort!.postMessage(
  workerData.confirmed ? { ok: true, valid: true } : { ok: true, valid: false },
)
