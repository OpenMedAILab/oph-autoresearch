import { describe, expect, test } from 'bun:test'
import {
  FORMAL_DATASET_TARGET,
  FORMAL_ENTRY_ARGV,
  FORMAL_EXECUTION_SCHEMA,
  FORMAL_OUTPUT_TARGET,
  validFormalCodeReviewResult,
  validFormalExecutionPlan,
} from './formal-execution.ts'

const hash = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`

function plan() {
  return {
    schema: FORMAL_EXECUTION_SCHEMA,
    planId: 'plan_1',
    taskRevisionId: 'task_1',
    candidateArtifactId: 'artifact_1',
    codeHash: hash('a'),
    candidateReceiptHash: hash('b'),
    workspaceBindingHash: hash('c'),
    ociImageDigest: hash('d'),
    entryArgv: FORMAL_ENTRY_ARGV,
    dataManifestHash: hash('e'),
    labelSetContentHash: hash('f'),
    trustedEvaluatorId: 'binary-classification-v1',
    trustedEvaluatorHash: hash('1'),
    resources: {
      maxRuntimeMs: 11 * 60_000,
      cpu: 2,
      memoryMb: 512,
      pidsLimit: 128,
      network: 'disabled' as const,
    },
    datasetMount: { target: FORMAL_DATASET_TARGET, readOnly: true as const },
    outputMount: { target: FORMAL_OUTPUT_TARGET },
  }
}

describe('formal execution contract', () => {
  test('accepts only fixed non-shell OCI execution constraints', () => {
    expect(validFormalExecutionPlan(plan())).toBe(true)
    expect(validFormalExecutionPlan({ ...plan(), entryArgv: ['sh', '-c'] })).toBe(false)
    expect(
      validFormalExecutionPlan({
        ...plan(),
        resources: { ...plan().resources, network: 'enabled' },
      }),
    ).toBe(false)
    expect(validFormalExecutionPlan({ ...plan(), outputMount: { target: '/tmp/user-path' } })).toBe(
      false,
    )
  })

  test('does not let accepted review conceal an error finding or claim a human runner receipt', () => {
    const review = {
      schema: 'research-formal-code-review-v1' as const,
      reviewId: 'review_1',
      reviewKind: 'isolated-api' as const,
      candidateArtifactId: 'artifact_1',
      taskRevisionId: 'task_1',
      codeHash: hash('a'),
      candidateReceiptHash: hash('b'),
      workspaceBindingHash: hash('c'),
      ociImageDigest: hash('d'),
      dataManifestHash: hash('e'),
      labelSetContentHash: hash('f'),
      trustedEvaluatorId: 'binary-classification-v1',
      trustedEvaluatorHash: hash('1'),
      decision: 'accepted' as const,
      findings: [],
      reviewedAt: 1,
      reviewerId: 'binary-classification-v1',
      runnerReceiptHash: hash('2'),
    }
    expect(validFormalCodeReviewResult(review)).toBe(true)
    expect(
      validFormalCodeReviewResult({
        ...review,
        findings: [{ severity: 'error', code: 'unsafe', message: 'unsafe' }],
      }),
    ).toBe(false)
    expect(validFormalCodeReviewResult({ ...review, reviewKind: 'human-signed' })).toBe(false)
  })
})
