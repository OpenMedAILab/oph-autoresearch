import type { ResearchCampaign } from '@oph-autoresearch/core'
import { createResource, createSignal, For, Show } from 'solid-js'
import { client } from '../lib/store/index.ts'

interface PatternState {
  nextAction: string
  taskRevisionId: string | null
  dispatchKey: string | null
  stages: Array<{ stageId: string; status: string; evidence: string }>
  candidateAssessments: Array<{ reportHash: string; decision: string }>
}
export function ResearchPatternPanel(props: {
  campaign: ResearchCampaign
  busy: boolean
  act: (work: () => Promise<void>, message: string) => Promise<void>
}) {
  const [dataMode, setDataMode] = createSignal('features')
  const [backend, setBackend] = createSignal('builtin-local')
  const [devices] = createResource(
    () =>
      backend() === 'ssh-daemon' || props.campaign.pattern?.plan.backend === 'ssh-daemon'
        ? props.campaign.workspaceId
        : undefined,
    async (workspaceId) =>
      client.api<{
        observations: Array<{ id: string; availableSlots: number; backendPolicyHash: string }>
        selected: { id: string } | null
      }>(`/api/research/execution-devices?ws=${encodeURIComponent(workspaceId)}`),
  )
  const endpoint = () =>
    `/api/research/campaigns/${props.campaign.id}/pattern?ws=${encodeURIComponent(props.campaign.workspaceId)}`
  const [state] = createResource(
    () => (props.campaign.pattern ? `${props.campaign.id}:${props.campaign.version}` : undefined),
    async () => (await client.api<{ state: PatternState }>(endpoint())).state,
  )
  const approval = () =>
    props.campaign.approvals.find(
      (a) =>
        a.status === 'active' &&
        !a.consumedBy &&
        a.bundleHash === props.campaign.bundleHash &&
        a.scope?.kind === 'execution' &&
        a.scope.expiresAt > Date.now() &&
        a.scope.taskRevisionId === state()?.taskRevisionId &&
        a.scope.dispatchKey === state()?.dispatchKey,
    )
  let key = crypto.randomUUID()
  const apply = () =>
    props.act(async () => {
      await client.api(endpoint(), {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: props.campaign.version,
          idempotencyKey: key,
          pattern: {
            dataMode: dataMode(),
            backend: backend(),
            policy: {
              syntheticOnly: true,
              allowPublicMetadata: true,
              maxModelRequests: 2,
              currency: props.campaign.budget.currency,
              budget: props.campaign.budget.limit,
            },
            adaptive: { minSensitivity: 0.5, minSpecificity: 0.5, maxAuRocCIWidth: 1 },
          },
        }),
      })
      key = crypto.randomUUID()
    }, '固定研究方案及任务已保存；执行需另行审批。')
  const advance = () =>
    props.act(async () => {
      await client.api(endpoint().replace('/pattern?', '/pattern/advance?'), {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: props.campaign.version,
          approvalId: approval()?.id,
        }),
      })
    }, '已提交一个获批步骤，请以核验后的产物为准。')
  return (
    <section aria-label="固定研究方案">
      <h5>固定研究方案</h5>
      <Show when={!props.campaign.pattern || state()?.nextAction === 'replan-required'}>
        <label for={`pattern-data-${props.campaign.id}`}>合成数据类型</label>
        <select
          id={`pattern-data-${props.campaign.id}`}
          value={dataMode()}
          disabled={props.busy}
          onChange={(e) => setDataMode(e.currentTarget.value)}
        >
          <option value="scores">合成评分</option>
          <option value="auto">合成策略验收（按预检条件筛选）</option>
          <option value="features">合成特征</option>
          <option value="retinal-images">合成灰度图像</option>
        </select>
        <label for={`pattern-backend-${props.campaign.id}`}>执行位置</label>
        <select
          id={`pattern-backend-${props.campaign.id}`}
          value={backend()}
          disabled={props.busy}
          onChange={(e) => setBackend(e.currentTarget.value)}
        >
          <option value="builtin-local">内置本地</option>
          <option value="localhost-daemon">已配置的本机守护进程</option>
          <option value="ssh-daemon">已配置的 SSH 远端设备</option>
        </select>
        <p>
          固定样例预检：敏感度与特异度至少 0.5，AUROC 置信区间宽度不超过
          1。预算使用当前研究设置。第三方技能的静态审查不授予执行权限。
        </p>
        <button type="button" disabled={props.busy} onClick={() => void apply()}>
          保存固定研究方案
        </button>
      </Show>
      <Show when={devices()}>
        {(quote) => (
          <section aria-label="远端资源报价">
            <p>
              可用设备建议：{quote().selected ? '已有可用执行设备' : '暂无可用设备'}
              。报价不预留资源；执行审批绑定所选设备，提交后不会自动改派。
            </p>
            <For each={quote().observations}>
              {(device) => <p>执行设备 · 空闲执行槽 {device.availableSlots}/1</p>}
            </For>
          </section>
        )}
      </Show>
      <Show when={state()}>
        {(current) => (
          <>
            <p>下一步：{current().nextAction}</p>
            <ol>
              <For each={current().stages}>
                {(stage) => (
                  <li>
                    {stage.stageId} · {stage.status}
                    <p>{stage.evidence}</p>
                  </li>
                )}
              </For>
            </ol>
            <Show when={current().nextAction === 'approved-fixed-execution'}>
              <p>每次只运行一个固定步骤；需要与当前任务和研究包匹配的有效审批。</p>
              <button
                type="button"
                disabled={props.busy || !approval()}
                onClick={() => void advance()}
              >
                执行已审批的下一步
              </button>
            </Show>
            <details>
              <summary>候选技能审查记录（未准入）</summary>
              <For each={current().candidateAssessments}>
                {(report) => (
                  <p>
                    {report.decision === 'supported'
                      ? '证据支持'
                      : report.decision === 'accepted'
                        ? '通过'
                        : '需要复核'}
                  </p>
                )}
              </For>
            </details>
          </>
        )}
      </Show>
      <Show when={state.error}>
        <output>方案状态读取失败，请刷新重试。</output>
      </Show>
    </section>
  )
}
