import type { FormalExecutionRoute } from './formal-execution-controller.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'
import { createSshDaemonClient, type SshDaemonConfig } from './ssh-daemon-client.ts'

/** Trusted administrator configuration; never accepted from an HTTP body or model tool. */
export type SshFormalExecutionRoute = Omit<FormalExecutionRoute, 'authority'> & {
  config: SshDaemonConfig
}
export function createFormalSshRoute(input: SshFormalExecutionRoute) {
  if (input.config.authorityId !== input.authorityId) throw new Error('正式执行服务器身份不匹配')
  const client = createSshDaemonClient(input.config)
  const route: FormalExecutionRoute = {
    ...input,
    authority: {
      identity: () => client.identity(),
      submit: (spec, epoch) => client.submit(spec, epoch),
      query: (key, epoch) => client.query(key, epoch),
      cancel: (key, epoch) => client.cancel(key, epoch),
      receipt: (key, epoch) => client.receipt(key, epoch),
      reconcileInterrupted: () => client.reconcileInterrupted(),
      registerCandidate: (candidate) => client.registerFormalCandidate(candidate),
      async verifyReceipt(spec, bytes) {
        const job = await client.query(spec.dispatchKey, spec.execution.authorityEpoch)
        const specHash = sha256(canonicalJson(spec))
        if (
          !job ||
          job.status !== 'completed' ||
          job.specHash !== specHash ||
          job.contentHash !== sha256(bytes)
        )
          return false
        return client.verifyFormalReceipt(spec.dispatchKey, specHash, spec.execution.authorityEpoch)
      },
    },
  }
  return { route, close: () => client.close() }
}
