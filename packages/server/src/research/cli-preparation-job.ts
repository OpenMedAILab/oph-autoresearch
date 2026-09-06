import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import type { CliPreparationJobSpec, ResearchJobSpec } from '@oph-autoresearch/core'
import { canonicalJson, sha256 } from './skill-lock.ts'

export type { CliPreparationJobSpec } from '@oph-autoresearch/core'

export type DaemonJobSpec = ResearchJobSpec | CliPreparationJobSpec

export type CliPreparationAdministratorConfig = {
  backendPolicyHash: string
  workspaceRoot: string
  workspaceScope: string
  credentialHome: string
  adapters: Array<{
    deviceId: string
    kind: 'codex-exec' | 'claude-print'
    executable: string
    binaryHash: string
    id: string
    model: string
  }>
}

export function cliPreparationAdapterConfigHash(
  adapter: Pick<
    CliPreparationAdministratorConfig['adapters'][number],
    'binaryHash' | 'kind' | 'executable' | 'id' | 'model'
  >,
): string {
  return sha256(
    canonicalJson({
      kind: adapter.kind,
      id: adapter.id,
      model: adapter.model,
      executable: adapter.executable,
      binaryHash: adapter.binaryHash,
    }),
  )
}

/** Hashes an admitted executable only after rejecting links and unbounded inputs. */
export function cliPreparationExecutableHash(executable: string): string {
  const resolved = realpathSync(executable)
  const stat = lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024)
    throw new Error('unsafe CLI preparation executable')
  const descriptor = openSync(resolved, 'r')
  const hasher = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (let offset = 0; offset < stat.size; ) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      )
      if (count === 0) throw new Error('CLI preparation executable changed while hashing')
      hasher.update(buffer.subarray(0, count))
      offset += count
    }
  } finally {
    closeSync(descriptor)
  }
  return `sha256:${hasher.digest('hex')}`
}

export function isCliPreparationJob(spec: DaemonJobSpec): spec is CliPreparationJobSpec {
  return spec.version === 3
}
