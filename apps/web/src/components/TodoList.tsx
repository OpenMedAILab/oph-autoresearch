import type { TodoItem } from '@oph-autoresearch/core'
import { For, Show } from 'solid-js'
import { IconCheck, IconSpinner } from './Icons.tsx'

/**
 * 一份待办清单的行渲染。**三种状态各有各的记号**：勾（做完）、转圈（正在做）、
 * 空心点（还没开始）——光看文字分不出来，而「哪条做完了」正是这块地方要回答的。
 *
 * 独立成件是因为有**两个挂载点**：会话流里的 `write_todos` 工具卡，以及子会话
 * 详情。工具卡若落进通用参数表就只剩一行 JSON，状态会埋在引号里。
 *
 * **清单由调用方传进来，不读 store。** 会话流里那张卡要显示的是**那一次**提交的
 * 那一份，读全局当前清单会让历史的每一张卡都显示成最新状态。
 */
export function TodoList(props: { todos: readonly TodoItem[] }) {
  return (
    <ol class="todo-list">
      <For each={props.todos}>
        {(t) => (
          <li
            class="todo-item"
            classList={{ done: t.status === 'completed', now: t.status === 'in_progress' }}
          >
            <span class="todo-mark">
              <Show
                when={t.status !== 'pending'}
                fallback={<span class="todo-dot" aria-hidden="true" />}
              >
                <Show when={t.status === 'completed'} fallback={<IconSpinner size={12} />}>
                  <IconCheck size={12} />
                </Show>
              </Show>
            </span>
            <span class="todo-text">{t.content}</span>
          </li>
        )}
      </For>
    </ol>
  )
}
