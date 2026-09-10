import { Show } from 'solid-js'
import { openSettings, settingsPage } from '../../lib/store/index.ts'
import { modelSetupRequired } from './configStore.ts'

/** 配置尚未完成时，首页与设置页共用同一个模型设置入口。 */
export function ModelSetupNotice() {
  return (
    <Show when={modelSetupRequired()}>
      <section class="model-setup-notice" aria-label="模型配置引导">
        <div>
          <strong>开始前，请先配置模型</strong>
          <p>选择模型服务并填写 API Key。</p>
        </div>
        <Show when={settingsPage() !== 'models'}>
          <button
            class="btn-primary model-setup-action"
            type="button"
            onClick={() => openSettings('models')}
          >
            配置模型
          </button>
        </Show>
      </section>
    </Show>
  )
}
