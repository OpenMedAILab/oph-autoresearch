import { createResource, For, Show } from 'solid-js'
import { client } from '../lib/store/index.ts'

type Experiment = {
  trainingSamples: number
  testSamples: number
  models: Array<{
    id: string
    metrics: { accuracy: number; logLoss: number }
    trainingLoss: { first: number; last: number } | null
  }>
}
export function ResearchExperimentResult(props: {
  campaignId: string
  workspaceId: string
  attemptId: string
}) {
  const [receipt] = createResource(
    () => `${props.campaignId}:${props.attemptId}`,
    async () =>
      client.api<{ experiment?: Experiment }>(
        `/api/research/campaigns/${props.campaignId}/synthetic/receipt?ws=${encodeURIComponent(props.workspaceId)}&attemptId=${encodeURIComponent(props.attemptId)}`,
      ),
  )
  return (
    <section aria-label="实验指标对比">
      <Show when={receipt.error}>
        <p role="alert">回执无法核验，请核对产物完整性与版本。</p>
      </Show>
      <Show when={receipt()?.experiment}>
        {(experiment) => (
          <>
            <h5>合成图像实验结果</h5>
            <p>
              训练 {experiment().trainingSamples} 张 · 独立测试 {experiment().testSamples} 张 ·
              固定阈值 0.5
            </p>
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>准确率</th>
                  <th>对数损失</th>
                  <th>训练损失</th>
                </tr>
              </thead>
              <tbody>
                <For each={experiment().models}>
                  {(model) => (
                    <tr>
                      <td>
                        {model.id === 'training-prevalence'
                          ? '训练集比例基线'
                          : '逻辑回归（梯度拟合）'}
                      </td>
                      <td>{(model.metrics.accuracy * 100).toFixed(1)}%</td>
                      <td>{model.metrics.logLoss.toFixed(4)}</td>
                      <td>
                        {model.trainingLoss
                          ? `${model.trainingLoss.first.toFixed(4)} → ${model.trainingLoss.last.toFixed(4)}`
                          : '不适用'}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <p>
              已通过确定性训练重放与指标复算。独立科研复核与结论发布另行审批；此处不表示临床性能。
            </p>
          </>
        )}
      </Show>
    </section>
  )
}
