/**
 * 文件浏览与预览。
 *
 * 「兼容所有格式」（需求 8）的实现策略是**分类而非穷举**：把文件归到几个渲染族
 * （文本/图片/PDF/音视频/表格/归档/二进制），每族一种渲染器，具体扩展名只影响
 * 语法高亮语言的选择。插件可以注册新的族或覆盖某扩展名的族——穷举扩展名的表
 * 永远追不上现实，而族是有限的。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { IGNORED_DIRS } from '@oph-autoresearch/tools'
import JSZip from 'jszip'

export type PreviewKind =
  | 'text'
  | 'markdown'
  | 'html'
  | 'office'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'tabular'
  | 'archive'
  | 'binary'

export interface FileNode {
  name: string
  path: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  contentHash?: string
  /** 目录才有；懒加载，未展开时为 undefined。 */
  children?: FileNode[]
}

export interface PreviewResult {
  path: string
  kind: PreviewKind
  mime: string
  size: number
  /** 供编辑保存时做并发冲突检查。 */
  mtime: number
  contentHash?: string
  /** 文本族才有。 */
  content?: string
  /** 语法高亮语言标识。 */
  language?: string
  /** 二进制族用 data URI 回传（有大小上限）。 */
  dataUri?: string
  truncated: boolean
  /** 无法内联时给出的说明，UI 直接显示。 */
  note?: string
}

/** 文本预览上限。超过就截断——把 5MB 的日志塞进浏览器只会把标签页卡死。 */
const MAX_TEXT_BYTES = 512 * 1024
/** 内联二进制上限（data URI 会膨胀约 1.37 倍）。 */
const MAX_INLINE_BYTES = 4 * 1024 * 1024
/** PDF 单独一档上限：论文、报告动辄十几 MB，而前端渲染是分页按需的。 */
const MAX_INLINE_PDF_BYTES = 32 * 1024 * 1024
/** Office OOXML 在本机解包渲染；限制原始压缩包，避免巨型文档耗尽内存。 */
export const MAX_OFFICE_BYTES = 32 * 1024 * 1024

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.env': 'bash',
  '.dockerfile': 'dockerfile',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.zig': 'zig',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
}

const EXT_KIND: Record<string, PreviewKind> = {
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.avif': 'image',
  '.svg': 'text', // SVG 既是图片也是文本；给文本以便直接编辑，UI 侧再叠加渲染
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.csv': 'tabular',
  '.tsv': 'tabular',
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.xz': 'archive',
  '.whl': 'archive',
  '.jar': 'archive',
  '.docx': 'office',
  '.pptx': 'office',
  '.xlsx': 'office',
  '.doc': 'office',
  '.ppt': 'office',
  '.xls': 'office',
  '.ods': 'tabular',
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

export function classify(path: string): { kind: PreviewKind; mime: string; language?: string } {
  const ext = extname(path).toLowerCase()
  const kind = EXT_KIND[ext] ?? 'text'
  const mime = EXT_MIME[ext] ?? (kind === 'text' ? 'text/plain' : 'application/octet-stream')
  const language = EXT_LANGUAGE[ext]
  return { kind, mime, ...(language ? { language } : {}) }
}

/**
 * 界面文件树。**磁盘上有什么就列什么，一条都不过滤。**
 *
 * 不跳 `node_modules` / `.git` / 构建产物，也不跳点开头的条目。这棵树是用户
 * 自己的文件浏览器，回答的问题是「工作区里有什么」——按名字藏掉一部分，
 * 界面上等同于它不存在，而 `preview` 照样读得到、模型照样改得到。
 *
 * 模型侧的 `list_dir` / `glob` / `grep` **仍然**按 `IGNORED_DIRS` 跳噪音目录，
 * 那是 token 预算，不是「这个目录不存在」。两边不一致的方向只允许是这一个：
 * **界面比模型看得多**。反过来（界面藏、模型列）用户就没法核对模型说的话。
 *
 * 按 depth 懒展开，所以列全不等于一次遍历整棵树：`node_modules` 也只有点开
 * 才会往里走一层。
 */
export async function listTree(
  workspaceRoot: string,
  relPath: string,
  depth: number,
): Promise<FileNode[]> {
  const abs = join(workspaceRoot, relPath)
  return walk(abs, workspaceRoot, depth)
}

async function walk(dir: string, root: string, depth: number): Promise<FileNode[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: FileNode[] = []

  for (const e of entries) {
    const abs = join(dir, e.name)
    const info = await stat(abs).catch(() => null)
    if (!info) continue

    const node: FileNode = {
      name: e.name,
      path: toPosix(relative(root, abs)),
      kind: e.isDirectory() ? 'dir' : 'file',
      size: info.size,
      mtime: info.mtimeMs,
    }
    if (e.isDirectory() && depth > 1) {
      node.children = await walk(abs, root, depth - 1)
    }
    out.push(node)
  }

  // 目录在前，同类按名排。和资源管理器/编辑器的直觉一致。
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
  return out
}

/** 目标已存在。调用方要把它翻成 409——**不覆盖**是这条接口的硬口径。 */
export class EntryExistsError extends Error {
  constructor(readonly relPath: string) {
    super(`${relPath} 已存在`)
    this.name = 'EntryExistsError'
  }
}

/** 文件在编辑期间被别的进程改过。覆盖它会丢掉别人的修改。 */
export class FileChangedError extends Error {
  constructor(readonly relPath: string) {
    super(`${relPath} 已在磁盘上发生变化，请重新打开后再编辑`)
    this.name = 'FileChangedError'
  }
}

/** 代码编辑器允许保存的上限。和预览上限一致，避免只加载到半份却覆盖整份文件。 */
const MAX_EDIT_BYTES = MAX_TEXT_BYTES

const pendingTextWrites = new Map<string, Promise<void>>()
const contentHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Compare byte identity, serialize app writers, then replace atomically. External writers
 * do not participate in this lock: this is not a filesystem compare-and-swap guarantee. */
export async function writeTextEntry(
  workspaceRoot: string,
  relPath: string,
  content: string,
  expectedContentHash: string,
): Promise<FileNode> {
  if (!/^[a-f0-9]{64}$/.test(expectedContentHash ?? '')) {
    throw new FileChangedError(relPath)
  }
  const abs = await realpath(join(workspaceRoot, relPath))
  const prior = pendingTextWrites.get(abs) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingTextWrites.set(abs, pending)
  await prior
  let temporary: string | undefined
  try {
    const before = await stat(abs)
    if (!before.isFile()) throw new Error(`${relPath} 不是文件`)
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_EDIT_BYTES) {
      throw new RangeError(`文件超过 ${formatBytes(MAX_EDIT_BYTES)}，不能在内置编辑器中保存`)
    }
    const assertCurrent = async () => {
      if (
        (await stat(abs)).size > MAX_EDIT_BYTES ||
        contentHash(await readFile(abs)) !== expectedContentHash
      ) {
        throw new FileChangedError(relPath)
      }
    }
    await assertCurrent()
    temporary = join(dirname(abs), `.oph-edit-${randomUUID()}.tmp`)
    await writeFile(temporary, bytes, { flag: 'wx', mode: before.mode & 0o777 })
    await assertCurrent()
    await rename(temporary, abs)
    temporary = undefined
    const after = await stat(abs)
    return {
      name: basename(abs),
      path: toPosix(relPath),
      kind: 'file',
      size: bytes.length,
      mtime: after.mtimeMs,
      contentHash: contentHash(bytes),
    }
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
    release()
    if (pendingTextWrites.get(abs) === pending) pendingTextWrites.delete(abs)
  }
}

/**
 * 复制文件或目录。默认复制到同一层，并生成不会覆盖现有条目的名字。
 * 指定目标目录时也沿用这一口径，连续复制得到 `name copy 2.ext`。
 */
export async function copyEntry(
  workspaceRoot: string,
  relPath: string,
  destinationDir = toPosix(dirname(relPath)),
): Promise<FileNode> {
  const source = join(workspaceRoot, relPath)
  const info = await stat(source)
  const targetDir = join(workspaceRoot, destinationDir === '.' ? '' : destinationDir)
  if (!(await stat(targetDir)).isDirectory()) throw new Error(`${destinationDir} 不是文件夹`)

  const target = await availableCopyPath(targetDir, basename(source), info.isDirectory())
  await cp(source, target, { recursive: info.isDirectory(), errorOnExist: true, force: false })
  const copied = await stat(target)
  return {
    name: basename(target),
    path: toPosix(relative(workspaceRoot, target)),
    kind: copied.isDirectory() ? 'dir' : 'file',
    size: copied.size,
    mtime: copied.mtimeMs,
  }
}

/** 把条目移动到一个已经存在的工作区目录中，保留原文件名且从不覆盖。 */
export async function moveEntry(
  workspaceRoot: string,
  relPath: string,
  destinationDir: string,
): Promise<FileNode> {
  const source = join(workspaceRoot, relPath)
  const sourceInfo = await stat(source)
  const targetDir = join(workspaceRoot, destinationDir === '.' ? '' : destinationDir)
  if (!(await stat(targetDir)).isDirectory()) throw new Error(`${destinationDir} 不是文件夹`)

  if (sourceInfo.isDirectory()) {
    const childPath = relative(source, targetDir)
    if (childPath === '' || (!childPath.startsWith(`..${sep}`) && childPath !== '..')) {
      throw new Error('不能把文件夹移动到它自己里面')
    }
  }

  const target = join(targetDir, basename(source))
  if (await stat(target).catch(() => null))
    throw new EntryExistsError(toPosix(relative(workspaceRoot, target)))
  await rename(source, target)
  const moved = await stat(target)
  return {
    name: basename(target),
    path: toPosix(relative(workspaceRoot, target)),
    kind: moved.isDirectory() ? 'dir' : 'file',
    size: moved.size,
    mtime: moved.mtimeMs,
  }
}

async function availableCopyPath(
  dir: string,
  original: string,
  directory: boolean,
): Promise<string> {
  const ext = directory ? '' : extname(original)
  const stem = directory ? original : original.slice(0, Math.max(0, original.length - ext.length))
  for (let index = 1; index < 10_000; index++) {
    const suffix = index === 1 ? ' copy' : ` copy ${index}`
    const candidate = join(dir, `${stem}${suffix}${ext}`)
    if (!(await stat(candidate).catch(() => null))) return candidate
  }
  throw new Error(`${original} 的副本名称已经用完`)
}

/**
 * 新建文件或目录。空文件、空目录，不带模板。
 *
 * 先判存在再落盘：`mkdir` 的 `recursive` 对已存在的目录**静默成功**，靠它兜底
 * 等于「新建」和「什么都没做」给出同一个回音。文件那一支再叠一个 `wx`，
 * 挡住判定与写入之间被人抢先建出来的那一瞬。
 *
 * 中间目录一并建出来（`docs/a/b.md` 里的 `docs/a`）：这是用户在输入框里
 * 打出来的路径，缺一层就报错等于让他一层一层建。
 */
export async function createEntry(
  workspaceRoot: string,
  relPath: string,
  kind: 'file' | 'dir',
): Promise<FileNode> {
  const abs = join(workspaceRoot, relPath)
  const taken = await stat(abs).catch(() => null)
  if (taken) throw new EntryExistsError(relPath)

  if (kind === 'dir') await mkdir(abs, { recursive: true })
  else {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, '', { flag: 'wx' })
  }

  const info = await stat(abs)
  return {
    name: basename(abs),
    path: toPosix(relPath),
    kind,
    size: info.size,
    mtime: info.mtimeMs,
  }
}

/**
 * 改名。**只换名字，不搬家**——目标恒定是同一个父目录下的另一个名字。
 *
 * 名字合法性由调用方先判（不能带分隔符、不能是 `.` / `..`）：那是入参校验，
 * 属于边界那一层。这里只管「新名字已经被占了」这一件事，和 `createEntry` 同一个口径。
 */
export async function renameEntry(
  workspaceRoot: string,
  relPath: string,
  name: string,
): Promise<FileNode> {
  const abs = join(workspaceRoot, relPath)
  const nextRel = toPosix(join(dirname(relPath), name))
  const nextAbs = join(workspaceRoot, nextRel)

  const taken = await stat(nextAbs).catch(() => null)
  // 同一个名字改成同一个名字：Windows 上不区分大小写，`a.ts` → `A.ts` 会被
  // 判成「已存在」而拒掉，所以只有真的换了目标才算冲突。
  if (taken && nextAbs !== abs) throw new EntryExistsError(nextRel)

  await rename(abs, nextAbs)
  const info = await stat(nextAbs)
  return {
    name,
    path: nextRel,
    kind: info.isDirectory() ? 'dir' : 'file',
    size: info.size,
    mtime: info.mtimeMs,
  }
}

/**
 * 删除。目录连着里面一起删。
 *
 * `force: false` 是有意的：不存在时要抛，让上面回 404。`force: true` 会把
 * 「删掉了」和「本来就没有」说成同一句话，而用户点的是删除，他需要知道有没有删掉。
 */
export async function deleteEntry(workspaceRoot: string, relPath: string): Promise<void> {
  await rm(join(workspaceRoot, relPath), { recursive: true, force: false })
}

export interface FindHit {
  path: string
  kind: 'file' | 'dir'
}

/** 一次搜索最多回这么多命中，以及最多翻这么多条目。两个上限都到了就算截断。 */
const FIND_MAX_HITS = 300
const FIND_MAX_ENTRIES = 20_000

/**
 * 按名字找文件。子串匹配，大小写不敏感。
 *
 * **这里跳 `IGNORED_DIRS`，和文件树不一样**，理由是搜得到才有用：树不过滤，
 * 因此工作区第一层就有 `node_modules`；按字典序铺开的话遍历预算会在依赖树里
 * 烧光，用户搜 `launch` 一个命中都拿不到。界面必须把这条边界说出来
 * （空结果那一行），否则空结果读起来就是文件不存在。
 *
 * 广度优先：浅的先出来。用户要找的文件通常在前两三层，而深处那些同名文件
 * 排在前面等于把结果列表占满。
 *
 * 只 `readdir` 不 `stat`：命中列表不显示大小与时间，为两万条各取一次元数据
 * 是白花的几百毫秒。
 */
export async function findByName(
  workspaceRoot: string,
  query: string,
): Promise<{ matches: FindHit[]; truncated: boolean }> {
  // 空查询回空结果，**判定放在这里而不是调用方**：空串是「谁都匹配」，
  // 由 HTTP 那层挡的话，第二个调用方一来就会拿到整棵树。
  const needle = query.trim().toLowerCase()
  if (!needle) return { matches: [], truncated: false }

  const matches: FindHit[] = []
  let scanned = 0
  let truncated = false
  const queue: string[] = [workspaceRoot]

  while (queue.length > 0) {
    const dir = queue.shift()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (matches.length >= FIND_MAX_HITS || scanned >= FIND_MAX_ENTRIES) {
        truncated = true
        return { matches, truncated }
      }
      scanned++
      const abs = join(dir, e.name)
      if (e.name.toLowerCase().includes(needle)) {
        matches.push({
          path: toPosix(relative(workspaceRoot, abs)),
          kind: e.isDirectory() ? 'dir' : 'file',
        })
      }
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) queue.push(abs)
    }
  }
  return { matches, truncated }
}

export async function preview(workspaceRoot: string, relPath: string): Promise<PreviewResult> {
  const abs = join(workspaceRoot, relPath)
  const info = await stat(abs)
  const { kind, mime, language } = classify(relPath)

  const base = {
    path: toPosix(relPath),
    kind,
    mime,
    size: info.size,
    mtime: info.mtimeMs,
    truncated: false,
    ...(language ? { language } : {}),
  }

  if (kind === 'text' || kind === 'markdown' || kind === 'html' || kind === 'tabular') {
    // 表格族里 csv/tsv 是文本，xlsx 不是——按实际能否解码决定走哪条路。
    const buf = await readFile(abs)
    const slice = buf.subarray(0, MAX_TEXT_BYTES)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    if (looksBinary(text)) {
      return { ...base, kind: 'binary', truncated: false, note: '二进制内容，无法以文本预览' }
    }
    return {
      ...base,
      content: text,
      ...(buf.length <= MAX_TEXT_BYTES ? { contentHash: contentHash(buf) } : {}),
      truncated: buf.length > MAX_TEXT_BYTES,
    }
  }

  if (kind === 'office') {
    const ext = extname(relPath).toLowerCase()
    if (!['.docx', '.pptx', '.xlsx'].includes(ext)) {
      return {
        ...base,
        truncated: false,
        note: '旧版 Office 二进制格式暂不支持内联预览，请另存为 docx、pptx 或 xlsx',
      }
    }
    if (info.size > MAX_OFFICE_BYTES) {
      return {
        ...base,
        truncated: true,
        note: `文件 ${formatBytes(info.size)}，超出 Office 本地预览上限`,
      }
    }
    const buf = await readFile(abs)
    try {
      return { ...base, content: await renderOffice(buf, ext) }
    } catch (error) {
      return {
        ...base,
        kind: 'binary',
        note: `Office 文档解析失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  if (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video') {
    const cap = kind === 'pdf' ? MAX_INLINE_PDF_BYTES : MAX_INLINE_BYTES
    if (info.size > cap) {
      return {
        ...base,
        truncated: true,
        note: `文件 ${formatBytes(info.size)}，超出内联上限，请在本地打开`,
      }
    }
    const buf = await readFile(abs)
    return { ...base, dataUri: `data:${mime};base64,${buf.toString('base64')}` }
  }

  return { ...base, note: kind === 'archive' ? '归档文件' : '二进制文件' }
}

/** 把 OOXML（docx/xlsx/pptx）字节渲染成预览 HTML。SSH 远程预览与本地预览共用同一份。 */
export async function renderOffice(bytes: Buffer, ext: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  if (ext === '.docx') return renderDocx(zip)
  if (ext === '.pptx') return renderPptx(zip)
  return renderXlsx(zip)
}

async function renderDocx(zip: JSZip): Promise<string> {
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) throw new Error('缺少 word/document.xml')
  const body = xml.match(/<w:body\b[\s\S]*?<\/w:body>/)?.[0] ?? xml
  // 图片先从 rels 换成 data URI，再按块切分——img 落在它所在的段落里。
  const withImages = await inlineDocxImages(zip, body)
  /*
   * 块的正则必须带反向引用：`<w:tbl>` 的单元格里是完整段落，`</w:p>` 比
   * `</w:tbl>` 先出现——不带 \1 时表格块会被单元格里第一个段落结束标签截断，
   * 表现为表格整个丢失、格内文字散成孤段。
   */
  const blocks = withImages.match(/<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g) ?? []
  const html = blocks
    .map((block) => {
      if (block.startsWith('<w:tbl')) {
        const rows = block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []
        return `<table><tbody>${rows
          .map((row) => {
            const cells = row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []
            return `<tr>${cells.map((cell) => `<td>${officeText(cell) || '&nbsp;'}</td>`).join('')}</tr>`
          })
          .join('')}</tbody></table>`
      }
      const text = officeText(block)
      return text ? `<p>${text}</p>` : '<p>&nbsp;</p>'
    })
    .join('')
  return `<article class="office-document">${html || '<p>文档没有可显示的正文</p>'}</article>`
}

const DOCX_IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/** 内联图片总字节上限：研究报告里的图按 MB 算，超了宁可缺图也不把页面撑爆。 */
const DOCX_MEDIA_CAP = 12 * 1024 * 1024

/**
 * 把 word/media 里的图片按 rels 映射嵌回正文。
 *
 * 只处理 `word/_rels/document.xml.rels` 里声明的关系：无 rels 或 media 缺失时
 * 正文原样返回，不把「没图」当错误。
 */
async function inlineDocxImages(zip: JSZip, body: string): Promise<string> {
  const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string')
  if (!relsXml) return body
  const mediaByRid = new Map<string, { path: string; mime: string }>()
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = m[0]
    const id = tag.match(/\bId="([^"]+)"/)?.[1]
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1]
    const type = tag.match(/\bType="([^"]+)"/)?.[1]
    if (!id || !target || !type?.includes('/image')) continue
    const ext = extname(target.split('?')[0] ?? '').toLowerCase()
    const mime = DOCX_IMAGE_EXTS[ext]
    if (!mime) continue
    mediaByRid.set(id, { path: `word/${target.replace(/^\/+/, '')}`, mime })
  }
  if (mediaByRid.size === 0) return body

  let total = 0
  const dataUriByRid = new Map<string, string>()
  for (const [rid, { path, mime }] of mediaByRid) {
    const file = zip.file(path)
    if (!file) continue
    if (total >= DOCX_MEDIA_CAP) break
    const bytes = await file.async('nodebuffer')
    if (total + bytes.length > DOCX_MEDIA_CAP) continue
    total += bytes.length
    dataUriByRid.set(rid, `data:${mime};base64,${bytes.toString('base64')}`)
  }
  if (dataUriByRid.size === 0) return body

  return body.replace(
    /<w:drawing\b[\s\S]*?r:embed="([^"]+)"[\s\S]*?<\/w:drawing>/g,
    (whole, rid: string) => {
      const uri = dataUriByRid.get(rid)
      return uri ? `<img src="${uri}" alt="文档图片" />` : whole
    },
  )
}

async function renderPptx(zip: JSZip): Promise<string> {
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(naturalPathSort)
    .slice(0, 200)
  const rendered = await Promise.all(
    slides.map(async (name, index) => {
      const xml = await zip.file(name)?.async('string')
      const paragraphs = (xml?.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [])
        .map(officeText)
        .filter(Boolean)
      const title = paragraphs[0] ?? `幻灯片 ${index + 1}`
      const rest = paragraphs.slice(1)
      return `<section class="office-slide"><span class="office-slide-number">${index + 1}</span><h2>${title}</h2>${rest.map((line) => `<p>${line}</p>`).join('')}</section>`
    }),
  )
  return `<article class="office-slides">${rendered.join('') || '<p>演示文稿没有可显示的幻灯片</p>'}</article>`
}

async function renderXlsx(zip: JSZip): Promise<string> {
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string')
  const shared = (sharedXml?.match(/<si\b[\s\S]*?<\/si>/g) ?? []).map(officeText)
  const sheets = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(naturalPathSort)
    .slice(0, 20)
  const rendered = await Promise.all(
    sheets.map(async (name, sheetIndex) => {
      const xml = await zip.file(name)?.async('string')
      const rows = (xml?.match(/<row\b[\s\S]*?<\/row>/g) ?? []).slice(0, 500)
      const table = rows
        .map((row) => {
          const cells = (row.match(/<c\b[\s\S]*?<\/c>/g) ?? []).slice(0, 80)
          return `<tr>${cells
            .map((cell) => {
              const type = cell.match(/\bt="([^"]+)"/)?.[1]
              const raw = cell.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? ''
              const inline = cell.match(/<is\b[\s\S]*?<\/is>/)?.[0]
              const value =
                type === 's'
                  ? (shared[Number(raw)] ?? '')
                  : type === 'inlineStr'
                    ? officeText(inline ?? '')
                    : escapeHtml(decodeXml(raw))
              return `<td>${value || '&nbsp;'}</td>`
            })
            .join('')}</tr>`
        })
        .join('')
      return `<section class="office-sheet"><h2>工作表 ${sheetIndex + 1}</h2><div class="office-sheet-scroll"><table><tbody>${table}</tbody></table></div></section>`
    }),
  )
  return `<article class="office-workbook">${rendered.join('') || '<p>工作簿没有可显示的数据</p>'}</article>`
}

function officeText(xml: string): string {
  const text = (xml.match(/<(?:w:t|a:t|t)(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:t|a:t|t)>/g) ?? [])
    .map((node) => node.replace(/^<[^>]+>|<\/[^>]+>$/g, ''))
    .map(decodeXml)
    .map(escapeHtml)
    .join('')
  // 图片通常独占一个 run；排在段落文字后面，位置差异在图与文字混排时才会看出来。
  const images = (xml.match(/<img\b[^>]*>/g) ?? []).join('')
  return `${text}${images}`
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function naturalPathSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

/** 控制字符密度判定。比嗅探魔数通用——覆盖所有未登记的格式。 */
function looksBinary(sample: string): boolean {
  if (!sample) return false
  let control = 0
  const n = Math.min(sample.length, 4096)
  for (let i = 0; i < n; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) return true
    if (c < 9 || (c > 13 && c < 32)) control++
  }
  return control / n > 0.1
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const toPosix = (p: string) => p.split(sep).join('/')
