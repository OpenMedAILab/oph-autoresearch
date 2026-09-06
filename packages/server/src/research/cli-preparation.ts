import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { canonicalJson, sha256 } from './skill-lock.ts'

const TEXT_LIMIT = 256_000
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export interface CliPreparationAdapter {
  id: string
  model: string
  /** Administrator-admitted executable and fixed arguments; never a shell string. */
  argv: readonly string[]
}
export interface CliPreparationTransport {
  run(input: Readonly<{ argv: readonly string[]; cwd: string; stdin: string; timeoutMs: number }>): Promise<{
    exitCode: number
    stdout: string
    stderr?: string
    identity?: string
  }>
}
export interface CliPreparationDraft {
  schema: 'research-cli-preparation-draft-v1'
  taskRevisionId: string
  adapter: { id: string; model: string; identity: string }
  inputHash: string
  configHash: string
  contentHash: string
  code: string
  patch: string | null
  humanApprovalRequired: true
}

function validAdapter(adapter: CliPreparationAdapter) {
  return ID.test(adapter.id) && adapter.model.length > 0 && adapter.model.length <= 256 &&
    adapter.argv.length > 0 && adapter.argv.every(arg => typeof arg === 'string' && arg.length <= 4096 && !/[\0\r\n]/.test(arg))
}
async function bounded(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > TEXT_LIMIT) throw new Error('CLI preparation output exceeds limit')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { reader.releaseLock() }
}

/** Produces review-only candidate code. It cannot apply patches or start training. */
export async function prepareCliDraft(input: {
  workspaceRoot: string
  workspaceScope: string
  taskRevisionId: string
  instructions: string
  maxRuntimeMs: number
  budget: { maxRequests: 0; maxCostUsd: 0 }
  adapter: CliPreparationAdapter
  transport?: CliPreparationTransport
}): Promise<CliPreparationDraft> {
  if (!validAdapter(input.adapter) || !ID.test(input.taskRevisionId) || input.instructions.length > 32_000 ||
    !Number.isSafeInteger(input.maxRuntimeMs) || input.maxRuntimeMs < 1 || input.maxRuntimeMs > 600_000 ||
    input.budget.maxRequests !== 0 || input.budget.maxCostUsd !== 0)
    throw new Error('invalid approved CLI preparation specification')
  const root = realpathSync(resolve(input.workspaceRoot))
  if (!lstatSync(root).isDirectory()) throw new Error('invalid preparation workspace')
  const scope = resolve(root, input.workspaceScope)
  if (scope !== root && !scope.startsWith(`${root}${sep}`)) throw new Error('workspace scope escapes root')
  const approved = Object.freeze({ schema: 'research-cli-preparation-v1', taskRevisionId: input.taskRevisionId, workspaceScope: input.workspaceScope, instructions: input.instructions, maxRuntimeMs: input.maxRuntimeMs, budget: input.budget })
  const config = Object.freeze({ id: input.adapter.id, model: input.adapter.model, argv: [...input.adapter.argv] })
  const stdin = canonicalJson({ approved, config })
  const result = input.transport
    ? await input.transport.run({ argv: config.argv, cwd: scope, stdin, timeoutMs: input.maxRuntimeMs })
    : await (async () => {
        const child = Bun.spawn(config.argv, { cwd: scope, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'ignore', env: Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) })
        const timer = setTimeout(() => child.kill(), input.maxRuntimeMs)
        try {
          return { exitCode: await child.exited, stdout: await bounded(child.stdout as ReadableStream<Uint8Array>), identity: `pid:${child.pid}` }
        } finally { clearTimeout(timer) }
      })()
  if (result.exitCode !== 0 || result.stdout.length > TEXT_LIMIT) throw new Error('admitted CLI preparation failed')
  const generated = JSON.parse(result.stdout) as { code?: unknown; patch?: unknown }
  if (!generated || typeof generated.code !== 'string' || generated.code.length === 0 || generated.code.length > TEXT_LIMIT ||
    (generated.patch !== undefined && typeof generated.patch !== 'string'))
    throw new Error('CLI preparation returned an invalid draft')
  const code = generated.code
  const patch = typeof generated.patch === 'string' ? generated.patch : null
  const contentHash = `sha256:${createHash('sha256').update(canonicalJson({ code, patch })).digest('hex')}`
  return Object.freeze({ schema: 'research-cli-preparation-draft-v1', taskRevisionId: input.taskRevisionId, adapter: { id: config.id, model: config.model, identity: result.identity ?? `adapter:${config.id}` }, inputHash: sha256(canonicalJson(approved)), configHash: sha256(canonicalJson(config)), contentHash, code, patch, humanApprovalRequired: true })
}
