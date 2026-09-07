/**
 * CodeMirror 装配。
 *
 * 选 CodeMirror 而不是 Monaco：Monaco 约 5MB 且强依赖 Web Worker，
 * 在 WKWebView（macOS 的 Tauri）里 worker 路径和 CSP 都要额外处理；
 * CodeMirror 6 约 200KB、按语言按需加载、无 worker，行为在三个平台一致。
 *
 * 语言包全部动态导入：一次只会用到一两种，全量打进首屏没有道理。
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentUnit,
  StreamLanguage,
  type StreamParser,
  syntaxHighlighting,
} from '@codemirror/language'
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'

const legacy = (load: () => Promise<StreamParser<unknown>>) => async (): Promise<Extension> =>
  StreamLanguage.define(await load())

/** 扩展名 → 语言包加载器。找不到就用无高亮的纯文本，不报错。 */
const LOADERS: Record<string, () => Promise<Extension>> = {
  ts: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  js: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  mjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  cjs: async () => (await import('@codemirror/lang-javascript')).javascript(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  py: async () => (await import('@codemirror/lang-python')).python(),
  rs: async () => (await import('@codemirror/lang-rust')).rust(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  htm: async () => (await import('@codemirror/lang-html')).html(),
  vue: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-css')).css(),
  md: async () => (await import('@codemirror/lang-markdown')).markdown(),
  mdx: async () => (await import('@codemirror/lang-markdown')).markdown(),
  c: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).c),
  h: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).c),
  cpp: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).cpp),
  hpp: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).cpp),
  java: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).java),
  cs: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).csharp),
  kt: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).kotlin),
  scala: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).scala),
  dart: legacy(async () => (await import('@codemirror/legacy-modes/mode/clike')).dart),
  go: legacy(async () => (await import('@codemirror/legacy-modes/mode/go')).go),
  sh: legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  bash: legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  zsh: legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  ps1: legacy(async () => (await import('@codemirror/legacy-modes/mode/powershell')).powerShell),
  sql: legacy(async () => (await import('@codemirror/legacy-modes/mode/sql')).standardSQL),
  yaml: legacy(async () => (await import('@codemirror/legacy-modes/mode/yaml')).yaml),
  yml: legacy(async () => (await import('@codemirror/legacy-modes/mode/yaml')).yaml),
  toml: legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
  r: legacy(async () => (await import('@codemirror/legacy-modes/mode/r')).r),
  rb: legacy(async () => (await import('@codemirror/legacy-modes/mode/ruby')).ruby),
  lua: legacy(async () => (await import('@codemirror/legacy-modes/mode/lua')).lua),
  swift: legacy(async () => (await import('@codemirror/legacy-modes/mode/swift')).swift),
  hs: legacy(async () => (await import('@codemirror/legacy-modes/mode/haskell')).haskell),
  erl: legacy(async () => (await import('@codemirror/legacy-modes/mode/erlang')).erlang),
  proto: legacy(async () => (await import('@codemirror/legacy-modes/mode/protobuf')).protobuf),
  dockerfile: legacy(
    async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile,
  ),
}

export async function languageFor(path: string): Promise<Extension[]> {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const load = LOADERS[ext]
  if (!load) return []
  try {
    return [await load()]
  } catch {
    // 语言包加载失败只影响高亮，不该让预览整体打不开。
    return []
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript React',
  js: 'JavaScript',
  jsx: 'JavaScript React',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  json: 'JSON',
  py: 'Python',
  rs: 'Rust',
  html: 'HTML',
  htm: 'HTML',
  vue: 'Vue',
  css: 'CSS',
  scss: 'SCSS',
  md: 'Markdown',
  mdx: 'MDX',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  hpp: 'C++',
  java: 'Java',
  cs: 'C#',
  kt: 'Kotlin',
  scala: 'Scala',
  dart: 'Dart',
  go: 'Go',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  r: 'R',
  rb: 'Ruby',
  lua: 'Lua',
  swift: 'Swift',
  hs: 'Haskell',
  erl: 'Erlang',
  proto: 'Protocol Buffers',
  dockerfile: 'Dockerfile',
}

export function languageName(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGE_NAMES[ext] ?? (ext ? ext.toUpperCase() : '纯文本')
}

/**
 * 接近 VS Code 的语义色阶。颜色仍由应用 token 控制，切换明暗主题时不需要维护
 * 第二份 HighlightStyle；没有 parser 的纯文本也会自然退化，不产生错误样式。
 */
const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--code-keyword)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--code-type)' },
  {
    tag: [tags.definition(tags.variableName), tags.function(tags.variableName)],
    color: 'var(--code-function)',
  },
  {
    tag: [tags.variableName, tags.propertyName, tags.attributeName],
    color: 'var(--code-variable)',
  },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  // 中文注释不做伪斜体：系统给 CJK 字形合成倾斜后会发虚、行内基线也不稳。
  { tag: tags.comment, color: 'var(--code-comment)' },
  { tag: tags.meta, color: 'var(--code-comment)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--code-punctuation)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--code-regexp)' },
  { tag: [tags.heading, tags.strong], color: 'var(--code-keyword)', fontWeight: '600' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--danger)', textDecoration: 'underline wavy' },
])

/**
 * 主题。
 *
 * 全部颜色走 CSS 变量，不写死——这样编辑器跟着应用的亮/暗切换走，
 * 不需要维护两份主题，也不会出现「界面暗了但代码区还是白的」。
 */
export const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13.5px',
    backgroundColor: 'var(--code-bg)',
    color: 'var(--text-primary)',
  },
  '.cm-content': {
    fontFamily: 'var(--font-code)',
    fontSynthesis: 'none',
    padding: '8px 0 40px',
    caretColor: 'var(--accent)',
  },
  '.cm-line': { padding: '0 18px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--code-gutter)',
    color: 'var(--text-tertiary)',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '42px',
    padding: '0 10px 0 8px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    width: '16px',
    padding: '0 3px 0 0',
    color: 'var(--text-tertiary)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--code-active-line)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--code-active-line)',
    color: 'var(--text-primary)',
  },
  '.cm-scroller': { lineHeight: '1.65', fontFamily: 'var(--font-code)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--code-selection) !important',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--code-bracket-match)',
    outline: '1px solid var(--accent)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--code-search-match)',
    outline: '1px solid var(--warning)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-panels': {
    backgroundColor: 'var(--bg-raised)',
    color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border-default)',
  },
  '.cm-panel.cm-search': { padding: '6px 10px' },
  '.cm-panel.cm-search input': {
    border: '1px solid var(--border-default)',
    borderRadius: '4px',
    backgroundColor: 'var(--bg-inset)',
    color: 'var(--text-primary)',
  },
  '.cm-panel.cm-search button': {
    border: '1px solid var(--border-default)',
    borderRadius: '4px',
    backgroundColor: 'var(--bg-raised)',
    color: 'var(--text-secondary)',
  },
})

export interface EditorPosition {
  line: number
  column: number
}

export function showEditorSearch(view: EditorView | null): void {
  if (view) openSearchPanel(view)
}

export interface CodeEditorOptions {
  editable?: boolean | undefined
  onPosition?: ((position: EditorPosition) => void) | undefined
  onChange?: ((content: string) => void) | undefined
  onSave?: (() => void) | undefined
}

export async function createCodeEditor(
  parent: HTMLElement,
  doc: string,
  path: string,
  options: CodeEditorOptions = {},
): Promise<EditorView> {
  const lang = await languageFor(path)
  const editable = options.editable ?? false
  const positionListener = EditorView.updateListener.of((update) => {
    if (!update.selectionSet && !update.docChanged) return
    const head = update.state.selection.main.head
    const line = update.state.doc.lineAt(head)
    options.onPosition?.({ line: line.number, column: head - line.from + 1 })
    if (update.docChanged) options.onChange?.(update.state.doc.toString())
  })
  const saveKeymap = {
    key: 'Mod-s',
    run: () => {
      options.onSave?.()
      return true
    },
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        highlightSpecialChars(),
        drawSelection(),
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        ...(editable ? [history()] : []),
        search({ top: true }),
        keymap.of([
          saveKeymap,
          ...searchKeymap,
          ...(editable ? [...defaultKeymap, ...historyKeymap, indentWithTab] : []),
        ]),
        syntaxHighlighting(codeHighlightStyle),
        EditorState.tabSize.of(2),
        indentUnit.of('  '),
        EditorView.contentAttributes.of({
          'aria-label': editable ? `代码编辑器：${path}` : `只读代码：${path}`,
          autocapitalize: 'off',
          autocomplete: 'off',
          spellcheck: 'false',
        }),
        positionListener,
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
        theme,
        ...lang,
      ],
    }),
  })
  options.onPosition?.({ line: 1, column: 1 })
  return view
}
