#!/usr/bin/env bun
/** Collect only the target just built, preserving earlier local installers and build caches. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

function assertWithin(root: string, path: string): void {
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('安装包路径不在预期构建目录中')
}

/** Source selection is exact: a stale installer from another target cannot enter this delivery. */
export async function collectInstaller(root: string, target: string): Promise<string> {
  if (!/^(x86_64|aarch64)-pc-windows-(gnu|msvc)$/.test(target))
    throw new Error('需要明确的 Windows Rust target')
  const workspace = await realpath(resolve(root))
  const version = (await readFile(join(workspace, 'VERSION'), 'utf8')).trim()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('版本无效')
  const buildRoot = await realpath(join(workspace, '.tmp', 'cargo-target'))
  assertWithin(workspace, buildRoot)
  let sourceDir = buildRoot
  for (const segment of [target, 'release', 'bundle', 'nsis']) {
    sourceDir = join(sourceDir, segment)
    const entry = await lstat(sourceDir)
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error('安装包目标路径不能包含链接或非目录')
  }
  const installers = (await readdir(sourceDir)).filter((name) => name.endsWith('.exe'))
  const architecture = target.startsWith('x86_64-') ? 'x64' : 'arm64'
  if (
    installers.length !== 1 ||
    installers[0] !== `oph-autoresearch_${version}_${architecture}-setup.exe`
  )
    throw new Error('当前目标必须只有一个与 VERSION 一致的安装包')
  const name = installers[0]!
  const sourceEntry = await lstat(join(sourceDir, name))
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) throw new Error('安装包必须为普通文件')
  const source = await realpath(join(sourceDir, name))
  assertWithin(sourceDir, source)
  const outputRoot = join(workspace, '.tmp', 'installer')
  await mkdir(outputRoot, { recursive: true })
  assertWithin(workspace, await realpath(outputRoot))
  const output = await mkdtemp(join(outputRoot, `v${version}-${target}-`))
  const destination = join(output, name)
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  const sourceBytes = await readFile(source)
  const bytes = await readFile(destination)
  const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const hash = digest(bytes)
  if (hash !== digest(sourceBytes)) throw new Error('安装包复制校验失败')
  await writeFile(join(output, 'SHA256SUMS.txt'), `${hash}  ${name}\n`, { flag: 'wx' })
  await writeFile(
    join(output, 'package.json'),
    `${JSON.stringify({ version, target, file: name, byteLength: bytes.length, sha256: hash }, null, 2)}\n`,
    { flag: 'wx' },
  )
  return output
}

if (import.meta.main) {
  const target = Bun.argv[2]
  if (!target) throw new Error('用法：bun run scripts/collect-installer.ts <Rust target>')
  process.stdout.write(`${await collectInstaller(join(import.meta.dir, '..'), target)}\n`)
}
