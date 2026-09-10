import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSshRunOptions, type SshProfile, saveSshProfiles, sshRunTool } from './ssh.ts'
import { sshJobStatusTool } from './ssh-job.ts'

const profile: SshProfile = {
  id: 'run-test',
  name: 'Run test',
  host: 'test.invalid',
  port: 22,
  root: '/allowed',
  readOnly: false,
  hostKeyPolicy: 'strict',
}

describe('SSH execution limits and receipt state', () => {
  test('rejects ineffective options and scope escapes before execution', () => {
    for (const timeout_ms of [0, -1, 1.5, '1000', NaN, 3600001])
      expect(() => resolveSshRunOptions(profile, { timeout_ms })).toThrow('timeout_ms')
    expect(() => resolveSshRunOptions(profile, { cwd: '/outside' })).toThrow('越过允许根目录')
    expect(() => resolveSshRunOptions(profile, { probe_url: 'https://example.com' })).toThrow(
      '不支持参数',
    )
    expect(resolveSshRunOptions(profile, { timeout_ms: null, cwd: null })).toEqual({
      timeoutMs: 600000,
      cwd: '/allowed',
    })
  })

  test('applies cwd and deadline to the actual SSH process, preserving timeout as unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oph-ssh-run-'))
    const bin = join(root, 'bin')
    const cwd = join(root, 'work with spaces')
    await mkdir(bin)
    await mkdir(cwd)
    const shim = join(bin, 'ssh')
    await writeFile(
      shim,
      '#!/bin/sh\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n',
    )
    await chmod(shim, 0o700)
    const setsid = join(bin, 'setsid')
    await writeFile(
      setsid,
      '#!/usr/bin/env python3\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n',
    )
    await chmod(setsid, 0o700)
    const realpath = join(bin, 'realpath')
    await writeFile(
      realpath,
      '#!/usr/bin/env python3\nimport os, sys\nprint(os.path.realpath(sys.argv[-1], strict=True))\n',
    )
    await chmod(realpath, 0o700)
    const previousHome = process.env.OPH_AUTORESEARCH_HOME
    const previousPath = process.env.PATH
    process.env.OPH_AUTORESEARCH_HOME = root
    process.env.PATH = `${bin}:${previousPath}`
    try {
      await saveSshProfiles([{ ...profile, root }])
      const ctx = { emit() {} } as unknown as Parameters<typeof sshRunTool.fn>[1]
      const ok = await sshRunTool.fn(
        { profile: profile.id, command: 'pwd', cwd, timeout_ms: 5000 },
        ctx,
      )
      expect(ok.status).toBe('success')
      expect(ok.data).toMatchObject({
        cwd,
        stdout: `${cwd}\n`,
        remoteState: 'completed',
        timedOut: false,
      })
      const events: unknown[] = []
      const jobContext = {
        ...ctx,
        emitSshJobFinished: (event: unknown) => events.push(event),
      } as Parameters<typeof sshJobStatusTool.fn>[1]
      const detached = await sshRunTool.fn(
        {
          profile: profile.id,
          cwd,
          command: 'sleep 1; printf "finished\\n"',
          detach: true,
          timeout_ms: 5000,
        },
        ctx,
      )
      if (detached.status !== 'success') throw new Error(JSON.stringify(detached))
      expect(detached.status).toBe('success')
      expect(detached.data?.pid).toBeGreaterThan(0)
      const runDir = detached.data?.runDir
      expect(
        (await sshJobStatusTool.fn({ profile: profile.id, runDir }, jobContext)).data?.state,
      ).toBe('running')
      await Bun.sleep(1100)
      const finished = await sshJobStatusTool.fn({ profile: profile.id, runDir }, jobContext)
      expect(finished.data).toMatchObject({
        state: 'completed',
        exitCode: 0,
        logTail: 'finished\n',
      })
      expect(events).toHaveLength(1)
      const failed = await sshRunTool.fn(
        { profile: profile.id, cwd, command: 'exit 7', detach: true },
        ctx,
      )
      await Bun.sleep(50)
      expect(
        (
          await sshJobStatusTool.fn(
            { profile: profile.id, runDir: failed.data?.runDir },
            jobContext,
          )
        ).data,
      ).toMatchObject({ state: 'failed', exitCode: 7 })
      const unknownDir = join(cwd, 'lost-job')
      await mkdir(unknownDir)
      await writeFile(join(unknownDir, 'pid'), '99999999')
      expect(
        (await sshJobStatusTool.fn({ profile: profile.id, runDir: unknownDir }, jobContext)).data,
      ).toMatchObject({ state: 'unknown', reason: 'process_missing_without_exit_code' })
      expect(events).toHaveLength(3)
      const started = Date.now()
      const stalled = await sshRunTool.fn(
        { profile: profile.id, command: 'exec sleep 5', timeout_ms: 1000 },
        ctx,
      )
      expect(Date.now() - started).toBeLessThan(4000)
      expect(stalled.status).toBe('failure')
      expect(stalled.message).toContain('远端任务状态未知')
      expect(stalled.data).toMatchObject({
        timedOut: true,
        timeoutMs: 1000,
        remoteState: 'unknown',
      })
      const rejected = await sshRunTool.fn(
        { profile: profile.id, command: 'pwd', cwd: '/outside' },
        ctx,
      )
      expect(rejected).toMatchObject({ status: 'failure', executed: false })
    } finally {
      if (previousHome === undefined) delete process.env.OPH_AUTORESEARCH_HOME
      else process.env.OPH_AUTORESEARCH_HOME = previousHome
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  }, 10_000)
})
