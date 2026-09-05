/**
 * PDF 分页渲染预览。
 *
 * 为什么不用 iframe 交给系统阅读器：WebView2 没有内建 PDF 渲染，iframe 里放
 * data URI 是整页空白；WKWebView 有内建渲染，两端行为分叉。这里用 pdf.js 统一
 * 成同一套画布渲染，哪个外壳里都一样。
 *
 * **pdf.js 主体按需加载。** worker 的路径由 vite 编译期标成资源 URL，主代码走
 * `await import('pdfjs-dist')` 单独成一个 chunk——只有真的打开 PDF 才会拉它。
 */

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'

/** 最多画这么多页：论文正文不会超过，巨型扫描件只给开头并明说。 */
const MAX_PAGES = 300

export function PdfPreview(props: { dataUri: string; title: string }) {
  const [note, setNote] = createSignal<string | null>(null)
  const [pageCount, setPageCount] = createSignal(0)
  const [rendered, setRendered] = createSignal(0)
  const [tick, setTick] = createSignal(0)
  let host!: HTMLDivElement
  let generation = 0
  let activeTask: { destroy: () => Promise<void> } | null = null

  onMount(() => {
    // 窗口变宽变窄要按新宽度重排页宽。debounce 一下：resize 会连着来几十个。
    let timer: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setTick((n) => n + 1), 180)
    }
    window.addEventListener('resize', onResize)
    onCleanup(() => {
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    })
  })

  createEffect(() => {
    const uri = props.dataUri
    tick()
    const mine = ++generation
    setNote(null)
    setRendered(0)
    host.replaceChildren()

    void (async () => {
      const pdfjs = await import('pdfjs-dist')
      if (mine !== generation) return
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

      const comma = uri.indexOf(',')
      if (comma < 0) throw new Error('PDF 数据无效')
      const bytes = Uint8Array.from(atob(uri.slice(comma + 1)), (c) => c.charCodeAt(0))

      const task = pdfjs.getDocument({ data: bytes })
      const doc = await task.promise
      if (mine !== generation) {
        void task.destroy()
        return
      }
      void activeTask?.destroy()
      activeTask = task
      setPageCount(doc.numPages)
      if (doc.numPages > MAX_PAGES) setNote(`文档共 ${doc.numPages} 页，只渲染前 ${MAX_PAGES} 页`)

      const pages = Math.min(doc.numPages, MAX_PAGES)
      // 页宽跟着容器走；容器还在布局中时取个能用的下限。
      const fit = Math.max(240, host.clientWidth - 56)
      for (let i = 1; i <= pages; i++) {
        if (mine !== generation) return
        const page = await doc.getPage(i)
        const viewport = page.getViewport({ scale: fit / page.getViewport({ scale: 1 }).width })
        // 高分屏提采样让文字清晰，CSS 尺寸仍是 1x——画布像素加倍即可。
        const outputScale = Math.min(window.devicePixelRatio || 1, 2)
        const canvas = document.createElement('canvas')
        canvas.className = 'pdf-page'
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        host.append(canvas)
        await page.render({
          canvas,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        }).promise
        if (mine !== generation) return
        setRendered(i)
      }
    })().catch((error) => {
      if (mine !== generation) return
      const message = error instanceof Error ? error.message : String(error)
      setNote(
        error?.name === 'PasswordException'
          ? 'PDF 有密码保护，暂不支持内联预览'
          : `PDF 解析失败：${message}`,
      )
    })
  })

  onCleanup(() => {
    void activeTask?.destroy()
  })

  return (
    <div class="pdf-preview">
      <div class="pdf-preview-head">
        <span class="truncate" data-tip={props.title}>
          {props.title}
        </span>
        <Show when={pageCount() > 0}>
          <span class="pdf-preview-count">
            {rendered()} / {pageCount()} 页
          </span>
        </Show>
      </div>
      <div class="pdf-preview-pages" ref={host} />
      <Show when={note()}>{(n) => <div class="pdf-preview-note">{n()}</div>}</Show>
    </div>
  )
}
