import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@oph-autoresearch/agent'
import { DEFAULT_DENSITY } from '@oph-autoresearch/ai'
import { globTool } from './search.ts'

function ctx(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    conversationId: 'cv_search',
    runId: 'rn_search',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  }
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oph-autoresearch-search-'))
  await mkdir(join(root, '.oph'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'visible.json'), '{}')
  await writeFile(join(root, '.oph', 'patterns.json'), '{}')
  await writeFile(join(root, '.oph', 'team.json'), '{}')
  await writeFile(join(root, '.git', 'config.json'), '{}')
  await writeFile(join(root, 'node_modules', 'pkg', 'package.json'), '{}')
  return root
}

function files(out: unknown): string[] {
  return (out as { data: { files: string[] } }).data.files
}

function hiddenMetadata(out: { data?: Record<string, unknown> }): unknown {
  return out.data?.hidden
}

describe('glob hidden paths', () => {
  test('default omits hidden files and says so in metadata', async () => {
    const root = await workspace()
    const out = await globTool.fn({ pattern: '**/*.json' }, ctx(root))
    expect(files(out)).toEqual(['visible.json'])
    expect(hiddenMetadata(out)).toBe('excluded_by_default')
    expect(out.message).toContain('默认未搜索隐藏文件')
  })

  test('an explicit hidden pattern includes its files', async () => {
    const root = await workspace()
    const out = await globTool.fn({ pattern: '.oph/**' }, ctx(root))
    expect(files(out).sort()).toEqual(['.oph/patterns.json', '.oph/team.json'])
    expect(hiddenMetadata(out)).toBe('included')
  })

  test('an explicit hidden search path includes its files', async () => {
    const root = await workspace()
    const out = await globTool.fn({ pattern: '**/*.json', path: '.oph' }, ctx(root))
    expect(files(out).sort()).toEqual(['.oph/patterns.json', '.oph/team.json'])
  })

  test('include_hidden searches hidden paths but still skips ignored directories', async () => {
    const root = await workspace()
    const out = await globTool.fn({ pattern: '**/*.json', include_hidden: true }, ctx(root))
    expect(files(out).sort()).toEqual(['.oph/patterns.json', '.oph/team.json', 'visible.json'])
    expect(files(out)).not.toContain('.git/config.json')
    expect(files(out)).not.toContain('node_modules/pkg/package.json')
  })
})
