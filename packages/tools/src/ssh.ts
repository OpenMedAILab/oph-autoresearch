/**
 * 受控 SSH 数据访问。
 *
 * 系统密钥交给 OpenSSH（ssh config / ssh-agent）；用户显式提供的密码或私钥默认只留在当前
 * 进程内存中，**经用户确认保存后**进入 `ssh.json` 的 `credentials` 段（文件权限 0600），
 * 供下次连接自动使用；认证失败时该条会被清除、要求重新输入。
 * 界面与 Agent 共用同一份 profile、临时凭证和路径边界，避免“界面看得到，
 * 模型却用另一条命令绕开”的双轨实现。私钥落地只发生在单次 ssh 子进程的临时文件中，
 * 子进程结束后立即删除。
 */

import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import type { ToolSpec } from '@oph-autoresearch/agent'
import { collectProcess } from './sandbox.ts'
import { globalScopeRoot } from './scopes.ts'

export interface SshProfile {
  id: string
  name: string
  host: string
  username?: string
  port: number
  root: string
  readOnly: boolean
  hostKeyPolicy: 'strict' | 'accept-new'
}

export interface SshEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtime: number
}

export interface SshCommandTarget {
  host: string
  username?: string
  port: number
}

export type SshTargetInput = {
  host: string
  username?: string
  port?: number | string
}

export type SshAuthMode = 'system-key' | 'private-key' | 'password'

/**
 * 最近成功连接过的主机。这里只保存重新连接所需的非敏感元数据；密码、私钥和口令
 * 存在文档里单独的 `credentials` 段（见 `saveSshCredential`），不进这一条。
 * `lastPath` 是用户最近确认为数据工作区的目录。
 */
export interface SshRecentConnection extends SshCommandTarget {
  authMode: SshAuthMode
  hostKeyPolicy: SshProfile['hostKeyPolicy']
  home: string
  lastPath?: string
  lastConnectedAt: number
}

export type SshConnectionAuth =
  | { mode: 'password'; password: string }
  | { mode: 'private-key'; privateKey: string; passphrase?: string }

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i
const HOST = /^[a-z0-9._:[\]-]+$/i
const USER = /^[a-z0-9._-]+$/i
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
const MAX_RECENT_CONNECTIONS = 12
const sessionCredentials = new Map<string, SshConnectionAuth>()

/** 保存的凭证按「用户@主机:端口」记，与内存凭证表同一个键。 */
export type SshCredentialKey = string

interface SshConfigDocument {
  profiles: SshProfile[]
  recentConnections: SshRecentConnection[]
  credentials: Record<SshCredentialKey, SshConnectionAuth>
}

type SshExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  authMode: 'system-key' | SshConnectionAuth['mode']
}

export function normalizePrivateKey(value: string): string {
  if (!value || value.length > 1024 * 1024 || value.includes('\0')) {
    throw new Error('请输入有效的 SSH 私钥')
  }
  const normalized = value.trim().replace(/\r\n/g, '\n')
  if (/^PuTTY-User-Key-File-/i.test(normalized)) {
    throw new Error('暂不支持 PuTTY PPK；请先导出为 OpenSSH 私钥格式')
  }
  const match = /^-----BEGIN (?:(OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----$/m.exec(
    normalized,
  )
  if (!match) throw new Error('私钥格式无效：请选择或粘贴 OpenSSH、PEM 私钥')
  const end = `-----END ${match[1] ? `${match[1]} ` : ''}PRIVATE KEY-----`
  if (!normalized.endsWith(end)) throw new Error('私钥内容不完整，缺少结束标记')
  return `${normalized}\n`
}

/**
 * 接受与 VS Code Remote SSH 最常用的一条入口相同的命令形状。
 *
 * 高级跳板机、IdentityFile、证书等继续交给 ~/.ssh/config；这里故意不接收 `-i`，
 * 否则私钥路径会被写进应用配置。也不把整条命令交给 shell，解析后的三个字段才会
 * 进入 Bun.spawn 的参数数组。
 */
export function parseSshCommand(command: string): SshCommandTarget {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens[0]?.toLowerCase() !== 'ssh') throw new Error('请输入以 ssh 开头的连接命令')
  let port = 22
  let username = ''
  let destination = ''
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '-p' || token === '-l') {
      const value = tokens[++i]
      if (!value) throw new Error(`${token} 后缺少参数`)
      if (token === '-p') port = Number(value)
      else username = value
      continue
    }
    if (token.startsWith('-p') && token.length > 2) {
      port = Number(token.slice(2))
      continue
    }
    if (token.startsWith('-l') && token.length > 2) {
      username = token.slice(2)
      continue
    }
    if (token.startsWith('-')) {
      throw new Error(`暂不直接保存 SSH 参数 ${token}；请把高级选项写入 ~/.ssh/config`)
    }
    if (destination) throw new Error('SSH 命令只能包含一个目标主机')
    destination = token
  }
  if (!destination) throw new Error('SSH 命令缺少目标主机')
  const at = destination.lastIndexOf('@')
  const host = at > 0 ? destination.slice(at + 1) : destination
  if (at > 0 && !username) username = destination.slice(0, at)
  if (!HOST.test(host) || (username && !USER.test(username)))
    throw new Error('SSH 用户名或主机无效')
  if (
    /^\d+(?:\.\d+){3}$/.test(host) &&
    host.split('.').some((part) => Number(part) < 0 || Number(part) > 255)
  ) {
    throw new Error('IPv4 地址无效：每一段都必须在 0 到 255 之间')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口无效')
  return { host, ...(username ? { username } : {}), port }
}

/**
 * 校验来自表单/API 的独立连接字段。UI 不再拼接或提交整条 SSH 命令；后端只把
 * 这三个经过白名单校验的值放进 OpenSSH 参数数组。
 */
export function normalizeSshTarget(input: SshTargetInput): SshCommandTarget {
  const host = String(input.host ?? '').trim()
  const username = String(input.username ?? '').trim()
  const port = Number(input.port ?? 22)
  if (!host) throw new Error('请输入 SSH 主机地址')
  if (!validHost(host)) {
    if (
      /^\d+(?:\.\d+){3}$/.test(host) &&
      host.split('.').some((part) => Number(part) < 0 || Number(part) > 255)
    ) {
      throw new Error('IPv4 地址无效：每一段都必须在 0 到 255 之间')
    }
    throw new Error('SSH 主机地址无效')
  }
  if (username && !USER.test(username)) throw new Error('SSH 用户名无效')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口无效')
  return { host, ...(username ? { username } : {}), port }
}

export function sshTargetProfile(
  target: SshTargetInput,
  hostKeyPolicy: SshProfile['hostKeyPolicy'] = 'accept-new',
): SshProfile {
  const normalized = normalizeSshTarget(target)
  return {
    id: 'remote-session',
    name: normalized.host,
    ...normalized,
    root: '/',
    readOnly: true,
    hostKeyPolicy,
  }
}

export function sshCommandProfile(
  command: string,
  hostKeyPolicy: SshProfile['hostKeyPolicy'] = 'accept-new',
): SshProfile {
  const parsed = parseSshCommand(command)
  return {
    id: 'remote-session',
    name: parsed.host,
    ...parsed,
    root: '/',
    readOnly: true,
    hostKeyPolicy,
  }
}

export function sshConfigPath(): string {
  return join(globalScopeRoot(), 'ssh.json')
}

async function loadSshConfigDocument(): Promise<SshConfigDocument> {
  const parsed = await readFile(sshConfigPath(), 'utf8')
    .then(
      (raw) =>
        JSON.parse(raw) as {
          profiles?: unknown
          recentConnections?: unknown
          credentials?: unknown
        },
    )
    .catch(() => ({ profiles: [], recentConnections: [], credentials: {} }))
  return {
    profiles: Array.isArray(parsed.profiles)
      ? parsed.profiles.map(normalizeProfile).filter((p): p is SshProfile => p !== null)
      : [],
    recentConnections: Array.isArray(parsed.recentConnections)
      ? parsed.recentConnections
          .map(normalizeRecentConnection)
          .filter((p): p is SshRecentConnection => p !== null)
          .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
          .slice(0, MAX_RECENT_CONNECTIONS)
      : [],
    credentials: normalizeCredentials(parsed.credentials),
  }
}

/** 凭证段整体校验：坏条目直接丢——某条被手工改坏不该让整份配置读不出来。 */
function normalizeCredentials(raw: unknown): Record<string, SshConnectionAuth> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SshConnectionAuth> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim() || !value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (v.mode === 'password' && typeof v.password === 'string' && validSecret(v.password, 4096)) {
      out[key] = { mode: 'password', password: v.password }
    } else if (
      v.mode === 'private-key' &&
      typeof v.privateKey === 'string' &&
      validSecret(v.privateKey, 1024 * 1024) &&
      (v.passphrase === undefined ||
        (typeof v.passphrase === 'string' && validSecret(v.passphrase, 4096)))
    ) {
      out[key] = {
        mode: 'private-key',
        privateKey: v.privateKey,
        ...(typeof v.passphrase === 'string' ? { passphrase: v.passphrase } : {}),
      }
    }
  }
  return out
}

function validSecret(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !value.includes('\0')
}

async function saveSshConfigDocument(document: SshConfigDocument): Promise<void> {
  const file = sshConfigPath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  // 凭证段在文件里，权限必须收住；Windows 上 chmod 是空操作，靠用户目录 ACL。
  await chmod(file, 0o600).catch(() => undefined)
}

export async function loadSshProfiles(): Promise<SshProfile[]> {
  return (await loadSshConfigDocument()).profiles
}

export async function loadSshRecentConnections(): Promise<SshRecentConnection[]> {
  return (await loadSshConfigDocument()).recentConnections
}

export async function saveSshProfiles(input: unknown): Promise<SshProfile[]> {
  if (!Array.isArray(input)) throw new Error('profiles 必须是数组')
  const profiles = input.map((raw, i) => {
    const profile = normalizeProfile(raw)
    if (!profile) throw new Error(`第 ${i + 1} 条 SSH 配置无效`)
    return profile
  })
  const ids = new Set<string>()
  for (const p of profiles) {
    if (ids.has(p.id)) throw new Error(`SSH 标识重复：${p.id}`)
    ids.add(p.id)
  }
  const current = await loadSshConfigDocument()
  await saveSshConfigDocument({ ...current, profiles })
  return profiles
}

/** 记录一次成功连接；同一用户、主机和端口只保留最新一条。 */
export async function recordSshConnection(
  target: SshCommandTarget,
  options: {
    authMode: SshAuthMode
    hostKeyPolicy: SshProfile['hostKeyPolicy']
    home: string
    lastPath?: string
    connectedAt?: number
  },
): Promise<SshRecentConnection[]> {
  const home = normalizeRoot(options.home)
  const lastPath = options.lastPath ? normalizeRoot(options.lastPath) : undefined
  if (!validHost(target.host) || (target.username && !USER.test(target.username))) {
    throw new Error('SSH 用户名或主机无效')
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !home) {
    throw new Error('SSH 最近连接记录无效')
  }
  const recent: SshRecentConnection = {
    host: target.host,
    ...(target.username ? { username: target.username } : {}),
    port: target.port,
    authMode: options.authMode,
    hostKeyPolicy: options.hostKeyPolicy,
    home,
    ...(lastPath ? { lastPath } : {}),
    lastConnectedAt: options.connectedAt ?? Date.now(),
  }
  const current = await loadSshConfigDocument()
  const sameTarget = (candidate: SshRecentConnection) =>
    candidate.host.toLowerCase() === recent.host.toLowerCase() &&
    candidate.username === recent.username &&
    candidate.port === recent.port
  const previous = current.recentConnections.find(sameTarget)
  const merged = {
    ...recent,
    ...(recent.lastPath ? {} : previous?.lastPath ? { lastPath: previous.lastPath } : {}),
  }
  const recentConnections = [
    merged,
    ...current.recentConnections.filter((item) => !sameTarget(item)),
  ]
    .sort((a, b) => b.lastConnectedAt - a.lastConnectedAt)
    .slice(0, MAX_RECENT_CONNECTIONS)
  await saveSshConfigDocument({ ...current, recentConnections })
  return recentConnections
}

/** 凭证段的键：用户@主机:端口。与内存凭证表 `credentialKey` 同一形状。 */
export function sshCredentialKey(target: SshCommandTarget): SshCredentialKey {
  return `${target.username ?? ''}@${target.host}:${target.port}`
}

/**
 * 保存一条连接凭证，覆盖同键旧值。
 *
 * **只在连接成功之后调用**：错的密码不该落盘。这里是明文存储，文件权限已收成
 * 0600；认证失败时由连接流程调用 `clearSshCredential` 清除。
 */
export async function saveSshCredential(
  target: SshCommandTarget,
  auth: SshConnectionAuth,
): Promise<void> {
  const key = sshCredentialKey(target)
  const current = await loadSshConfigDocument()
  await saveSshConfigDocument({ ...current, credentials: { ...current.credentials, [key]: auth } })
}

export async function loadSshCredential(
  target: SshCommandTarget,
): Promise<SshConnectionAuth | undefined> {
  const credentials = await loadSshCredentials()
  return credentials[sshCredentialKey(target)]
}

export async function clearSshCredential(target: SshCommandTarget): Promise<void> {
  const key = sshCredentialKey(target)
  const current = await loadSshConfigDocument()
  if (!(key in current.credentials)) return
  const credentials = { ...current.credentials }
  delete credentials[key]
  await saveSshConfigDocument({ ...current, credentials })
}

/**
 * 忘掉一条最近连接：从 `recentConnections` 移除同键条目，并按同一键清除
 * 已保存的凭证（若有）。用户删除连接记录通常就是为了清理这一个目标，
 * 凭证留着会让「下次自动使用」变成猜不透的行为。
 */
export async function forgetSshRecentConnection(
  target: SshCommandTarget,
): Promise<SshRecentConnection[]> {
  const key = sshCredentialKey(target)
  const current = await loadSshConfigDocument()
  const sameTarget = (candidate: SshRecentConnection) =>
    candidate.host.toLowerCase() === target.host.toLowerCase() &&
    candidate.username === target.username &&
    candidate.port === target.port
  const recentConnections = current.recentConnections.filter((item) => !sameTarget(item))
  const credentials = { ...current.credentials }
  delete credentials[key]
  await saveSshConfigDocument({ ...current, recentConnections, credentials })
  return recentConnections
}

export async function loadSshCredentials(): Promise<Record<SshCredentialKey, SshConnectionAuth>> {
  return (await loadSshConfigDocument()).credentials
}

function normalizeProfile(raw: unknown): SshProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const id = typeof p.id === 'string' ? p.id.trim() : ''
  const host = typeof p.host === 'string' ? p.host.trim() : ''
  const username = typeof p.username === 'string' ? p.username.trim() : ''
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  const port = Number(p.port ?? 22)
  const root = normalizeRoot(typeof p.root === 'string' ? p.root : '/')
  const hostKeyPolicy = p.hostKeyPolicy === 'accept-new' ? 'accept-new' : 'strict'
  if (!PROFILE_ID.test(id) || !validHost(host) || (username && !USER.test(username))) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !root) return null
  return {
    id,
    name: name || id,
    host,
    ...(username ? { username } : {}),
    port,
    root,
    readOnly: p.readOnly !== false,
    hostKeyPolicy,
  }
}

function normalizeRecentConnection(raw: unknown): SshRecentConnection | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  const username = typeof value.username === 'string' ? value.username.trim() : ''
  const port = Number(value.port ?? 22)
  const home = normalizeRoot(typeof value.home === 'string' ? value.home : '/')
  const lastPath =
    typeof value.lastPath === 'string' && value.lastPath.trim()
      ? normalizeRoot(value.lastPath)
      : undefined
  const authMode = value.authMode
  const lastConnectedAt = Number(value.lastConnectedAt)
  if (
    !validHost(host) ||
    (username && !USER.test(username)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !home ||
    (value.lastPath && !lastPath) ||
    !['system-key', 'private-key', 'password'].includes(String(authMode)) ||
    !Number.isFinite(lastConnectedAt) ||
    lastConnectedAt <= 0
  ) {
    return null
  }
  return {
    host,
    ...(username ? { username } : {}),
    port,
    authMode: authMode as SshAuthMode,
    hostKeyPolicy: value.hostKeyPolicy === 'strict' ? 'strict' : 'accept-new',
    home,
    ...(lastPath ? { lastPath } : {}),
    lastConnectedAt,
  }
}

function validHost(host: string): boolean {
  if (!HOST.test(host)) return false
  return !(
    /^\d+(?:\.\d+){3}$/.test(host) &&
    host.split('.').some((part) => Number(part) < 0 || Number(part) > 255)
  )
}

function normalizeRoot(value: string): string | null {
  const root = posix.normalize(value.trim().replaceAll('\\', '/'))
  return root.startsWith('/') ? root : null
}

export function resolveSshPath(profile: SshProfile, requested?: string): string {
  const root = profile.root === '/' ? '/' : profile.root.replace(/\/$/, '')
  const raw = (requested ?? '').trim().replaceAll('\\', '/')
  const candidate = raw.startsWith('/') ? posix.normalize(raw) : posix.resolve(root, raw || '.')
  if (root !== '/' && candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`远程路径越过允许根目录 ${root}`)
  }
  return candidate
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** 远端再按 realpath 校验一次，避免根目录内的符号链接跳到 /etc 等边界外。 */
function remotePathGuard(profile: SshProfile, path: string): string {
  return (
    `root=$(realpath -e ${quote(profile.root)}) || exit $?; ` +
    `path=$(realpath -e ${quote(path)}) || exit $?; ` +
    `if [ "$root" != "/" ]; then case "$path" in "$root"|"$root"/*) ;; ` +
    `*) echo "远程路径越过允许根目录" >&2; exit 66;; esac; fi; `
  )
}

function target(profile: SshProfile): string {
  return profile.username ? `${profile.username}@${profile.host}` : profile.host
}

function credentialKey(profile: SshProfile): string {
  return `${profile.username ?? ''}@${profile.host}:${profile.port}`
}

function authLabel(mode: SshExecResult['authMode']): string {
  if (mode === 'password') return '临时密码'
  if (mode === 'private-key') return '临时私钥'
  return '系统密钥'
}

function askpassPath(): string {
  const configured = process.env.OPH_SSH_ASKPASS_PATH
  const sibling = join(
    dirname(process.execPath),
    process.platform === 'win32' ? 'oph-ssh-askpass.exe' : 'oph-ssh-askpass',
  )
  const path = configured || sibling
  if (!existsSync(path)) {
    throw new Error('安全认证组件缺失，请重新安装桌面应用；系统密钥认证仍可继续使用')
  }
  return path
}

async function sshExec(
  profile: SshProfile,
  command: string,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    onChunk?: (s: string) => void
    auth?: SshConnectionAuth
  } = {},
): Promise<SshExecResult> {
  const auth = options.auth ?? sessionCredentials.get(credentialKey(profile))
  const authMode = auth?.mode ?? 'system-key'
  let tempDir = ''
  let privateKeyPath = ''
  if (auth?.mode === 'private-key') {
    const privateKey = normalizePrivateKey(auth.privateKey)
    tempDir = await mkdtemp(join(tmpdir(), 'oph-ssh-key-'))
    privateKeyPath = join(tempDir, 'identity')
    try {
      await writeFile(privateKeyPath, privateKey, { mode: 0o600 })
    } catch (error) {
      await rmdir(tempDir).catch(() => undefined)
      throw error
    }
  }
  const askpassSecret =
    auth?.mode === 'password'
      ? auth.password
      : auth?.mode === 'private-key'
        ? auth.passphrase
        : undefined
  const args = [
    '-o',
    `BatchMode=${askpassSecret === undefined ? 'yes' : 'no'}`,
    ...(auth?.mode === 'password'
      ? [
          '-o',
          'PreferredAuthentications=password,keyboard-interactive',
          '-o',
          'PubkeyAuthentication=no',
          '-o',
          'NumberOfPasswordPrompts=1',
        ]
      : auth?.mode === 'private-key'
        ? [
            '-o',
            'PreferredAuthentications=publickey',
            '-o',
            'IdentitiesOnly=yes',
            '-i',
            privateKeyPath,
            ...(askpassSecret === undefined ? [] : ['-o', 'NumberOfPasswordPrompts=1']),
          ]
        : []),
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil((options.timeoutMs ?? 15_000) / 1000))}`,
    '-o',
    `StrictHostKeyChecking=${profile.hostKeyPolicy === 'accept-new' ? 'accept-new' : 'yes'}`,
    '-p',
    String(profile.port),
    target(profile),
    command,
  ]
  const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
  if (askpassSecret !== undefined) {
    Object.assign(env, {
      SSH_ASKPASS: askpassPath(),
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || 'oph-autoresearch',
      OPH_SSH_ASKPASS_MODE: '1',
      OPH_SSH_ASKPASS_SECRET: askpassSecret,
    })
  }
  try {
    const proc = Bun.spawn(['ssh', ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
    const got = await collectProcess(proc, {
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onChunk
        ? {
            onText: (channel: 'stdout' | 'stderr', text: string) => {
              if (channel === 'stdout') options.onChunk?.(text)
              return text
            },
          }
        : {}),
    })
    return {
      stdout: got.stdout,
      stderr: got.stderr,
      exitCode: got.exitCode,
      timedOut: got.timedOut,
      authMode,
    }
  } finally {
    if (privateKeyPath) await rm(privateKeyPath, { force: true }).catch(() => undefined)
    if (tempDir) await rmdir(tempDir).catch(() => undefined)
  }
}

/** 建立临时只读会话并取得远端 HOME；不会把连接写入配置。 */
export async function connectSshCommand(
  command: string,
  hostKeyPolicy: SshProfile['hostKeyPolicy'] = 'accept-new',
  auth?: SshConnectionAuth,
): Promise<{ profile: SshProfile; home: string; message: string }> {
  return connectSshTarget(parseSshCommand(command), hostKeyPolicy, auth)
}

/** 由独立用户名、主机和端口建立连接；OpenSSH 命令参数只在后端组装。 */
export async function connectSshTarget(
  targetInput: SshTargetInput,
  hostKeyPolicy: SshProfile['hostKeyPolicy'] = 'accept-new',
  auth?: SshConnectionAuth,
): Promise<{ profile: SshProfile; home: string; message: string }> {
  const profile = sshTargetProfile(targetInput, hostKeyPolicy)
  const result = await sshExec(profile, `printf '__OPH_SSH_OK__\\n'; printf '%s' "$HOME"`, {
    timeoutMs: 20_000,
    ...(auth ? { auth } : {}),
  })
  if (result.exitCode !== 0 || !result.stdout.startsWith('__OPH_SSH_OK__\n')) {
    throw new Error(sshError(result))
  }
  if (auth) sessionCredentials.set(credentialKey(profile), auth)
  const home = posix.normalize(result.stdout.slice('__OPH_SSH_OK__\n'.length).trim() || '/')
  return {
    profile,
    home: home.startsWith('/') ? home : '/',
    message: `已连接 ${target(profile)}:${profile.port}（${authLabel(result.authMode)}认证）`,
  }
}

/** 校验并返回可作为工作区的真实远程目录。 */
export async function inspectSshDirectory(profile: SshProfile, requested: string): Promise<string> {
  const path = resolveSshPath(profile, requested)
  const result = await sshExec(
    profile,
    `${remotePathGuard(profile, path)}test -d "$path" || exit 67; cd "$path" && pwd -P`,
    { timeoutMs: 20_000 },
  )
  if (result.exitCode !== 0) throw new Error(sshError(result))
  const resolved = posix.normalize(result.stdout.trim())
  if (!resolved.startsWith('/')) throw new Error('远程目录返回了无效路径')
  return resolved
}

/**
 * 删除远程条目（目录连同内容）。**拒绝删除允许根目录本身**——其余一切交给远端
 * realpath 守卫（`remotePathGuard`），删除的是真实路径、越界的符号链接会先被拒。
 * 这是界面上的显式破坏性操作，不在 Agent 工具面里提供。
 */
export async function deleteSshEntry(profile: SshProfile, requested: string): Promise<string> {
  const path = resolveSshPath(profile, requested)
  if (path === profile.root) throw new Error('不能删除连接根目录')
  const result = await sshExec(
    profile,
    `${remotePathGuard(profile, path)}rm -rf -- "$path" && printf '__OPH_REMOVED__'`,
    { timeoutMs: 120_000 },
  )
  if (result.exitCode !== 0 || !result.stdout.includes('__OPH_REMOVED__')) {
    throw new Error(sshError(result))
  }
  return path
}

/** 只为界面内联预览读取有限字节，不创建本地文件，也不提供保存入口。 */
export async function readSshBinary(
  profile: SshProfile,
  requested: string,
  maxBytes = 8 * 1024 * 1024,
): Promise<{ path: string; base64: string; size: number }> {
  const path = resolveSshPath(profile, requested)
  const cap = Math.min(32 * 1024 * 1024, Math.max(1, Math.trunc(maxBytes)))
  const command =
    remotePathGuard(profile, path) +
    `size=$(wc -c < "$path") || exit $?; ` +
    `if [ "$size" -gt ${cap} ]; then echo "文件超过内联预览上限：$size bytes" >&2; exit 65; fi; ` +
    `printf '__OPH_SIZE__:%s\\n' "$size"; base64 "$path" | tr -d '\\n'`
  const result = await sshExec(profile, command, { timeoutMs: 60_000 })
  if (result.exitCode !== 0) throw new Error(sshError(result))
  const newline = result.stdout.indexOf('\n')
  const marker = newline >= 0 ? result.stdout.slice(0, newline) : ''
  const size = Number(marker.replace('__OPH_SIZE__:', ''))
  if (!marker.startsWith('__OPH_SIZE__:') || !Number.isFinite(size)) {
    throw new Error('远程文件预览响应无效')
  }
  return { path, size, base64: result.stdout.slice(newline + 1).trim() }
}

function sshError(result: SshExecResult): string {
  if (result.timedOut) return 'SSH 连接超时'
  if (/incorrect passphrase|bad passphrase/i.test(result.stderr)) return '私钥口令错误。'
  if (/Load key .*invalid format|error in libcrypto/i.test(result.stderr))
    return 'SSH 私钥格式无效；请选择 OpenSSH 或 PEM 私钥。'
  if (/Permission denied/i.test(result.stderr)) {
    if (result.authMode === 'password') {
      return 'SSH 认证失败：用户名或密码错误，或者服务器禁止了密码登录。'
    }
    if (result.authMode === 'private-key') {
      return 'SSH 认证失败：服务器未接受所选私钥。请确认登录用户名，以及对应公钥已加入服务器的 ~/.ssh/authorized_keys。'
    }
    return 'SSH 认证失败：服务器未接受系统密钥。请选择“私钥文件/粘贴”或“密码认证”，也可以把本机公钥加入服务器的 ~/.ssh/authorized_keys。'
  }
  if (/Connection refused/i.test(result.stderr))
    return 'SSH 连接被拒绝：请检查端口和服务器 SSH 服务。'
  if (
    /Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(
      result.stderr,
    )
  )
    return '无法解析 SSH 主机：请检查主机名或 IP 地址；IPv4 的每一段必须在 0 到 255 之间。'
  if (/No route to host|Network is unreachable/i.test(result.stderr))
    return '无法到达 SSH 主机：请检查地址、网络和防火墙。'
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(result.stderr))
    return 'SSH 主机密钥校验失败：服务器密钥可能已变化，请先在系统 known_hosts 中核实并更新。'
  if (/Connection reset|Connection closed/i.test(result.stderr))
    return 'SSH 连接被服务器中断：请检查 SSH 服务、登录策略和安全组规则。'
  const tail = result.stderr
    .trim()
    .split('\n')
    .filter((line) => !/^Warning: Permanently added/i.test(line.trim()))
    .slice(-4)
    .join('\n')
  return tail || `ssh 退出码 ${result.exitCode}`
}

export async function testSshProfile(
  profile: SshProfile,
): Promise<{ ok: boolean; message: string }> {
  const result = await sshExec(profile, "printf '__OPH_SSH_OK__'")
  return result.exitCode === 0 && result.stdout.includes('__OPH_SSH_OK__')
    ? { ok: true, message: `已连接 ${target(profile)}:${profile.port}` }
    : { ok: false, message: sshError(result) }
}

export async function listSshFiles(profile: SshProfile, requested?: string): Promise<SshEntry[]> {
  const path = resolveSshPath(profile, requested)
  const script =
    remotePathGuard(profile, path) +
    `find "$path" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' | head -n 2000`
  const result = await sshExec(profile, script, { timeoutMs: 20_000 })
  if (result.exitCode !== 0) throw new Error(sshError(result))
  const entries: SshEntry[] = []
  for (const line of result.stdout.split('\n')) {
    if (!line) continue
    const [type, sizeRaw, timeRaw, ...nameParts] = line.split('\t')
    const name = nameParts.join('\t')
    if (!name || name === '.' || name === '..') continue
    const kind = type === 'd' ? 'dir' : type === 'f' ? 'file' : type === 'l' ? 'link' : 'other'
    entries.push({
      name,
      path: posix.join(path, name),
      kind,
      size: Number(sizeRaw) || 0,
      mtime: Math.round((Number(timeRaw) || 0) * 1000),
    })
  }
  return entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  )
}

export async function readSshText(
  profile: SshProfile,
  requested: string,
  offset = 1,
  limit = 2000,
): Promise<{ path: string; content: string; truncated: boolean }> {
  const path = resolveSshPath(profile, requested)
  const start = Math.max(1, Math.trunc(offset))
  const count = Math.min(5000, Math.max(1, Math.trunc(limit)))
  const end = start + count
  const script =
    remotePathGuard(profile, path) +
    `size=$(wc -c < "$path") || exit $?; ` +
    `if [ "$size" -gt ${MAX_TEXT_BYTES} ]; then echo "__OPH_TOO_LARGE__:$size" >&2; exit 65; fi; ` +
    `sed -n '${start},${end}p' "$path"`
  const result = await sshExec(profile, script, { timeoutMs: 30_000 })
  if (result.exitCode !== 0) throw new Error(sshError(result))
  const lines = result.stdout.replace(/\r\n/g, '\n').split('\n')
  const truncated = lines.length > count
  return { path, content: lines.slice(0, count).join('\n'), truncated }
}

/**
 * 整读文本文件（HTML / Markdown / 源码等预览用）：不按行截断，只按字节上限。
 *
 * 预览族里按行截断只适合「大日志」这类数据；HTML 和 Markdown 是**一份完整文档**，
 * 截前 5000 行等于渲染一个坏掉的页面——「预览不全」就是这么来的。
 */
export async function readSshWholeText(
  profile: SshProfile,
  requested: string,
): Promise<{ path: string; content: string; size: number; truncated: boolean }> {
  const path = resolveSshPath(profile, requested)
  const command =
    remotePathGuard(profile, path) +
    `size=$(wc -c < "$path") || exit $?; ` +
    `printf '__OPH_SIZE__:%s\\\\n' "$size"; head -c ${MAX_TEXT_BYTES} "$path"`
  const result = await sshExec(profile, command, { timeoutMs: 60_000 })
  if (result.exitCode !== 0) throw new Error(sshError(result))
  const newline = result.stdout.indexOf('\n')
  const marker = newline >= 0 ? result.stdout.slice(0, newline) : ''
  const size = Number(marker.replace('__OPH_SIZE__:', ''))
  if (!marker.startsWith('__OPH_SIZE__:') || !Number.isFinite(size)) {
    throw new Error('远程文件预览响应无效')
  }
  return {
    path,
    size,
    content: result.stdout.slice(newline + 1),
    truncated: size > MAX_TEXT_BYTES,
  }
}

async function findProfile(id: string): Promise<SshProfile> {
  const profile = (await loadSshProfiles()).find((p) => p.id === id)
  if (!profile) throw new Error(`找不到 SSH 连接：${id}`)
  return profile
}

export const sshListTool: ToolSpec = {
  name: 'ssh_list_files',
  description:
    '列出已配置 SSH 服务器允许根目录内的文件。认证使用系统 ssh-agent/SSH config，不读取私钥。',
  parameters: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'SSH 连接标识' },
      path: { type: 'string', description: '允许根目录内的远程路径，默认连接根目录' },
    },
    required: ['profile'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: 'SSH 远程目录',
  category: 'external',
  facet: 'SSH',
  summary: '浏览受控 SSH 服务器目录',
  targetExtractor: (a) => `${String(a.profile)}:${String(a.path ?? '.')}`,
  permissionEffect: 'network',
  parallelSafe: true,
  resourceKeys: (a) => [`ssh:${String(a.profile)}:${String(a.path ?? '.')}`],
  async fn(args) {
    const profile = await findProfile(String(args.profile))
    const entries = await listSshFiles(
      profile,
      typeof args.path === 'string' ? args.path : undefined,
    )
    return {
      status: 'success',
      message: `列出 ${profile.name} 的 ${entries.length} 项`,
      data: { profile: profile.id, root: profile.root, entries },
    }
  },
}

export const sshReadTool: ToolSpec = {
  name: 'ssh_read_file',
  description:
    '读取已配置 SSH 服务器允许根目录内的文本或常见眼科图像。大文本用 offset/limit 分段。',
  parameters: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'SSH 连接标识' },
      path: { type: 'string', description: '远程文件路径' },
      offset: { type: 'integer', description: '文本起始行，默认 1' },
      limit: { type: 'integer', description: '文本最多行数，默认 2000' },
    },
    required: ['profile', 'path'],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: 'SSH 远程文件',
  category: 'external',
  facet: 'SSH',
  summary: '读取远程文本或图像',
  targetExtractor: (a) => `${String(a.profile)}:${String(a.path)}`,
  permissionEffect: 'network',
  parallelSafe: true,
  resourceKeys: (a) => [`ssh:${String(a.profile)}:${String(a.path)}`],
  async fn(args, ctx) {
    const profile = await findProfile(String(args.profile))
    const path = resolveSshPath(profile, String(args.path))
    if (IMAGE_EXT.test(path)) {
      if (ctx.vision === false) {
        return {
          status: 'failure',
          message: '当前模型不接受图片输入，请换用视觉模型或读取配套文本。',
        }
      }
      const command =
        remotePathGuard(profile, path) +
        `size=$(wc -c < "$path") || exit $?; ` +
        `if [ "$size" -gt ${MAX_IMAGE_BYTES} ]; then echo "图片超过 10 MB" >&2; exit 65; fi; ` +
        `base64 "$path" | tr -d '\\n'`
      const result = await sshExec(profile, command, { signal: ctx.signal, timeoutMs: 60_000 })
      if (result.exitCode !== 0) return { status: 'failure', message: sshError(result) }
      const ext = path.toLowerCase().split('.').pop()
      const mime =
        ext === 'png'
          ? 'image/png'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : 'image/jpeg'
      return {
        status: 'success',
        message: `读取远程图片 ${profile.name}:${path}`,
        data: { images: [{ data: result.stdout.trim(), mime }] },
      }
    }
    const data = await readSshText(
      profile,
      path,
      typeof args.offset === 'number' ? args.offset : 1,
      typeof args.limit === 'number' ? args.limit : 2000,
    )
    return {
      status: 'success',
      message: `读取 ${profile.name}:${data.path}${data.truncated ? '（已截断）' : ''}`,
      data,
    }
  },
}

export const sshRunTool: ToolSpec = {
  name: 'ssh_run_command',
  description:
    '在已配置且允许写入的 SSH 服务器上执行命令。用于训练、预处理或明确的远程操作；只读连接会拒绝。',
  parameters: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'SSH 连接标识' },
      command: { type: 'string', description: '交给远程登录 shell 的命令' },
    },
    required: ['profile', 'command'],
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: 'SSH 远程命令',
  category: 'external',
  facet: 'SSH',
  summary: '受审批执行远程训练或数据操作',
  targetExtractor: (a) => String(a.profile),
  permissionEffect: 'execute',
  async fn(args, ctx) {
    const profile = await findProfile(String(args.profile))
    if (profile.readOnly) {
      return {
        status: 'failure',
        executed: false,
        message: `${profile.name} 是只读连接，已拒绝远程命令。`,
      }
    }
    const command = String(args.command).trim()
    if (!command) return { status: 'failure', executed: false, message: 'command 不能为空' }
    const guarded = `cd ${quote(profile.root)} && ${command}`
    const result = await sshExec(profile, guarded, {
      signal: ctx.signal,
      timeoutMs: 10 * 60_000,
      onChunk: (text) => ctx.emit('stdout', text),
    })
    return {
      status: result.exitCode === 0 && !result.timedOut ? 'success' : 'failure',
      message:
        result.exitCode === 0 && !result.timedOut
          ? `远程命令完成（${profile.name}）`
          : `远程命令失败（${profile.name}）：${sshError(result)}`,
      data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
    }
  },
}
