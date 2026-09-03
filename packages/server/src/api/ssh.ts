/** SSH 连接配置、连通性检查与远程文件浏览。 */

import { extname } from 'node:path'
import {
  connectSshCommand,
  inspectSshDirectory,
  listSshFiles,
  loadSshProfiles,
  readSshBinary,
  readSshOfficeText,
  readSshText,
  type SshConnectionAuth,
  type SshProfile,
  saveSshProfiles,
  sshConfigPath,
  testSshProfile,
} from '@oph-autoresearch/tools'
import { classify } from '../files.ts'
import { type ApiHandler, json } from './types.ts'

interface LiveSshSession {
  profile: SshProfile
  home: string
  touchedAt: number
}

const LIVE_TTL_MS = 30 * 60_000
const liveSessions = new Map<string, LiveSshSession>()

function liveSession(id: string): LiveSshSession | undefined {
  const now = Date.now()
  for (const [key, value] of liveSessions) {
    if (now - value.touchedAt > LIVE_TTL_MS) liveSessions.delete(key)
  }
  const session = liveSessions.get(id)
  if (session) session.touchedAt = now
  return session
}

function profileId(profile: SshProfile, used: Set<string>): string {
  const base =
    profile.host
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-|-$/g, '') || 'ssh'
  let id = base.slice(0, 40)
  let n = 2
  while (used.has(id)) id = `${base.slice(0, 36)}-${n++}`
  return id
}

async function previewSshFile(profile: SshProfile, requested: string) {
  const ext = extname(requested).toLowerCase()
  if (/\.(docx|xlsx|pptx)$/i.test(ext)) {
    const data = await readSshOfficeText(profile, requested)
    return {
      path: data.path,
      kind: 'office',
      mime: 'text/plain',
      size: 0,
      content: data.content,
      truncated: data.truncated,
      note: '只读文本化预览；未在本机或远端生成副本',
    }
  }
  if (/\.(doc|xls|ppt)$/i.test(ext)) {
    return {
      path: requested,
      kind: 'binary',
      mime: 'application/octet-stream',
      size: 0,
      truncated: false,
      note: '旧版 Office 二进制格式暂不内联；请另存为 docx、xlsx 或 pptx 后预览',
    }
  }
  const meta = classify(requested)
  if (
    meta.kind === 'image' ||
    meta.kind === 'pdf' ||
    meta.kind === 'audio' ||
    meta.kind === 'video'
  ) {
    const data = await readSshBinary(profile, requested)
    return {
      path: data.path,
      kind: meta.kind,
      mime: meta.mime,
      size: data.size,
      dataUri: `data:${meta.mime};base64,${data.base64}`,
      truncated: false,
    }
  }
  if (/\.(dcm|nii|nii\.gz)$/i.test(requested)) {
    return {
      path: requested,
      kind: 'binary',
      mime: 'application/octet-stream',
      size: 0,
      truncated: false,
      note: '医学影像不在桌面端展开；请让 Agent 在远端执行脱敏、只读分析',
    }
  }
  const data = await readSshText(profile, requested, 1, 5000)
  return {
    path: data.path,
    kind: ext === '.md' || ext === '.mdx' ? 'markdown' : meta.kind,
    mime: meta.mime,
    language: meta.language,
    size: 0,
    content: data.content,
    truncated: data.truncated,
  }
}

async function profileById(id: string) {
  return (await loadSshProfiles()).find((p) => p.id === id)
}

export const handleSshApi: ApiHandler = async (url, req) => {
  const path = url.pathname

  if (path === '/api/ssh/connect' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      command?: string
      acceptNewHost?: boolean
      authMode?: 'system-key' | 'private-key' | 'password'
      password?: string
      privateKey?: string
      privateKeyPassphrase?: string
    } | null
    if (!body?.command?.trim()) return json({ error: '请输入 SSH 命令' }, 400)
    if (body.authMode && !['system-key', 'private-key', 'password'].includes(body.authMode)) {
      return json({ error: 'SSH 认证方式无效' }, 400)
    }
    let auth: SshConnectionAuth | undefined
    if (body.authMode === 'password') {
      if (!body.password || body.password.length > 4096 || body.password.includes('\0')) {
        return json({ error: '请输入有效的 SSH 密码' }, 400)
      }
      auth = { mode: 'password', password: body.password }
    } else if (body.authMode === 'private-key') {
      if (
        !body.privateKey ||
        body.privateKey.length > 1024 * 1024 ||
        body.privateKey.includes('\0')
      ) {
        return json({ error: '请选择或粘贴有效的 SSH 私钥' }, 400)
      }
      if (
        body.privateKeyPassphrase &&
        (body.privateKeyPassphrase.length > 4096 || body.privateKeyPassphrase.includes('\0'))
      ) {
        return json({ error: '私钥口令包含无效字符' }, 400)
      }
      auth = {
        mode: 'private-key',
        privateKey: body.privateKey,
        ...(body.privateKeyPassphrase ? { passphrase: body.privateKeyPassphrase } : {}),
      }
    }
    try {
      const connected = await connectSshCommand(
        body.command,
        body.acceptNewHost === false ? 'strict' : 'accept-new',
        auth,
      )
      const sessionId = crypto.randomUUID()
      liveSessions.set(sessionId, { ...connected, touchedAt: Date.now() })
      return json({
        sessionId,
        home: connected.home,
        message: connected.message,
        target: {
          host: connected.profile.host,
          username: connected.profile.username,
          port: connected.profile.port,
        },
      })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/session/list' && req.method === 'GET') {
    const session = liveSession(url.searchParams.get('session') ?? '')
    if (!session) return json({ error: 'SSH 会话已断开，请重新连接' }, 410)
    try {
      const requested = url.searchParams.get('path') || session.home
      const entries = await listSshFiles(session.profile, requested)
      return json({ path: requested, entries })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/session/preview' && req.method === 'GET') {
    const session = liveSession(url.searchParams.get('session') ?? '')
    const requested = url.searchParams.get('path') ?? ''
    if (!session) return json({ error: 'SSH 会话已断开，请重新连接' }, 410)
    if (!requested) return json({ error: '缺少远程文件路径' }, 400)
    try {
      return json(await previewSshFile(session.profile, requested))
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/workspace' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      sessionId?: string
      path?: string
      name?: string
    } | null
    const session = liveSession(body?.sessionId ?? '')
    if (!session) return json({ error: 'SSH 会话已断开，请重新连接' }, 410)
    if (!body?.path?.trim()) return json({ error: '请选择远程文件夹' }, 400)
    try {
      const root = await inspectSshDirectory(session.profile, body.path)
      const profiles = await loadSshProfiles()
      const existing = profiles.find(
        (candidate) =>
          candidate.host === session.profile.host &&
          candidate.username === session.profile.username &&
          candidate.port === session.profile.port &&
          candidate.root === root,
      )
      if (existing) return json({ ok: true, profile: existing })
      const id = profileId(session.profile, new Set(profiles.map((profile) => profile.id)))
      const saved: SshProfile = {
        ...session.profile,
        id,
        name: body.name?.trim() || `${session.profile.host}:${root}`,
        root,
        readOnly: true,
      }
      await saveSshProfiles([...profiles, saved])
      return json({ ok: true, profile: saved })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/profiles' && req.method === 'GET') {
    return json({ path: sshConfigPath(), profiles: await loadSshProfiles() })
  }

  if (path === '/api/ssh/profiles' && req.method === 'PUT') {
    const body = (await req.json().catch(() => null)) as { profiles?: unknown } | null
    try {
      const profiles = await saveSshProfiles(body?.profiles)
      return json({ ok: true, path: sshConfigPath(), profiles })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 422)
    }
  }

  if (path === '/api/ssh/test' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as { id?: string } | null
    const profile = body?.id ? await profileById(body.id) : undefined
    if (!profile) return json({ error: '找不到 SSH 连接' }, 404)
    const result = await testSshProfile(profile).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
    return json(result, result.ok ? 200 : 502)
  }

  if (path === '/api/ssh/list' && req.method === 'GET') {
    const id = url.searchParams.get('profile') ?? ''
    const profile = await profileById(id)
    if (!profile) return json({ error: '找不到 SSH 连接' }, 404)
    try {
      const requested = url.searchParams.get('path') ?? undefined
      const entries = await listSshFiles(profile, requested)
      return json({ profile, path: requested || profile.root, entries })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/read' && req.method === 'GET') {
    const id = url.searchParams.get('profile') ?? ''
    const requested = url.searchParams.get('path') ?? ''
    const profile = await profileById(id)
    if (!profile) return json({ error: '找不到 SSH 连接' }, 404)
    if (!requested) return json({ error: '缺少远程文件路径' }, 400)
    try {
      return json(await readSshText(profile, requested))
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  return null
}
