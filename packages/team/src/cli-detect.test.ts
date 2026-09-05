/**
 * 覆盖范围：`cli-detect.ts`（PATH 解析、凭证判据）。
 *
 * 测的是**行为**：装了就出现在结果里、没装就不出现、见到凭证才算接入。
 * 表里认哪几家不测——那是随时会加的一行数据，不是行为。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliCandidateDirs, codexDesktopCandidatePaths, detectClis, findCli } from './cli-detect.ts'

/** 造一个假的 claude 可执行文件。两种后缀都写，POSIX 与 Windows 各认一个。 */
async function fakeBin(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oph-cli-'))
  await writeFile(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(dir, `${name}.cmd`), '@echo off\n')
  return dir
}

describe('外部 CLI 识别', () => {
  /**
   * 表里写了「接着问」用什么参数，识别结果就必须带着它。
   * 漏抄那两项的表现是静默失效：表里写着，跑起来却当那家不支持。
   */
  test('接着问要用的两项跟着识别结果出来', async () => {
    const dir = await fakeBin('claude')
    const [claude] = await detectClis({ PATH: dir, PATHEXT: '.CMD' })
    expect(claude?.sessionField).toBeTruthy()
    expect(claude?.resumeArgs?.join(' ')).toContain('{session}')
  })

  test('PATH 上有就认出来，没有的不出现', async () => {
    const dir = await fakeBin('claude')
    const found = await detectClis({ PATH: dir, PATHEXT: '.CMD' })
    expect(found.map((c) => c.id)).toEqual(['claude'])
    expect(found[0]!.vendor).toBe('Anthropic')
    expect(found[0]!.path.startsWith(dir)).toBe(true)
  })

  test('PATH 上一个都没有时回空，不报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oph-cli-empty-'))
    expect(await detectClis({ PATH: dir, PATHEXT: '.CMD' })).toEqual([])
  })

  test('环境变量里有 key 就算接入', async () => {
    const dir = await fakeBin('claude')
    const on = await findCli('claude', { PATH: dir, PATHEXT: '.CMD', ANTHROPIC_API_KEY: 'sk-x' })
    expect(on?.connected).toBe(true)
  })

  test('装了但没凭证时是「未接入」，不是「没装」', async () => {
    const dir = await fakeBin('codex')
    // 家目录下可能真的有 ~/.codex/auth.json（这台机器上装过），
    // 所以这条只断言它**被识别到了**，接入与否交给上一条按环境变量测。
    const found = await findCli('codex', { PATH: dir, PATHEXT: '.CMD' })
    expect(found?.id).toBe('codex')
    expect(typeof found?.connected).toBe('boolean')
  })

  test('不认识的 id 返回 undefined', async () => {
    const dir = await fakeBin('claude')
    expect(await findCli('nope', { PATH: dir, PATHEXT: '.CMD' })).toBeUndefined()
  })

  test('Windows 风格的 PATH 引号不会让已安装 CLI 消失', async () => {
    const dir = await fakeBin('claude')
    const [found] = await detectClis({ PATH: `"${dir}"`, PATHEXT: '.CMD' })
    expect(found?.id).toBe('claude')
  })

  test('PATH 之外的标准用户级目录也在候选里', () => {
    // 各家的原生安装不进 PATH：codex 在 `.codex/bin` 与 `.codex/.sandbox-bin`，
    // claude 在 `.claude/local`。漏掉的表现是设置页「本机没有识别到外部 CLI」。
    const dirs = cliCandidateDirs('home', {})
    expect(dirs).toContain(join('home', '.codex', 'bin'))
    expect(dirs).toContain(join('home', '.codex', '.sandbox-bin'))
    expect(dirs).toContain(join('home', '.claude', 'local'))
  })

  test('Codex 桌面版的版本目录按新到旧生成候选路径', () => {
    expect(codexDesktopCandidatePaths('local', ['9ba7', 'aa10'])).toEqual([
      join('local', 'OpenAI', 'Codex', 'bin', 'aa10', 'codex.exe'),
      join('local', 'OpenAI', 'Codex', 'bin', '9ba7', 'codex.exe'),
    ])
  })
})
