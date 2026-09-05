/**
 * Trusted runner-side tracking collectors. Raw upstream payloads stay in the runner process.
 * Never mount these collectors as local clinical-data endpoints or pass through provider bodies.
 */
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA1 = /^[0-9a-f]{40}$/
const MAX_BYTES = 1024 * 1024
const STATUSES = new Set(['RUNNING', 'SCHEDULED', 'FINISHED', 'FAILED', 'KILLED'])

export interface NumericTrackingField {
  min: number
  max: number
}

export interface RunnerMlflowSource {
  /** An opaque application reference allocated for this approved source; not a patient identifier. */
  referenceId: string
  baseUrl: string
  runId: string
  authorization?: string
  metrics: Readonly<Record<string, NumericTrackingField>>
  numericParams: Readonly<Record<string, NumericTrackingField>>
}

export interface MlflowAggregate {
  source: 'mlflow'
  referenceId: string
  status: string
  metrics: Record<string, number | null>
  numericParams: Record<string, number | null>
  verification: 'provider-reported'
  artifactAccess: 'not-collected'
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid tracking response')
  return value as Record<string, unknown>
}

function numericRules(value: RunnerMlflowSource['metrics']): Record<string, NumericTrackingField> {
  const entries = Object.entries(object(value))
  if (entries.length > 64) throw new Error('Too many tracking fields')
  const rules: Record<string, NumericTrackingField> = Object.create(null)
  for (const [key, raw] of entries) {
    const rule = object(raw)
    if (
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) ||
      Object.keys(rule).sort().join(',') !== 'max,min' ||
      typeof rule.min !== 'number' ||
      typeof rule.max !== 'number' ||
      !Number.isFinite(rule.min) ||
      !Number.isFinite(rule.max) ||
      rule.min > rule.max
    )
      throw new Error('Invalid tracking field policy')
    rules[key] = { min: rule.min, max: rule.max }
  }
  return rules
}

async function boundedBytes(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) throw new Error('Missing tracking response body')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('Tracking metadata exceeds size limit')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function projectNumeric(
  input: unknown,
  rules: Record<string, NumericTrackingField>,
  strings: boolean,
): Record<string, number | null> {
  if (input !== undefined && !Array.isArray(input)) throw new Error('Invalid tracking response')
  const output: Record<string, number | null> = Object.fromEntries(
    Object.keys(rules).map((key) => [key, null]),
  )
  const seen = new Set<string>()
  for (const raw of (input ?? []) as unknown[]) {
    const item = object(raw)
    if (typeof item.key !== 'string' || !Object.hasOwn(rules, item.key)) continue
    if (seen.has(item.key)) throw new Error('Ambiguous tracking metric')
    seen.add(item.key)
    let number: number
    if (strings) {
      if (
        typeof item.value !== 'string' ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(item.value)
      )
        throw new Error('Tracking parameter is not a decimal number')
      number = Number(item.value)
    } else {
      if (typeof item.value !== 'number') throw new Error('Tracking metric is not numeric')
      number = item.value
    }
    const rule = rules[item.key]!
    if (!Number.isFinite(number) || number < rule.min || number > rule.max)
      throw new Error('Tracking value violates numeric policy')
    output[item.key] = number
  }
  return output
}

/** Captures one source and allowlist before jobs run; callers cannot substitute URLs or run IDs. */
export function createRunnerMlflowCollector(
  source: RunnerMlflowSource,
): () => Promise<MlflowAggregate> {
  if (!UUID.test(source.referenceId) || !/^[0-9a-f]{32}$/.test(source.runId))
    throw new Error('Invalid tracking source reference')
  let base: URL
  try {
    base = new URL(source.baseUrl)
  } catch {
    throw new Error('Invalid tracking source URL')
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))
  )
    throw new Error('Tracking source requires HTTPS or loopback HTTP')
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const url = new URL('api/2.0/mlflow/runs/get', base)
  url.searchParams.set('run_id', source.runId)
  const metrics = numericRules(source.metrics)
  const params = numericRules(source.numericParams)
  const referenceId = source.referenceId
  const runId = source.runId
  const authorization = source.authorization
  return async () => {
    let payload: unknown
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: authorization ? { authorization } : {},
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Tracking source unavailable')
      }
      payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response.body)),
      )
    } catch {
      throw new Error('Tracking source unavailable or invalid')
    }
    const run = object(object(payload).run)
    const info = object(run.info)
    const data = object(run.data)
    if (info.run_id !== runId || typeof info.status !== 'string' || !STATUSES.has(info.status))
      throw new Error('Tracking run identity or status mismatch')
    return {
      source: 'mlflow',
      referenceId,
      status: info.status,
      metrics: projectNumeric(data.metrics, metrics, false),
      numericParams: projectNumeric(data.params, params, true),
      verification: 'provider-reported',
      artifactAccess: 'not-collected',
    }
  }
}

export interface RunnerDvcSource {
  referenceId: string
  repositoryRoot: string
  revision: string
}

/** Reads immutable Git metadata on the runner. Never resolves DVC storage URLs or downloads data. */
export function createRunnerDvcCollector(source: RunnerDvcSource) {
  if (!UUID.test(source.referenceId) || !SHA1.test(source.revision))
    throw new Error('DVC metadata requires an opaque reference and full commit')
  const { referenceId, revision, repositoryRoot } = source
  return async () => {
    const root = await realpath(repositoryRoot).catch(() => {
      throw new Error('DVC repository unavailable')
    })
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
    }
    async function git(args: string[]): Promise<Uint8Array> {
      const child = (() => {
        try {
          return Bun.spawn(['git', '--no-replace-objects', '-C', root, ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
            env,
          })
        } catch {
          throw new Error('DVC revision metadata unavailable')
        }
      })()
      const timer = setTimeout(() => child.kill(), 10_000)
      try {
        const [bytes, , code] = await Promise.all([
          boundedBytes(child.stdout),
          boundedBytes(child.stderr),
          child.exited,
        ])
        if (code !== 0) throw new Error('DVC revision metadata unavailable')
        return bytes
      } catch {
        child.kill()
        await child.exited
        throw new Error('DVC revision metadata unavailable')
      } finally {
        clearTimeout(timer)
      }
    }
    const topLevel = new TextDecoder().decode(await git(['rev-parse', '--show-toplevel'])).trim()
    const actualRoot = await realpath(topLevel).catch(() => {
      throw new Error('DVC repository unavailable')
    })
    if (relative(root, actualRoot) !== '') throw new Error('DVC repository root mismatch')
    const resolved = new TextDecoder()
      .decode(await git(['rev-parse', '--verify', `${revision}^{commit}`]))
      .trim()
    if (resolved !== revision) throw new Error('DVC revision is not a commit')
    const lock = await git(['show', '--no-ext-diff', '--no-textconv', `${revision}:dvc.lock`])
    if (lock.byteLength === 0) throw new Error('DVC lock is empty')
    return {
      source: 'dvc' as const,
      referenceId,
      revision,
      lockSha256: `sha256:${new Bun.CryptoHasher('sha256').update(lock).digest('hex')}`,
      lockByteLength: lock.byteLength,
      verification: 'git-lock-bytes' as const,
      dataAccess: 'not-collected' as const,
    }
  }
}
