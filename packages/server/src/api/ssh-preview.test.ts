import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectSshDirectory,
  readSshWholeText,
  type SshProfile,
  sshProfileConnectionHash,
} from '@oph-autoresearch/tools'
import { sshListTool, sshRunTool } from '../../../tools/src/ssh.ts'
import { handleSshApi } from './ssh.ts'
import type { ApiRequestDeps } from './types.ts'

// 使用本地假 SSH 传输执行真实 shell 命令，既覆盖转义又不连接实验服务器。
test.skipIf(process.platform === 'win32')(
  'SSH 文本预览与工作区实验模式端到端契约',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'oph-ssh-preview-'))
    const previousPath = process.env.PATH
    const previousHome = process.env.OPH_AUTORESEARCH_HOME
    try {
      const bin = join(root, 'bin')
      await mkdir(bin)
      const shim = join(bin, 'ssh')
      await writeFile(
        shim,
        `#!/bin/sh
for arg do command="$arg"; done
realpath() { if [ "$1" = '-e' ]; then shift; fi; command realpath "$@"; }
eval "$command"
`,
      )
      await chmod(shim, 0o755)
      process.env.PATH = `${bin}:${previousPath}`
      process.env.OPH_AUTORESEARCH_HOME = join(root, 'home')
      const call = async (path: string, body?: unknown) => {
        const url = new URL(`http://localhost${path}`)
        const res = await handleSshApi(
          url,
          new Request(
            url.href,
            body === undefined
              ? undefined
              : {
                  method: 'POST',
                  body: JSON.stringify(body),
                },
          ),
          {} as ApiRequestDeps,
        )
        return res!
      }
      const connection = (await (
        await call('/api/ssh/connect', { host: 'fake.example.org', port: 22 })
      ).json()) as { sessionId: string }
      expect(connection.sessionId).toBeString()
      const folder = join(root, '实验目录')
      await mkdir(folder)
      const save = (readOnly?: boolean) =>
        call('/api/ssh/workspace', {
          sessionId: connection.sessionId,
          path: folder,
          ...(readOnly === undefined ? {} : { readOnly }),
        })
      const initial = (await (await save()).json()) as { profile: SshProfile }
      expect(initial.profile.readOnly).toBe(true)
      const textPath = join(folder, "预览 '测试.jsonl")
      await writeFile(textPath, '第一行\n第二行\n')
      expect(await readSshWholeText(initial.profile, textPath)).toMatchObject({
        content: '第一行\n第二行\n',
        truncated: false,
        size: Buffer.byteLength('第一行\n第二行\n'),
      })
      await writeFile(textPath, 'x'.repeat(6 * 1024 * 1024))
      const preview = (await (
        await call(
          `/api/ssh/session/preview?session=${connection.sessionId}&path=${encodeURIComponent(textPath)}`,
        )
      ).json()) as { size: number; content: string; truncated: boolean }
      expect(preview.size).toBe(6 * 1024 * 1024)
      expect(preview.content).toHaveLength(2 * 1024 * 1024)
      expect(preview.truncated).toBe(true)
      await writeFile(textPath, '')
      expect(await readSshWholeText(initial.profile, textPath)).toMatchObject({
        content: '',
        size: 0,
        truncated: false,
      })
      const discovered = await sshListTool.fn({}, {} as Parameters<typeof sshListTool.fn>[1])
      expect(discovered).toMatchObject({
        status: 'success',
        data: { profiles: [{ id: initial.profile.id, readOnly: true }] },
      })
      const args = { profile: initial.profile.id, command: "printf 'processed' > result.txt" }
      const context = {
        signal: new AbortController().signal,
        emit: () => {},
      } as unknown as Parameters<typeof sshRunTool.fn>[1]
      expect(await sshRunTool.fn(args, context)).toMatchObject({
        status: 'failure',
        executed: false,
      })
      const writable = (await (await save(false)).json()) as { profile: SshProfile }
      expect(writable.profile).toMatchObject({ id: initial.profile.id, readOnly: false })
      expect(((await (await save()).json()) as { profile: SshProfile }).profile.readOnly).toBe(
        false,
      )
      expect(await sshRunTool.fn(args, context)).toMatchObject({ status: 'success' })
      expect(await readFile(join(folder, 'result.txt'), 'utf8')).toBe('processed')
      const projectDirectory = join(folder, 'project')
      await mkdir(projectDirectory)
      expect(await inspectSshDirectory(writable.profile, projectDirectory, true)).toBe(
        projectDirectory,
      )
      await expect(inspectSshDirectory(initial.profile, projectDirectory, true)).rejects.toThrow()
      const boundContext = {
        ...context,
        projectServerBinding: {
          version: 1 as const,
          profileId: writable.profile.id,
          remoteRoot: projectDirectory,
          connectionHash: sshProfileConnectionHash(writable.profile),
          verifiedAt: Date.now(),
        },
      }
      expect(await sshListTool.fn({}, boundContext)).toMatchObject({
        data: { profiles: [{ id: writable.profile.id, root: projectDirectory }] },
      })
      expect(
        await sshRunTool.fn({ ...args, command: "printf 'bound' > result.txt" }, boundContext),
      ).toMatchObject({ status: 'success' })
      expect(await readFile(join(projectDirectory, 'result.txt'), 'utf8')).toBe('bound')
      expect(await readFile(join(folder, 'result.txt'), 'utf8')).toBe('processed')
      await expect(
        sshRunTool.fn({ ...args, profile: 'other-server' }, boundContext),
      ).rejects.toThrow('不属于当前研究项目')
      await expect(
        sshListTool.fn({ profile: writable.profile.id, path: folder }, boundContext),
      ).rejects.toThrow('越过允许根目录')

      expect(((await (await save(true)).json()) as { profile: SshProfile }).profile.readOnly).toBe(
        true,
      )
      expect(await sshRunTool.fn(args, context)).toMatchObject({
        status: 'failure',
        executed: false,
      })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousHome === undefined) delete process.env.OPH_AUTORESEARCH_HOME
      else process.env.OPH_AUTORESEARCH_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
