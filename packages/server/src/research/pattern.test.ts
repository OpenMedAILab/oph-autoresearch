import { describe, expect, test } from 'bun:test'
import { compileResearchPattern } from './pattern.ts'

const input = {
  dataMode: 'features' as const,
  backend: 'builtin-local' as const,
  policy: {
    syntheticOnly: true as const,
    allowPublicMetadata: false,
    maxModelRequests: 2 as const,
    currency: 'CNY' as const,
    budget: 10,
  },
}
describe('fixed synthetic research Pattern', () => {
  test('compiles deterministic nine-stage finite dependencies', () => {
    const a = compileResearchPattern(input),
      b = compileResearchPattern(input)
    expect(a).toEqual(b)
    expect(a.nodes.map((n) => n.stageId)).toEqual([
      'question',
      'literature',
      'dataset_audit',
      'protocol_freeze',
      'smoke',
      'experiment',
      'evaluation',
      'independent_review',
      'release',
    ])
    expect(a.nodes[6]!.dependsOn).toEqual(['experiment'])
    expect(a.nodes.filter((n) => n.requiresHumanApproval).map((n) => n.stageId)).toEqual([
      'experiment',
      'independent_review',
      'release',
    ])
  })
  test('rejects arbitrary code, paths and policy capabilities', () => {
    for (const change of [
      { code: 'import x' },
      { path: 'C:/data' },
      { ...input, policy: { ...input.policy, syntheticOnly: false } },
      { ...input, policy: { ...input.policy, maxModelRequests: 3 } },
    ])
      expect(() => compileResearchPattern(change)).toThrow()
  })
  test('uses only fixed registry candidate measurement and blocks unmet criteria', () => {
    const selected = compileResearchPattern({
      ...input,
      adaptive: { minSensitivity: 0.5, minSpecificity: 0.5, maxAuRocCIWidth: 1 },
    })
    expect(selected.selection).toMatchObject({
      selectedTemplateId: 'synthetic-training-evaluation-v1',
      status: 'selected',
    })
    expect(selected.selection.measurements[0]).toMatchObject({
      templateId: 'synthetic-training-evaluation-v1',
      inputHash: expect.stringMatching(/^sha256:/),
    })
    expect(
      compileResearchPattern({
        ...input,
        adaptive: { minSensitivity: 1, minSpecificity: 1, maxAuRocCIWidth: 0 },
      }).selection.status,
    ).toBe('blocked')
  })
  test('maps retinal images to the curated retinal fixed template', () =>
    expect(
      compileResearchPattern({ ...input, dataMode: 'retinal-images' }).selection.selectedTemplateId,
    ).toBe('synthetic-retinal-image-v1'))
})
