import { describe, expect, test } from 'bun:test'
import fixture from '../../../../fixtures/synthetic-retinal-images.json'
import {
  assertRetinalSkill,
  extractRetinalFeature,
  fitRetinalEvaluation,
  RETINAL_SKILL,
  RETINAL_SKILL_BINDING,
  retinalEvaluationOutput,
} from './retinal-template.ts'

function input() {
  return structuredClone(fixture)
}
describe('synthetic retinal phantom template', () => {
  test('extracts deterministic grayscale features from actual raster values', () => {
    expect(extractRetinalFeature(input().images[0]!.pixels)).toBeCloseTo(-2.1875)
    const changed = input()
    changed.images[0]!.pixels.fill(90)
    expect(extractRetinalFeature(changed.images[0]!.pixels)).toBeGreaterThan(
      extractRetinalFeature(input().images[0]!.pixels),
    )
  })
  test('keeps train-only fitted parameters fixed when held-out rasters change', () => {
    const baseline = fitRetinalEvaluation(input())
    const changed = input()
    changed.images.find((image) => image.split === 'test' && image.label === 0)!.pixels.fill(255)
    const heldOut = fitRetinalEvaluation(changed)
    expect(heldOut.preprocessing).toEqual(baseline.preprocessing)
    expect(heldOut.report.metrics).not.toEqual(baseline.report.metrics)
  })
  test('rejects corrupt rasters and subject/group leakage', () => {
    const wrongDimensions = input()
    wrongDimensions.images[0]!.pixels.pop()
    expect(() => fitRetinalEvaluation(wrongDimensions)).toThrow(/image/)
    const invalid = input()
    invalid.images[0]!.pixels[0] = Number.NaN
    expect(() => fitRetinalEvaluation(invalid)).toThrow(/image/)
    const leaked = input()
    leaked.images[2]!.subjectId = leaked.images[0]!.subjectId
    leaked.images[2]!.eye = 'R'
    leaked.images[2]!.visitId = 'v2'
    expect(() => fitRetinalEvaluation(leaked)).toThrow(/crosses splits/)
  })
  test('emits aggregate-only phantom evidence and rejects provenance drift', async () => {
    const output = retinalEvaluationOutput()
    expect(output).toMatchObject({
      schema: 'synthetic-retinal-image-v1',
      inputHash: RETINAL_SKILL.source.contentHash,
      featureExtraction: { modality: 'synthetic-fundus', width: 8, height: 8, images: 11 },
    })
    expect(RETINAL_SKILL_BINDING).toMatchObject({
      templateId: 'synthetic-retinal-image-v1',
      sourceHash: output.inputHash,
    })
    expect(JSON.stringify(output)).not.toMatch(/pixels|subjectId|phantom-0|train-a|test-a/)
    const tampered = structuredClone(RETINAL_SKILL) as unknown as {
      source: { contentHash: string }
    }
    tampered.source.contentHash = `sha256:${'0'.repeat(64)}`
    await expect(assertRetinalSkill(tampered)).rejects.toThrow(/Invalid fixed retinal skill/)
  })
})
