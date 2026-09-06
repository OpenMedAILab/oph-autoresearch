/** 后台 CLI 目录：启动时探测，按执行位置隔离结果。 */
import { tmpdir } from 'node:os'
import {
  type CliProbe,
  type CliProbeTransport,
  cachedCliProbe,
  cliProbeChannel,
  cliTemplate,
  detectClis,
  probeCli,
} from '@oph-autoresearch/team'
import {
  loadSshProfiles,
  loadSshRecentConnections,
  prepareSshCommand,
  type SshProfile,
  setSshCliCapabilities,
  sshCredentialKey,
} from '@oph-autoresearch/tools'

export interface CliCatalogAgent {
  id: string
  provider: string
  vendor: string
  path: string
  location: string
  profileId?: string
  canRun: boolean
  connected: boolean
  probe: CliProbe | null
}
export interface CliCatalogHost {
  id: string
  label: string
  status: 'probing' | 'ready' | 'error'
  message: string
}
let agents: CliCatalogAgent[] = []
let hosts: CliCatalogHost[] = []
let pending: Promise<void> | undefined
let checkedAt = 0
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export function cliCatalogSnapshot() {
  return { agents, hosts, probing: !!pending, checkedAt }
}
export function remoteCliProvider(profileId: string, id: string) {
  return `cli:ssh:${profileId}:${id}`
}
export function parseRemoteCliProvider(provider: string) {
  const match = /^cli:ssh:([a-z0-9_-]+):(codex|claude|grok)$/i.exec(provider)
  return match ? { profileId: match[1]!, id: match[2]! } : undefined
}

export const remoteCliPath =
  'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.grok/bin:$HOME/.npm-global/bin:$PATH"; for d in "$HOME"/.nvm/versions/node/*/bin; do [ ! -d "$d" ] || PATH="$d:$PATH"; done;'
export function remoteProbeTransport(profile: SshProfile): CliProbeTransport {
  return async (command, args, cwd, timeout) => {
    // 登录 shell 读取服务器 PATH；探针在临时目录运行，不加载研究目录的项目钩子。
    const invocation = [command, ...args].map(shellQuote).join(' ')
    const script = `${remoteCliPath} cd /tmp && if command -v timeout >/dev/null 2>&1; then exec timeout ${Math.ceil(timeout / 1000)}s ${invocation}; else exec ${invocation}; fi`
    const prepared = await prepareSshCommand(profile, `bash -lc ${shellQuote(script)}`, {
      timeoutMs: 10_000,
    })
    try {
      const io = cliProbeChannel(
        prepared.argv[0]!,
        prepared.argv.slice(1),
        cwd,
        timeout + 10_000,
        prepared.env,
      )
      return {
        ...io,
        close: async () => {
          try {
            await io.close()
          } finally {
            await prepared.cleanup()
          }
        },
      }
    } catch (error) {
      await prepared.cleanup()
      throw error
    }
  }
}

export async function probeRemoteHost(profile: SshProfile): Promise<CliCatalogAgent[]> {
  const transport = remoteProbeTransport(profile)
  const scan = `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.grok/bin:$HOME/.npm-global/bin:$PATH"; for d in "$HOME"/.nvm/versions/node/*/bin; do [ ! -d "$d" ] || PATH="$d:$PATH"; done; for c in codex claude grok; do p=$(command -v "$c" 2>/dev/null) || continue; case "$p" in /*) printf '%s\\t%s\\n' "$c" "$p";; esac; done`
  const io = await transport('bash', ['-lc', scan], tmpdir(), 15_000)
  let stdout: string
  try {
    const result = await io.output()
    if (result.code !== 0) throw new Error('SSH 连接或 CLI 安装查询失败，请检查服务器连接')
    stdout = result.stdout
  } finally {
    await io.close()
  }
  const rows: CliCatalogAgent[] = []
  for (const line of stdout.split('\n')) {
    const [id, path] = line.split('\t')
    if (!id || !path?.startsWith('/')) continue
    const cli = cliTemplate(id, path.trim())
    if (!cli || !['codex', 'claude', 'grok'].includes(id)) continue
    const probe = await probeCli(cli, {
      force: true,
      scope: `ssh:${sshCredentialKey(profile)}`,
      transport,
    })
    rows.push({
      id,
      provider: remoteCliProvider(profile.id, id),
      vendor: cli.vendor,
      path: cli.path,
      location: `服务器 · ${profile.name}`,
      profileId: profile.id,
      canRun: !profile.readOnly,
      connected: probe.status === 'authenticated',
      probe,
    })
  }
  return rows
}

/** 合并相同服务器，优先使用可写项目。最近连接还没保存为项目也能探测。 */
export async function cliSshTargets(): Promise<SshProfile[]> {
  const profiles = await loadSshProfiles()
  const result = new Map<string, SshProfile>()
  for (const profile of profiles) {
    const key = sshCredentialKey(profile)
    if (!result.has(key) || (result.get(key)!.readOnly && !profile.readOnly))
      result.set(key, profile)
  }
  for (const recent of await loadSshRecentConnections()) {
    const key = sshCredentialKey(recent)
    if (result.has(key)) continue
    result.set(key, {
      ...recent,
      id: `recent-${Bun.hash(key).toString(16)}`,
      name: recent.host,
      root: recent.lastPath ?? recent.home,
      readOnly: true,
    })
  }
  return [...result.values()]
}
export function refreshCliCatalog(force = false): Promise<void> {
  if (pending) return pending
  if (!force && checkedAt && Date.now() - checkedAt < 5 * 60_000) return Promise.resolve()
  const task = async () => {
    const local = async () => {
      const installed = await detectClis()
      agents = [
        ...agents.filter((a) => a.profileId),
        ...installed.map((cli) => ({
          id: cli.id,
          provider: `cli:${cli.id}`,
          vendor: cli.vendor,
          path: cli.path,
          location: '本机',
          canRun: true,
          connected: false,
          probe: cachedCliProbe(cli) ?? null,
        })),
      ]
      await Promise.all(
        installed.map(async (cli) => {
          const probe = await probeCli(cli, { force })
          agents = agents.map((a) =>
            a.provider === `cli:${cli.id}`
              ? { ...a, connected: probe.status === 'authenticated', probe }
              : a,
          )
        }),
      )
    }
    const remote = async () => {
      const profiles = await cliSshTargets()
      agents = agents.filter((a) => !a.profileId || profiles.some((p) => p.id === a.profileId))
      hosts = profiles.map((p) => ({
        id: p.id,
        label: p.name,
        status: 'probing',
        message: '正在查询远程 CLI',
      }))
      // 最多两台服务器并发，离线服务器不会阻塞本机目录。
      const queue = [...profiles]
      await Promise.all(
        [0, 1].map(async () => {
          while (queue.length) {
            const current = queue.shift()!
            setSshCliCapabilities(current, [])
            agents = agents.filter((a) => a.profileId !== current.id)
            try {
              const found = await probeRemoteHost(current)
              setSshCliCapabilities(
                current,
                found.map((a) => ({
                  id: a.id,
                  path: a.path,
                  status: a.probe?.status ?? 'unknown',
                  models: a.probe?.models ?? [],
                  checkedAt: a.probe?.checkedAt ?? Date.now(),
                })),
              )
              agents = [...agents.filter((a) => a.profileId !== current.id), ...found]
              hosts = hosts.map((h) =>
                h.id === current.id
                  ? {
                      ...h,
                      status: 'ready',
                      message: found.length ? `发现 ${found.length} 个 CLI` : '未发现支持的 CLI',
                    }
                  : h,
              )
            } catch {
              hosts = hosts.map((h) =>
                h.id === current.id
                  ? {
                      ...h,
                      status: 'error',
                      message: '服务器探测失败，请检查 SSH 连接、认证与网络',
                    }
                  : h,
              )
            }
          }
        }),
      )
    }
    await Promise.all([local(), remote()])
    checkedAt = Date.now()
  }
  pending = task().finally(() => {
    pending = undefined
  })
  return pending
}

let scheduled = false
export function scheduleCliRefresh(): void {
  // 自动网络探测不进入测试沙箱；测试显式调用带假 SSH 的探针。
  if (process.env.OPH_AUTORESEARCH_TEST_TEMP) return
  if (scheduled) return
  scheduled = true
  void (async () => {
    try {
      await pending
    } catch {
      /* 连接变更后仍重试 */
    }
    scheduled = false
    await refreshCliCatalog(true)
  })().catch(() => undefined)
}
