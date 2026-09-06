import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { FormalExecutionPlan } from '@oph-autoresearch/core'
import { cliPreparationExecutableHash } from './cli-preparation-job.ts'
import { type FormalOciJobSpec, formalExecutionPlanHash } from './formal-job.ts'

const SHA256 = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_STDIO_BYTES = 64 * 1024
const MAX_PREDICTIONS_BYTES = 16 * 1024 * 1024

export interface FormalOciAdministratorConfig {
  podmanExecutable: string
  podmanBinaryHash: string
  candidates: readonly { candidateArtifactId: string; mainPy: string; candidateReceipt: string }[]
  datasets: readonly { dataManifestHash: string; root: string }[]
  labels: readonly { labelSetContentHash: string; path: string }[]
  evaluators: readonly { id: 'binary-classification-v1'; hash: string }[]
}

export interface PodmanCommand {
  run(
    argv: readonly string[],
    timeoutMs: number,
  ): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }
}

function bytesHash(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
function bounded(bytes: Uint8Array) {
  return bytes.byteLength <= MAX_STDIO_BYTES ? bytes : bytes.slice(0, MAX_STDIO_BYTES)
}
function fileHash(path: string) {
  return bytesHash(readFileSync(path))
}
function safeDirectory(path: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('formal OCI path is not a safe directory')
  return realpathSync(path)
}
function safeFile(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('formal OCI path is not a safe regular file')
  return realpathSync(path)
}
function mountedPath(root: string, child: string) {
  const target = resolve(root, child)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('formal OCI output escapes its root')
  return target
}

/** A production probe. macOS and rootful/cgroup-v1 Podman are explicitly refused. */
export function probeRootlessPodman(command: PodmanCommand, platform = process.platform): void {
  if (platform !== 'linux') throw new Error('formal OCI requires Linux rootless Podman')
  const response = command.run(['info', '--format', 'json'], 10_000)
  if (response.exitCode !== 0) throw new Error('Podman rootless OCI probe failed')
  let info: Record<string, unknown>
  try {
    info = JSON.parse(new TextDecoder().decode(response.stdout)) as Record<string, unknown>
  } catch {
    throw new Error('Podman rootless OCI probe returned invalid JSON')
  }
  const host = info.host as Record<string, unknown> | undefined
  const security = host?.security as Record<string, unknown> | undefined
  if (!host || security?.rootless !== true || host.cgroupVersion !== 'v2')
    throw new Error('Podman must be rootless with cgroup v2 resource controls')
}

export function systemPodmanCommand(executable: string): PodmanCommand {
  return {
    run(argv, timeoutMs) {
      const child = Bun.spawnSync([executable, ...argv], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
        env: { PATH: process.env.PATH ?? '' },
      })
      return {
        exitCode: child.exitCode,
        stdout: new Uint8Array(child.stdout),
        stderr: new Uint8Array(child.stderr),
      }
    },
  }
}

export class FormalOciAdapter {
  private readonly config: FormalOciAdministratorConfig
  private readonly command: PodmanCommand
  constructor(
    config: FormalOciAdministratorConfig,
    command = systemPodmanCommand(config.podmanExecutable),
    platform = process.platform,
  ) {
    const executable = safeFile(config.podmanExecutable)
    if (cliPreparationExecutableHash(executable) !== config.podmanBinaryHash)
      throw new Error('admitted Podman binary changed')
    if (
      !config.candidates.length ||
      !config.datasets.length ||
      !config.labels.length ||
      !config.evaluators.length ||
      new Set(config.candidates.map((item) => item.candidateArtifactId)).size !==
        config.candidates.length ||
      new Set(config.datasets.map((item) => item.dataManifestHash)).size !==
        config.datasets.length ||
      new Set(config.labels.map((item) => item.labelSetContentHash)).size !== config.labels.length
    )
      throw new Error('formal OCI administrator registry is incomplete')
    for (const item of config.candidates) {
      if (!ID.test(item.candidateArtifactId)) throw new Error('invalid formal candidate registry')
      safeFile(item.mainPy)
      safeFile(item.candidateReceipt)
    }
    for (const item of config.datasets) {
      if (!SHA256.test(item.dataManifestHash)) throw new Error('invalid formal dataset registry')
      safeDirectory(item.root)
    }
    for (const item of config.labels) {
      if (
        !SHA256.test(item.labelSetContentHash) ||
        fileHash(safeFile(item.path)) !== item.labelSetContentHash
      )
        throw new Error('invalid formal truth registry')
    }
    this.config = { ...config, podmanExecutable: executable }
    this.command = command
    probeRootlessPodman(command, platform)
  }
  private bindings(plan: FormalExecutionPlan) {
    const candidate = this.config.candidates.find(
      (item) => item.candidateArtifactId === plan.candidateArtifactId,
    )
    const dataset = this.config.datasets.find(
      (item) => item.dataManifestHash === plan.dataManifestHash,
    )
    const labels = this.config.labels.find(
      (item) => item.labelSetContentHash === plan.labelSetContentHash,
    )
    const evaluator = this.config.evaluators.find(
      (item) => item.id === plan.trustedEvaluatorId && item.hash === plan.trustedEvaluatorHash,
    )
    if (!candidate || !dataset || !labels || !evaluator)
      throw new Error('formal plan is not admitted')
    if (
      fileHash(candidate.mainPy) !== plan.codeHash ||
      fileHash(candidate.candidateReceipt) !== plan.candidateReceiptHash
    )
      throw new Error('formal candidate bytes changed')
    return { candidate, dataset, labels, evaluator }
  }
  validate(job: FormalOciJobSpec) {
    if (job.formalPlanHash !== formalExecutionPlanHash(job.formalPlan))
      throw new Error('formal plan hash changed')
    this.bindings(job.formalPlan)
  }
  argv(job: FormalOciJobSpec, outputDirectory: string) {
    const plan = job.formalPlan
    this.validate(job)
    const { candidate, dataset } = this.bindings(plan)
    const output = safeDirectory(outputDirectory)
    return [
      'run',
      '--name',
      job.execution.containerName,
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--read-only-tmpfs=false',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--userns',
      'keep-id',
      '--pids-limit',
      String(plan.resources.pidsLimit),
      '--cpus',
      String(plan.resources.cpu),
      '--memory',
      `${plan.resources.memoryMb}m`,
      '--stop-timeout',
      '1',
      '--volume',
      `${safeDirectory(dataset.root)}:/dataset:ro`,
      '--volume',
      `${output}:/out:rw`,
      '--volume',
      `${safeFile(candidate.mainPy)}:/work/main.py:ro`,
      '--workdir',
      '/work',
      plan.ociImageDigest,
      ...plan.entryArgv,
    ] as const
  }
  inspect(containerName: string) {
    if (!ID.test(containerName)) throw new Error('invalid formal OCI container name')
    return this.command.run(
      ['inspect', '--format', '{{.ImageDigest}} {{.State.Status}}', containerName],
      10_000,
    )
  }
  stopAndConfirm(job: FormalOciJobSpec) {
    const before = this.inspect(job.execution.containerName)
    if (before.exitCode === 0) {
      const state = new TextDecoder().decode(before.stdout).trim().split(/\s+/)
      if (state[0] !== job.formalPlan.ociImageDigest) return false
      if (!['running', 'created', 'paused'].includes(state[1] ?? '')) return true
    }
    const stopped = this.command.run(['stop', '--time', '1', job.execution.containerName], 10_000)
    if (stopped.exitCode !== 0) return false
    const inspected = this.inspect(job.execution.containerName)
    if (inspected.exitCode !== 0) return true // Removed is also a confirmed stopped state.
    const state = new TextDecoder().decode(inspected.stdout).trim().split(/\s+/)
    return (
      state[0] === job.formalPlan.ociImageDigest &&
      !['running', 'created', 'paused'].includes(state[1] ?? '')
    )
  }
  run(job: FormalOciJobSpec, outputDirectory: string) {
    const result = this.command.run(
      this.argv(job, outputDirectory),
      job.formalPlan.resources.maxRuntimeMs + 5_000,
    )
    return { ...result, stdout: bounded(result.stdout), stderr: bounded(result.stderr) }
  }
  /** Outside OCI: labels are the only truth source and worker-supplied metrics are ignored. */
  evaluate(job: FormalOciJobSpec, outputDirectory: string) {
    const { labels } = this.bindings(job.formalPlan)
    const predictionsPath = mountedPath(safeDirectory(outputDirectory), 'predictions.json')
    const bytes = readFileSync(predictionsPath)
    if (bytes.byteLength > MAX_PREDICTIONS_BYTES) throw new Error('formal predictions exceed bound')
    const truth = JSON.parse(readFileSync(labels.path, 'utf8')) as unknown
    const predictions = JSON.parse(bytes.toString()) as unknown
    if (!Array.isArray(truth) || !Array.isArray(predictions))
      throw new Error('invalid formal evaluator fixture')
    const labelsById = new Map<string, 0 | 1>()
    for (const row of truth) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error('invalid truth row')
      const record = row as Record<string, unknown>
      if (
        Object.keys(record).sort().join(',') !== 'id,label' ||
        !ID.test(String(record.id)) ||
        ![0, 1].includes(record.label as number) ||
        labelsById.has(record.id as string)
      )
        throw new Error('invalid truth registry')
      labelsById.set(record.id as string, record.label as 0 | 1)
    }
    const scores = new Map<string, number>()
    for (const row of predictions) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error('invalid prediction row')
      const record = row as Record<string, unknown>
      if (
        Object.keys(record).sort().join(',') !== 'id,probability' ||
        !ID.test(String(record.id)) ||
        typeof record.probability !== 'number' ||
        !Number.isFinite(record.probability) ||
        record.probability < 0 ||
        record.probability > 1 ||
        scores.has(record.id as string)
      )
        throw new Error('invalid prediction registry')
      scores.set(record.id as string, record.probability as number)
    }
    if (scores.size !== labelsById.size || [...labelsById.keys()].some((id) => !scores.has(id)))
      throw new Error('predictions must cover the complete truth registry')
    let tp = 0,
      tn = 0,
      fp = 0,
      fn = 0
    for (const [id, label] of labelsById) {
      const predicted = scores.get(id)! >= 0.5 ? 1 : 0
      if (predicted && label) tp++
      else if (predicted) fp++
      else if (label) fn++
      else tn++
    }
    const n = labelsById.size
    return {
      schema: 'research-formal-oci-receipt-v1' as const,
      planHash: job.formalPlanHash,
      codeHash: job.formalPlan.codeHash,
      imageDigest: job.formalPlan.ociImageDigest,
      dataManifestHash: job.formalPlan.dataManifestHash,
      labelSetContentHash: job.formalPlan.labelSetContentHash,
      evaluatorHash: job.formalPlan.trustedEvaluatorHash,
      predictionHash: bytesHash(bytes),
      metrics: {
        accuracy: (tp + tn) / n,
        precision: tp + fp ? tp / (tp + fp) : 0,
        recall: tp + fn ? tp / (tp + fn) : 0,
        tp,
        tn,
        fp,
        fn,
      },
    }
  }
  verifyReceipt(job: FormalOciJobSpec, outputDirectory: string, bytes: Uint8Array) {
    try {
      const claimed = JSON.parse(new TextDecoder().decode(bytes))
      return canonical(claimed) === canonical(this.evaluate(job, outputDirectory))
    } catch {
      return false
    }
  }
}
