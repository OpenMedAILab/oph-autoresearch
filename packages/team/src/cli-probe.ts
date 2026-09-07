/** CLI 自报的登录状态和模型目录；不发送推理提示词，不读取或回传凭证。 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { DetectedCli } from './cli-detect.ts'

export interface CliModel {
  id: string
  label: string
}
export interface CliProbe {
  status: 'authenticated' | 'unauthenticated' | 'unknown' | 'error'
  models: CliModel[]
  checkedAt: number
  message: string
}
const cache = new Map<string, CliProbe>()
const pending = new Map<string, Promise<CliProbe>>()
const TTL = 5 * 60_000
const keyOf = (cli: DetectedCli, scope = 'local') => `${scope}:${cli.id}:${cli.path}`
export function cachedCliProbe(cli: DetectedCli, scope = 'local'): CliProbe | undefined {
  const result = cache.get(keyOf(cli, scope))
  return result
}

/** 有界 stdio 子进程。退出、错误和超时都收口，原始输出只在内存内解析。 */
export function cliProbeChannel(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env = process.env,
) {
  const proc = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: { ...env, NO_COLOR: '1', CI: '1' },
  })
  let stdout = '',
    buffer = '',
    failed: Error | undefined
  let closed = false
  const waiters = new Set<{
    match: (row: Record<string, unknown>) => boolean
    resolve: (row: Record<string, unknown>) => void
    reject: (e: Error) => void
  }>()
  const stop = () => {
    if (closed) return
    try {
      if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGKILL')
      else proc.kill()
    } catch {
      proc.kill()
    }
  }
  const fail = (error: Error) => {
    failed = error
    for (const w of waiters) w.reject(error)
    waiters.clear()
    stop()
  }
  proc.stdin.on('error', () => fail(new Error('CLI 通信失败')))
  proc.on('error', () => fail(new Error('CLI 无法启动')))
  let stderr = ''
  const errorDecoder = new StringDecoder('utf8')
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += errorDecoder.write(chunk)
    if (Buffer.byteLength(stderr) > 2 * 1024 * 1024) fail(new Error('CLI 探针响应过大'))
  })
  const decoder = new StringDecoder('utf8')
  proc.stdout.on('data', (chunk: Buffer) => {
    const decoded = decoder.write(chunk)
    stdout += decoded
    buffer += decoded
    if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
      fail(new Error('CLI 探针响应过大'))
      return
    }
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      try {
        const row = JSON.parse(line) as Record<string, unknown>
        for (const w of waiters)
          if (w.match(row)) {
            waiters.delete(w)
            w.resolve(row)
          }
      } catch {
        /* CLI 横幅不参与协议 */
      }
    }
  })
  const exited = new Promise<number | null>((resolve) =>
    proc.on('close', (code) => {
      closed = true
      for (const w of waiters) w.reject(failed ?? new Error('CLI 未返回有效探针响应'))
      waiters.clear()
      resolve(code)
    }),
  )
  const timer = setTimeout(() => fail(new Error('CLI 探测超时，请检查登录与网络后重试')), timeoutMs)
  return {
    send: (body: unknown) => proc.stdin.write(`${JSON.stringify(body)}\n`),
    request: (body: unknown, match: (row: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (failed || closed) {
          reject(failed ?? new Error('CLI 已退出'))
          return
        }
        waiters.add({ match, resolve, reject })
        proc.stdin.write(`${JSON.stringify(body)}\n`)
      }),
    output: async () => {
      proc.stdin.end()
      const code = await exited
      if (failed) throw failed
      return { code, stdout, stderr }
    },
    close: async () => {
      clearTimeout(timer)
      stop()
      await exited
    },
  }
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function modelList(value: unknown, idKey: string, labelKey: string): CliModel[] {
  if (!Array.isArray(value)) throw new Error('CLI 模型目录格式不受支持')
  const models = new Map<string, CliModel>()
  for (const entry of value) {
    const row = record(entry)
    const id = row[idKey]
    if (row.hidden === true || typeof id !== 'string' || !id.trim() || id.length > 200) continue
    models.set(id, { id, label: typeof row[labelKey] === 'string' ? String(row[labelKey]) : id })
  }
  return [...models.values()]
}
export type CliProbeTransport = (
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
) => Promise<ReturnType<typeof cliProbeChannel>>
const localTransport: CliProbeTransport = async (...args) => cliProbeChannel(...args)

async function codex(
  cli: DetectedCli,
  cwd: string,
  timeout: number,
  transport: CliProbeTransport,
): Promise<Omit<CliProbe, 'checkedAt'>> {
  const io = await transport(cli.path, ['app-server', '--listen', 'stdio://'], cwd, timeout)
  let id = 0
  const rpc = async (method: string, params: unknown) => {
    const current = ++id
    const reply = await io.request({ id: current, method, params }, (row) => row.id === current)
    if (reply.error) throw new Error('Codex 账户或模型查询失败，请在终端检查登录状态后重试')
    return record(reply.result)
  }
  try {
    await rpc('initialize', {
      clientInfo: { name: 'oph_cli_probe', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    })
    io.send({ method: 'initialized', params: {} })
    const account = await rpc('account/read', { refreshToken: true })
    if (!account.account && account.requiresOpenaiAuth !== false)
      return {
        status: 'unauthenticated',
        models: [],
        message: 'Codex 返回未登录，请先在终端运行 codex login',
      }
    const models: CliModel[] = []
    let cursor: unknown = null
    const seen = new Set<unknown>()
    do {
      const page = await rpc('model/list', { limit: 100, includeHidden: false, cursor })
      models.push(...modelList(page.data, 'model', 'displayName'))
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('Codex 模型目录分页异常')
      seen.add(cursor)
    } while (cursor)
    return {
      status: account.account ? 'authenticated' : 'unknown',
      models,
      message: account.account
        ? 'Codex 账户状态已读取，模型来自 CLI 实时目录'
        : '当前提供方不要求 OpenAI 登录，模型来自 CLI 目录',
    }
  } finally {
    await io.close()
  }
}
async function claude(
  cli: DetectedCli,
  cwd: string,
  timeout: number,
  transport: CliProbeTransport,
): Promise<Omit<CliProbe, 'checkedAt'>> {
  const auth = await transport(cli.path, ['auth', 'status', '--json'], cwd, timeout)
  let status: Record<string, unknown>
  try {
    const result = await auth.output()
    status = record(JSON.parse(result.stdout))
  } finally {
    await auth.close()
  }
  if (status.loggedIn === false)
    return {
      status: 'unauthenticated',
      models: [],
      message: 'Claude 返回未登录，请先在终端运行 claude auth login',
    }
  if (status.loggedIn !== true)
    return { status: 'unknown', models: [], message: 'Claude 未返回可识别的登录状态' }
  const io = await transport(
    cli.path,
    [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--settings',
      '{"disableAllHooks":true}',
      '--no-session-persistence',
    ],
    cwd,
    timeout,
  )
  try {
    const reply = await io.request(
      { type: 'control_request', request_id: 'probe', request: { subtype: 'initialize' } },
      (row) => row.type === 'control_response' && record(row.response).request_id === 'probe',
    )
    const response = record(reply.response)
    if (response.subtype !== 'success') throw new Error('Claude 模型目录查询失败')
    return {
      status: 'authenticated',
      models: modelList(record(response.response).models, 'value', 'displayName'),
      message: 'Claude 已登录，模型来自 CLI 初始化目录',
    }
  } finally {
    await io.close()
  }
}
export function parseGrokModels(stdout: string): Omit<CliProbe, 'checkedAt'> {
  if (
    /not authenticated|not logged in|please (?:log|sign) in|authentication required/i.test(stdout)
  )
    return {
      status: 'unauthenticated',
      models: [],
      message: 'Grok 返回未登录，请先在终端运行 grok login',
    }
  const block = stdout.split(/Available models:\s*/i)[1]
  const models: CliModel[] = []
  for (const line of (block ?? '').split('\n')) {
    const match = /^\s*(?:\*\s*)?(grok-[\w.:-]+)(?:\s+\(default\))?\s*$/.exec(line)
    if (match?.[1]) models.push({ id: match[1], label: match[1] })
  }
  const authenticated = /you are logged in with|you are authenticated/i.test(stdout)
  return {
    status: authenticated ? 'authenticated' : 'unknown',
    models,
    message: authenticated
      ? 'Grok 已登录，模型来自 CLI 目录'
      : models.length
        ? 'Grok 返回模型目录，但未明确确认登录状态'
        : 'Grok 未返回可识别的模型目录，请检查 CLI 登录状态',
  }
}
export async function probeCli(
  cli: DetectedCli,
  options: {
    force?: boolean
    timeoutMs?: number
    scope?: string
    transport?: CliProbeTransport
  } = {},
): Promise<CliProbe> {
  const key = keyOf(cli, options.scope)
  const cached = cachedCliProbe(cli, options.scope)
  if (!options.force && cached && Date.now() - cached.checkedAt < TTL) return cached
  if (pending.has(key)) return pending.get(key)!
  const task = (async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'oph-cli-probe-'))
    let result: CliProbe
    try {
      const timeout = options.timeoutMs ?? 20_000
      const transport = options.transport ?? localTransport
      let detail: Omit<CliProbe, 'checkedAt'>
      if (cli.id === 'codex') detail = await codex(cli, cwd, timeout, transport)
      else if (cli.id === 'claude') detail = await claude(cli, cwd, timeout, transport)
      else if (cli.id === 'grok') {
        const io = await transport(cli.path, ['models'], cwd, timeout)
        try {
          const output = await io.output()
          if (output.code !== 0) throw new Error('Grok 模型查询失败，请在终端检查登录状态')
          detail = parseGrokModels(`${output.stdout}\n${output.stderr}`)
        } finally {
          await io.close()
        }
      } else
        detail = { status: 'unknown', models: [], message: '该 CLI 暂无已验证的登录和模型查询接口' }
      result = { ...detail, checkedAt: Date.now() }
    } catch (error) {
      // 只返回本模块定义的诊断；JSON 解析器可能把原始响应片段带入错误信息。
      const message =
        error instanceof SyntaxError
          ? 'CLI 探针返回了无效 JSON'
          : error instanceof Error
            ? error.message
            : 'CLI 探测失败'
      result = { status: 'error', models: [], checkedAt: Date.now(), message }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
    cache.set(key, result)
    return result
  })()
  pending.set(key, task)
  try {
    return await task
  } finally {
    pending.delete(key)
  }
}
