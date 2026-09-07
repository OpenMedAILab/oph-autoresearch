/** 桌面外壳把上一份 oph serve 的终态交给恢复进程时使用的窄环境协议。 */

import type { ProcessExitObservation } from '@oph-autoresearch/store'
import { redactSecrets } from '@oph-autoresearch/tools'

const KINDS = new Set<ProcessExitObservation['exitKind']>(['terminated', 'output_channel_closed'])

function finiteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function processExitObservationFromEnv(
  env: Record<string, string | undefined>,
): ProcessExitObservation | undefined {
  const kind = env.OPH_AUTORESEARCH_PREVIOUS_EXIT_KIND
  const observedAt = finiteNumber(env.OPH_AUTORESEARCH_PREVIOUS_EXIT_AT_MS)
  if (!KINDS.has(kind as ProcessExitObservation['exitKind']) || observedAt === null) {
    return undefined
  }
  return {
    source: 'desktop_sidecar',
    observedAt,
    exitKind: kind as ProcessExitObservation['exitKind'],
    exitCode: finiteNumber(env.OPH_AUTORESEARCH_PREVIOUS_EXIT_CODE),
    signal: finiteNumber(env.OPH_AUTORESEARCH_PREVIOUS_EXIT_SIGNAL),
    stderrTail: env.OPH_AUTORESEARCH_PREVIOUS_STDERR_TAIL?.trim() || null,
  }
}

/** 原生层看不到 provider 配置；到 server 持久化边界才有完整凭证集可安全脱敏。 */
export function sanitizeProcessExitObservation(
  observation: ProcessExitObservation,
  secrets: { values: string[] },
): ProcessExitObservation {
  return {
    ...observation,
    stderrTail: observation.stderrTail
      ? redactSecrets(observation.stderrTail, secrets).slice(-8_192)
      : null,
  }
}
