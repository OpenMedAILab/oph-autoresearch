/** Import candidates derived from real SSH tool outcomes, including member conversations. */
import { type ConversationId, parseTerminalJson, type Step } from '@oph-autoresearch/core'
import { listConversationTree, listRuns, listSteps, type Store } from '@oph-autoresearch/store'

export function campaignSteps(store: Store, parentId: ConversationId) {
  return listConversationTree(store, parentId).flatMap((conversation) =>
    listRuns(store, conversation.id).flatMap((run) => listSteps(store, run.id)),
  )
}
function dataOf(step: Step) {
  return step.status === 'success' &&
    step.payload?.kind === 'tool_result' &&
    step.payload.outcome.executed === true &&
    step.payload.outcome.status === 'success'
    ? step.payload.outcome.data
    : undefined
}
export function experimentSources(steps: Step[]) {
  return steps.flatMap((source) => {
    if (source.toolName !== 'ssh_run_command') return []
    const data = dataOf(source)
    if (!data) return []
    const wrap = (summary: Record<string, unknown>, statusStepId: string | null) => ({
      sourceStepId: source.id,
      statusStepId,
      runId: source.runId,
      createdAt: source.createdAt,
      summary,
    })
    if (source.payload?.kind === 'tool_result' && source.payload.args?.detach === true) {
      if (
        data.state !== 'running' ||
        typeof data.runDir !== 'string' ||
        !Number.isSafeInteger(data.pid)
      )
        return []
      return steps.flatMap((status) => {
        if (status.toolName !== 'ssh_job_status' || status.createdAt < source.createdAt) return []
        const terminal = dataOf(status)
        if (
          !terminal ||
          !['completed', 'failed'].includes(String(terminal.state)) ||
          terminal.profile !== data.profile ||
          terminal.runDir !== data.runDir ||
          terminal.pid !== data.pid ||
          !Number.isSafeInteger(terminal.exitCode) ||
          (terminal.state === 'completed') !== (terminal.exitCode === 0) ||
          typeof terminal.logTail !== 'string'
        )
          return []
        try {
          const receipt = parseTerminalJson(terminal.logTail)
          return [
            wrap(
              { ...receipt, run_dir: data.runDir, pid: data.pid, exit_code: terminal.exitCode },
              status.id,
            ),
          ]
        } catch {
          return []
        }
      })
    }
    if (data.exitCode !== 0 || data.timedOut !== false || typeof data.stdout !== 'string') return []
    try {
      const receipt = parseTerminalJson(data.stdout)
      return receipt.exit_code === data.exitCode ? [wrap(receipt, null)] : []
    } catch {
      return []
    }
  })
}
