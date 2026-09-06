import type { Workspace } from '@oph-autoresearch/core'
import {
  inspectSshDirectory,
  loadSshProfiles,
  scopeSshProfile,
  sshProfileConnectionHash,
} from '@oph-autoresearch/tools'

export async function verifyWorkspaceServerBinding(
  input: unknown,
): Promise<NonNullable<Workspace['serverBinding']>> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('新建研究项目必须选择服务器工作目录')
  const body = input as Record<string, unknown>
  if (
    Object.keys(body).sort().join(',') !== 'profileId,remoteRoot' ||
    typeof body.profileId !== 'string' ||
    typeof body.remoteRoot !== 'string' ||
    !body.remoteRoot.startsWith('/')
  )
    throw new Error('请选择服务器和绝对工作目录')
  const profile = (await loadSshProfiles()).find((candidate) => candidate.id === body.profileId)
  if (!profile) throw new Error('服务器配置不存在，请先连接并保存服务器目录')
  const remoteRoot = await inspectSshDirectory(profile, body.remoteRoot, true)
  const binding = {
    version: 1 as const,
    profileId: profile.id,
    remoteRoot,
    connectionHash: sshProfileConnectionHash(profile),
    verifiedAt: Date.now(),
  }
  scopeSshProfile(profile, binding)
  return binding
}

/** Returns only the bound server scope. Deleted/changed profiles never fall back to a global default. */
export async function resolveWorkspaceServerBinding(workspace: Workspace) {
  const binding = workspace.serverBinding
  if (!binding) throw new Error('此研究项目尚未绑定服务器工作目录')
  const profile = (await loadSshProfiles()).find((candidate) => candidate.id === binding.profileId)
  if (!profile) throw new Error('项目绑定的服务器配置已删除')
  return { binding, profile: scopeSshProfile(profile, binding), localRoot: workspace.rootPath }
}
