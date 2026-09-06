import type { FormalCodeReviewResult, FormalExecutionPlan } from '@oph-autoresearch/core'

/**
 * Deliberately narrow port for the paid code reviewer.  It receives candidate
 * code and the frozen digest-only plan, and has no tool, conversation, event,
 * artifact-list, workspace-path, credential, or shell capability.
 */
export interface IsolatedFormalCodeReviewer {
  review(input: { code: string; plan: FormalExecutionPlan }): Promise<{
    reviewerId: string
    decision: FormalCodeReviewResult['decision']
    findings: FormalCodeReviewResult['findings']
    runnerReceiptHash: string
  }>
}
