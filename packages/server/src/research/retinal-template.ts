import type { SyntheticCompletionValidation } from '@oph-autoresearch/core'
import fixture from '../../../../fixtures/synthetic-retinal-images.json'
import { canonicalJson, type SkillLock, sha256 } from './skill-lock.ts'
import { lockedResearchSkillPort } from './skill-port.ts'
import { fitAndEvaluate } from './training-template.ts'

export const RETINAL_PROTOCOL = Object.freeze({
  id: 'synthetic-retinal-image-v1',
  modality: 'synthetic-fundus',
  feature: 'mean_grayscale_brightness_normalized',
  normalization: { center: 128, scale: 32 },
  purpose: 'synthetic phantom validation only; not a clinical classifier or performance claim',
})
type Image = {
  subjectId: string
  eye: string
  visitId: string
  duplicateGroupId: string
  split: 'train' | 'validation' | 'test'
  label: number
  pixels: number[]
}
type Fixture = { schema: string; width: number; height: number; modality: string; images: Image[] }
function hasKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function validText(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}
export function extractRetinalFeature(pixels: readonly number[]) {
  return (pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length - 128) / 32
}
export function fitRetinalEvaluation(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid retinal phantom fixture')
  const data = input as Fixture
  if (
    !hasKeys(data as unknown as Record<string, unknown>, [
      'height',
      'images',
      'modality',
      'schema',
      'width',
    ]) ||
    data.schema !== 'synthetic-retinal-image-v1' ||
    data.modality !== 'synthetic-fundus' ||
    !Number.isSafeInteger(data.width) ||
    !Number.isSafeInteger(data.height) ||
    data.width < 1 ||
    data.height < 1 ||
    data.width > 64 ||
    data.height > 64 ||
    !Array.isArray(data.images)
  )
    throw new Error('Invalid retinal phantom schema')
  const expectedPixels = data.width * data.height
  const rows = data.images.map((image, index) => {
    if (
      !image ||
      typeof image !== 'object' ||
      !hasKeys(image as unknown as Record<string, unknown>, [
        'duplicateGroupId',
        'eye',
        'label',
        'pixels',
        'split',
        'subjectId',
        'visitId',
      ]) ||
      !validText(image.subjectId) ||
      !validText(image.eye) ||
      !validText(image.visitId) ||
      !validText(image.duplicateGroupId) ||
      !['train', 'validation', 'test'].includes(image.split) ||
      !Number.isInteger(image.label) ||
      ![0, 1].includes(image.label) ||
      !Array.isArray(image.pixels) ||
      image.pixels.length !== expectedPixels ||
      !image.pixels.every((pixel) => Number.isSafeInteger(pixel) && pixel >= 0 && pixel <= 255)
    )
      throw new Error('Invalid retinal phantom image')
    return {
      id: `phantom-${index}`,
      patientId: image.subjectId,
      eye: image.eye,
      visitId: image.visitId,
      duplicateGroupId: image.duplicateGroupId,
      split: image.split,
      label: image.label,
      feature: extractRetinalFeature(image.pixels),
    }
  })
  const result = fitAndEvaluate({ schema: 'synthetic-features-v1', rows })
  return {
    report: result.report,
    preprocessing: result.preprocessing,
    featureExtraction: {
      schema: RETINAL_PROTOCOL.id,
      protocol: RETINAL_PROTOCOL.feature,
      modality: data.modality,
      purpose: RETINAL_PROTOCOL.purpose,
      width: data.width,
      height: data.height,
      images: rows.length,
      featureHash: sha256(canonicalJson(rows.map(({ feature, split }) => ({ feature, split })))),
    },
  }
}
const FIXTURE_HASH = 'sha256:ce5d32ed59791b68f28fa562215db289ea9f55f809fc731cff3ebe0a1c6b50ed'
const PROTOCOL_HASH = 'sha256:e2c14de70505e69c528753d635019d0d1f649bb9fda42988b453610caf818639'
const REPORT_HASH = 'sha256:c4946437570b4b5b43f0e6ea357e43e83d033986a6382393f8a10424f181ef23'
export const RETINAL_SKILL: SkillLock = {
  id: 'oph-first-party-synthetic-retinal-image',
  version: 1,
  source: {
    sourceKind: 'local-bundle',
    baseCommit: 'e4d3322f19b33c545819b4b5e15a50eaee4c5d33',
    path: 'fixtures/synthetic-retinal-images.json',
    contentHash: FIXTURE_HASH,
    license: 'MIT',
    dependencies: [],
    scriptHash: PROTOCOL_HASH,
    tools: [],
    network: 'deny',
    data: 'synthetic-only',
    backend: 'builtin-local',
    evaluation: { id: 'synthetic-retinal-image-contract-v1', hash: REPORT_HASH },
    reviewer: 'code-owned-first-party-lock',
    status: 'admitted-first-party',
    executionEnabled: true,
  },
}
export const RETINAL_SKILL_BINDING = Object.freeze({
  id: RETINAL_SKILL.id,
  version: 1,
  sourceHash: FIXTURE_HASH,
  evaluationHash: REPORT_HASH,
  templateId: 'synthetic-retinal-image-v1',
  templateHash: PROTOCOL_HASH,
})
export function retinalEvaluationOutput() {
  if (
    sha256(canonicalJson(fixture)) !== FIXTURE_HASH ||
    sha256(canonicalJson(RETINAL_PROTOCOL)) !== PROTOCOL_HASH
  )
    throw new Error('Fixed retinal phantom source or descriptor drift')
  const result = fitRetinalEvaluation(fixture)
  if (sha256(canonicalJson(result)) !== REPORT_HASH)
    throw new Error('Fixed retinal evaluation contract drift')
  return { schema: 'synthetic-retinal-image-v1' as const, inputHash: FIXTURE_HASH, ...result }
}
export async function assertRetinalSkill(manifest: unknown = RETINAL_SKILL) {
  if (canonicalJson(manifest) !== canonicalJson(RETINAL_SKILL))
    throw new Error('Invalid fixed retinal skill')
  retinalEvaluationOutput()
  await lockedResearchSkillPort([
    {
      lock: RETINAL_SKILL,
      observe: async () => ({ snapshot: RETINAL_SKILL.source, content: canonicalJson(fixture) }),
    },
  ]).read(RETINAL_SKILL.id)
}
export function reviewRetinalEvidence(bytes: Uint8Array): SyntheticCompletionValidation {
  if (bytes.byteLength > 64 * 1024) throw new Error('Retinal evidence exceeds size limit')
  if (
    canonicalJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) !==
    canonicalJson(retinalEvaluationOutput())
  )
    throw new Error('Retinal evidence differs from recomputed contract')
  return {
    inputHash: FIXTURE_HASH,
    contentHash: sha256(bytes),
    byteLength: bytes.byteLength,
    verifiedAt: Date.now(),
  }
}
