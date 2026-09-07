#!/usr/bin/env bun
/** 编译不携带任何凭证的 OpenSSH askpass 小工具，供密码认证时临时调用。 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT_DIR = join(ROOT, 'apps/desktop/src-tauri/bin')
const SOURCE = join(ROOT, 'native/ssh-askpass.rs')

async function hostTriple(): Promise<string> {
  const proc = Bun.spawn(['rustc', '-vV'], { stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error('未找到 rustc，无法构建 SSH 密码辅助进程')
  const match = /^host:\s*(\S+)$/m.exec(output)
  if (!match) throw new Error('无法从 rustc -vV 解析目标三元组')
  return match[1]!
}

export async function buildSshAskpass(): Promise<string> {
  const triple = await hostTriple()
  const ext = process.platform === 'win32' ? '.exe' : ''
  const output = join(OUT_DIR, `oph-ssh-askpass-${triple}${ext}`)
  await mkdir(OUT_DIR, { recursive: true })
  await rm(output, { force: true })
  const proc = Bun.spawn(
    ['rustc', '--edition=2021', '-C', 'opt-level=s', '-C', 'strip=symbols', SOURCE, '-o', output],
    { cwd: ROOT, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
  )
  if ((await proc.exited) !== 0) throw new Error('SSH 密码辅助进程编译失败')
  return output
}

if (import.meta.main) {
  const output = await buildSshAskpass()
  process.stdout.write(`SSH askpass → ${output}\n`)
}
