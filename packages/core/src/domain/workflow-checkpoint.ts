import type { WorkflowNode, WorkflowReceipt } from './workflow.ts'

export function workflowAncestors(nodes: readonly WorkflowNode[], nodeId: string): Set<string> {
  const found = new Set<string>()
  const visit = (id: string) => {
    for (const need of nodes.find((node) => node.id === id)?.needs ?? []) {
      if (found.has(need)) continue
      found.add(need)
      visit(need)
    }
  }
  visit(nodeId)
  return found
}

/** A display projection of the existing node plan and validated receipts, shared by Web and cards. */
export function workflowCheckpointDetails(
  nodes: readonly WorkflowNode[],
  results: Record<string, WorkflowReceipt>,
  checkpointId: string,
) {
  const checkpoint = nodes.find((node) => node.id === checkpointId)
  const ancestors = workflowAncestors(nodes, checkpointId)
  const analyses = nodes.flatMap((node) => {
    if (node.kind === 'checkpoint' || node.outputKind !== 'analysis' || !ancestors.has(node.id))
      return []
    const receipt = results[node.id],
      output = receipt?.structuredOutput
    if (receipt?.status !== 'done' || !output) return []
    const next = output.next_experiment as {
      changes?: string[]
      rationale?: string
      estimated_cost?: string
    } | null
    return [
      {
        nodeId: node.id,
        decision: String(output.decision),
        summary: String(output.summary),
        nextExperiment: next
          ? [next.changes?.join('；'), next.rationale, next.estimated_cost]
              .filter(Boolean)
              .join('\n')
          : '',
      },
    ]
  })
  return { checks: checkpoint?.kind === 'checkpoint' ? (checkpoint.checks ?? []) : [], analyses }
}
export type WorkflowCheckpointDetails = ReturnType<typeof workflowCheckpointDetails>
