import { type WorkflowProjection, workflowCheckpointDetails } from '@oph-autoresearch/core'
import { createEffect, createSignal, createUniqueId, For, Show } from 'solid-js'
import { client, explainApiError, isRunning, state } from '../lib/store/index.ts'

export function WorkflowDecision(props: { workflow: WorkflowProjection; checkpointId: string }) {
  const [editing, setEditing] = createSignal(false)
  const [note, setNote] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal('')
  const noteId = createUniqueId()
  const details = () =>
    workflowCheckpointDetails(props.workflow.nodes, props.workflow.results, props.checkpointId)
  createEffect(() => {
    props.workflow.reviewStepId
    setBusy(false)
    setEditing(false)
    setResult('')
  })
  const submit = async (decision: 'approve' | 'revise') => {
    if (busy() || !state.activeConversation || !props.workflow.reviewStepId) return
    setBusy(true)
    setResult('')
    try {
      await client.api('/api/commands', {
        method: 'POST',
        body: JSON.stringify({
          type: 'workflow.review',
          conversationId: state.activeConversation,
          workflowId: props.workflow.workflowId,
          checkpointId: props.checkpointId,
          expectedStepId: props.workflow.reviewStepId,
          decision,
          note: note(),
        }),
      })
      setResult('已提交')
      setEditing(false)
    } catch (error) {
      setResult(explainApiError(error, '决策提交失败'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="wf-decision">
      <Show when={details().checks.length}>
        <ul class="wf-checks" aria-label="核验清单">
          <For each={details().checks}>{(check) => <li>{check}</li>}</For>
        </ul>
      </Show>
      <For each={details().analyses}>
        {(analysis) => (
          <div class="wf-analysis">
            <strong>
              分析建议：
              {({ accept: '接受', iterate: '迭代', stop: '停止' } as Record<string, string>)[
                analysis.decision
              ] ?? analysis.decision}
            </strong>
            <p>{analysis.summary}</p>
            <Show when={analysis.nextExperiment}>
              <p>下一步：{analysis.nextExperiment}</p>
            </Show>
          </div>
        )}
      </For>
      <div class="wf-decision-actions">
        <button
          type="button"
          class="btn-primary"
          disabled={busy() || isRunning()}
          on:click={() => void submit('approve')}
        >
          {busy() ? '提交中…' : '批准'}
        </button>
        <button
          type="button"
          class="btn-secondary"
          disabled={busy() || isRunning()}
          aria-expanded={editing()}
          on:click={() => setEditing(!editing())}
        >
          返工
        </button>
      </div>
      <Show when={editing()}>
        <label for={noteId}>返工意见</label>
        <textarea
          id={noteId}
          value={note()}
          on:input={(event) => setNote(event.currentTarget.value)}
        />
        <button
          type="button"
          class="btn-secondary"
          disabled={busy() || !note().trim() || isRunning()}
          on:click={() => void submit('revise')}
        >
          提交返工
        </button>
      </Show>
      <Show when={result()}>
        <output>{result()}</output>
      </Show>
    </div>
  )
}
