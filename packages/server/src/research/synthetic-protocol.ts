import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ResearchAttempt } from '@oph-autoresearch/core'
import { getResearchCampaign, type Store } from '@oph-autoresearch/store'
import { type RunnerTrackingReceipt, verifyTrackingBinding } from './runner-tracking.ts'
import {
  cancelSyntheticRun,
  type StartSyntheticRunInput,
  type SyntheticRunResult,
  startSyntheticRun,
} from './synthetic-runner.ts'
import { fixedResearchTemplate } from './template-registry.ts'

export interface ExperimentSummary {
  trainingSamples: number
  testSamples: number
  models: Array<{
    id: string
    metrics: { accuracy: number; logLoss: number }
    trainingLoss: { first: number; last: number } | null
  }>
}

/** Local controlled protocol. Ledger observations never trigger an implicit resubmission. */
export interface SyntheticProtocol {
  submit(
    input: Omit<StartSyntheticRunInput, 'store' | 'workspaceRoot' | 'campaignId'>,
  ): Promise<SyntheticRunResult>
  status(attemptId: string): {
    protocol: string
    attemptId: string
    campaignVersion: number
    status: ResearchAttempt['status']
    cancelRequested: boolean
    terminal: boolean
    retryAllowed: boolean
  }
  cancel(attemptId: string): SyntheticRunResult
  receipt(attemptId: string): Promise<{
    tracking?: RunnerTrackingReceipt
    protocol: string
    campaignId: string
    attemptId: string
    taskRevisionId: string
    artifactVersionId: string
    consumedArtifactVersionIds: string[]
    reviewKind: string
    humanApproval: boolean
    experiment?: ExperimentSummary
    inputHash: string
    contentHash: string
    byteLength: number
    verifiedAt: number
  }>
}
export function syntheticProtocol(
  store: Store,
  workspaceRoot: string,
  campaignId: string,
): SyntheticProtocol {
  function observe(attemptId: string) {
    const campaign = getResearchCampaign(store, campaignId)
    const attempt = campaign?.attempts.find((item) => item.id === attemptId)
    if (!campaign || !attempt) throw new Error('找不到合成尝试')
    return { campaign, attempt }
  }
  return {
    submit(input: Omit<StartSyntheticRunInput, 'store' | 'workspaceRoot' | 'campaignId'>) {
      return startSyntheticRun({ ...input, store, workspaceRoot, campaignId })
    },
    status(attemptId: string) {
      const { campaign, attempt } = observe(attemptId)
      return {
        protocol: 'local-synthetic-v1',
        attemptId,
        campaignVersion: campaign.version,
        status: attempt.status,
        cancelRequested: attempt.cancelRequestedAt !== null,
        terminal: attempt.status !== 'running' && attempt.status !== 'unknown',
        retryAllowed: false,
      }
    },
    cancel(attemptId: string) {
      const { campaign } = observe(attemptId)
      return cancelSyntheticRun({ store, campaignId, attemptId, expectedVersion: campaign.version })
    },
    async receipt(attemptId: string) {
      const { campaign, attempt } = observe(attemptId)
      if (attempt.status !== 'completed' || !attempt.artifactVersionId)
        throw new Error('尚无完成回执')
      const task = campaign.taskRevisions.find((item) => item.id === attempt.taskRevisionId)
      if (!task || task.status === 'stale') throw new Error('任务依赖已失效')
      const artifact = campaign.artifactVersions.find(
        (item) => item.id === attempt.artifactVersionId,
      )
      const plan = fixedResearchTemplate(task.templateId)
      const root = await realpath(resolve(workspaceRoot))
      let path = root
      for (const part of ['.oph', 'research', campaignId, attemptId, plan.filename]) {
        if (!/^[A-Za-z0-9._-]+$/.test(part)) throw new Error('回执路径无效')
        path = join(path, part)
        if ((await lstat(path)).isSymbolicLink()) throw new Error('回执路径包含软链接')
      }
      if (
        !artifact ||
        artifact.producerAttemptId !== attempt.id ||
        artifact.producerTaskRevisionId !== task.id ||
        artifact.uri !== pathToFileURL(path).href
      )
        throw new Error('回执产物路径未绑定')
      const bytes = await readFile(path)
      const validation = plan.verify(bytes)
      const tracking = verifyTrackingBinding(bytes, {
        dispatchKey: attempt.id,
        ...(attempt.jobSpec?.trackingPolicyHash
          ? { trackingPolicyHash: attempt.jobSpec.trackingPolicyHash }
          : {}),
      })
      if (validation.contentHash !== artifact.contentHash) throw new Error('回执产物字节已变化')
      const latest = observe(attemptId)
      const latestTask = latest.campaign.taskRevisions.find((item) => item.id === task.id)
      const latestArtifact = latest.campaign.artifactVersions.find(
        (item) => item.id === artifact.id,
      )
      if (
        latest.attempt.status !== 'completed' ||
        latest.attempt.artifactVersionId !== artifact.id ||
        !latestTask ||
        latestTask.status === 'stale' ||
        !latestArtifact ||
        latestArtifact.producerAttemptId !== attemptId ||
        latestArtifact.producerTaskRevisionId !== task.id ||
        latestArtifact.contentHash !== validation.contentHash
      )
        throw new Error('回执证据在读取期间已失效')
      return {
        protocol: 'local-synthetic-v1',
        campaignId,
        attemptId,
        taskRevisionId: task.id,
        artifactVersionId: artifact.id,
        consumedArtifactVersionIds: task.artifactVersionIds ?? [],
        reviewKind: plan.reviewKind,
        humanApproval: false,
        ...(task.templateId === 'supervised-phantom-v2'
          ? {
              experiment: (() => {
                const result = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
                  trainIds: string[]
                  testIds: string[]
                  models: ExperimentSummary['models']
                }
                return {
                  trainingSamples: result.trainIds.length,
                  testSamples: result.testIds.length,
                  models: result.models.map((model) => ({
                    id: model.id,
                    metrics: { accuracy: model.metrics.accuracy, logLoss: model.metrics.logLoss },
                    trainingLoss: model.trainingLoss,
                  })),
                }
              })(),
            }
          : {}),
        ...(tracking ? { tracking } : {}),
        ...validation,
      }
    },
  }
}
