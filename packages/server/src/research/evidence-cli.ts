import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, LlmAdapter } from '@oph-autoresearch/ai'
import { catalogKey, type OphConfig } from '@oph-autoresearch/runtime'
import type { EvidenceCliInput } from './evidence-cli-worker.ts'
import type { EvidencePack, EvidenceReviewResult } from './evidence-session.ts'
import { canonicalJson, sha256 } from './skill-lock.ts'

async function boundedText(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('Evidence CLI output exceeds contract')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** The parent guarded adapter remains the only outbound/budget authority. */
export async function runEvidenceCliReview(options: {
  pack: EvidencePack
  config: OphConfig
  adapter: LlmAdapter
  signal: AbortSignal
  workerArgv?: readonly string[]
}): Promise<EvidenceReviewResult> {
  if (options.signal.aborted) throw new Error('Evidence CLI cancelled before spawn')
  const scratch = await mkdtemp(join(tmpdir(), 'oph-evidence-cli-'))
  const token = randomBytes(32).toString('hex')
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) controller.abort()
  const timer = setTimeout(abort, 120_000)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 2_000_000,
    async fetch(request) {
      const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
      if (
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
      )
        return new Response('Unauthorized', { status: 401 })
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/stream')
        return new Response('', { status: 404 })
      const raw = (await request.json().catch(() => null)) as ChatRequest | null
      if (
        !raw ||
        raw.model !== options.adapter.spec.id ||
        !Array.isArray(raw.system) ||
        !Array.isArray(raw.messages) ||
        !Array.isArray(raw.tools) ||
        raw.tools.some((tool) => tool.name !== 'read_skill')
      )
        return new Response('Invalid research request', { status: 400 })
      const signal = AbortSignal.any([controller.signal, request.signal])
      const stream = new ReadableStream<Uint8Array>({
        async start(sink) {
          try {
            for await (const event of options.adapter.stream({ ...raw, signal }))
              sink.enqueue(Buffer.from(`${JSON.stringify({ event })}\n`))
          } catch {
            try {
              sink.enqueue(Buffer.from('{"error":"provider_request_failed"}\n'))
            } catch {}
          } finally {
            try {
              sink.close()
            } catch {}
          }
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    if (controller.signal.aborted) throw new Error('Evidence CLI cancelled before spawn')
    const selected = options.config.providers[options.config.active.provider]!
    const config: OphConfig = {
      active: { provider: 'evidence-bridge', model: options.config.active.model },
      mode: 'auto',
      providers: {
        'evidence-bridge': {
          kind: options.adapter.kind,
          apiKey: 'unused-local-bridge',
          models: {
            [options.config.active.model]: {
              ...(selected.models[options.config.active.model]?.effort
                ? { effort: selected.models[options.config.active.model]!.effort! }
                : {}),
            },
          },
        },
      },
      ...(options.config.catalog
        ? {
            catalog: {
              [catalogKey(options.config.active.model, options.adapter.kind)]:
                options.config.catalog[
                  catalogKey(options.config.active.model, options.adapter.kind)
                ]!,
            },
          }
        : {}),
    }
    const input: EvidenceCliInput = {
      schema: 'research-evidence-cli-v1',
      endpoint: `http://127.0.0.1:${server.port}`,
      token,
      pack: options.pack,
      evidencePackHash: sha256(canonicalJson(options.pack)),
      config,
      adapter: {
        kind: options.adapter.kind,
        spec: options.adapter.spec,
        transmits: options.adapter.transmits,
      },
    }
    const argv = options.workerArgv
      ? [...options.workerArgv]
      : [process.execPath, join(import.meta.dir, 'evidence-cli-worker.ts')]
    child = Bun.spawn(argv, {
      cwd: scratch,
      stdin: new Blob([JSON.stringify(input)]),
      stdout: 'pipe',
      stderr: 'ignore',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            ['PATH', 'SYSTEMROOT', 'WINDIR'].includes(key.toUpperCase()),
          ),
        ),
        HOME: scratch,
        USERPROFILE: scratch,
        TEMP: scratch,
        TMP: scratch,
        OPH_AUTORESEARCH_HOME: scratch,
      },
    })
    const worker = child
    const stop = () => worker.kill()
    controller.signal.addEventListener('abort', stop, { once: true })
    if (controller.signal.aborted) stop()
    try {
      const text = await boundedText(worker.stdout as ReadableStream<Uint8Array>, 256_000)
      if ((await worker.exited) !== 0 || controller.signal.aborted)
        throw new Error('Evidence CLI did not complete')
      const envelope = JSON.parse(text) as {
        schema: string
        workerPid: number
        result: EvidenceReviewResult
      }
      const result = envelope.result
      if (
        envelope.schema !== input.schema ||
        envelope.workerPid !== worker.pid ||
        !result ||
        result.evidencePackHash !== input.evidencePackHash ||
        canonicalJson(result.artifactVersionIds) !== canonicalJson(input.pack.artifactVersionIds) ||
        typeof result.text !== 'string' ||
        result.text.length > 16_000 ||
        !['done', 'failed', 'interrupted'].includes(result.status) ||
        result.reviewKind !== 'model-review' ||
        result.humanApproval !== false
      )
        throw new Error('Evidence CLI result is not bound to approved input')
      return result
    } finally {
      controller.signal.removeEventListener('abort', stop)
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
    controller.abort()
    if (child && child.exitCode === null) {
      child.kill()
      await child.exited
    }
    server.stop(true)
    await rm(scratch, { recursive: true, force: true })
  }
}
