import type { ResearchCampaign } from '@oph-autoresearch/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { client } from '../lib/store/index.ts'

type DocumentVersion = {
  kind:
    | 'study'
    | 'manuscript'
    | 'skillcandidate'
    | 'evidence'
    | 'venue'
    | 'reviewcase'
    | 'handoff'
    | 'peerreview'
  version: number
  contentHash: string
  stale: boolean
  verified: boolean
  createdAt: number
  document?: { question?: string; text?: string; counterEvidence?: string[]; endpoints?: string[] }
}
const names = {
  evidence: '文献证据',
  venue: '刊会档案',
  reviewcase: '审稿案例',
  handoff: '实验交接',
  peerreview: '稿件审阅',
  study: '研究方案',
  manuscript: '证据稿件',
  skillcandidate: '技能候选',
}
const fields = [
  ['question', '可检验的研究问题'],
  ['population', '研究人群或数据范围'],
  ['intervention', '干预或模型'],
  ['comparison', '对照方法'],
  ['outcome', '主要结局'],
  ['protocol', '实验流程与停止规则'],
  ['splitPlan', '数据拆分与泄漏防范'],
  ['endpoints', '评价指标（每行一项）'],
  ['counterEvidence', '反证与证据局限（每行一项）'],
  ['codeVersion', '代码版本说明'],
] as const
export function ResearchDocumentsPanel(props: {
  campaign: ResearchCampaign
  busy: boolean
  act: (work: () => Promise<void>, success: string) => Promise<void>
}) {
  const endpoint = () =>
    `/api/research/campaigns/${props.campaign.id}/documents?ws=${encodeURIComponent(props.campaign.workspaceId)}`
  const [documents] = createResource(
    () => `${props.campaign.id}:${props.campaign.version}`,
    async () => {
      const result = await client.api<{ documents: DocumentVersion[] }>(endpoint())
      if (!Array.isArray(result.documents)) throw new Error('Invalid document response')
      return result
    },
  )
  const versions = () => (documents.error ? [] : (documents()?.documents ?? []))
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [citations, setCitations] = createSignal<string[]>([])
  const ready = () => fields.every(([key]) => values()[key]?.trim()) && citations().length > 0
  const lines = (key: string) =>
    values()
      [key]!.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  async function save() {
    if (!ready() || props.busy) return
    const v = values()
    const latest = versions()
      .filter((item) => item.kind === 'study')
      .toSorted((a, b) => b.version - a.version)[0]
    await props.act(async () => {
      await client.api(endpoint(), {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: props.campaign.version,
          idempotencyKey: crypto.randomUUID(),
          kind: 'study',
          document: {
            question: v.question,
            PICO: {
              population: v.population,
              intervention: v.intervention,
              comparison: v.comparison,
              outcome: v.outcome,
            },
            evidenceCitations: citations(),
            counterEvidence: lines('counterEvidence'),
            protocol: { description: v.protocol },
            endpoints: lines('endpoints'),
            splitPlan: { description: v.splitPlan },
            codeVersion: v.codeVersion,
            previousVersion: latest?.contentHash ?? null,
          },
        }),
      })
    }, '已保存不可覆盖的研究方案版本；实验执行仍需单独审批。')
  }
  return (
    <section aria-label="研究文档">
      <h5>研究文档与版本</h5>
      <Show when={documents.error}>
        <p role="alert">文档暂时无法读取，请刷新后重试。</p>
      </Show>
      <For each={versions()}>
        {(item) => (
          <details>
            <summary>
              {names[item.kind]} · 版本 {item.version} ·{' '}
              {item.verified ? (item.stale ? '需重新核对依据' : '内容已核验') : '内容核验失败'}
            </summary>
            <p>{new Date(item.createdAt).toLocaleString()}</p>
            <Show when={item.document?.question}>
              <p>{item.document?.question}</p>
            </Show>
            <Show when={item.document?.text}>
              <p style={{ 'white-space': 'pre-wrap' }}>{item.document?.text}</p>
            </Show>
            <For each={item.document?.endpoints}>{(text) => <p>评价指标：{text}</p>}</For>
            <For each={item.document?.counterEvidence}>{(text) => <p>反证与局限：{text}</p>}</For>
            <Show when={item.kind === 'skillcandidate'}>
              <p>仅作为待评估候选保存，尚未获准用于执行。</p>
            </Show>
          </details>
        )}
      </For>
      <details>
        <summary>保存研究方案新版本</summary>
        <p>先登记公开文献，再填写研究问题、对照、实验流程与反证。每次保存保留历史版本。</p>
        <For each={fields}>
          {([key, label]) => (
            <label style={{ display: 'block' }}>
              {label}
              <textarea
                value={values()[key] ?? ''}
                onInput={(event) =>
                  setValues((previous) => ({ ...previous, [key]: event.currentTarget.value }))
                }
                disabled={props.busy}
                rows={key === 'protocol' ? 4 : 2}
              />
            </label>
          )}
        </For>
        <fieldset>
          <legend>方案依据</legend>
          <For each={props.campaign.literatureCitations ?? []}>
            {(citation) => (
              <label>
                <input
                  type="checkbox"
                  checked={citations().includes(citation.id)}
                  onChange={(event) =>
                    setCitations((old) =>
                      event.currentTarget.checked
                        ? [...old, citation.id]
                        : old.filter((id) => id !== citation.id),
                    )
                  }
                />
                {citation.title}
              </label>
            )}
          </For>
        </fieldset>
        <button type="button" disabled={props.busy || !ready()} onClick={() => void save()}>
          保存方案版本
        </button>
      </details>
    </section>
  )
}
