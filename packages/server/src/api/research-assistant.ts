import type { ConversationId } from '@oph-autoresearch/core'
import { getResearchCampaign, mutateResearchCampaign } from '@oph-autoresearch/store'
import { htmlToText, safeFetch } from '@oph-autoresearch/tools'
import {
  assistantContext,
  bindingHash,
  conversationCampaigns,
  pendingStudyHandoff,
  researchPreset,
} from '../research/research-assistant.ts'
import { readResearchDocuments, writeResearchDocument } from '../research/research-documents.ts'
import { publishResearchEvents } from '../research-events.ts'
import { type ApiHandler, json } from './types.ts'

/** Plan selection never grants an execution approval; it only requests local preparation. */
export const handleResearchAssistantApi: ApiHandler = async (url, req, deps) => {
  const match =
    /^\/api\/research\/campaigns\/([A-Za-z0-9_-]+)\/assistant(?:\/(confirm|preset|evidence))?$/.exec(
      url.pathname,
    )
  if (url.pathname === '/api/research/assistant' && req.method === 'GET') {
    try {
      return json(
        await assistantContext(
          deps,
          conversationCampaigns(deps, url.searchParams.get('conversationId') ?? ''),
          false,
        ),
      )
    } catch {
      return json({ error: '研究会话不存在' }, 404)
    }
  }
  if (!match) return null
  const campaign = getResearchCampaign(deps.store, match[1]!)
  if (!campaign || campaign.workspaceId !== deps.workspaceId)
    return json({ error: 'not_found' }, 404)
  if (!match[2] && req.method === 'GET') return json(await assistantContext(deps, [campaign]))
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return json({ error: 'invalid_body' }, 400)
  try {
    if (match[2] === 'preset') {
      if (Object.keys(body).join(',') !== 'phase') return json({ error: 'phase_required' }, 400)
      return json(await researchPreset(deps, campaign, body.phase))
    }
    if (match[2] === 'evidence') {
      if (
        Object.keys(body).some(
          (key) =>
            ![
              'key',
              'url',
              'title',
              'license',
              'expectedVersion',
              'idempotencyKey',
              'previousVersion',
            ].includes(key),
        ) ||
        typeof body.url !== 'string'
      )
        return json({ error: 'invalid_source_request' }, 400)
      const response = await safeFetch(body.url, { signal: AbortSignal.timeout(30_000) })
      if (response.blocked || !response.ok)
        return json(
          {
            error: '公开资料获取失败，未保存内容',
            detail: response.blocked?.message ?? `HTTP ${response.status}`,
          },
          409,
        )
      if (!/text\/|json|xml/.test(response.contentType ?? ''))
        return json({ error: '此入口支持可读网页/文本；PDF请先用已有文件工具提取并定位' }, 400)
      const raw = new TextDecoder().decode(response.body)
      const text = (response.contentType?.includes('html') ? htmlToText(raw) : raw).slice(0, 80_000)
      if (!text.trim()) return json({ error: '页面没有可读内容' }, 409)
      const result = await writeResearchDocument({
        store: deps.store,
        workspaceRoot: deps.workspaceRoot,
        campaignId: campaign.id,
        expectedVersion: body.expectedVersion as number,
        idempotencyKey: body.idempotencyKey as string,
        kind: 'evidence',
        document: {
          key: body.key,
          title: body.title,
          url: response.url,
          retrievedAt: new Date().toISOString(),
          readingDepth: 'partial-full-text',
          license: body.license ?? 'unknown',
          segments: [
            {
              locator: `retrieved text characters 0-${text.length}; completeness not established`,
              text,
            },
          ],
          previousVersion: body.previousVersion ?? null,
        },
      })
      publishResearchEvents(deps.store, deps.bus, deps.researchNotifications)
      return json(
        { ...result, note: '已保存实际获取的文本；未判定论文全文完整性或训练许可。' },
        201,
      )
    }
    if (match[2] === 'confirm') {
      if (deps.researchControllerOnly) return json({ error: '方案确认仅限用户界面' }, 403)
      if (
        Object.keys(body).sort().join(',') !== 'contentHash,documentId,expectedVersion,requestId' ||
        typeof body.requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId) ||
        typeof body.documentId !== 'string' ||
        typeof body.contentHash !== 'string'
      )
        return json({ error: 'invalid_confirmation' }, 400)
      const docs = await readResearchDocuments(deps.store, deps.workspaceRoot, campaign.id)
      const current = docs.find(
        (doc) =>
          doc.kind === 'study' &&
          doc.id === body.documentId &&
          doc.contentHash === body.contentHash &&
          doc.verified &&
          !doc.stale,
      )
      if (!current) return json({ error: '方案已变化或内容不可用，请查看当前版本' }, 409)
      if (
        campaign.studySelection?.contentHash === current.contentHash &&
        campaign.studySelection.localRoot === deps.workspaceRoot &&
        campaign.studySelection.serverBindingHash === bindingHash(deps)
      )
        return json({ campaign, replayed: true })
      const selected = mutateResearchCampaign(deps.store, campaign.id, {
        expectedVersion: body.expectedVersion as number,
        idempotencyKey: `study-selection-${body.requestId}`,
        command: {
          kind: 'selectStudy',
          documentId: current.id,
          contentHash: current.contentHash,
          requestId: body.requestId,
          localRoot: deps.workspaceRoot,
          serverBindingHash: bindingHash(deps),
        },
      })
      if (!selected.ok) return json(selected, 409)
      publishResearchEvents(deps.store, deps.bus, deps.researchNotifications)
      const prompt = pendingStudyHandoff(deps.store, selected.campaign)
      if (prompt && !deps.runs.isBusy(campaign.parentConversationId as ConversationId))
        deps.startRun(campaign.parentConversationId as ConversationId, prompt)
      return json({
        campaign: selected.campaign,
        replayed: selected.replayed,
        note: '方案已确认，实验准备待当前会话接手；正式运行仍按现有授权。',
      })
    }
    return json({ error: 'not_found' }, 404)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'research_action_failed' }, 409)
  }
}
