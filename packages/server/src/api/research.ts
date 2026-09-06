import type {
  ConversationId,
  ResearchCommand,
  ResearchControllerLimits,
  ResearchWriteResult,
} from '@oph-autoresearch/core'
import { isResearchTemplateId, validateLabelSetReference } from '@oph-autoresearch/core'
import {
  controllerApprovalScope,
  costEvidenceApprovalScope,
  createResearchCampaign,
  getConversation,
  getResearchCampaign,
  listResearchCampaigns,
  listResearchEvents,
  mutateResearchCampaign,
  researchCostSummary,
} from '@oph-autoresearch/store'
import { quoteBoundedController } from '../research/bounded-controller.ts'
import { HUMAN_PROOF_HEADER } from '../research/human-auth.ts'
import { prepareEvidenceCitations } from '../research/literature-evidence.ts'
import { compileResearchPattern } from '../research/pattern.ts'
import {
  advanceResearchPattern,
  applyResearchPattern,
  researchPatternStatus,
} from '../research/pattern-execution.ts'
import { readResearchDocuments } from '../research/research-documents.ts'
import { projectResearchFlow } from '../research/research-flow.ts'
import { executeEvidenceReview, quoteEvidenceReview } from '../research/review-execution.ts'
import { canonicalJson, sha256 } from '../research/skill-lock.ts'
import { syntheticProtocol } from '../research/synthetic-protocol.ts'
import {
  cancelSyntheticRun,
  reconcileSyntheticRun,
  startSyntheticRun,
  startSyntheticRunBackground,
} from '../research/synthetic-runner.ts'
import { fixedResearchTemplate, researchTemplateCatalog } from '../research/template-registry.ts'
import { publishResearchEvents } from '../research-events.ts'
import { pauseGoal } from '../run-control.ts'
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
    /^\/api\/research\/campaigns(?:\/([^/]+)(?:\/(events|notifications|progress|next_actions|controller(?:\/(?:quote|start))?|costs(?:\/(?:evidence|quote|settle))?|proposals|approve|revoke|release|labelsets|literature|pattern(?:\/(?:preview|advance))?|review(?:\/quote)?|synthetic(?:\/(?:cancel|status|receipt|reconcile))?))?)?$/.exec(
      url.pathname,
    )
  if (!match) return null
  const changed = () => publishResearchEvents(d.store, d.bus, d.researchNotifications)
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
  if (id && req.method === 'GET' && action === 'notifications') {
    return json({ notifications: d.researchNotifications?.list(id) ?? [] })
  }
  if (id && campaign && req.method === 'GET' && action === 'controller') {
    return json({
      control: campaign.progressControl ?? { mode: 'manual', state: 'active', generation: 0 },
      reservations: campaign.controllerReservations ?? [],
    })
  }
  if (
    id &&
    campaign &&
    req.method === 'POST' &&
    (action === 'controller/quote' || action === 'controller/start')
  ) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !body.limits ||
      typeof body.limits !== 'object' ||
      Array.isArray(body.limits)
    )
      return json({ error: '主控限额格式无效' }, 400)
    if (
      Object.keys(body.limits).sort().join(',') !==
      'deadlineAt,maxAdvances,maxInputCharacters,maxModelRequests,maxOutputTokens,stopAfter'
    )
      return json({ error: '主控限额字段无效' }, 400)
    const conversation = getConversation(d.store, campaign.parentConversationId as ConversationId)
    if (!conversation || conversation.provider.startsWith('cli:'))
      return json({ error: '有界主控需要本机 API 模型' }, 409)
    try {
      const quote = quoteBoundedController(
        d.config,
        campaign,
        body.limits as unknown as ResearchControllerLimits,
        conversation.provider
          ? { provider: conversation.provider, model: conversation.model }
          : conversation.model,
      )
      if (action === 'controller/quote') {
        if (Object.keys(body).join(',') !== 'limits')
          return json({ error: '主控报价字段无效' }, 400)
        return json({
          quote: {
            currency: quote.currency,
            reservedCost: quote.reservedCost,
            model: quote.model,
            limits: quote.limits,
          },
          body: {
            expectedVersion: campaign.version,
            idempotencyKey: `controller-approve:${crypto.randomUUID()}`,
            bundleHash: campaign.bundleHash,
            scope: controllerApprovalScope(campaign, {
              ...quote,
              expiresAt: Math.min(Date.now() + 15 * 60_000, quote.limits.deadlineAt),
            }),
          },
        })
      }
      if (
        Object.keys(body).sort().join(',') !==
          'approvalId,expectedGeneration,expectedVersion,idempotencyKey,limits,reservationId' ||
        typeof body.approvalId !== 'string' ||
        typeof body.reservationId !== 'string' ||
        typeof body.idempotencyKey !== 'string' ||
        !Number.isSafeInteger(body.expectedVersion) ||
        !Number.isSafeInteger(body.expectedGeneration)
      )
        return json({ error: '主控启动字段无效' }, 400)
      if (d.runs.isBusy(campaign.parentConversationId as ConversationId))
        return json({ error: '请等待当前会话结束，再启动有界推进' }, 409)
      const result = mutateResearchCampaign(d.store, id, {
        expectedVersion: body.expectedVersion as number,
        idempotencyKey: body.idempotencyKey,
        command: {
          kind: 'activateBoundedResearch',
          reservationId: body.reservationId,
          approvalId: body.approvalId,
          configHash: quote.configHash,
          currency: quote.currency,
          reservedCost: quote.reservedCost,
          limits: quote.limits,
          expectedGeneration: body.expectedGeneration as number,
        },
      })
      if (result.ok) {
        changed()
        if (!result.replayed)
          d.startRun(
            campaign.parentConversationId as ConversationId,
            '在已签署的主控限额内继续当前研究。先读取现状，再推进可执行步骤；遇到人类审批、未知运行或远端尚未完成时停止。候选代码必须等待独立审閱与正式执行批准。',
          )
      }
      return respond(result)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : '主控推进未获准' }, 409)
    }
  }
  if (id && campaign && req.method === 'GET' && action === 'costs') {
    return json({
      summary: researchCostSummary(campaign),
      evidence: campaign.costEvidence ?? [],
      settlements: campaign.costSettlements ?? [],
    })
  }
  if (id && campaign && req.method === 'GET' && action === 'costs/quote') {
    try {
      return json({
        body: {
          expectedVersion: campaign.version,
          idempotencyKey: `cost-approve:${crypto.randomUUID()}`,
          bundleHash: campaign.bundleHash,
          scope: costEvidenceApprovalScope(
            campaign,
            url.searchParams.get('evidenceId') ?? '',
            Date.now() + 15 * 60_000,
          ),
        },
      })
    } catch {
      return json({ error: '当前结算依据不可批准，请核对原费用记录。' }, 409)
    }
  }
  if (
    id &&
    campaign &&
    req.method === 'POST' &&
    (action === 'costs/evidence' || action === 'costs/settle')
  ) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Number.isSafeInteger(body.expectedVersion) ||
      typeof body.idempotencyKey !== 'string'
    )
      return json({ error: 'invalid_cost_request' }, 400)
    if (action === 'costs/evidence') {
      if (
        Object.keys(body).sort().join(',') !==
          'amount,description,expectedVersion,idempotencyKey,subject' ||
        typeof body.amount !== 'number' ||
        !Number.isFinite(body.amount) ||
        body.amount < 0 ||
        typeof body.description !== 'string' ||
        !body.description.trim() ||
        body.description.length > 2000 ||
        !body.subject ||
        typeof body.subject !== 'object' ||
        Array.isArray(body.subject)
      )
        return json({ error: 'invalid_cost_evidence' }, 400)
      const subject = body.subject as { kind?: unknown; id?: unknown }
      if (
        Object.keys(subject).sort().join(',') !== 'id,kind' ||
        (subject.kind !== 'cli_preparation' &&
          subject.kind !== 'model_review' &&
          subject.kind !== 'formal_review' &&
          subject.kind !== 'formal_execution' &&
          subject.kind !== 'controller') ||
        typeof subject.id !== 'string'
      )
        return json({ error: 'invalid_cost_subject' }, 400)
      const evidence = {
        id: `rce_${sha256(`${id}:${body.idempotencyKey}`).slice(7, 39)}`,
        subject: {
          kind: subject.kind as
            | 'cli_preparation'
            | 'model_review'
            | 'formal_review'
            | 'formal_execution'
            | 'controller',
          id: subject.id,
        },
        currency: campaign.budget.currency,
        amount: body.amount,
        description: body.description.trim(),
        source: 'human-attestation' as const,
        sourceHash: sha256(
          canonicalJson({
            subject,
            currency: campaign.budget.currency,
            amount: body.amount,
            description: body.description.trim(),
          }),
        ),
      }
      return respondAndPublish(
        mutateResearchCampaign(d.store, id, {
          expectedVersion: body.expectedVersion as number,
          idempotencyKey: body.idempotencyKey,
          command: { kind: 'recordCostEvidence', evidence },
        }),
      )
    }
    if (
      Object.keys(body).sort().join(',') !==
        'approvalId,evidenceId,expectedVersion,idempotencyKey' ||
      typeof body.evidenceId !== 'string' ||
      typeof body.approvalId !== 'string'
    )
      return json({ error: 'invalid_cost_settlement' }, 400)
    return respondAndPublish(
      mutateResearchCampaign(d.store, id, {
        expectedVersion: body.expectedVersion as number,
        idempotencyKey: body.idempotencyKey,
        command: {
          kind: 'settleCostEvidence',
          evidenceId: body.evidenceId,
          approvalId: body.approvalId,
        },
      }),
    )
  }
  if (id && campaign && req.method === 'GET' && action === 'next_actions') {
    const documents = await readResearchDocuments(d.store, d.workspaceRoot, id)
    if (getResearchCampaign(d.store, id)?.version !== campaign.version)
      return json({ error: '研究依据已更新，请刷新后重试。' }, 409)
    return json({ projection: projectResearchFlow(campaign, { documents }, Date.now()) })
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
  if (id && campaign && req.method === 'POST' && action === 'progress') {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(',') !==
        'expectedGeneration,expectedVersion,idempotencyKey,state' ||
      (body.state !== 'active' && body.state !== 'held') ||
      typeof body.expectedGeneration !== 'number' ||
      !Number.isSafeInteger(body.expectedGeneration) ||
      typeof body.expectedVersion !== 'number' ||
      !Number.isSafeInteger(body.expectedVersion) ||
      typeof body.idempotencyKey !== 'string'
    ) {
      return json({ error: 'invalid_progress_request' }, 400)
    }
    const result = mutateResearchCampaign(d.store, id, {
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
      command: {
        kind: 'setResearchProgress',
        state: body.state,
        expectedGeneration: body.expectedGeneration,
      },
    })
    if (!result.ok) return json(result, 409)
    if (!result.replayed) changed()
    const current = getResearchCampaign(d.store, id)!
    // A replay of an older hold must not interrupt a controller started after resume.
    // Holding new controller actions does not cancel already approved remote jobs.
    if (
      body.state === 'held' &&
      current.progressControl?.state === 'held' &&
      current.progressControl.generation === result.campaign.progressControl?.generation
    ) {
      const paused = pauseGoal(campaign.parentConversationId as ConversationId, d)
      if (!paused.ok)
        return json({ campaign: current, error: '推进已暂停，但主控中断需重试。' }, 409)
    }
    return json({ ...result, campaign: current, controllerScope: 'conversation' })
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
        typeof body.expectedVersion !== 'number' ||
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
          typeof body.expectedVersion !== 'number' ||
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
      typeof body.expectedVersion !== 'number' ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (action === 'approve' && !body.scope)
    )
      return json({ error: 'invalid_approval_request' }, 400)
    const result = mutateResearchCampaign(d.store, id, {
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
    })
    if (result.ok) {
      changed()
      const current = getResearchCampaign(d.store, id)
      const revoked = current?.approvals.find((item) => item.id === body.approvalId)
      if (
        action === 'revoke' &&
        current?.progressControl?.state === 'held' &&
        revoked?.status === 'revoked' &&
        revoked.consumedBy === `controller:${current.progressControl.reservationRef}`
      ) {
        await pauseGoal(current.parentConversationId as ConversationId, d)
      }
    }
    return respond(result)
  }
  if (id && campaign && action === 'release') {
    if (
      Object.keys(body).some(
        (key) =>
          !['approvalId', 'artifactVersionIds', 'expectedVersion', 'idempotencyKey'].includes(key),
      ) ||
      !Array.isArray(body.artifactVersionIds) ||
      typeof body.expectedVersion !== 'number' ||
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
      typeof body.expectedVersion !== 'number' ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (body.expectedVersion as number) < 1
    ) {
      return json({ error: 'invalid_synthetic_request' }, 400)
    }
    const start =
      url.searchParams.get('accepted') === 'true' ? startSyntheticRunBackground : startSyntheticRun
    const result = await start({
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
  if (
    typeof body.expectedVersion !== 'number' ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 1
  ) {
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
