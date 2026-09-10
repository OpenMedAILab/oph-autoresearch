import { For, Show } from 'solid-js'
import { renderMarkdown } from '../../lib/markdown.ts'
import { configNotices, configProblems, configWriteError } from './configStore.ts'
import { ModelSetupNotice } from './ModelSetupNotice.tsx'

/**
 * 展示服务端的配置引导、配置诊断与能力提醒；保存失败单独保留。
 * 诊断和提醒包含 markdown，必须保留列表与代码的层级。
 */
export function ConfigStatus() {
  return (
    <>
      <ModelSetupNotice />
      <Show when={configWriteError()}>{(msg) => <div class="settings-error">{msg()}</div>}</Show>
      <Show when={configProblems().length}>
        <div class="settings-notices bad">
          <For each={configProblems()}>
            {(p) => <div class="markdown" innerHTML={renderMarkdown(p)} />}
          </For>
        </div>
      </Show>
      <Show when={configNotices().length}>
        <div class="settings-notices">
          <For each={configNotices()}>
            {(n) => <div class="markdown" innerHTML={renderMarkdown(n)} />}
          </For>
        </div>
      </Show>
    </>
  )
}
