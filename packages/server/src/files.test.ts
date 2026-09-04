/**
 * 覆盖 `files.ts`：`listTree` / `createEntry` / `renameEntry` / `deleteEntry` /
 * `findByName` / `classify`。
 *
 * 锁五件事：**树里一条都不少**（依赖树、构建产物、点开头的条目全列——藏一条
 * 在界面上就等于它不存在）、**新建与改名都不覆盖**、**删不存在的要抛**（不静默成功）、
 * **搜索跳噪音目录**（与树口径不同，是有意的），以及分类的回落口径。
 * 预览的字节截断不在这里测。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  classify,
  copyEntry,
  createEntry,
  deleteEntry,
  EntryExistsError,
  FileChangedError,
  findByName,
  listTree,
  moveEntry,
  preview,
  renameEntry,
  writeTextEntry,
} from './files.ts'

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oph-autoresearch-tree-'))
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'main.ts'), 'export const b = 2\n', 'utf8')
  for (const noisy of ['coverage', 'node_modules', 'dist']) {
    await mkdir(join(dir, noisy), { recursive: true })
    await writeFile(join(dir, noisy, 'x.ts'), '// 产物\n', 'utf8')
  }
  await writeFile(join(dir, '.gitignore'), 'dist\n', 'utf8')
  await mkdir(join(dir, '.claude'), { recursive: true })
  await writeFile(join(dir, '.claude', 'settings.json'), '{}\n', 'utf8')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  return dir
}

describe('文件树', () => {
  /**
   * 一条都不过滤：依赖树、构建产物、`.git`、点开头的配置全在。
   *
   * 模型侧的 `list_dir` / `glob` / `grep` 仍按 `IGNORED_DIRS` 跳噪音目录，那是
   * token 预算；界面这棵树是用户核对磁盘内容的地方，藏一条在界面上就等于它
   * 不存在。不一致的方向只允许是界面看得多。
   */
  test('磁盘上有的全进树', async () => {
    const names = (await listTree(await workspace(), '', 2)).map((n) => n.name)
    for (const entry of [
      'src',
      'a.ts',
      'coverage',
      'node_modules',
      'dist',
      '.git',
      '.claude',
      '.gitignore',
    ]) {
      expect(names).toContain(entry)
    }
  })

  test('目录在前，子层按 depth 展开', async () => {
    const nodes = await listTree(await workspace(), '', 2)
    expect(nodes[0]?.kind).toBe('dir')
    expect(nodes.find((n) => n.name === 'src')?.children?.map((c) => c.name)).toEqual(['main.ts'])
  })

  /** depth 到底就不再展开——不是展开成空数组，那会让界面画一个假的空目录。 */
  test('depth=1 时目录没有 children 字段', async () => {
    const nodes = await listTree(await workspace(), '', 1)
    expect(nodes.find((n) => n.name === 'src')?.children).toBeUndefined()
  })
})

describe('新建', () => {
  test('文件建出来是空的，中间目录一并建', async () => {
    const dir = await workspace()
    const node = await createEntry(dir, 'docs/notes/a.md', 'file')
    expect(node).toMatchObject({ name: 'a.md', path: 'docs/notes/a.md', kind: 'file', size: 0 })
    expect(await readFile(join(dir, 'docs/notes/a.md'), 'utf8')).toBe('')
  })

  test('目录建出来能再往里建', async () => {
    const dir = await workspace()
    expect((await createEntry(dir, 'pkg', 'dir')).kind).toBe('dir')
    expect((await createEntry(dir, 'pkg/x.ts', 'file')).path).toBe('pkg/x.ts')
  })

  /** 覆盖是不可撤销的，所以「已存在」必须是个错，不能静默成功。 */
  test('重名一律报错，文件和目录都不覆盖', async () => {
    const dir = await workspace()
    expect(createEntry(dir, 'a.ts', 'file')).rejects.toThrow(EntryExistsError)
    expect(createEntry(dir, 'src', 'dir')).rejects.toThrow(EntryExistsError)
    // 原内容没被动过
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })
})

describe('改名与删除', () => {
  test('改名只换名字，路径留在原来那一层', async () => {
    const dir = await workspace()
    const node = await renameEntry(dir, 'src/main.ts', 'entry.ts')
    expect(node).toMatchObject({ name: 'entry.ts', path: 'src/entry.ts', kind: 'file' })
    expect(await readFile(join(dir, 'src/entry.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  test('改成一个已经存在的名字要报错，不覆盖', async () => {
    const dir = await workspace()
    await createEntry(dir, 'src/entry.ts', 'file')
    expect(renameEntry(dir, 'src/main.ts', 'entry.ts')).rejects.toThrow(EntryExistsError)
    expect(await readFile(join(dir, 'src/main.ts'), 'utf8')).toBe('export const b = 2\n')
  })

  test('删目录连里面一起删；删不存在的要抛，不静默', async () => {
    const dir = await workspace()
    await deleteEntry(dir, 'src')
    expect((await listTree(dir, '', 1)).map((n) => n.name)).not.toContain('src')
    expect(deleteEntry(dir, 'src')).rejects.toThrow()
  })
})

describe('编辑、复制与移动', () => {
  test('保存 UTF-8 中文代码，并拒绝覆盖外部修改', async () => {
    const dir = await workspace()
    const before = await preview(dir, 'a.ts')
    const saved = await writeTextEntry(
      dir,
      'a.ts',
      '// 中文注释保持清晰\nexport const 视力 = 1.0\n',
      before.mtime,
    )
    expect(await readFile(join(dir, 'a.ts'), 'utf8')).toContain('中文注释保持清晰')
    expect(saved.size).toBeGreaterThan(0)

    await writeFile(join(dir, 'a.ts'), '// 外部修改\n', 'utf8')
    expect(writeTextEntry(dir, 'a.ts', '// 不应覆盖\n', saved.mtime)).rejects.toThrow(
      FileChangedError,
    )
  })

  test('复制自动生成不冲突的副本名，移动保留名称且不覆盖', async () => {
    const dir = await workspace()
    const first = await copyEntry(dir, 'a.ts')
    const second = await copyEntry(dir, 'a.ts')
    expect(first.path).toBe('a copy.ts')
    expect(second.path).toBe('a copy 2.ts')
    expect(await readFile(join(dir, first.path), 'utf8')).toBe('export const a = 1\n')

    await mkdir(join(dir, 'archive'))
    const moved = await moveEntry(dir, first.path, 'archive')
    expect(moved.path).toBe('archive/a copy.ts')
    expect((await listTree(dir, '', 1)).map((node) => node.name)).not.toContain('a copy.ts')
    expect(await readFile(join(dir, moved.path), 'utf8')).toBe('export const a = 1\n')
  })

  test('文件夹不能移动到自己里面', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'src', 'nested'))
    expect(moveEntry(dir, 'src', 'src/nested')).rejects.toThrow('不能把文件夹移动到它自己里面')
  })
})

describe('按名搜索', () => {
  test('子串匹配、大小写不敏感，目录也算命中', async () => {
    const dir = await workspace()
    const { matches } = await findByName(dir, 'MAIN')
    expect(matches.map((m) => m.path)).toContain('src/main.ts')
    expect((await findByName(dir, 'src')).matches).toContainEqual({ path: 'src', kind: 'dir' })
  })

  /**
   * 搜索跳噪音目录，文件树不跳——两处口径不同是有意的：树不过滤之后第一层就有
   * `node_modules`，搜索要是也铺进去，遍历预算会在依赖树里烧光，用户一个命中都
   * 拿不到。这条边界要在界面上说出来。
   */
  test('不进噪音目录，但目录本身能被搜到', async () => {
    const dir = await workspace()
    await writeFile(join(dir, 'node_modules', 'main-helper.ts'), '// 依赖\n', 'utf8')
    const paths = (await findByName(dir, 'main')).matches.map((m) => m.path)
    expect(paths).toContain('src/main.ts')
    expect(paths).not.toContain('node_modules/main-helper.ts')
  })

  test('空查询回空结果，不回整棵树', async () => {
    expect(await findByName(await workspace(), '')).toEqual({ matches: [], truncated: false })
  })
})

describe('预览分类', () => {
  test('认识的扩展名给出种类与语言，不认识的回落到 text', () => {
    expect(classify('a/b.ts')).toEqual({ kind: 'text', mime: 'text/plain', language: 'typescript' })
    expect(classify('x.png').kind).toBe('image')
    expect(classify('x.pdf').kind).toBe('pdf')
    expect(classify('notes.md').kind).toBe('markdown')
    expect(classify('analysis.py').language).toBe('python')
    expect(classify('Pipeline.java').language).toBe('java')
    expect(classify('report.docx').kind).toBe('office')
    expect(classify('slides.pptx').kind).toBe('office')
    expect(classify('table.xlsx').kind).toBe('office')
    // 回落是 text 而不是 binary：新扩展名永远追不完，把没见过的当文本读
    // 最多是一屏乱码，当二进制则是「能读却不给看」。
    expect(classify('x.qwerty')).toEqual({ kind: 'text', mime: 'text/plain' })
  })

  test('docx、pptx 与 xlsx 都在本机解包成只读 HTML', async () => {
    const dir = await workspace()

    const docx = new JSZip()
    docx.file(
      'word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>眼底报告</w:t></w:r></w:p></w:body></w:document>',
    )
    await writeFile(join(dir, 'report.docx'), await docx.generateAsync({ type: 'nodebuffer' }))

    const pptx = new JSZip()
    pptx.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>研究结论</a:t></a:r></a:p></p:sld>')
    await writeFile(join(dir, 'slides.pptx'), await pptx.generateAsync({ type: 'nodebuffer' }))

    const xlsx = new JSZip()
    xlsx.file('xl/sharedStrings.xml', '<sst><si><t>患者编号</t></si></sst>')
    xlsx.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row></sheetData></worksheet>',
    )
    await writeFile(join(dir, 'table.xlsx'), await xlsx.generateAsync({ type: 'nodebuffer' }))

    expect((await preview(dir, 'report.docx')).content).toContain('眼底报告')
    expect((await preview(dir, 'slides.pptx')).content).toContain('研究结论')
    expect((await preview(dir, 'table.xlsx')).content).toContain('患者编号')
    expect((await preview(dir, 'table.xlsx')).content).toContain('42')
  })

  test('PDF 以内联 data URI 返回，交给 WebView 原生阅读器', async () => {
    const dir = await workspace()
    const bytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n')
    await writeFile(join(dir, 'report.pdf'), bytes)
    const result = await preview(dir, 'report.pdf')
    expect(result.kind).toBe('pdf')
    expect(result.mime).toBe('application/pdf')
    expect(result.dataUri).toBe(`data:application/pdf;base64,${bytes.toString('base64')}`)
  })
})
