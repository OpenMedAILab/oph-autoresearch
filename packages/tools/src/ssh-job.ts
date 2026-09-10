import type { ToolSpec } from '@oph-autoresearch/agent'
import { findSshProfile, remotePathGuard, resolveSshPath, sshExec } from './ssh.ts'
import { jobStatusScript } from './ssh-job-script.ts'

export const sshJobStatusTool: ToolSpec = {
  name: 'ssh_job_status',
  description:
    '读取远端作业的 pid、退出码与最后 50 行日志。进程消失且无退出码时返回 unknown，禁止猜测成功或自动重投。',
  parameters: {
    type: 'object',
    properties: { profile: { type: 'string' }, runDir: { type: 'string' } },
    required: ['profile', 'runDir'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: 'SSH 作业',
  category: 'external',
  facet: 'SSH',
  summary: '查询远端作业状态',
  permissionEffect: 'network',
  parallelSafe: true,
  targetExtractor: (args) => `${String(args.profile)}:${String(args.runDir)}`,
  async fn(args, ctx) {
    const profile = await findSshProfile(String(args.profile), ctx.projectServerBinding)
    if (typeof args.runDir !== 'string' || !args.runDir.trim())
      return { status: 'failure', executed: false, message: 'runDir 不能为空' }
    const runDir = resolveSshPath(profile, args.runDir)
    const result = await sshExec(profile, remotePathGuard(profile, runDir) + jobStatusScript(), {
      signal: ctx.signal,
      timeoutMs: 30_000,
    })
    const [header, ...lines] = result.stdout.split('\n')
    const match = header?.match(
      /^__OPH_JOB__:(running|completed|failed|unknown):(\d*):(\d*):([a-z_]*)$/,
    )
    const state =
      !result.timedOut && result.exitCode === 0 && match
        ? (match[1] as 'running' | 'completed' | 'failed' | 'unknown')
        : 'unknown'
    const reason = match?.[4] || (state === 'unknown' ? 'status_unavailable' : undefined)
    const data = {
      profile: profile.id,
      runDir,
      state,
      pid: match?.[2] ? Number(match[2]) : null,
      exitCode: match?.[3] ? Number(match[3]) : null,
      logTail: match ? lines.join('\n') : '',
      ...(reason ? { reason } : {}),
    }
    if (state !== 'running')
      ctx.emitSshJobFinished?.({
        profile: profile.id,
        runDir,
        state,
        ...(reason ? { reason } : {}),
      })
    return {
      status: 'success',
      message: `远端作业：${state}${reason ? `（${reason}）` : ''}`,
      data,
    }
  },
}
