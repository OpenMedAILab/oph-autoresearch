import { lstat, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ResearchCampaign } from '@oph-autoresearch/core'
import { verifyCandidateReceipt } from './cli-preparation-candidate.ts'
import { sha256 } from './skill-lock.ts'

/** Read saved, verified bytes only. This never contacts or executes the preparation CLI. */
export async function readCliCandidateView(
  campaign: ResearchCampaign,
  workspaceRoot: string,
  preparationId: string,
) {
  const preparation = campaign.cliPreparations?.find((item) => item.id === preparationId)
  const attempt = campaign.attempts.find((item) => item.id === preparation?.attemptId)
  const artifact = campaign.artifactVersions.find((item) => item.id === attempt?.artifactVersionId)
  const spec = attempt?.cliPreparationJobSpec
  if (
    !preparation ||
    !attempt ||
    !artifact ||
    !spec ||
    !['cli_preparation_candidate', 'cli_preparation_quarantined_candidate'].includes(
      artifact.kind,
    ) ||
    artifact.artifactId !==
      `${attempt.resultDisposition === 'quarantined' ? 'cli-preparation-quarantine' : 'cli-preparation'}:${preparation.id}` ||
    spec.execution.preparationId !== preparation.id ||
    spec.dispatchKey !== attempt.id
  )
    throw new Error('暂无可核验的候选代码')
  let path = await realpath(workspaceRoot)
  for (const part of ['.oph', 'research', campaign.id, attempt.id, 'cli-candidate.json']) {
    if (!/^[A-Za-z0-9._-]+$/.test(part)) throw new Error('候选路径无效')
    path = join(path, part)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('候选路径不能包含软链接')
  }
  const info = await lstat(path)
  if (!info.isFile() || info.size > 1_000_000 || artifact.uri !== pathToFileURL(path).href) {
    throw new Error('候选文件与账本不一致')
  }
  const bytes = await readFile(path)
  if (bytes.length > 1_000_000) throw new Error('候选文件超过预览上限')
  const receipt: unknown = JSON.parse(bytes.toString('utf8'))
  if (sha256(bytes) !== artifact.contentHash || !verifyCandidateReceipt(receipt, spec)) {
    throw new Error('候选内容已变化，不能作为审阅依据')
  }
  return {
    candidateArtifactId: artifact.id,
    taskRevisionId: spec.taskRevisionId,
    codeHash: receipt.draft.contentHash,
    candidateReceiptHash: artifact.contentHash,
    code: receipt.draft.code,
    patch: receipt.draft.patch,
    byteLength: bytes.length,
    quarantined: attempt.resultDisposition === 'quarantined',
    current: campaign.taskRevisions.some(
      (task) => task.id === spec.taskRevisionId && task.status !== 'stale',
    ),
    formalExecutionAvailable: false as const,
    formalExecutionReason: '尚无通过隔离验收的正式执行后端；候选代码仅供审阅。',
  }
}
