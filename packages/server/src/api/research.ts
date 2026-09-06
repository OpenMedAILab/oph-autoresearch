import type { ResearchCommand, ResearchWriteResult } from '@oph-autoresearch/core'
import { isResearchTemplateId, validateLabelSetReference } from '@oph-autoresearch/core'
import {
  createResearchCampaign,
  getConversation,
  getResearchCampaign,
  listResearchCampaigns,
  listResearchEvents,
  mutateResearchCampaign,
} from '@oph-autoresearch/store'
import { HUMAN_PROOF_HEADER } from '../research/human-auth.ts'
import { prepareEvidenceCitations } from '../research/literature-evidence.ts'
import { compileResearchPattern } from '../research/pattern.ts'
import {
  advanceResearchPattern,
  applyResearchPattern,
  researchPatternStatus,
} from '../research/pattern-execution.ts'
import { executeEvidenceReview, quoteEvidenceReview } from '../research/review-execution.ts'
import { syntheticProtocol } from '../research/synthetic-protocol.ts'
import {
  cancelSyntheticRun,
  reconcileSyntheticRun,
  startSyntheticRun,
} from '../research/synthetic-runner.ts'
import { fixedResearchTemplate, researchTemplateCatalog } from '../research/template-registry.ts'
import { publishResearchEvents } from '../research-events.ts'
import { type ApiHandler, json } from './types.ts'

const proposals = new Set([
  'setPolicy',
  'setInputs',
  'setBudget',
  'recordArtifact',
  'declareSyntheticTask',
])

function respond(result: ResearchWriteResult): Response {
  if (result.ok) return json(result)
  return json(
    result,
    result.code.includes('conflict') || result.code.startsWith('stale_') ? 409 : 400,
  )
}

/** Bearer access permits proposals. It does not attest a human reviewer. */
export const handleResearchApi: ApiHandler = async (url, req, d) => {
  const match =
    /^\/api\/research\/campaigns(?:\/([^/]+)(?:\/(events|proposals|approve|revoke|release|labelsets|literature|pattern(?:\/(?:preview|advance))?|review(?:\/quote)?|synthetic(?:\/(?:cancel|status|receipt|reconcile))?))?)?$/.exec(
      url.pathname,
    )
  if (!match) return null
  const changed = () => publishResearchEvents(d.store, d.bus)
  const respondAndPublish = (result: ResearchWriteResult) => {
    if (result.ok) changed()
    return respond(result)
  }
  const [, id, action] = match
  if ((action === 'approve' || action === 'revoke') && !d.researchHumanAuth) {
    return json(
      {
        error: 'human_identity_unavailable',
        message: '审批渠道未配置；应用访问令牌不能证明人类身份。',
      },
      403,
    )
  }
  if (!id && req.method === 'GET') {
    const conversationId = url.searchParams.get('conversationId') || undefined
    return json({
      campaigns: listResearchCampaigns(d.store, d.workspaceId, conversationId),
      approvalUrl: d.researchApprovalUrl ?? null,
      templates: researchTemplateCatalog(),
      executionBackends:
        d.researchExecutionDevices?.map((device) => ({
          id: device.id,
          backendPolicyHash: device.authority.backendPolicyHash,
          trackingPolicyHash: device.authority.trackingPolicyHash ?? null,
        })) ??
        (d.researchDaemonBackend
          ? [
              {
                id: d.researchDaemonBackend.kind ?? 'localhost-daemon',
                backendPolicyHash: d.researchDaemonBackend.daemon.backendPolicyHash ?? null,
                trackingPolicyHash: d.researchDaemonBackend.daemon.trackingPolicyHash ?? null,
              },
            ]
          : []),
      trackingPolicyHash: d.researchDaemonBackend?.daemon.trackingPolicyHash ?? null,
      approvalChannel: d.researchHumanAuth ? 'signed-human-proof' : 'unavailable',
    })
  }
  const campaign = id ? getResearchCampaign(d.store, id) : null
  if (id && (!campaign || campaign.workspaceId !== d.workspaceId)) {
    return json({ error: 'not_found' }, 404)
  }
  if (id && req.method === 'GET' && !action) {
    return json({
      campaign,
      approvalUrl: d.researchApprovalUrl ?? null,
      approvalChannel: d.researchHumanAuth ? 'signed-human-proof' : 'unavailable',
      trackingPolicyHash: d.researchDaemonBackend?.daemon.trackingPolicyHash ?? null,
    })
  }
  if (id && req.method === 'GET' && action === 'events') {
    return json({ events: listResearchEvents(d.store, id) })
  }
  if (id && campaign && req.method === 'GET' && action === 'pattern') {
    try {
      return json({ pattern: campaign.pattern, state: researchPatternStatus(campaign) })
    } catch {
      return json({ error: 'pattern_unavailable' }, 409)
    }
  }
  if (
    id &&
    req.method === 'GET' &&
    (action === 'synthetic/status' || action === 'synthetic/receipt')
  ) {
    const attemptId = url.searchParams.get('attemptId') ?? ''
    const protocol = syntheticProtocol(d.store, d.workspaceRoot, id)
    try {
      return json(
        action === 'synthetic/status'
          ? protocol.status(attemptId)
          : await protocol.receipt(attemptId),
      )
    } catch {
      return json({ error: 'synthetic_evidence_unavailable' }, 409)
    }
  }
  if (
    req.method !== 'POST' ||
    (id &&
      ![
        'proposals',
        'pattern',
        'pattern/preview',
        'pattern/advance',
        'approve',
        'revoke',
        'release',
        'labelsets',
        'literature',
        'review',
        'review/quote',
        'synthetic',
        'synthetic/cancel',
        'synthetic/reconcile',
      ].includes(action ?? ''))
  ) {
    return json({ error: 'method_not_allowed' }, 405)
  }
  const raw: unknown = await req.json().catch(() => null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return json({ error: 'invalid_request' }, 400)
  }
  const body = raw as Record<string, unknown>
  const boundHash =
    typeof body.approvalId === 'string'
      ? campaign?.approvals.find((a) => a.id === body.approvalId)?.scope?.backendPolicyHash
      : typeof body.attemptId === 'string'
        ? campaign?.attempts.find((a) => a.id === body.attemptId)?.backendPolicyHash
        : undefined
  const device = d.researchExecutionDevices?.find(
    (device) => device.authority.backendPolicyHash === boundHash,
  )
  const executionBackend = device
    ? { kind: 'ssh-daemon' as const, daemon: device.authority }
    : d.researchDaemonBackend
  if (
    d.researchExecutionDevices?.length &&
    ['synthetic', 'synthetic/reconcile', 'synthetic/cancel', 'pattern/advance'].includes(
      action ?? '',
    ) &&
    !device
  )
    return json({ error: 'approved_execution_device_required' }, 403)
  if (id && campaign && action?.startsWith('pattern')) {
    try {
      if (action === 'pattern/preview') return json({ plan: compileResearchPattern(body) })
      if (action === 'pattern') {
        if (
          Object.keys(body).some(
            (key) => !['pattern', 'expectedVersion', 'idempotencyKey'].includes(key),
          )
        )
          return json({ error: 'invalid_pattern_request' }, 400)
        return respondAndPublish(
          applyResearchPattern({
            store: d.store,
            campaignId: id,
            pattern: body.pattern,
            expectedVersion: body.expectedVersion as number,
            idempotencyKey: body.idempotencyKey as string,
          }),
        )
      }
      if (
        Object.keys(body).some((key) => !['expectedVersion', 'approvalId'].includes(key)) ||
        typeof body.approvalId !== 'string' ||
        !Number.isSafeInteger(body.expectedVersion)
      )
        return json({ error: 'invalid_pattern_advance' }, 400)
      const result = await advanceResearchPattern({
        store: d.store,
        workspaceRoot: d.workspaceRoot,
        campaignId: id,
        expectedVersion: body.expectedVersion as number,
        approvalId: body.approvalId,
        onChange: changed,
        ...(executionBackend ? { daemonBackend: executionBackend } : {}),
      })
      return json(result, result.ok ? 200 : 409)
    } catch {
      return json({ error: 'pattern_not_available_or_authorized' }, 409)
    }
  }
  if (id && campaign && action === 'literature') {
    const patternPolicy = campaign.pattern?.plan.policy
    if (
      patternPolicy &&
      typeof patternPolicy === 'object' &&
      !Array.isArray(patternPolicy) &&
      patternPolicy.allowPublicMetadata === false
    )
      return json({ error: 'pattern_public_metadata_denied' }, 403)
    if (
      !d.researchLiteratureCollector ||
      Object.keys(body).some(
        (key) => !['doi', 'pmid', 'expectedVersion', 'idempotencyKey'].includes(key),
      ) ||
      (typeof body.doi === 'string') === (typeof body.pmid === 'string')
    )
      return json({ error: 'invalid_literature_identifier' }, 400)
    const existing = campaign.literatureCitations?.find((c) =>
      body.doi ? c.doi === String(body.doi).toLowerCase() : c.pmid === body.pmid,
    )
    if (existing) return json({ campaign, citation: existing, replayed: true })
    try {
      const source = await d.researchLiteratureCollector(
        typeof body.doi === 'string' ? { doi: body.doi } : { pmid: body.pmid as string },
      )
      const citation = prepareEvidenceCitations([source])[0]!
      return respondAndPublish(
        mutateResearchCampaign(d.store, id, {
          expectedVersion: body.expectedVersion as number,
          idempotencyKey: body.idempotencyKey as string,
          command: { kind: 'recordLiteratureCitation', citation },
        }),
      )
    } catch {
      return json({ error: 'public_literature_unavailable' }, 409)
    }
  }
  if (id && campaign && (action === 'review' || action === 'review/quote')) {
    const allowed =
      action === 'review/quote'
        ? ['attemptIds']
        : ['attemptIds', 'expectedVersion', 'dispatchKey', 'approvalId']
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      !Array.isArray(body.attemptIds) ||
      body.attemptIds.length < 1 ||
      body.attemptIds.length > 16 ||
      body.attemptIds.some((id) => typeof id !== 'string') ||
      (action === 'review' &&
        (typeof body.approvalId !== 'string' ||
          typeof body.dispatchKey !== 'string' ||
          !Number.isSafeInteger(body.expectedVersion)))
    )
      return json({ error: 'invalid_review_request' }, 400)
    try {
      const base = {
        store: d.store,
        config: d.config,
        workspaceRoot: d.workspaceRoot,
        campaignId: id,
        attemptIds: body.attemptIds as string[],
        ...(d.researchReviewCli ? { cli: d.researchReviewCli } : {}),
      }
      if (action === 'review/quote') return json({ quote: await quoteEvidenceReview(base) })
      return json(
        await executeEvidenceReview({
          ...base,
          expectedVersion: body.expectedVersion as number,
          dispatchKey: body.dispatchKey as string,
          approvalId: body.approvalId as string,
          signal: req.signal,
          onChange: changed,
        }),
      )
    } catch {
      return json({ error: 'review_not_authorized_or_unavailable' }, 409)
    }
  }
  if (id && campaign && action === 'labelsets') {
    const reviewer = d.researchHumanAuth?.({
      header: req.headers.get(HUMAN_PROOF_HEADER),
      workspaceId: d.workspaceId,
      campaignId: id,
      action: 'labelset',
      body,
    })
    if (!reviewer) return json({ error: 'invalid_human_proof' }, 403)
    if (
      Object.keys(body).some(
        (key) => !['reference', 'expectedVersion', 'idempotencyKey'].includes(key),
      )
    )
      return json({ error: 'invalid_labelset_request' }, 400)
    try {
      const reference = validateLabelSetReference(body.reference)
      if (reference.issuer !== reviewer.issuer)
        return json({ error: 'labelset_issuer_mismatch' }, 403)
      return respondAndPublish(
        mutateResearchCampaign(d.store, id, {
          expectedVersion: body.expectedVersion as number,
          idempotencyKey: body.idempotencyKey as string,
          command: { kind: 'recordLabelSet', reference, reviewer },
        }),
      )
    } catch {
      return json({ error: 'invalid_labelset' }, 400)
    }
  }
  if (id && campaign && (action === 'approve' || action === 'revoke')) {
    const reviewer = d.researchHumanAuth?.({
      header: req.headers.get(HUMAN_PROOF_HEADER),
      workspaceId: d.workspaceId,
      campaignId: id,
      action,
      body,
    })
    if (!reviewer) return json({ error: 'invalid_human_proof' }, 403)
    const allowed =
      action === 'approve'
        ? ['bundleHash', 'scope', 'approvalId', 'expectedVersion', 'idempotencyKey']
        : ['approvalId', 'expectedVersion', 'idempotencyKey']
    if (
      Object.keys(body).some((key) => !allowed.includes(key)) ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (action === 'approve' && !body.scope)
    )
      return json({ error: 'invalid_approval_request' }, 400)
    return respondAndPublish(
      mutateResearchCampaign(d.store, id, {
        expectedVersion: body.expectedVersion as number,
        idempotencyKey: body.idempotencyKey as string,
        command: (action === 'approve'
          ? {
              kind: 'approve',
              bundleHash: body.bundleHash,
              scope: body.scope,
              ...(body.approvalId ? { approvalId: body.approvalId } : {}),
              reviewer,
            }
          : { kind: 'revokeApproval', approvalId: body.approvalId, reviewer }) as ResearchCommand,
      }),
    )
  }
  if (id && campaign && action === 'release') {
    if (
      Object.keys(body).some(
        (key) =>
          !['approvalId', 'artifactVersionIds', 'expectedVersion', 'idempotencyKey'].includes(key),
      ) ||
      !Array.isArray(body.artifactVersionIds) ||
      !Number.isSafeInteger(body.expectedVersion)
    )
      return json({ error: 'invalid_release' }, 400)
    try {
      const protocol = syntheticProtocol(d.store, d.workspaceRoot, id)
      for (const artifactId of body.artifactVersionIds) {
        const attempt = campaign.attempts.find((a) => a.artifactVersionId === artifactId)
        if (!attempt) throw new Error('Artifact has no completed producer')
        await protocol.receipt(attempt.id)
      }
    } catch {
      return json({ error: 'release_evidence_unavailable' }, 409)
    }
    return respondAndPublish(
      mutateResearchCampaign(d.store, id, {
        expectedVersion: body.expectedVersion as number,
        idempotencyKey: body.idempotencyKey as string,
        command: {
          kind: 'release',
          approvalId: body.approvalId as string,
          artifactVersionIds: body.artifactVersionIds as string[],
        },
      }),
    )
  }
  if (id && campaign && action === 'synthetic/reconcile') {
    if (Object.keys(body).some((key) => key !== 'attemptId') || typeof body.attemptId !== 'string')
      return json({ error: 'invalid_reconcile' }, 400)
    const result = await reconcileSyntheticRun({
      store: d.store,
      workspaceRoot: d.workspaceRoot,
      campaignId: id,
      expectedVersion: campaign.version,
      attemptId: body.attemptId,
      onChange: changed,
      ...(executionBackend ? { daemonBackend: executionBackend } : {}),
    })
    return json(result, result.ok ? 200 : result.code === 'execution_unknown' ? 409 : 400)
  }
  if (id && campaign && action === 'synthetic') {
    if (
      Object.keys(body).some(
        (key) =>
          ![
            'dispatchKey',
            'expectedVersion',
            'taskRevisionId',
            'templateId',
            'approvalId',
          ].includes(key),
      ) ||
      (body.templateId !== undefined && !isResearchTemplateId(body.templateId)) ||
      (body.taskRevisionId !== undefined &&
        (typeof body.taskRevisionId !== 'string' || !body.taskRevisionId.trim())) ||
      typeof body.dispatchKey !== 'string' ||
      !body.dispatchKey.trim() ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (body.expectedVersion as number) < 1
    ) {
      return json({ error: 'invalid_synthetic_request' }, 400)
    }
    const result = await startSyntheticRun({
      ...(executionBackend ? { daemonBackend: executionBackend } : {}),
      requireApproval: d.researchRequireApproval ?? false,
      ...(typeof body.approvalId === 'string' ? { approvalId: body.approvalId } : {}),
      ...(isResearchTemplateId(body.templateId) ? { templateId: body.templateId } : {}),
      ...(typeof body.taskRevisionId === 'string' ? { taskRevisionId: body.taskRevisionId } : {}),
      store: d.store,
      workspaceRoot: d.workspaceRoot,
      campaignId: id,
      expectedVersion: body.expectedVersion as number,
      dispatchKey: body.dispatchKey,
      onChange: changed,
    })
    return json(
      result,
      result.ok
        ? 200
        : 'code' in result && String(result.code).match(/conflict|stale_/)
          ? 409
          : 400,
    )
  }
  if (id && campaign && action === 'synthetic/cancel') {
    if (
      Object.keys(body).some((key) => key !== 'attemptId') ||
      typeof body.attemptId !== 'string' ||
      !body.attemptId.trim()
    )
      return json({ error: 'invalid_cancel_request' }, 400)
    const result = cancelSyntheticRun({
      ...(executionBackend ? { daemonBackend: executionBackend } : {}),
      store: d.store,
      campaignId: id,
      attemptId: body.attemptId,
      expectedVersion: campaign.version,
      onChange: changed,
    })
    return json(result, result.ok ? 200 : 409)
  }
  if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim()) {
    return json({ error: 'idempotency_key_required' }, 400)
  }
  if (!id) {
    if (
      Object.keys(body).some(
        (key) => !['parentConversationId', 'goal', 'idempotencyKey'].includes(key),
      )
    ) {
      return json({ error: 'unsupported_create_field' }, 400)
    }
    if (
      typeof body.parentConversationId !== 'string' ||
      typeof body.goal !== 'string' ||
      !body.goal.trim()
    ) {
      return json({ error: 'goal_and_parent_conversation_required' }, 400)
    }
    const parent = getConversation(d.store, body.parentConversationId as never)
    if (!parent || parent.workspaceId !== d.workspaceId || parent.parentConversationId) {
      return json({ error: 'parent_conversation_not_found' }, 404)
    }
    return respondAndPublish(
      createResearchCampaign(d.store, {
        workspaceId: d.workspaceId,
        parentConversationId: parent.id,
        goal: body.goal,
        policy: {},
        inputs: {},
        budget: { currency: 'USD', limit: 0 },
        idempotencyKey: body.idempotencyKey as string,
      }),
    )
  }
  if (
    Object.keys(body).some((key) => !['command', 'expectedVersion', 'idempotencyKey'].includes(key))
  ) {
    return json({ error: 'unsupported_proposal_field' }, 400)
  }
  const command = body.command as Record<string, unknown> | undefined
  if (!command || typeof command.kind !== 'string' || !proposals.has(command.kind)) {
    return json({ error: 'proposal_command_required' }, 400)
  }
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
    return json({ error: 'expected_version_required' }, 400)
  }
  if (
    command.kind === 'declareSyntheticTask' &&
    command.templateId !== undefined &&
    !isResearchTemplateId(command.templateId)
  )
    return json({ error: 'invalid_template' }, 400)
  return respondAndPublish(
    mutateResearchCampaign(d.store, id, {
      idempotencyKey: body.idempotencyKey as string,
      expectedVersion: body.expectedVersion as number,
      command: (command.kind === 'declareSyntheticTask'
        ? {
            ...command,
            skillBinding: fixedResearchTemplate(command.templateId).binding,
          }
        : command) as ResearchCommand,
    }),
  )
}
