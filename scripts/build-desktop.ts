#!/usr/bin/env bun
/**
 * 按当前 Rust 工具链的 host triple 构建桌面应用。
 *
 * Windows 同时存在 GNU 与 MSVC 工具链。Tauri CLI 只按操作系统猜目标时，可能让
 * Cargo 编出 GNU 应用，却在封装阶段查找 `*-windows-msvc.exe` sidecar。目标必须由
 * `rustc -vV` 的真实 host 决定，并同时传给 sidecar 与 Tauri。
 */

import { delimiter, dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
const env = {
  ...process.env,
  [pathKey]: [dirname(process.execPath), process.env[pathKey]].filter(Boolean).join(delimiter),
}

async function hostTriple(): Promise<string> {
  const proc = Bun.spawn(['rustc', '-vV'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(stderr.trim() || 'rustc -vV 执行失败')
  const match = /^host:\s*(\S+)$/m.exec(stdout)
  if (!match) throw new Error('无法从 rustc -vV 解析目标三元组')
  return match[1]!
}

async function run(args: string[]): Promise<void> {
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: ROOT,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) process.exit(code)
}

const target = await hostTriple()
process.stdout.write(`桌面构建目标：${target}\n`)
await run(['run', 'scripts/build-sidecar.ts'])
await run(['run', '--cwd', 'apps/desktop', 'tauri', 'build', '--target', target])
await run(['run', 'scripts/collect-installer.ts'])
