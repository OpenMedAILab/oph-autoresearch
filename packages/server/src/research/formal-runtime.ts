import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { FormalExecutionPlan, ResearchCampaign, Workspace } from '@oph-autoresearch/core'
import { getWorkspace, type Store } from '@oph-autoresearch/store'
import { resolveWorkspaceServerBinding } from '../workspace-binding.ts'
import { readCliCandidateView } from './cli-candidate-view.ts'
import { formalWorkspaceBindingHash } from './formal-binding.ts'
import type { FormalExecutionRoute, FormalExecutionScope } from './formal-execution-controller.ts'
import { sha256 } from './skill-lock.ts'

export async function resolveFormalScope(
  store: Store,
  scope: FormalExecutionScope,
  resolver: (workspace: Workspace) => Promise<{
    binding: NonNullable<Workspace['serverBinding']>
    profile?: { root: string }
  }> = resolveWorkspaceServerBinding,
) {
  const workspace = getWorkspace(store, scope.workspaceId as never)
  if (!workspace || workspace.rootPath !== scope.workspaceRoot)
    throw new Error('研究项目目录已变化')
  const resolved = await resolver(workspace)
  const { binding } = resolved
  if (resolved.profile && resolved.profile.root !== binding.remoteRoot)
    throw new Error('服务器绑定目录已变化')
  return { ...binding, workspaceBindingHash: formalWorkspaceBindingHash(workspace.id, binding) }
}

export function matchingFormalRoutes(
  routes: readonly FormalExecutionRoute[],
  binding: Awaited<ReturnType<typeof resolveFormalScope>>,
) {
  return routes.filter(
    (route) =>
      route.profileId === binding.profileId &&
      route.connectionHash === binding.connectionHash &&
      route.remoteRoot === binding.remoteRoot &&
      (route.workspaceBindingHash === undefined ||
        route.workspaceBindingHash === binding.workspaceBindingHash),
  )
}

export async function readFormalCandidate(
  store: Store,
  plan: FormalExecutionPlan,
  campaign: ResearchCampaign,
) {
  const workspace = getWorkspace(store, campaign.workspaceId as never)
  const attempt = campaign.attempts.find(
    (item) => item.artifactVersionId === plan.candidateArtifactId,
  )
  const preparation = campaign.cliPreparations?.find((item) => item.attemptId === attempt?.id)
  if (!workspace || !preparation) throw new Error('正式计划缺少已核验的候选来源')
  const candidate = await readCliCandidateView(campaign, workspace.rootPath, preparation.id)
  const artifact = campaign.artifactVersions.find(
    (item) => item.id === candidate.candidateArtifactId,
  )!
  const code = Buffer.from(candidate.code, 'utf8')
  if (
    !candidate.current ||
    candidate.quarantined ||
    sha256(code) !== plan.codeHash ||
    candidate.candidateReceiptHash !== plan.candidateReceiptHash
  )
    throw new Error('候选代码已变化或不可正式执行')
  const path = fileURLToPath(artifact.uri)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let candidateReceipt: Buffer
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_000_000)
      throw new Error('候选回执文件不可用')
    candidateReceipt = Buffer.alloc(stat.size)
    for (let offset = 0; offset < candidateReceipt.length; ) {
      const { bytesRead } = await file.read(
        candidateReceipt,
        offset,
        candidateReceipt.length - offset,
        offset,
      )
      if (!bytesRead) throw new Error('候选回执读取期间已变化')
      offset += bytesRead
    }
    const after = await file.stat()
    if (
      after.size !== stat.size ||
      after.nlink !== 1 ||
      sha256(candidateReceipt) !== plan.candidateReceiptHash
    )
      throw new Error('候选回执已变化')
  } finally {
    await file.close()
  }
  return { code, candidateReceipt }
}
