/** Covers collection target isolation, immutable delivery directories and version rejection. */
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectInstaller } from './collect-installer.ts'

const temporary = join(import.meta.dir, '..', '.tmp', 'installer-collection-tests')
const target = 'x86_64-pc-windows-gnu'
const name = 'oph-autoresearch_0.1.8_x64-setup.exe'

async function fixture(withCurrent = true) {
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'run-'))
  const current = join(root, '.tmp', 'cargo-target', target, 'release', 'bundle', 'nsis')
  const other = join(
    root,
    '.tmp',
    'cargo-target',
    'x86_64-pc-windows-msvc',
    'release',
    'bundle',
    'nsis',
  )
  if (withCurrent) await mkdir(current, { recursive: true })
  await mkdir(other, { recursive: true })
  await writeFile(join(root, 'VERSION'), '0.1.8\n')
  if (withCurrent) await writeFile(join(current, name), 'new target bytes')
  await writeFile(join(other, name), 'stale other target bytes')
  return { root, current, other }
}

test('only current target is delivered; repeated collection preserves prior packages and caches', async () => {
  const { root, current, other } = await fixture()
  const first = await collectInstaller(root, target)
  expect(await readFile(join(first, name), 'utf8')).toBe('new target bytes')
  await writeFile(join(current, name), 'second build bytes')
  const second = await collectInstaller(root, target)
  expect(second).not.toBe(first)
  expect(await readFile(join(first, name), 'utf8')).toBe('new target bytes')
  expect(await readFile(join(second, name), 'utf8')).toBe('second build bytes')
  expect(await readFile(join(other, name), 'utf8')).toBe('stale other target bytes')
  const manifest = JSON.parse(await readFile(join(second, 'package.json'), 'utf8'))
  const hash = new Bun.CryptoHasher('sha256').update('second build bytes').digest('hex')
  expect(manifest).toEqual({ version: '0.1.8', target, file: name, byteLength: 18, sha256: hash })
  expect(await readFile(join(second, 'SHA256SUMS.txt'), 'utf8')).toBe(`${hash}  ${name}\n`)
})

test('stale versions, extra installers and path-like targets cannot be delivered', async () => {
  const { root, current } = await fixture()
  await writeFile(join(root, 'VERSION'), '0.1.9\n')
  await expect(collectInstaller(root, target)).rejects.toThrow('VERSION')
  await writeFile(join(root, 'VERSION'), '0.1.8\n')
  await writeFile(join(current, 'another.exe'), 'unrelated')
  await expect(collectInstaller(root, target)).rejects.toThrow('VERSION')
  await expect(collectInstaller(root, '../release')).rejects.toThrow('target')
})

test('a target junction cannot relabel a different target installer', async () => {
  const { root } = await fixture(false)
  const buildRoot = join(root, '.tmp', 'cargo-target')
  await symlink(join(buildRoot, 'x86_64-pc-windows-msvc'), join(buildRoot, target), 'junction')
  await expect(collectInstaller(root, target)).rejects.toThrow('链接')
})
