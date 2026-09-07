import { parentPort } from 'node:worker_threads'

const until = Date.now() + 1600
let value = 0
while (Date.now() < until) value = (value + Math.sqrt(value + 1)) % 1000
parentPort!.postMessage({
  ok: true,
  result: {
    exitCode: 0,
    stdout: new Uint8Array([1]),
    stderr: new Uint8Array(),
    cleanupConfirmed: true,
  },
  receipt: new Uint8Array([value & 255]),
})
