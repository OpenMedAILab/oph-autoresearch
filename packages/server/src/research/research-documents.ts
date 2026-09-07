import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ArtifactVersion, ResearchCampaign } from '@oph-autoresearch/core'
import {
  getResearchCampaign,
  mutateResearchCampaign,
  reviewSourceContextHash,
  type Store,
  scientificContextHash,
} from '@oph-autoresearch/store'
import {
  isKnowledgeKind,
  type KnowledgeKind,
  knowledgeKey,
  validateKnowledge,
} from './research-knowledge.ts'
import { parseModelReview } from './review-contract.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'
import { type WorkflowReviewEvidence, workflowDocumentEvidence } from './workflow-evidence.ts'

export type ResearchDocumentKind = 'study' | 'manuscript' | 'skillcandidate' | KnowledgeKind
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const HASH = /^sha256:[a-f0-9]{64}$/
const MAX_BYTES = 256 * 1024
const MAX_TEXT = 16_000
const MAX_SHORT_TEXT = 512

export class ResearchDocumentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
  }
}
type DocumentInput = Record<string, unknown>
type StoredDocument = { kind: ResearchDocumentKind; document: DocumentInput }
function fail(message: string, status: 400 | 404 | 409 = 400): never {
  throw new ResearchDocumentError(message, status)
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function text(value: unknown, field: string, maximum = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`invalid ${field}`)
  return value
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  if (!isObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) && Object.values(value).every(jsonValue)
  )
}
function json(value: unknown, field: string, nonempty = false): Record<string, unknown> {
  if (!isObject(value) || !jsonValue(value) || (nonempty && Object.keys(value).length === 0))
    fail(`invalid ${field}`)
  try {
    if (canonicalJson(value).length > MAX_TEXT) fail(`invalid ${field}`)
  } catch {
    fail(`invalid ${field}`)
  }
  return value
}
function stringList(value: unknown, field: string, maximum = 64): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum)
    fail(`invalid ${field}`)
  const result = value.map((entry) => text(entry, field, MAX_TEXT))
  if (new Set(result).size !== result.length) fail(`invalid ${field}`)
  return result
}
function latestDocument(
  campaign: ResearchCampaign,
  kind: ResearchDocumentKind,
  key?: string,
): ArtifactVersion | undefined {
  return campaign.artifactVersions
    .filter(
      (artifact) =>
        artifact.artifactId === documentArtifactId(kind, key) &&
        artifact.kind === `research-document-${kind}`,
    )
    .toSorted((left, right) => right.version - left.version)[0]
}
function requirePreviousVersion(
  campaign: ResearchCampaign,
  kind: ResearchDocumentKind,
  value: unknown,
  key?: string,
) {
  const latest = latestDocument(campaign, kind, key)
  if (latest ? value !== latest.contentHash : value !== null)
    fail(
      `previousVersion must be ${latest?.contentHash ?? 'null'} (latest document contentHash)`,
      409,
    )
}

function staleTaskIds(campaign: ResearchCampaign): Set<string> {
  const stale = new Set<string>()
  for (const task of campaign.taskRevisions) {
    if (
      task.sourceContextHash &&
      task.sourceContextHash !== scientificContextHash(campaign, task.sourceContextVersion ?? 1)
    )
      if (campaign.taskRevisions.some((next) => next.previousRevisionId === task.id))
        stale.add(task.id)
    for (const contentHash of task.labelSetContentHashes ?? []) {
      const bound = campaign.labelSets?.find((labelSet) => labelSet.contentHash === contentHash)
      const latest = campaign.labelSets
        ?.filter((labelSet) => labelSet.id === bound?.id)
        .toSorted((left, right) => right.version - left.version)[0]
      if (!bound || latest?.contentHash !== contentHash) stale.add(task.id)
    }
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const task of campaign.taskRevisions) {
      if (stale.has(task.id)) continue
      if (
        (task.artifactVersionIds ?? []).some((id) => {
          const artifact = campaign.artifactVersions.find((candidate) => candidate.id === id)
          return (
            !artifact ||
            campaign.artifactVersions.some(
              (candidate) =>
                candidate.artifactId === artifact.artifactId &&
                candidate.version > artifact.version,
            ) ||
            (!!artifact.producerTaskRevisionId && stale.has(artifact.producerTaskRevisionId))
          )
        })
      ) {
        stale.add(task.id)
        changed = true
      }
    }
  }
  return stale
}
function isCurrentValidatedArtifact(campaign: ResearchCampaign, artifactId: string): boolean {
  const artifact = campaign.artifactVersions.find((candidate) => candidate.id === artifactId)
  const task = artifact?.producerTaskRevisionId
    ? campaign.taskRevisions.find((candidate) => candidate.id === artifact.producerTaskRevisionId)
    : undefined
  if (
    !artifact?.validation ||
    !artifact.producerTaskRevisionId ||
    !artifact.producerAttemptId ||
    !task ||
    artifact.validation.contentHash !== artifact.contentHash ||
    artifact.validation.inputHash !== task.inputHash ||
    campaign.artifactVersions.some(
      (candidate) =>
        candidate.artifactId === artifact.artifactId && candidate.version > artifact.version,
    ) ||
    staleTaskIds(campaign).has(artifact.producerTaskRevisionId)
  )
    return false
  return campaign.attempts.some(
    (attempt) =>
      attempt.id === artifact.producerAttemptId &&
      attempt.taskRevisionId === artifact.producerTaskRevisionId &&
      attempt.status === 'completed' &&
      attempt.artifactVersionId === artifact.id,
  )
}
function reviewEvidence(
  campaign: ResearchCampaign,
  reviewId: unknown,
  workflowReviews: WorkflowReviewEvidence[] = [],
) {
  const workflowReview = workflowReviews.find((item) => item.review.id === reviewId)
  if (workflowReview) return workflowReview
  const review =
    typeof reviewId === 'string'
      ? campaign.modelReviews?.find((item) => item.id === reviewId)
      : undefined
  if (
    !review ||
    review.status !== 'done' ||
    review.sourceValidity !== 'current' ||
    review.sourceContextHash !==
      reviewSourceContextHash(campaign, review.sourceContextVersion ?? 1) ||
    review.artifactVersionIds.some((id) => !isCurrentValidatedArtifact(campaign, id))
  )
    return null
  try {
    const map = parseModelReview(review.text ?? '', review.artifactVersionIds)
    return map.decision === 'supported' ? { review, map, workflow: false } : null
  } catch {
    return null
  }
}
function currentReview(
  campaign: ResearchCampaign,
  reviewId: unknown,
  workflowReviews: WorkflowReviewEvidence[] = [],
) {
  const evidence = reviewEvidence(campaign, reviewId, workflowReviews)
  if (!evidence) fail('unsupported manuscript claim', 409)
  return evidence
}
function sameArtifactReferences(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
function validateStudy(campaign: ResearchCampaign, document: DocumentInput) {
  if (
    !hasExactKeys(document, [
      'PICO',
      'codeVersion',
      'counterEvidence',
      'endpoints',
      'evidenceCitations',
      'previousVersion',
      'protocol',
      'question',
      'splitPlan',
    ])
  )
    fail('invalid study document')
  text(document.question, 'study question')
  json(document.PICO, 'study PICO', true)
  json(document.protocol, 'study protocol', true)
  json(document.splitPlan, 'study splitPlan', true)
  text(document.codeVersion, 'study codeVersion', MAX_SHORT_TEXT)
  const citations = stringList(document.evidenceCitations, 'study evidenceCitations')
  if (
    citations.some(
      (id) =>
        !campaign.literatureCitations?.some((citation) => citation.id === id) &&
        !campaign.artifactVersions.some(
          (a) => a.kind === 'research-document-evidence' && a.contentHash === id,
        ),
    )
  )
    fail('unknown evidence citation', 409)
  stringList(document.counterEvidence, 'study counterEvidence')
  stringList(document.endpoints, 'study endpoints')
  requirePreviousVersion(campaign, 'study', document.previousVersion)
}
function validateManuscript(
  campaign: ResearchCampaign,
  document: DocumentInput,
  workflowReviews: WorkflowReviewEvidence[] = [],
) {
  if (!hasExactKeys(document, ['claims', 'journalRequirementsHash', 'previousVersion', 'text']))
    fail('invalid manuscript document')
  text(document.text, 'manuscript text', 96_000)
  if (
    typeof document.journalRequirementsHash !== 'string' ||
    !HASH.test(document.journalRequirementsHash)
  )
    fail('invalid manuscript journalRequirementsHash')
  if (
    !Array.isArray(document.claims) ||
    document.claims.length === 0 ||
    document.claims.length > 128
  )
    fail('invalid manuscript claims')
  for (const candidate of document.claims) {
    if (
      !isObject(candidate) ||
      !hasExactKeys(candidate, ['artifactVersionIds', 'claim', 'reviewId'])
    )
      fail('unsupported manuscript claim')
    text(candidate.claim, 'manuscript claim')
    const ids = stringList(candidate.artifactVersionIds, 'manuscript artifactVersionIds')
    const { review, map, workflow } = currentReview(campaign, candidate.reviewId, workflowReviews)
    if (
      ids.some(
        (id) =>
          !review.artifactVersionIds.includes(id) ||
          (!workflow && !isCurrentValidatedArtifact(campaign, id)),
      )
    )
      fail('unsupported manuscript claim', 409)
    if (
      !map.claims.some(
        (supported) =>
          supported.claim === candidate.claim &&
          sameArtifactReferences(supported.artifactVersionIds, ids),
      )
    )
      fail('unsupported manuscript claim', 409)
  }
  requirePreviousVersion(campaign, 'manuscript', document.previousVersion)
}
function validateSkillCandidate(campaign: ResearchCampaign, document: DocumentInput) {
  if (
    !hasExactKeys(document, [
      'evaluationArtifactVersionIds',
      'previousVersion',
      'sourceHash',
      'status',
    ])
  )
    fail('invalid skill candidate')
  if (
    document.status !== 'candidate-not-admitted' ||
    typeof document.sourceHash !== 'string' ||
    !HASH.test(document.sourceHash)
  )
    fail('invalid skill candidate')
  if (
    stringList(document.evaluationArtifactVersionIds, 'skill candidate evaluations').some(
      (id) => !isCurrentValidatedArtifact(campaign, id),
    )
  )
    fail('invalid skill candidate evaluation reference', 409)
  requirePreviousVersion(campaign, 'skillcandidate', document.previousVersion)
}
function validateDocument(
  campaign: ResearchCampaign,
  kind: ResearchDocumentKind,
  document: DocumentInput,
  workflowReviews: WorkflowReviewEvidence[] = [],
) {
  if (isKnowledgeKind(kind)) {
    try {
      validateKnowledge(kind, document)
    } catch (error) {
      fail(error instanceof Error ? error.message : 'invalid knowledge')
    }
    requirePreviousVersion(campaign, kind, document.previousVersion, knowledgeKey(document))
    if (
      ['handoff', 'experiment', 'resultsreview'].includes(kind) &&
      (!campaign.studySelection ||
        document.studyHash !== campaign.studySelection.contentHash ||
        latestDocument(campaign, 'study')?.contentHash !== document.studyHash)
    )
      fail('handoff requires the currently confirmed study', 409)
    if (
      kind === 'peerreview' &&
      latestDocument(campaign, 'manuscript')?.contentHash !== document.manuscriptHash
    )
      fail('peer review requires the current manuscript', 409)
    return
  }
  if (kind === 'study') return validateStudy(campaign, document)
  if (kind === 'manuscript') return validateManuscript(campaign, document, workflowReviews)
  return validateSkillCandidate(campaign, document)
}
function documentDependenciesCurrent(
  campaign: ResearchCampaign,
  kind: ResearchDocumentKind,
  document: DocumentInput,
  workflowReviews: WorkflowReviewEvidence[] = [],
) {
  if (isKnowledgeKind(kind)) {
    if (['handoff', 'experiment', 'resultsreview'].includes(kind))
      return (
        document.studyHash === campaign.studySelection?.contentHash &&
        document.studyHash === latestDocument(campaign, 'study')?.contentHash
      )
    if (kind === 'peerreview')
      return document.manuscriptHash === latestDocument(campaign, 'manuscript')?.contentHash
    return true
  }
  if (kind === 'study')
    return (
      Array.isArray(document.evidenceCitations) &&
      document.evidenceCitations.every(
        (id) =>
          typeof id === 'string' &&
          (campaign.literatureCitations?.some((citation) => citation.id === id) ||
            campaign.artifactVersions.some(
              (a) => a.kind === 'research-document-evidence' && a.contentHash === id,
            )),
      )
    )
  if (kind === 'skillcandidate')
    return (
      Array.isArray(document.evaluationArtifactVersionIds) &&
      document.evaluationArtifactVersionIds.every(
        (id) => typeof id === 'string' && isCurrentValidatedArtifact(campaign, id),
      )
    )
  if (!Array.isArray(document.claims)) return false
  return document.claims.every((candidate) => {
    if (
      !isObject(candidate) ||
      typeof candidate.claim !== 'string' ||
      !Array.isArray(candidate.artifactVersionIds)
    )
      return false
    const ids = candidate.artifactVersionIds
    const evidence = reviewEvidence(campaign, candidate.reviewId, workflowReviews)
    if (
      !ids.every(
        (id) =>
          typeof id === 'string' &&
          (evidence?.workflow
            ? evidence.review.artifactVersionIds.includes(id)
            : isCurrentValidatedArtifact(campaign, id)),
      )
    )
      return false
    return (
      !!evidence &&
      evidence.map.claims.some(
        (supported) =>
          supported.claim === candidate.claim &&
          sameArtifactReferences(supported.artifactVersionIds, ids as string[]),
      )
    )
  })
}
function contained(root: string, path: string) {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}
async function documentDirectory(
  workspaceRoot: string,
  campaignId: string,
): Promise<{ root: string; dir: string }> {
  const root = await realpath(resolve(workspaceRoot))
  let dir = root
  for (const part of ['.oph', 'research', campaignId, 'documents']) {
    const next = join(dir, part)
    if (!contained(root, next)) fail('unsafe document path', 409)
    const entry = await lstat(next).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? null : Promise.reject(error),
    )
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) fail('unsafe document path', 409)
    if (!entry) await mkdir(next)
    dir = await realpath(next)
    if (!contained(root, dir)) fail('unsafe document path', 409)
  }
  return { root, dir }
}
function documentFileName(kind: ResearchDocumentKind, hash: string) {
  return `${kind}-${hash.slice(-16)}.json`
}
async function writeImmutableFile(
  workspaceRoot: string,
  campaignId: string,
  kind: ResearchDocumentKind,
  bytes: Uint8Array,
  hash: string,
) {
  const { root, dir } = await documentDirectory(workspaceRoot, campaignId),
    path = join(dir, documentFileName(kind, hash))
  if (!contained(root, path)) fail('unsafe document path', 409)
  const verifyExisting = async () => {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) fail('unsafe document file', 409)
    const existing = await readFile(path)
    if (!existing.equals(bytes)) fail('immutable document content conflict', 409)
  }
  try {
    await verifyExisting()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await writeFile(path, bytes, { flag: 'wx' })
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      await verifyExisting()
    }
  }
  return pathToFileURL(path).href
}
function documentArtifactId(kind: ResearchDocumentKind, key?: string) {
  return `document-${kind}${key ? `-${key}` : ''}`
}
function commandFor(kind: ResearchDocumentKind, hash: string, uri: string, key?: string) {
  return {
    kind: 'recordArtifact' as const,
    artifactId: documentArtifactId(kind, key),
    artifactKind: `research-document-${kind}`,
    contentHash: hash,
    uri,
  }
}
function existingIdempotency(store: Store, campaignId: string, idempotencyKey: string) {
  return !!store.db
    .query<{ value: 1 }, [string, string]>(
      'SELECT 1 AS value FROM research_idempotency WHERE campaign_id = ? AND idempotency_key = ?',
    )
    .get(campaignId, idempotencyKey)
}

async function resolveManuscriptFile(workspaceRoot: string, document: DocumentInput) {
  if (!Object.hasOwn(document, 'textFile')) return document
  if (
    !hasExactKeys(document, ['claims', 'journalRequirementsHash', 'previousVersion', 'textFile']) ||
    !isObject(document.textFile) ||
    !hasExactKeys(document.textFile, ['path', 'sha256'])
  )
    fail('manuscript textFile replaces text and requires path and sha256')
  const source = document.textFile
  if (
    typeof source.path !== 'string' ||
    !source.path.trim() ||
    isAbsolute(source.path) ||
    typeof source.sha256 !== 'string' ||
    !HASH.test(source.sha256)
  )
    fail('invalid manuscript textFile path or sha256')
  const root = await realpath(resolve(workspaceRoot))
  let path: string
  try {
    path = await realpath(resolve(root, source.path))
  } catch {
    return fail('manuscript textFile is unavailable', 404)
  }
  const inside = relative(root, path)
  if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside))
    fail('manuscript textFile must be inside the workspace')
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('invalid manuscript textFile size or type')
  const bytes = await readFile(path)
  if (bytes.length > MAX_BYTES) fail('manuscript textFile exceeds size limit')
  if (sha256(bytes) !== source.sha256) fail('manuscript textFile hash mismatch', 409)
  let manuscriptText: string
  try {
    manuscriptText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return fail('manuscript textFile must be UTF-8')
  }
  const { textFile: _source, ...rest } = document
  return { ...rest, text: manuscriptText }
}

export async function writeResearchDocument(input: {
  store: Store
  workspaceRoot: string
  campaignId: string
  expectedVersion: number
  idempotencyKey: string
  kind: ResearchDocumentKind
  document: DocumentInput
}) {
  if (!ID.test(input.campaignId) || !ID.test(input.idempotencyKey))
    fail('invalid document identity')
  if (
    !['study', 'manuscript', 'skillcandidate'].includes(input.kind) &&
    !isKnowledgeKind(input.kind)
  )
    fail('invalid document kind')
  const campaign = getResearchCampaign(input.store, input.campaignId)
  if (!campaign) fail('campaign not found', 404)
  if (!isObject(input.document)) fail('invalid document')
  if (input.kind === 'manuscript')
    input = { ...input, document: await resolveManuscriptFile(input.workspaceRoot, input.document) }
  const key = isKnowledgeKind(input.kind) ? knowledgeKey(input.document) : undefined
  if (input.kind === 'study') {
    const sources = await readResearchDocuments(input.store, input.workspaceRoot, campaign.id)
    for (const ref of Array.isArray(input.document.evidenceCitations)
      ? input.document.evidenceCitations
      : []) {
      if (
        typeof ref === 'string' &&
        HASH.test(ref) &&
        !sources.some(
          (source) => source.kind === 'evidence' && source.contentHash === ref && source.verified,
        )
      )
        fail('evidence source content is unavailable', 409)
    }
  }
  if (isKnowledgeKind(input.kind))
    await validateKnowledgeReferences(
      input.store,
      input.workspaceRoot,
      campaign,
      input.kind,
      input.document,
    )
  const bytes = Buffer.from(`${canonicalJson({ kind: input.kind, document: input.document })}\n`)
  if (bytes.length > MAX_BYTES) fail('document exceeds size limit')
  const contentHash = sha256(bytes),
    root = await realpath(resolve(input.workspaceRoot)),
    uri = pathToFileURL(
      join(
        root,
        '.oph',
        'research',
        input.campaignId,
        'documents',
        documentFileName(input.kind, contentHash),
      ),
    ).href
  const mutation = {
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    command: commandFor(input.kind, contentHash, uri, key),
  }
  if (existingIdempotency(input.store, input.campaignId, input.idempotencyKey)) {
    const replay = mutateResearchCampaign(input.store, input.campaignId, mutation)
    if (!replay.ok) fail(replay.message, 409)
    return { campaign: replay.campaign, contentHash, uri, replayed: true }
  }
  if (!Number.isSafeInteger(input.expectedVersion) || campaign.version !== input.expectedVersion)
    fail(`campaign version is ${campaign.version}`, 409)
  const artifacts = campaign.artifactVersions.filter((a) => a.kind.startsWith('research-document-'))
  const contents = await Promise.all(
    artifacts.map((a) => verifiedContent(input.workspaceRoot, campaign, a)),
  )
  const workflowEvidence = workflowDocumentEvidence(input.store, campaign, artifacts, contents)
  if (input.kind === 'experiment' || input.kind === 'resultsreview') {
    const probe = {
      id: 'pending-workflow-document',
      artifactId: documentArtifactId(input.kind, key),
      kind: `research-document-${input.kind}`,
      version:
        1 +
        Math.max(
          0,
          ...artifacts
            .filter((a) => a.artifactId === documentArtifactId(input.kind, key))
            .map((a) => a.version),
        ),
    } as ArtifactVersion
    const checked = workflowDocumentEvidence(
      input.store,
      campaign,
      [...artifacts, probe],
      [...contents, input.document],
    )
    if (
      !(input.kind === 'experiment' ? checked.validExperiments : checked.validReviews).has(probe.id)
    )
      fail(
        'Missing current SSH tool receipt or completed independent workflow provenance; read context documentSchemas',
        409,
      )
  }
  validateDocument(campaign, input.kind, input.document, workflowEvidence.reviews)
  const immutableUri = await writeImmutableFile(
      input.workspaceRoot,
      input.campaignId,
      input.kind,
      bytes,
      contentHash,
    ),
    changed = mutateResearchCampaign(input.store, input.campaignId, {
      ...mutation,
      command: commandFor(input.kind, contentHash, immutableUri, key),
    })
  if (!changed.ok) fail(changed.message, changed.code.includes('stale') ? 409 : 400)
  return { campaign: changed.campaign, contentHash, uri: immutableUri, replayed: false }
}
async function verifiedContent(
  workspaceRoot: string,
  campaign: ResearchCampaign,
  artifact: ArtifactVersion,
) {
  const kind = artifact.kind.replace('research-document-', '') as ResearchDocumentKind
  if (!['study', 'manuscript', 'skillcandidate'].includes(kind) && !isKnowledgeKind(kind))
    return null
  const root = await realpath(resolve(workspaceRoot)),
    expected = join(
      root,
      '.oph',
      'research',
      campaign.id,
      'documents',
      documentFileName(kind, artifact.contentHash),
    )
  if (artifact.uri !== pathToFileURL(expected).href || !contained(root, expected)) return null
  const entry = await lstat(expected).catch(() => null)
  if (!entry?.isFile() || entry.isSymbolicLink()) return null
  const resolved = await realpath(expected).catch(() => null)
  if (!resolved || !contained(root, resolved)) return null
  const bytes = await readFile(expected).catch(() => null)
  if (!bytes || sha256(bytes) !== artifact.contentHash) return null
  try {
    const parsed = JSON.parse(bytes.toString()) as StoredDocument
    if (!isObject(parsed) || parsed.kind !== kind || !isObject(parsed.document)) return null
    return Buffer.from(`${canonicalJson(parsed)}\n`).equals(bytes) ? parsed.document : null
  } catch {
    return null
  }
}
export async function readResearchDocuments(
  store: Store,
  workspaceRoot: string,
  campaignId: string,
) {
  const campaign = getResearchCampaign(store, campaignId)
  if (!campaign) fail('campaign not found', 404)
  const artifacts = campaign.artifactVersions.filter((artifact) =>
    artifact.kind.startsWith('research-document-'),
  )
  const contents = await Promise.all(
    artifacts.map((artifact) => verifiedContent(workspaceRoot, campaign, artifact)),
  )
  const workflowEvidence = workflowDocumentEvidence(store, campaign, artifacts, contents)
  return artifacts.map((artifact, index) => {
    const kind = artifact.kind.replace('research-document-', '') as ResearchDocumentKind,
      content = contents[index]
    const sourceContentMissing =
      kind === 'study' &&
      Array.isArray(content?.evidenceCitations) &&
      content.evidenceCitations.some(
        (ref) =>
          typeof ref === 'string' &&
          HASH.test(ref) &&
          !artifacts.some(
            (source, i) =>
              source.kind === 'research-document-evidence' &&
              source.contentHash === ref &&
              contents[i],
          ),
      )
    return {
      id: artifact.id,
      kind,
      key: content?.key,
      uri: artifact.uri,
      version: artifact.version,
      contentHash: artifact.contentHash,
      createdAt: artifact.createdAt,
      stale:
        latestDocument(
          campaign,
          kind,
          isKnowledgeKind(kind) && content ? knowledgeKey(content) : undefined,
        )?.id !== artifact.id ||
        !content ||
        sourceContentMissing ||
        (kind === 'experiment' && !workflowEvidence.validExperiments.has(artifact.id)) ||
        (kind === 'resultsreview' && !workflowEvidence.validReviews.has(artifact.id)) ||
        !documentDependenciesCurrent(campaign, kind, content, workflowEvidence.reviews),
      verified: content !== null,
      ...(content ? { document: content } : {}),
    }
  })
}
export function listResearchDocuments(store: Store, campaignId: string) {
  const campaign = getResearchCampaign(store, campaignId)
  if (!campaign) fail('campaign not found', 404)
  return campaign.artifactVersions.filter((artifact) =>
    artifact.kind.startsWith('research-document-'),
  )
}

async function validateKnowledgeReferences(
  store: Store,
  root: string,
  campaign: ResearchCampaign,
  kind: KnowledgeKind,
  document: DocumentInput,
) {
  const all = (await readResearchDocuments(store, root, campaign.id)).filter(
    (item) => item.verified,
  )
  const current = all.filter((item) => !item.stale)
  if (kind === 'venue') {
    const evidence = (key: unknown) =>
      current.find((item) => item.kind === 'evidence' && item.document?.key === key)?.document
    for (const exemplar of Array.isArray(document.exemplars) ? document.exemplars : []) {
      if (!isObject(exemplar) || !evidence(exemplar.evidenceKey))
        fail('unknown exemplar evidence', 409)
    }
    for (const inference of Array.isArray(document.writingInferences)
      ? document.writingInferences
      : []) {
      if (!isObject(inference) || !Array.isArray(inference.evidenceKeys))
        fail('invalid inference evidence')
      for (const key of inference.evidenceKeys) {
        const item = evidence(key)
        if (!item || !['partial-full-text', 'full-text'].includes(String(item.readingDepth)))
          fail('writing analysis needs located full-text evidence', 409)
      }
    }
  }
  if (
    kind === 'reviewcase' &&
    all.some(
      (item) =>
        item.kind === 'reviewcase' &&
        item.document?.paperGroup === document.paperGroup &&
        item.document?.split !== document.split,
    )
  )
    fail('all versions of one paper must remain in the same split', 409)
  if (
    kind === 'peerreview' &&
    !current.some(
      (item) => item.kind === 'manuscript' && item.contentHash === document.manuscriptHash,
    )
  )
    fail('manuscript evidence is stale or unavailable', 409)
}
