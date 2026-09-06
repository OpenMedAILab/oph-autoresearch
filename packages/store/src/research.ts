import {
  type ArtifactVersion,
  canonicalResearchBundle,
  foldResearchEvents,
  type HumanApproval,
  isResearchTemplateId,
  type ResearchAttempt,
  type ResearchCampaign,
  type ResearchCampaignInput,
  type ResearchCommand,
  type ResearchEvent,
  type ResearchTaskRevision,
  type ResearchWriteResult,
  SYNTHETIC_SUMMARY_TEMPLATE,
  validateLabelSetReference,
  validateLabelSetSuccessor,
} from '@oph-autoresearch/core'
import type { Store } from './db.ts'

const SHA256 = /^sha256:[a-f0-9]{64}$/

type EventRow = {
  id: string
  campaign_id: string
  sequence: number
  event_type: ResearchEvent['type']
  command: string | null
  campaign: string
  occurred_at: number
}

type CampaignRow = { snapshot: string }
type IdempotencyRow = { payload_hash: string; result_snapshot: string; event_id: string }

export interface ResearchRunningAttempt {
  campaignId: string
  taskRevision: ResearchTaskRevision
  attempt: ResearchAttempt
}

export interface RecoverSyntheticAttemptsOptions {
  isOwnerAlive?: (pid: number) => boolean
}

export interface ResearchMutation {
  idempotencyKey: string
  expectedVersion: number
  command: ResearchCommand
}

function digest(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(value)
  return `sha256:${hasher.digest('hex')}`
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function textError(value: unknown, name: string): string | null {
  return typeof value === 'string' && value.trim() ? null : `${name} 必须是非空字符串`
}

function jsonObject(value: unknown, name: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${name} 必须是 JSON 对象`
  return jsonValue(value) ? null : `${name} 必须是可序列化 JSON`
}

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) && Object.values(value).every(jsonValue)
  )
}

function commandError(command: unknown): string | null {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return 'command 必须是对象'
  }
  return typeof (command as { kind?: unknown }).kind === 'string'
    ? null
    : 'command.kind 必须是字符串'
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function budgetError(budget: unknown): string | null {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return 'budget 必须是对象'
  const row = budget as { currency?: unknown; limit?: unknown }
  if (textError(row.currency, 'budget.currency')) return 'budget.currency 必须是非空字符串'
  if (typeof row.limit !== 'number' || !Number.isFinite(row.limit) || row.limit < 0) {
    return 'budget.limit 必须是非负有限数值'
  }
  return null
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function campaignOf(row: CampaignRow | null | undefined): ResearchCampaign | null {
  return row ? normalizeCampaign(JSON.parse(row.snapshot) as ResearchCampaign) : null
}

function normalizeCampaign(campaign: ResearchCampaign): ResearchCampaign {
  return {
    ...campaign,
    taskRevisions: Array.isArray(campaign.taskRevisions) ? campaign.taskRevisions : [],
    attempts: Array.isArray(campaign.attempts) ? campaign.attempts : [],
  }
}

function eventOf(row: EventRow): ResearchEvent {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    sequence: row.sequence,
    type: row.event_type,
    command: row.command ? (JSON.parse(row.command) as ResearchCommand) : null,
    campaign: normalizeCampaign(JSON.parse(row.campaign) as ResearchCampaign),
    occurredAt: row.occurred_at,
  }
}

function current(store: Store, id: string): ResearchCampaign | null {
  return campaignOf(
    store.db
      .query<CampaignRow, [string]>('SELECT snapshot FROM research_campaigns WHERE id = ?')
      .get(id),
  )
}

function validInput(input: ResearchCampaignInput): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'campaign input 必须是对象'
  return (
    textError(input.idempotencyKey, 'idempotencyKey') ??
    textError(input.workspaceId, 'workspaceId') ??
    textError(input.parentConversationId, 'parentConversationId') ??
    textError(input.goal, 'goal') ??
    jsonObject(input.policy, 'policy') ??
    jsonObject(input.inputs, 'inputs') ??
    budgetError(input.budget)
  )
}

function invalid(code: string, message: string): ResearchWriteResult {
  return { ok: false, code, message }
}

function bundleHash(campaign: ResearchCampaign): string {
  return digest(canonicalResearchBundle(campaign))
}

function invalidateChangedApprovals(campaign: ResearchCampaign, now: number): ResearchCampaign {
  return {
    ...campaign,
    approvals: campaign.approvals.map((approval) =>
      approval.status === 'active' && approval.bundleHash !== campaign.bundleHash
        ? { ...approval, status: 'invalidated', invalidatedAt: now }
        : approval,
    ),
  }
}

function validateProof(proof: {
  reviewerId: string
  proofId: string
  verifiedAt: number
}): string | null {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return 'reviewer 必须是对象'
  return (
    textError(proof.reviewerId, 'reviewer.reviewerId') ??
    textError(proof.proofId, 'reviewer.proofId') ??
    (!Number.isSafeInteger(proof.verifiedAt) || proof.verifiedAt <= 0
      ? 'reviewer.verifiedAt 必须是正整数时间戳'
      : null)
  )
}

function taskStatus(task: ResearchTaskRevision, attempts: readonly ResearchAttempt[]) {
  const related = attempts.filter((attempt) => attempt.taskRevisionId === task.id)
  if (related.some((attempt) => attempt.status === 'completed')) return 'verified' as const
  if (related.some((attempt) => attempt.status === 'running')) return 'pending' as const
  if (related.some((attempt) => attempt.status === 'failed')) return 'failed' as const
  if (
    related.some((attempt) => attempt.status === 'cancelled' || attempt.status === 'interrupted')
  ) {
    return 'interrupted' as const
  }
  return 'pending' as const
}

function taskContextHash(campaign: ResearchCampaign): string {
  return digest(
    canonicalJson({ policy: campaign.policy, inputs: campaign.inputs, budget: campaign.budget }),
  )
}

function withDerivedTaskStatuses(campaign: ResearchCampaign): ResearchCampaign {
  const stale = new Set<string>()
  for (const task of campaign.taskRevisions) {
    for (const contentHash of task.labelSetContentHashes ?? []) {
      const bound = campaign.labelSets?.find((ref) => ref.contentHash === contentHash)
      const latest = campaign.labelSets
        ?.filter((ref) => ref.id === bound?.id)
        .toSorted((a, b) => b.version - a.version)[0]
      if (!bound || latest?.contentHash !== contentHash) stale.add(task.id)
    }
    if (task.sourceContextHash && task.sourceContextHash !== taskContextHash(campaign))
      stale.add(task.id)
    if (campaign.taskRevisions.some((next) => next.previousRevisionId === task.id))
      stale.add(task.id)
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const task of campaign.taskRevisions) {
      if (stale.has(task.id)) continue
      const invalid = (task.artifactVersionIds ?? []).some((id) => {
        const artifact = campaign.artifactVersions.find((item) => item.id === id)
        if (!artifact) return true
        return (
          campaign.artifactVersions.some(
            (item) => item.artifactId === artifact.artifactId && item.version > artifact.version,
          ) ||
          (artifact.producerTaskRevisionId !== undefined &&
            stale.has(artifact.producerTaskRevisionId))
        )
      })
      if (invalid) {
        stale.add(task.id)
        changed = true
      }
    }
  }
  return {
    ...campaign,
    ...(campaign.modelReviews
      ? {
          modelReviews: campaign.modelReviews.map((review) => ({
            ...review,
            sourceValidity:
              (review.sourceContextHash !== undefined &&
                review.sourceContextHash !== reviewSourceContextHash(campaign)) ||
              review.artifactVersionIds.some((id) => {
                const artifact = campaign.artifactVersions.find((a) => a.id === id)
                return (
                  !artifact ||
                  !artifact.validation ||
                  !artifact.producerTaskRevisionId ||
                  stale.has(artifact.producerTaskRevisionId) ||
                  campaign.artifactVersions.some(
                    (a) => a.artifactId === artifact.artifactId && a.version > artifact.version,
                  )
                )
              })
                ? ('stale' as const)
                : ('current' as const),
          })),
        }
      : {}),
    taskRevisions: campaign.taskRevisions.map((task) => ({
      ...task,
      status: stale.has(task.id) ? 'stale' : taskStatus(task, campaign.attempts),
    })),
  }
}

function reviewSourceContextHash(campaign: ResearchCampaign): string {
  return digest(
    canonicalJson({
      context: taskContextHash(campaign),
      literatureCitations: campaign.literatureCitations ?? [],
    }),
  )
}

function attemptById(campaign: ResearchCampaign, attemptId: unknown): ResearchAttempt | null {
  if (textError(attemptId, 'attemptId')) return null
  return campaign.attempts.find((attempt) => attempt.id === attemptId) ?? null
}

function ownedRunningAttempt(
  campaign: ResearchCampaign,
  attemptId: unknown,
): { ok: true; attempt: ResearchAttempt } | { ok: false; code: string; message: string } {
  const attempt = attemptById(campaign, attemptId)
  if (!attempt) return { ok: false, code: 'unknown_attempt', message: '找不到 attemptId' }
  if (attempt.ownerPid !== process.pid) {
    return {
      ok: false,
      code: 'not_attempt_owner',
      message: '只有领取该尝试的进程可以提交执行结果',
    }
  }
  if (attempt.status !== 'running') {
    return { ok: false, code: 'inactive_attempt', message: '该尝试已结束' }
  }
  return { ok: true, attempt }
}

function nextCampaign(
  campaign: ResearchCampaign,
  command: ResearchCommand,
  now: number,
): { ok: true; campaign: ResearchCampaign } | { ok: false; code: string; message: string } {
  let next: ResearchCampaign
  if ('skillBinding' in command && command.skillBinding !== undefined) {
    const binding = command.skillBinding
    if (
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      textError(binding.id, 'skill id') ||
      !Number.isSafeInteger(binding.version) ||
      binding.version < 1 ||
      !SHA256.test(binding.sourceHash) ||
      !SHA256.test(binding.evaluationHash) ||
      !SHA256.test(binding.templateHash) ||
      !isResearchTemplateId(binding.templateId) ||
      binding.templateId !== (command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE)
    )
      return invalid('invalid_skill_binding', '执行技能绑定无效')
  }
  switch (command.kind) {
    case 'applyResearchPattern': {
      const selection = command.plan?.selection
      if (!selection || typeof selection !== 'object' || Array.isArray(selection))
        return invalid('invalid_pattern', 'Pattern selection evidence is required')
      const blocked = selection.status === 'blocked' && selection.selectedTemplateId === null
      if (
        (campaign.pattern &&
          ((campaign.pattern.taskRevisionIds.length > 0 &&
            !withDerivedTaskStatuses(campaign).taskRevisions.some(
              (t) =>
                campaign.pattern!.taskRevisionIds.includes(t.id) &&
                ['stale', 'failed', 'interrupted'].includes(t.status),
            )) ||
            campaign.attempts.some((a) => ['running', 'unknown'].includes(a.status)))) ||
        !command.plan ||
        !SHA256.test(command.contractHash) ||
        digest(canonicalJson(command.plan)) !== command.contractHash ||
        command.plan.schema !== 'research-pattern-v1' ||
        !Array.isArray(command.tasks) ||
        (blocked
          ? command.tasks.length !== 0
          : selection.status !== 'selected' ||
            command.tasks.length !== 2 ||
            command.tasks[0]?.templateId !== SYNTHETIC_SUMMARY_TEMPLATE ||
            command.tasks[1]?.templateId !== selection.selectedTemplateId) ||
        command.tasks.some(
          (task) =>
            task.kind !== 'declareSyntheticTask' ||
            task.previousRevisionId !== undefined ||
            task.artifactVersionIds.length !== 0,
        )
      )
        return invalid('invalid_pattern', 'Pattern must be a new bounded fixed plan')
      let compiled = campaign
      const taskRevisionIds: string[] = []
      for (const task of command.tasks) {
        const result = nextCampaign(compiled, task, now)
        if (!result.ok) return result
        compiled = result.campaign
        taskRevisionIds.push(compiled.taskRevisions.at(-1)!.id)
      }
      next = {
        ...compiled,
        stage: 'protocol',
        status: blocked ? 'blocked' : 'proposal',
        ...(campaign.pattern
          ? { patternHistory: [...(campaign.patternHistory ?? []), campaign.pattern] }
          : {}),
        pattern: {
          contractHash: command.contractHash,
          plan: cloneJson(command.plan),
          taskRevisionIds,
        },
      }
      break
    }
    case 'reserveModelReview': {
      const spec = command.spec
      const approval = campaign.approvals.find((a) => a.id === spec?.approvalId)
      const scope = approval?.scope
      if (
        !spec ||
        !approval ||
        approval.status !== 'active' ||
        approval.consumedBy ||
        approval.bundleHash !== campaign.bundleHash ||
        scope?.kind !== 'model_review' ||
        scope.expiresAt <= now ||
        scope.dispatchKey !== spec.dispatchKey ||
        scope.evidencePackHash !== spec.evidencePackHash ||
        scope.configHash !== spec.configHash ||
        scope.maxRequests !== spec.maxRequests ||
        scope.maxOutputTokens !== spec.maxOutputTokens ||
        spec.maxRequests !== 2 ||
        spec.maxOutputTokens !== 1024 ||
        !SHA256.test(spec.evidencePackHash) ||
        !SHA256.test(spec.configHash) ||
        spec.currency !== scope.currency ||
        spec.currency !== campaign.budget.currency ||
        !Number.isFinite(spec.reservedCost) ||
        spec.reservedCost <= 0 ||
        spec.reservedCost > scope.maxCost ||
        !Array.isArray(spec.artifactVersionIds) ||
        canonicalJson([...spec.artifactVersionIds].sort()) !==
          canonicalJson([...scope.artifactVersionIds].sort()) ||
        spec.artifactVersionIds.some(
          (id) => !campaign.artifactVersions.some((a) => a.id === id && a.validation),
        ) ||
        (campaign.modelReviews ?? []).some((r) => r.dispatchKey === spec.dispatchKey) ||
        (campaign.modelReviews ?? []).reduce((sum, r) => sum + r.reservedCost, 0) +
          spec.reservedCost >
          campaign.budget.limit
      )
        return invalid(
          'review_approval_required',
          'Review requires exact approved evidence/model/limits and available reserved budget',
        )
      const id = randomId('rmr')
      next = {
        ...campaign,
        modelReviews: [
          ...(campaign.modelReviews ?? []),
          {
            ...cloneJson(spec),
            sourceContextHash: reviewSourceContextHash(campaign),
            id,
            ownerPid: process.pid,
            requestCount: 0,
            status: 'reserved',
          },
        ],
        approvals: campaign.approvals.map((a) =>
          a.id === approval.id ? { ...a, consumedBy: id } : a,
        ),
      }
      break
    }
    case 'startModelReviewRequest': {
      const review = campaign.modelReviews?.find((r) => r.id === command.reviewId)
      const approval = campaign.approvals.find((a) => a.id === review?.approvalId)
      if (
        !review ||
        review.ownerPid !== process.pid ||
        !['reserved', 'running'].includes(review.status) ||
        review.requestCount >= review.maxRequests ||
        approval?.status !== 'active' ||
        approval.bundleHash !== campaign.bundleHash ||
        !approval.scope ||
        approval.scope.expiresAt <= now
      )
        return invalid(
          'review_send_denied',
          'Review request is not authorized by the remaining reservation',
        )
      next = {
        ...campaign,
        modelReviews: campaign.modelReviews!.map((r) =>
          r.id === review.id ? { ...r, requestCount: r.requestCount + 1, status: 'running' } : r,
        ),
      }
      break
    }
    case 'finishModelReview': {
      const review = campaign.modelReviews?.find((r) => r.id === command.reviewId)
      if (
        !review ||
        review.ownerPid !== process.pid ||
        !['reserved', 'running'].includes(review.status) ||
        typeof command.text !== 'string' ||
        command.text.length > 16000 ||
        (command.actualCost !== null &&
          (!Number.isFinite(command.actualCost) || command.actualCost < 0))
      )
        return invalid('invalid_review_finish', 'Review result does not bind an active reservation')
      const stale = review.artifactVersionIds.some((id) => {
        const a = campaign.artifactVersions.find((a) => a.id === id)
        return (
          !a ||
          !withDerivedTaskStatuses(campaign).taskRevisions.some(
            (t) => t.id === a.producerTaskRevisionId && t.status === 'verified',
          )
        )
      })
      const status =
        stale || (command.actualCost ?? 0) > review.reservedCost ? 'unknown' : command.status
      next = {
        ...campaign,
        modelReviews: campaign.modelReviews!.map((r) =>
          r.id === review.id
            ? {
                ...r,
                status,
                runId: command.runId,
                conversationId: command.conversationId,
                text: command.text,
                contentHash: digest(command.text),
                actualCost: command.actualCost,
              }
            : r,
        ),
      }
      break
    }
    case 'recordLiteratureCitation': {
      const citation = command.citation
      if (
        !citation ||
        citation.sourceKind !== 'public-metadata' ||
        citation.fullText !== false ||
        citation.verification !== 'retrieved-public-metadata' ||
        !SHA256.test(citation.contentHash) ||
        !SHA256.test(citation.projectionHash)
      )
        return invalid('invalid_literature_citation', 'Verified public metadata citation required')
      const {
        projectionHash,
        verification: _verification,
        fullText: _fullText,
        ...source
      } = citation
      if (
        digest(canonicalJson(source)) !== projectionHash ||
        (campaign.literatureCitations ?? []).some((c) => c.id === citation.id)
      )
        return invalid(
          'invalid_literature_citation',
          'Citation projection hash changed or duplicated',
        )
      next = {
        ...campaign,
        literatureCitations: [...(campaign.literatureCitations ?? []), cloneJson(citation)],
      }
      break
    }
    case 'recordLabelSet': {
      if (validateProof(command.reviewer))
        return invalid('invalid_reviewer', 'Trusted signer proof required')
      try {
        const reference = validateLabelSetReference(command.reference)
        const previous = (campaign.labelSets ?? [])
          .filter((ref) => ref.id === reference.id)
          .toSorted((a, b) => b.version - a.version)[0]
        if (previous) validateLabelSetSuccessor(previous, reference)
        else if (reference.version !== 1)
          return invalid('invalid_labelset_revision', 'Initial LabelSet must start at version 1')
        next = { ...campaign, labelSets: [...(campaign.labelSets ?? []), cloneJson(reference)] }
      } catch {
        return invalid('invalid_labelset', 'Invalid immutable aggregate LabelSet reference')
      }
      break
    }
    case 'setPolicy': {
      const error = jsonObject(command.policy, 'policy')
      if (error) return invalid('invalid_policy', error)
      next = { ...campaign, policy: cloneJson(command.policy), status: 'proposal' }
      break
    }
    case 'setInputs': {
      const error = jsonObject(command.inputs, 'inputs')
      if (error) return invalid('invalid_inputs', error)
      next = { ...campaign, inputs: cloneJson(command.inputs), status: 'proposal' }
      break
    }
    case 'setBudget': {
      const error = budgetError(command.budget)
      if (error) return invalid('invalid_budget', error)
      if (
        (campaign.modelReviews ?? []).reduce((sum, r) => sum + r.reservedCost, 0) >
          command.budget.limit ||
        ((campaign.modelReviews ?? []).length &&
          command.budget.currency !== campaign.budget.currency)
      )
        return invalid(
          'reserved_budget',
          'Existing review reservations cannot be reduced or converted',
        )
      next = { ...campaign, budget: cloneJson(command.budget), status: 'proposal' }
      break
    }
    case 'recordArtifact': {
      const error =
        textError(command.artifactId, 'artifactId') ??
        textError(command.uri, 'uri') ??
        textError(command.artifactKind, 'artifactKind') ??
        (!SHA256.test(command.contentHash)
          ? 'contentHash 必须是 sha256: 后接 64 位小写十六进制'
          : null)
      if (error) return invalid('invalid_artifact', error)
      const artifactId = command.artifactId.trim()
      const lastVersion = campaign.artifactVersions
        .filter((artifact) => artifact.artifactId === artifactId)
        .reduce((max, artifact) => Math.max(max, artifact.version), 0)
      const artifact: ArtifactVersion = {
        id: randomId('rav'),
        artifactId,
        version: lastVersion + 1,
        uri: command.uri.trim(),
        kind: command.artifactKind.trim(),
        contentHash: command.contentHash,
        createdAt: now,
      }
      next = {
        ...campaign,
        artifactVersions: [...campaign.artifactVersions, artifact],
        status: 'proposal',
      }
      break
    }
    case 'approve': {
      const error =
        (!SHA256.test(command.bundleHash)
          ? 'bundleHash 必须是 sha256: 后接 64 位小写十六进制'
          : null) ?? validateProof(command.reviewer)
      if (error) return invalid('invalid_approval', error)
      if (command.bundleHash !== campaign.bundleHash) {
        return invalid('stale_bundle', '审批绑定的 bundleHash 与当前研究包不一致')
      }
      if (command.scope !== undefined) {
        const scope = command.scope
        if (
          !scope ||
          (scope.trackingPolicyHash !== undefined &&
            (scope.kind !== 'execution' || !SHA256.test(scope.trackingPolicyHash))) ||
          (scope.backendPolicyHash !== undefined &&
            (scope.kind !== 'execution' || !SHA256.test(scope.backendPolicyHash))) ||
          !['protocol', 'execution', 'model_review', 'release'].includes(scope.kind) ||
          !Number.isSafeInteger(scope.expiresAt) ||
          scope.expiresAt <= now ||
          scope.expiresAt > now + 24 * 60 * 60 * 1000 ||
          scope.currency !== campaign.budget.currency ||
          !Number.isFinite(scope.maxCost) ||
          scope.maxCost < 0 ||
          scope.maxCost > campaign.budget.limit ||
          !Array.isArray(scope.artifactVersionIds) ||
          new Set(scope.artifactVersionIds).size !== scope.artifactVersionIds.length ||
          scope.artifactVersionIds.some(
            (id) => !campaign.artifactVersions.some((a) => a.id === id),
          ) ||
          (scope.kind === 'execution' &&
            (!scope.dispatchKey ||
              !scope.taskRevisionId ||
              !campaign.taskRevisions.some(
                (t) => t.id === scope.taskRevisionId && t.status !== 'stale',
              )))
        )
          return invalid(
            'invalid_approval_scope',
            'Approval requires current scope, budget and expiry',
          )
      }
      const approval: HumanApproval = {
        id:
          (typeof command.approvalId === 'string' && command.approvalId.trim()) || randomId('hap'),
        ...(command.scope ? { scope: cloneJson(command.scope) } : {}),
        bundleHash: campaign.bundleHash,
        reviewerId: command.reviewer.reviewerId.trim(),
        reviewerProofId: command.reviewer.proofId.trim(),
        reviewedAt: command.reviewer.verifiedAt,
        status: 'active',
        revokedAt: null,
        revokedByReviewerId: null,
        invalidatedAt: null,
      }
      if (campaign.approvals.some((existing) => existing.id === approval.id)) {
        return invalid('duplicate_approval', 'approvalId 已存在')
      }
      next = { ...campaign, approvals: [...campaign.approvals, approval] }
      break
    }
    case 'release': {
      if (campaign.pattern) {
        const derived = withDerivedTaskStatuses(campaign)
        const ids = campaign.pattern.taskRevisionIds
        if (
          ids.length !== 2 ||
          ids.some(
            (id) => !derived.taskRevisions.some((t) => t.id === id && t.status === 'verified'),
          ) ||
          !derived.modelReviews?.some(
            (r) =>
              r.status === 'done' &&
              r.sourceValidity === 'current' &&
              r.artifactVersionIds.some((id) =>
                campaign.artifactVersions.some(
                  (a) => a.id === id && a.producerTaskRevisionId === ids.at(-1),
                ),
              ),
          )
        )
          return invalid(
            'pattern_review_required',
            'Pattern release requires current completed steps and evidence review',
          )
      }
      const approval = campaign.approvals.find((a) => a.id === command.approvalId)
      if (
        !approval ||
        approval.status !== 'active' ||
        approval.bundleHash !== campaign.bundleHash ||
        approval.consumedBy ||
        approval.scope?.kind !== 'release' ||
        approval.scope.expiresAt <= now ||
        !Array.isArray(command.artifactVersionIds) ||
        command.artifactVersionIds.length === 0 ||
        canonicalJson([...command.artifactVersionIds].sort()) !==
          canonicalJson([...approval.scope.artifactVersionIds].sort()) ||
        command.artifactVersionIds.some((id) => {
          const a = campaign.artifactVersions.find((item) => item.id === id)
          return (
            !a?.validation ||
            !a.producerTaskRevisionId ||
            withDerivedTaskStatuses(campaign).taskRevisions.find(
              (t) => t.id === a.producerTaskRevisionId,
            )?.status !== 'verified'
          )
        })
      )
        return invalid('approval_required', 'Release requires approved verified current artifacts')
      next = {
        ...campaign,
        stage: 'output',
        status: 'completed',
        approvals: campaign.approvals.map((a) =>
          a.id === approval.id ? { ...a, consumedBy: `release:${campaign.version + 1}` } : a,
        ),
      }
      break
    }
    case 'revokeApproval': {
      const error = textError(command.approvalId, 'approvalId') ?? validateProof(command.reviewer)
      if (error) return invalid('invalid_revocation', error)
      const found = campaign.approvals.find((approval) => approval.id === command.approvalId)
      if (!found) return invalid('unknown_approval', '找不到 approvalId')
      if (found.status !== 'active') return invalid('inactive_approval', '该审批已经失效或撤销')
      next = {
        ...campaign,
        approvals: campaign.approvals.map((approval) =>
          approval.id === found.id
            ? {
                ...approval,
                status: 'revoked',
                revokedAt: command.reviewer.verifiedAt,
                revokedByReviewerId: command.reviewer.reviewerId.trim(),
              }
            : approval,
        ),
      }
      break
    }
    case 'declareSyntheticTask': {
      const templateId = command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE
      if (!isResearchTemplateId(templateId))
        return invalid('invalid_template', 'unknown fixed synthetic template')
      if (
        textError(command.taskId, 'taskId') ||
        !SHA256.test(command.inputHash) ||
        !Array.isArray(command.artifactVersionIds) ||
        command.artifactVersionIds.length > 100 ||
        new Set(command.artifactVersionIds).size !== command.artifactVersionIds.length ||
        command.artifactVersionIds.some(
          (id) =>
            typeof id !== 'string' ||
            !campaign.artifactVersions.some((artifact) => artifact.id === id),
        )
      )
        return invalid('invalid_task_spec', '任务必须绑定有效的确切输入产物版本')
      if (
        command.labelSetContentHashes !== undefined &&
        (!Array.isArray(command.labelSetContentHashes) ||
          new Set(command.labelSetContentHashes).size !== command.labelSetContentHashes.length ||
          command.labelSetContentHashes.some(
            (hash) => !(campaign.labelSets ?? []).some((ref) => ref.contentHash === hash),
          ))
      )
        return invalid(
          'invalid_labelset_dependency',
          'Task must bind exact admitted LabelSet versions',
        )
      const siblings = campaign.taskRevisions.filter((task) => task.taskId === command.taskId)
      const previous = siblings.toSorted((a, b) => b.revision - a.revision)[0]
      if (previous?.id !== command.previousRevisionId)
        return invalid('task_revision_conflict', '修订必须指定当前最新任务版本')
      const task: ResearchTaskRevision = {
        id: randomId('rtr'),
        taskId: command.taskId,
        ...(command.labelSetContentHashes
          ? { labelSetContentHashes: [...command.labelSetContentHashes].sort() }
          : {}),
        revision: (previous?.revision ?? 0) + 1,
        ...(previous ? { previousRevisionId: previous.id } : {}),
        sourceContextHash: taskContextHash(campaign),
        ...(command.skillBinding ? { skillBinding: cloneJson(command.skillBinding) } : {}),
        artifactVersionIds: [...command.artifactVersionIds].sort(),
        stage: 'execution',
        templateId,
        stageId: templateId === SYNTHETIC_SUMMARY_TEMPLATE ? 'smoke' : 'evaluation',
        inputHash: command.inputHash,
        outputContract: templateId,
        dataClass: 'synthetic',
        status: 'pending',
        createdAt: now,
      }
      next = { ...campaign, taskRevisions: [...campaign.taskRevisions, task] }
      break
    }
    case 'claimSynthetic': {
      if (
        (command.backend === 'ssh-daemon' &&
          (!command.backendPolicyHash || !SHA256.test(command.backendPolicyHash))) ||
        (command.backendPolicyHash !== undefined && command.backend !== 'ssh-daemon')
      )
        return invalid('invalid_backend_policy', 'SSH execution requires a pinned transport policy')
      if (
        command.trackingPolicyHash !== undefined &&
        (!['localhost-daemon', 'ssh-daemon'].includes(command.backend ?? '') ||
          !SHA256.test(command.trackingPolicyHash))
      )
        return invalid('invalid_tracking_policy', 'Tracking must bind a daemon source policy')
      const templateId = command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE
      if (!isResearchTemplateId(templateId))
        return invalid('invalid_template', 'unknown fixed synthetic template')
      const error =
        textError(command.dispatchKey, 'dispatchKey') ??
        (!SHA256.test(command.inputHash) ? 'inputHash 必须是 sha256: 后接 64 位小写十六进制' : null)
      if (error) return invalid('invalid_synthetic_claim', error)
      const selected = command.taskRevisionId
        ? withDerivedTaskStatuses(campaign).taskRevisions.find(
            (task) => task.id === command.taskRevisionId,
          )
        : undefined
      if (
        campaign.pattern &&
        (!selected || !campaign.pattern.taskRevisionIds.includes(selected.id))
      )
        return invalid('pattern_task_required', 'Only an applied Pattern task can be dispatched')
      if (
        selected &&
        canonicalJson(selected.skillBinding ?? null) !== canonicalJson(command.skillBinding ?? null)
      )
        return invalid('skill_binding_conflict', '执行技能锁与任务规格不一致')
      if (
        command.taskRevisionId &&
        (!selected ||
          selected.status === 'stale' ||
          selected.inputHash !== command.inputHash ||
          selected.templateId !== templateId)
      )
        return invalid('stale_task_revision', '任务版本不存在、已失效或输入不匹配')
      if (
        selected &&
        campaign.attempts.some(
          (attempt) =>
            attempt.taskRevisionId === selected.id &&
            (attempt.status === 'running' || attempt.status === 'unknown'),
        )
      )
        return invalid('task_attempt_conflict', '该任务已有运行中的尝试')
      const approval = command.approvalId
        ? campaign.approvals.find((a) => a.id === command.approvalId)
        : undefined
      const patternIndex = selected
        ? (campaign.pattern?.taskRevisionIds.indexOf(selected.id) ?? -1)
        : -1
      if (
        patternIndex >= 0 &&
        (campaign.pattern!.plan.backend !== (command.backend ?? 'builtin-local') ||
          campaign
            .pattern!.taskRevisionIds.slice(0, patternIndex)
            .some(
              (id) =>
                !withDerivedTaskStatuses(campaign).taskRevisions.some(
                  (t) => t.id === id && t.status === 'verified',
                ),
            ))
      )
        return invalid(
          'pattern_dependency_required',
          'Pattern requires the pinned backend and verified predecessor steps',
        )
      if (
        command.requireApproval ||
        command.approvalId ||
        patternIndex >= 0 ||
        command.backend === 'ssh-daemon'
      ) {
        if (
          !approval ||
          approval.status !== 'active' ||
          approval.bundleHash !== campaign.bundleHash ||
          approval.consumedBy ||
          approval.scope?.kind !== 'execution' ||
          approval.scope.expiresAt <= now ||
          approval.scope.currency !== campaign.budget.currency ||
          approval.scope.maxCost < 0 ||
          approval.scope.taskRevisionId !== selected?.id ||
          approval.scope.dispatchKey !== command.dispatchKey ||
          approval.scope.trackingPolicyHash !== command.trackingPolicyHash ||
          approval.scope.backendPolicyHash !== command.backendPolicyHash ||
          canonicalJson([...approval.scope.artifactVersionIds].sort()) !==
            canonicalJson([...(selected?.artifactVersionIds ?? [])].sort())
        )
          return invalid(
            'approval_required',
            'Dispatch requires an active exact task, input, key, budget and expiry approval',
          )
      }
      const task: ResearchTaskRevision = selected ?? {
        id: randomId('rtr'),
        revision: 1,
        stage: 'execution',
        templateId,
        stageId: templateId === SYNTHETIC_SUMMARY_TEMPLATE ? 'smoke' : 'evaluation',
        inputHash: command.inputHash,
        outputContract: templateId,
        dataClass: 'synthetic',
        status: 'pending',
        createdAt: now,
        sourceContextHash: taskContextHash(campaign),
        artifactVersionIds: [],
        ...(command.skillBinding ? { skillBinding: cloneJson(command.skillBinding) } : {}),
      }
      const attempt: ResearchAttempt = {
        id: randomId('rat'),
        taskRevisionId: task.id,
        dispatchKey: command.dispatchKey.trim(),
        ...(command.trackingPolicyHash ? { trackingPolicyHash: command.trackingPolicyHash } : {}),
        ...(command.backendPolicyHash ? { backendPolicyHash: command.backendPolicyHash } : {}),
        ...(command.backend ? { backend: command.backend } : {}),
        ownerPid: process.pid,
        status: 'running',
        executionStartedAt: now,
        endedAt: null,
        artifactVersionId: null,
        error: null,
        cancelRequestedAt: null,
      }
      next = {
        ...campaign,
        taskRevisions: selected ? campaign.taskRevisions : [...campaign.taskRevisions, task],
        attempts: [...campaign.attempts, attempt],
        approvals: approval
          ? campaign.approvals.map((a) =>
              a.id === approval.id ? { ...a, consumedBy: attempt.id } : a,
            )
          : campaign.approvals,
      }
      break
    }
    case 'bindSyntheticJob': {
      const owned = ownedRunningAttempt(campaign, command.attemptId)
      if (!owned.ok) return owned
      const task = campaign.taskRevisions.find((t) => t.id === owned.attempt.taskRevisionId)
      const spec = command.spec
      if (
        !['localhost-daemon', 'ssh-daemon'].includes(owned.attempt.backend ?? '') ||
        owned.attempt.jobSpec ||
        !spec ||
        (spec.version !== 1 && spec.version !== 2) ||
        (spec.version === 1 && spec.execution !== undefined) ||
        (spec.version === 2 &&
          (task?.templateId !== 'supervised-phantom-v2' ||
            spec.execution?.adapter !== 'supervised-phantom-v2' ||
            spec.execution.codeHash !== task.skillBinding?.sourceHash ||
            spec.execution.maxRuntimeMs !== 600_000)) ||
        (spec.trackingPolicyHash !== undefined && !SHA256.test(spec.trackingPolicyHash)) ||
        spec.trackingPolicyHash !== owned.attempt.trackingPolicyHash ||
        spec.backendPolicyHash !== owned.attempt.backendPolicyHash ||
        spec.campaignId !== campaign.id ||
        spec.taskRevisionId !== task?.id ||
        spec.dispatchKey !== owned.attempt.id ||
        spec.templateId !== task.templateId ||
        spec.inputHash !== task.inputHash ||
        spec.resource?.cpu !== 1 ||
        spec.resource.memoryMb !== 256 ||
        !Number.isSafeInteger(spec.lease?.fence) ||
        spec.lease.fence < 1 ||
        spec.lease.expiresAt <= now ||
        textError(spec.lease.token, 'lease token')
      )
        return invalid(
          'invalid_job_binding',
          'Job must bind the fixed claimed task and resource lease',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((a) =>
          a.id === owned.attempt.id
            ? { ...a, jobSpec: cloneJson(spec), jobSpecHash: digest(canonicalJson(spec)) }
            : a,
        ),
      }
      break
    }
    case 'markSyntheticUnknown': {
      const attempt = attemptById(campaign, command.attemptId)
      if (
        !attempt ||
        !['localhost-daemon', 'ssh-daemon'].includes(attempt.backend ?? '') ||
        !['running', 'unknown'].includes(attempt.status)
      )
        return invalid(
          'invalid_unknown_transition',
          'Only an unresolved daemon attempt may become unknown',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((a) =>
          a.id === attempt.id
            ? { ...a, status: 'unknown', error: command.reason, endedAt: null }
            : a,
        ),
      }
      break
    }
    case 'resumeSyntheticObservation': {
      const attempt = attemptById(campaign, command.attemptId)
      if (
        !attempt ||
        !['localhost-daemon', 'ssh-daemon'].includes(attempt.backend ?? '') ||
        !['running', 'unknown'].includes(attempt.status) ||
        command.jobSpecHash !== attempt.jobSpecHash ||
        (attempt.ownerPid !== process.pid && ownerAlive(attempt.ownerPid))
      )
        return invalid(
          'invalid_job_observation',
          'Observation must bind an unresolved job with no other live owner',
        )
      next = {
        ...campaign,
        attempts: campaign.attempts.map((a) =>
          a.id === attempt.id ? { ...a, status: 'running', ownerPid: process.pid, error: null } : a,
        ),
      }
      break
    }
    case 'finishSynthetic': {
      const owned = ownedRunningAttempt(campaign, command.attemptId)
      if (!owned.ok) return owned
      if (owned.attempt.cancelRequestedAt !== null) {
        return invalid('cancel_requested', '已请求取消的尝试不能提交完成结果')
      }
      const task = campaign.taskRevisions.find(
        (candidate) => candidate.id === owned.attempt.taskRevisionId,
      )
      if (
        !task ||
        withDerivedTaskStatuses(campaign).taskRevisions.find(
          (candidate) => candidate.id === task.id,
        )?.status === 'stale' ||
        !isResearchTemplateId(task.templateId) ||
        task.dataClass !== 'synthetic'
      ) {
        return invalid('invalid_synthetic_task', '尝试没有可执行的合成任务规格')
      }
      const validation = command.validation
      const error =
        (!SHA256.test(command.contentHash)
          ? 'contentHash 必须是 sha256: 后接 64 位小写十六进制'
          : null) ??
        textError(command.uri, 'uri') ??
        textError(command.artifactKind, 'artifactKind') ??
        (command.artifactKind !== task.outputContract ? 'Artifact contract mismatch' : null) ??
        (!validation || typeof validation !== 'object'
          ? 'validation 必须来自 runner 的字节核验'
          : null) ??
        (!SHA256.test(validation?.inputHash ?? '') || validation?.inputHash !== task.inputHash
          ? 'validation.inputHash 与当前任务输入不一致'
          : null) ??
        (!SHA256.test(validation?.contentHash ?? '') ||
        validation?.contentHash !== command.contentHash
          ? 'validation.contentHash 与定稿内容不一致'
          : null) ??
        (!Number.isSafeInteger(validation?.byteLength) || (validation?.byteLength ?? -1) < 0
          ? 'validation.byteLength 必须是非负整数'
          : null) ??
        (!Number.isSafeInteger(validation?.verifiedAt) || (validation?.verifiedAt ?? 0) <= 0
          ? 'validation.verifiedAt 必须是正整数时间戳'
          : null)
      if (error) return invalid('invalid_synthetic_finish', error)
      const artifact: ArtifactVersion = {
        id: randomId('rav'),
        artifactId: task.id,
        mediaType: 'application/json',
        dataClass: 'synthetic',
        inputArtifactVersionIds: [...(task.artifactVersionIds ?? [])],
        schemaId: task.outputContract,
        validation: cloneJson(validation),
        producerAttemptId: owned.attempt.id,
        producerTaskRevisionId: task.id,
        version:
          Math.max(
            0,
            ...campaign.artifactVersions
              .filter((item) => item.artifactId === task.id)
              .map((item) => item.version),
          ) + 1,
        uri: command.uri.trim(),
        kind: command.artifactKind.trim(),
        contentHash: command.contentHash,
        createdAt: now,
      }
      next = {
        ...campaign,
        artifactVersions: [...campaign.artifactVersions, artifact],
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                status: 'completed',
                endedAt: now,
                artifactVersionId: artifact.id,
              }
            : attempt,
        ),
      }
      break
    }
    case 'failSynthetic': {
      const owned = ownedRunningAttempt(campaign, command.attemptId)
      if (!owned.ok) return owned
      const error = textError(command.error, 'error')
      if (error) return invalid('invalid_synthetic_failure', error)
      next = {
        ...campaign,
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                status: attempt.cancelRequestedAt === null ? 'failed' : 'cancelled',
                endedAt: now,
                error: command.error.trim(),
              }
            : attempt,
        ),
      }
      break
    }
    case 'requestCancelSynthetic': {
      const attempt = attemptById(campaign, command.attemptId)
      if (!attempt) return invalid('unknown_attempt', '找不到 attemptId')
      if (attempt.status !== 'running' && attempt.status !== 'unknown')
        return invalid('inactive_attempt', '该尝试已结束')
      if (attempt.cancelRequestedAt !== null)
        return invalid('cancel_requested', '该尝试已经请求取消')
      next = {
        ...campaign,
        attempts: campaign.attempts.map((candidate) =>
          candidate.id === attempt.id ? { ...candidate, cancelRequestedAt: now } : candidate,
        ),
      }
      break
    }
    case 'interruptSynthetic': {
      const owned = ownedRunningAttempt(campaign, command.attemptId)
      if (!owned.ok) return owned
      const error = textError(command.reason, 'reason')
      if (error) return invalid('invalid_synthetic_interrupt', error)
      next = {
        ...campaign,
        attempts: campaign.attempts.map((attempt) =>
          attempt.id === owned.attempt.id
            ? {
                ...attempt,
                status: attempt.cancelRequestedAt === null ? 'interrupted' : 'cancelled',
                endedAt: now,
                error: command.reason.trim(),
              }
            : attempt,
        ),
      }
      break
    }
    case 'recoverSynthetic': {
      const attempt = attemptById(campaign, command.attemptId)
      if (!attempt) return invalid('unknown_attempt', '找不到 attemptId')
      if (attempt.status !== 'running') return invalid('inactive_attempt', '该尝试已结束')
      const error = textError(command.reason, 'reason')
      if (error) return invalid('invalid_synthetic_recovery', error)
      next = {
        ...campaign,
        attempts: campaign.attempts.map((candidate) =>
          candidate.id === attempt.id
            ? {
                ...candidate,
                status: candidate.cancelRequestedAt === null ? 'interrupted' : 'cancelled',
                endedAt: now,
                error: command.reason.trim(),
              }
            : candidate,
        ),
      }
      break
    }
    default:
      return invalid('invalid_command', '不支持的 research command')
  }

  const versioned = { ...next, version: campaign.version + 1, updatedAt: now }
  const hashed = { ...versioned, bundleHash: bundleHash(versioned) }
  return { ok: true, campaign: withDerivedTaskStatuses(invalidateChangedApprovals(hashed, now)) }
}

function append(
  store: Store,
  event: ResearchEvent,
  idempotencyKey?: string,
  payloadHash?: string,
): void {
  store.db
    .query(
      `INSERT INTO research_events
       (id, campaign_id, sequence, event_type, command, campaign, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.campaignId,
      event.sequence,
      event.type,
      event.command === null ? null : JSON.stringify(event.command),
      JSON.stringify(event.campaign),
      event.occurredAt,
    )
  store.db
    .query(
      `INSERT INTO research_outbox (id, event_id, topic, payload, created_at, delivered_at)
       VALUES (?, ?, 'research.campaign.changed', ?, ?, NULL)`,
    )
    .run(randomId('rob'), event.id, JSON.stringify(event), event.occurredAt)
  if (idempotencyKey && payloadHash) {
    store.db
      .query(
        `INSERT INTO research_idempotency
         (campaign_id, idempotency_key, payload_hash, event_id, result_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.campaignId,
        idempotencyKey,
        payloadHash,
        event.id,
        JSON.stringify(event.campaign),
        event.occurredAt,
      )
  }
}

export function createResearchCampaign(
  store: Store,
  input: ResearchCampaignInput,
): ResearchWriteResult {
  const error = validInput(input)
  if (error) return invalid('invalid_campaign', error)
  const idempotencyKey = input.idempotencyKey.trim()
  const workspaceId = input.workspaceId.trim()
  const parentConversationId = input.parentConversationId.trim()
  const goal = input.goal.trim()
  const payloadHash = digest(
    canonicalJson({
      workspaceId,
      parentConversationId,
      goal,
      policy: input.policy,
      inputs: input.inputs,
      budget: input.budget,
    }),
  )
  return store.tx(() => {
    const known = store.db
      .query<IdempotencyRow, [string, string, string]>(
        `SELECT payload_hash, event_id, result_snapshot FROM research_create_idempotency
         WHERE workspace_id = ? AND parent_conversation_id = ? AND idempotency_key = ?`,
      )
      .get(workspaceId, parentConversationId, idempotencyKey)
    if (known) {
      if (known.payload_hash !== payloadHash) {
        return invalid('idempotency_conflict', '同一个 idempotencyKey 不能复用到不同请求')
      }
      const campaign = normalizeCampaign(JSON.parse(known.result_snapshot) as ResearchCampaign)
      const event = listResearchEvents(store, campaign.id).find(
        (candidate) => candidate.id === known.event_id,
      )
      if (!event) throw new Error(`research campaign ${campaign.id} has no create result event`)
      return { ok: true, campaign, event, replayed: true }
    }
    const parent = store.db
      .query<{ workspace_id: string }, [string]>(
        'SELECT workspace_id FROM conversations WHERE id = ?',
      )
      .get(parentConversationId)
    if (!parent) return invalid('unknown_parent_conversation', 'parentConversationId 不存在')
    if (parent.workspace_id !== workspaceId) {
      return invalid('parent_workspace_mismatch', 'parentConversationId 不属于 workspaceId')
    }
    const now = Date.now()
    const draft: ResearchCampaign = {
      id: randomId('rc'),
      workspaceId,
      parentConversationId,
      goal,
      stage: 'question',
      status: 'proposal',
      version: 1,
      policy: cloneJson(input.policy),
      inputs: cloneJson(input.inputs),
      budget: cloneJson(input.budget),
      artifactVersions: [],
      approvals: [],
      taskRevisions: [],
      attempts: [],
      bundleHash: '',
      createdAt: now,
      updatedAt: now,
    }
    const campaign = { ...draft, bundleHash: bundleHash(draft) }
    const event: ResearchEvent = {
      id: randomId('rev'),
      campaignId: campaign.id,
      sequence: 1,
      type: 'created',
      command: null,
      campaign,
      occurredAt: now,
    }
    store.db
      .query(
        `INSERT INTO research_campaigns
         (id, workspace_id, parent_conversation_id, version, snapshot, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaign.id,
        campaign.workspaceId,
        campaign.parentConversationId,
        campaign.version,
        JSON.stringify(campaign),
        now,
      )
    append(store, event)
    store.db
      .query(
        `INSERT INTO research_create_idempotency
         (workspace_id, parent_conversation_id, idempotency_key, payload_hash, event_id, result_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        campaign.workspaceId,
        campaign.parentConversationId,
        idempotencyKey,
        payloadHash,
        event.id,
        JSON.stringify(campaign),
        now,
      )
    return { ok: true, campaign, event, replayed: false }
  })
}

export function getResearchCampaign(store: Store, id: string): ResearchCampaign | null {
  return current(store, id)
}

export function listResearchCampaigns(
  store: Store,
  workspaceId: string,
  parentConversationId?: string,
): ResearchCampaign[] {
  const rows = parentConversationId
    ? store.db
        .query<CampaignRow, [string, string]>(
          `SELECT snapshot FROM research_campaigns
           WHERE workspace_id = ? AND parent_conversation_id = ? ORDER BY updated_at DESC`,
        )
        .all(workspaceId, parentConversationId)
    : store.db
        .query<CampaignRow, [string]>(
          'SELECT snapshot FROM research_campaigns WHERE workspace_id = ? ORDER BY updated_at DESC',
        )
        .all(workspaceId)
  return rows.map((row) => normalizeCampaign(JSON.parse(row.snapshot) as ResearchCampaign))
}

export function mutateResearchCampaign(
  store: Store,
  id: string,
  mutation: ResearchMutation,
): ResearchWriteResult {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation)) {
    return invalid('invalid_mutation', 'mutation 必须是对象')
  }
  const campaignIdError = textError(id, 'campaignId')
  if (campaignIdError) return invalid('invalid_campaign_id', campaignIdError)
  const key = textError(mutation.idempotencyKey, 'idempotencyKey')
  if (key) return invalid('invalid_idempotency_key', key)
  const idempotencyKey = mutation.idempotencyKey.trim()
  if (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion < 1) {
    return invalid('invalid_expected_version', 'expectedVersion 必须是正整数')
  }
  const malformed = commandError(mutation.command)
  if (malformed) return invalid('invalid_command', malformed)
  const stableCommand = (command: ResearchCommand) => {
    if (
      (command.kind === 'approve' ||
        command.kind === 'revokeApproval' ||
        command.kind === 'recordLabelSet') &&
      command.reviewer
    ) {
      const { verifiedAt: _observedAt, ...identity } = command.reviewer
      return { ...command, reviewer: identity }
    }
    return command
  }
  const payloadHash = digest(
    canonicalJson({
      expectedVersion: mutation.expectedVersion,
      command: stableCommand(mutation.command),
    }),
  )
  return store.tx(() => {
    const known = store.db
      .query<IdempotencyRow, [string, string]>(
        `SELECT payload_hash, result_snapshot FROM research_idempotency
         WHERE campaign_id = ? AND idempotency_key = ?`,
      )
      .get(id, idempotencyKey)
    if (known) {
      const campaign = normalizeCampaign(JSON.parse(known.result_snapshot) as ResearchCampaign)
      const event = listResearchEvents(store, id).find(
        (candidate) => candidate.sequence === campaign.version,
      )
      if (!event) throw new Error(`research campaign ${id} has no idempotent result event`)
      if (
        known.payload_hash !== payloadHash &&
        (!event.command ||
          !['approve', 'revokeApproval', 'recordLabelSet'].includes(event.command.kind) ||
          digest(
            canonicalJson({
              expectedVersion: event.sequence - 1,
              command: stableCommand(event.command),
            }),
          ) !== payloadHash)
      )
        return invalid(
          'idempotency_conflict',
          'Same idempotency key cannot identify different requests',
        )

      return { ok: true, campaign, event, replayed: true }
    }

    const campaign = current(store, id)
    if (!campaign) return invalid('not_found', '找不到 research campaign')
    if (mutation.command.kind === 'claimSynthetic') {
      if (textError(mutation.command.dispatchKey, 'dispatchKey')) {
        return invalid('invalid_synthetic_claim', 'dispatchKey 必须是非空字符串')
      }
      const dispatchKey = mutation.command.dispatchKey.trim()
      const existing = campaign.attempts.find((attempt) => attempt.dispatchKey === dispatchKey)
      if (existing) {
        const task = campaign.taskRevisions.find(
          (candidate) => candidate.id === existing.taskRevisionId,
        )
        if (
          !task ||
          task.inputHash !== mutation.command.inputHash ||
          task.templateId !== (mutation.command.templateId ?? SYNTHETIC_SUMMARY_TEMPLATE) ||
          canonicalJson(task.skillBinding ?? null) !==
            canonicalJson(mutation.command.skillBinding ?? null) ||
          (mutation.command.taskRevisionId !== undefined &&
            mutation.command.taskRevisionId !== task.id)
        ) {
          return invalid('dispatch_key_conflict', '同一个 dispatchKey 已绑定另一份输入')
        }
        const event = listResearchEvents(store, id).find(
          (candidate) =>
            candidate.command?.kind === 'claimSynthetic' &&
            candidate.command.dispatchKey.trim() === dispatchKey,
        )
        if (!event) throw new Error(`research campaign ${id} has no claim event for ${dispatchKey}`)
        return { ok: true, campaign, event, replayed: true }
      }
    }
    if (
      mutation.command.kind === 'approve' ||
      mutation.command.kind === 'revokeApproval' ||
      mutation.command.kind === 'recordLabelSet'
    ) {
      const proofId = mutation.command.reviewer?.proofId
      if (
        typeof proofId === 'string' &&
        store.db
          .query(
            "SELECT 1 FROM research_events WHERE json_extract(command, '$.reviewer.proofId') = ? LIMIT 1",
          )
          .get(proofId)
      )
        return invalid('replayed_human_proof', 'Human proof has already been consumed')
    }
    if (campaign.version !== mutation.expectedVersion) {
      return invalid('stale_version', `campaign 版本已经是 ${campaign.version}`)
    }
    const built = nextCampaign(campaign, mutation.command, Date.now())
    if (!built.ok) return built
    const event: ResearchEvent = {
      id: randomId('rev'),
      campaignId: id,
      sequence: built.campaign.version,
      type: mutation.command.kind,
      command: cloneJson(mutation.command),
      campaign: built.campaign,
      occurredAt: built.campaign.updatedAt,
    }
    const update = store.db
      .query(
        `UPDATE research_campaigns SET version = ?, snapshot = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        event.sequence,
        JSON.stringify(built.campaign),
        event.occurredAt,
        id,
        mutation.expectedVersion,
      )
    if (update.changes !== 1) return invalid('stale_version', 'campaign 已被另一位写入者更新')
    append(store, event, idempotencyKey, payloadHash)
    return { ok: true, campaign: built.campaign, event, replayed: false }
  })
}

export function listResearchEvents(store: Store, campaignId: string): ResearchEvent[] {
  return store.db
    .query<EventRow, [string]>(
      `SELECT id, campaign_id, sequence, event_type, command, campaign, occurred_at
       FROM research_events WHERE campaign_id = ? ORDER BY sequence`,
    )
    .all(campaignId)
    .map(eventOf)
}

export function findRunningSyntheticAttempts(store: Store): ResearchRunningAttempt[] {
  const campaigns = store.db
    .query<CampaignRow, []>('SELECT snapshot FROM research_campaigns')
    .all()
    .map((row) => normalizeCampaign(JSON.parse(row.snapshot) as ResearchCampaign))
  return campaigns.flatMap((campaign) =>
    campaign.attempts
      .filter((attempt) => attempt.status === 'running')
      .flatMap((attempt) => {
        const taskRevision = campaign.taskRevisions.find(
          (task) => task.id === attempt.taskRevisionId,
        )
        return taskRevision ? [{ campaignId: campaign.id, taskRevision, attempt }] : []
      }),
  )
}

function ownerAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function recoverAttempt(store: Store, campaignId: string, attemptId: string): ResearchWriteResult {
  return store.tx(() => {
    const campaign = current(store, campaignId)
    if (!campaign) return invalid('not_found', '找不到 research campaign')
    const built = nextCampaign(
      campaign,
      {
        kind: 'recoverSynthetic',
        attemptId,
        reason: '执行进程已退出，恢复时终结悬挂尝试',
      },
      Date.now(),
    )
    if (!built.ok) return built
    const event: ResearchEvent = {
      id: randomId('rev'),
      campaignId,
      sequence: built.campaign.version,
      type: 'recoverSynthetic',
      command: {
        kind: 'recoverSynthetic',
        attemptId,
        reason: '执行进程已退出，恢复时终结悬挂尝试',
      },
      campaign: built.campaign,
      occurredAt: built.campaign.updatedAt,
    }
    const update = store.db
      .query(
        `UPDATE research_campaigns SET version = ?, snapshot = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        event.sequence,
        JSON.stringify(built.campaign),
        event.occurredAt,
        campaignId,
        campaign.version,
      )
    if (update.changes !== 1) return invalid('stale_version', 'campaign 已被另一位写入者更新')
    append(store, event)
    return { ok: true, campaign: built.campaign, event, replayed: false }
  })
}

/** Only dead owners are recovered; a live process keeps exclusive control of its attempt. */
export function recoverRunningSyntheticAttempts(
  store: Store,
  options: RecoverSyntheticAttemptsOptions = {},
): ResearchAttempt[] {
  const isOwnerAlive = options.isOwnerAlive ?? ownerAlive
  const recovered: ResearchAttempt[] = []
  for (const running of findRunningSyntheticAttempts(store)) {
    if (isOwnerAlive(running.attempt.ownerPid)) continue
    const result = ['localhost-daemon', 'ssh-daemon'].includes(running.attempt.backend ?? '')
      ? mutateResearchCampaign(store, running.campaignId, {
          expectedVersion: getResearchCampaign(store, running.campaignId)!.version,
          idempotencyKey: `daemon-owner-lost:${running.attempt.id}`,
          command: {
            kind: 'markSyntheticUnknown',
            attemptId: running.attempt.id,
            reason: 'Daemon job requires explicit observation after owner exit',
          },
        })
      : recoverAttempt(store, running.campaignId, running.attempt.id)
    if (!result.ok) continue
    const attempt = result.campaign.attempts.find(
      (candidate) => candidate.id === running.attempt.id,
    )
    if (attempt) recovered.push(attempt)
  }
  return recovered
}

/** Rebuilds the mutable projection from the append-only campaign event ledger. */
export function rebuildResearchCampaignProjection(
  store: Store,
  campaignId: string,
): ResearchCampaign | null {
  return store.tx(() => {
    const campaign = foldResearchEvents(listResearchEvents(store, campaignId))
    if (!campaign) return null
    store.db
      .query(
        `INSERT INTO research_campaigns
         (id, workspace_id, parent_conversation_id, version, snapshot, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           parent_conversation_id = excluded.parent_conversation_id,
           version = excluded.version,
           snapshot = excluded.snapshot,
           updated_at = excluded.updated_at`,
      )
      .run(
        campaign.id,
        campaign.workspaceId,
        campaign.parentConversationId,
        campaign.version,
        JSON.stringify(campaign),
        campaign.updatedAt,
      )
    return campaign
  })
}
