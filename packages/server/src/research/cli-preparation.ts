import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { canonicalJson, sha256 } from './skill-lock.ts'

const LIMIT = 256_000
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
export type CliPreparationAdapter = {
  kind: 'codex-exec' | 'claude-print'
  executable: string
  binaryHash: string
  id: string
  model: string
}
export interface PreparationCapability {
  taskRevisionId: string
  specHash: string
  verify(): boolean
}
export interface CliPreparationDraft {
  schema: 'research-cli-preparation-draft-v1'
  taskRevisionId: string
  specHash: string
  adapter: { id: string; model: string; identity: string }
  inputHash: string
  configHash: string
  contentHash: string
  code: string
  patch: string | null
  usage: null
  humanApprovalRequired: true
}
async function read(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader(),
    c: Uint8Array[] = []
  let n = 0
  try {
    while (true) {
      const x = await r.read()
      if (x.done) break
      n += x.value.byteLength
      if (n > LIMIT) throw new Error('CLI preparation output exceeds limit')
      c.push(x.value)
    }
    return Buffer.concat(c).toString('utf8')
  } catch (error) {
    await r.cancel().catch(() => {})
    throw error
  } finally {
    r.releaseLock()
  }
}
function command(a: CliPreparationAdapter, p: string) {
  if (
    !ID.test(a.id) ||
    !a.model ||
    a.model.length > 256 ||
    !a.executable ||
    /[\0\r\n]/.test(a.executable) ||
    !/^sha256:[a-f0-9]{64}$/.test(a.binaryHash)
  )
    throw new Error('invalid admitted CLI adapter')
  return a.kind === 'codex-exec'
    ? [
        a.executable,
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--disable',
        'shell_tool',
        '--disable',
        'unified_exec',
        '--disable',
        'hooks',
        '--disable',
        'multi_agent',
        '--model',
        a.model,
        p,
      ]
    : [
        a.executable,
        '-p',
        p,
        '--output-format',
        'json',
        '--model',
        a.model,
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--settings',
        '{"disableAllHooks":true}',
        '--disable-slash-commands',
        '--no-session-persistence',
      ]
}
function draftText(kind: CliPreparationAdapter['kind'], stdout: string) {
  if (kind === 'claude-print') {
    const envelope = JSON.parse(stdout) as { result?: unknown }
    if (typeof envelope.result !== 'string')
      throw new Error('CLI preparation returned an invalid Claude envelope')
    return envelope.result
  }
  let final: string | undefined
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } }
    if (
      event.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    )
      final = event.item.text
  }
  if (!final) throw new Error('CLI preparation returned no Codex agent message')
  return final
}
/** Calls only a verified capability in an empty staging directory; it never applies output. */
export async function prepareCliDraft(input: {
  workspaceRoot: string
  workspaceScope: string
  instructions: string
  maxRuntimeMs: number
  adapter: CliPreparationAdapter
  capability: PreparationCapability
  credentialHome: string
  /** A daemon worker is already a dedicated process group, so its CLI must inherit that group. */
  processGroup?: 'isolated' | 'daemon-worker'
}): Promise<CliPreparationDraft> {
  if (
    !input.capability.verify() ||
    !ID.test(input.capability.taskRevisionId) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.capability.specHash) ||
    !Number.isSafeInteger(input.maxRuntimeMs) ||
    input.maxRuntimeMs < 1 ||
    input.maxRuntimeMs > 600000 ||
    typeof input.instructions !== 'string' ||
    input.instructions.length < 1 ||
    input.instructions.length > 32_000
  )
    throw new Error('invalid approved CLI preparation capability')
  const root = realpathSync(resolve(input.workspaceRoot)),
    requested = resolve(root, input.workspaceScope)
  if (requested !== root && !requested.startsWith(`${root}${sep}`))
    throw new Error('workspace scope escapes root')
  const scope = realpathSync(requested)
  if (scope !== root && !scope.startsWith(`${root}${sep}`))
    throw new Error('workspace scope escapes root')
  const config = Object.freeze({
      kind: input.adapter.kind,
      id: input.adapter.id,
      model: input.adapter.model,
      executable: input.adapter.executable,
      binaryHash: input.adapter.binaryHash,
    }),
    approved = Object.freeze({
      taskRevisionId: input.capability.taskRevisionId,
      workspaceScope: input.workspaceScope,
      instructions: input.instructions,
      maxRuntimeMs: input.maxRuntimeMs,
      config,
    }),
    derivedHash = sha256(canonicalJson(approved))
  if (input.capability.specHash !== derivedHash)
    throw new Error('preparation capability does not bind approved specification')
  const prompt = `Return JSON only with code and optional patch. Do not execute tools, train, edit files, or request permissions. Approved task ${approved.taskRevisionId}: ${input.instructions}`,
    stage = await mkdtemp(`${tmpdir()}${sep}oph-cli-prep-`)
  let child: Bun.Subprocess | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const terminate = (signal: 'SIGTERM' | 'SIGKILL') => {
    if (!child) return
    if (input.processGroup !== 'daemon-worker' && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {}
    }
    if (child.exitCode === null) child.kill(signal)
  }
  try {
    child = Bun.spawn(command(input.adapter, prompt), {
      cwd: stage,
      stdout: 'pipe',
      stderr: 'pipe',
      detached: input.processGroup !== 'daemon-worker' && process.platform !== 'win32',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: input.credentialHome,
        USERPROFILE: input.credentialHome,
      },
    })
    timer = setTimeout(() => {
      timedOut = true
      // The daemon worker is a dedicated job group. This covers CLI descendants
      // that ignore a direct TERM without ever signalling the daemon's group.
      if (input.processGroup === 'daemon-worker' && process.platform !== 'win32') {
        try {
          process.kill(-process.pid, 'SIGTERM')
          return
        } catch {
          // Fall through to the owned child where process groups are unavailable.
        }
      }
      terminate('SIGTERM')
      escalation = setTimeout(() => terminate('SIGKILL'), 1000)
    }, input.maxRuntimeMs)
    const [stdout, _stderr, exit] = await Promise.all([
      read(child.stdout as ReadableStream<Uint8Array>),
      read(child.stderr as ReadableStream<Uint8Array>),
      child.exited,
    ])
    clearTimeout(timer)
    if (escalation) clearTimeout(escalation)
    if (timedOut) throw new Error('CLI preparation exceeded approved runtime')
    if (exit !== 0) throw new Error('admitted CLI preparation failed')
    const raw = JSON.parse(draftText(config.kind, stdout)) as { code?: unknown; patch?: unknown }
    if (
      typeof raw.code !== 'string' ||
      !raw.code ||
      raw.code.length > LIMIT ||
      (raw.patch !== undefined && typeof raw.patch !== 'string')
    )
      throw new Error('CLI preparation returned an invalid draft')
    const patch = typeof raw.patch === 'string' ? raw.patch : null,
      contentHash = `sha256:${createHash('sha256')
        .update(canonicalJson({ code: raw.code, patch }))
        .digest('hex')}`
    return Object.freeze({
      schema: 'research-cli-preparation-draft-v1',
      taskRevisionId: approved.taskRevisionId,
      specHash: derivedHash,
      adapter: {
        id: config.id,
        model: config.model,
        identity: `${config.kind}:${config.executable}`,
      },
      inputHash: derivedHash,
      configHash: sha256(canonicalJson(config)),
      contentHash,
      code: raw.code,
      patch,
      usage: null,
      humanApprovalRequired: true,
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (escalation) clearTimeout(escalation)
    terminate('SIGKILL')
    if (child) await child.exited.catch(() => {})
    await rm(stage, { recursive: true, force: true })
  }
}
