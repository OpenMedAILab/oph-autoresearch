import { scheduleCliRefresh } from '../cli-catalog.ts'
/** SSH 连接配置、连通性检查与远程文件浏览。 */

import { extname } from 'node:path'
import {
  clearSshCredential,
  connectSshTarget,
  deleteSshEntry,
  forgetSshRecentConnection,
  inspectSshDirectory,
  listSshFiles,
  loadSshCredential,
  loadSshCredentials,
  loadSshProfiles,
  loadSshRecentConnections,
  normalizeSshTarget,
  readSshBinary,
  readSshText,
  readSshWholeText,
  recordSshConnection,
  type SshAuthMode,
  type SshConnectionAuth,
  type SshProfile,
  saveSshCredential,
  saveSshProfiles,
  sshConfigPath,
  sshCredentialKey,
  testSshProfile,
} from '@oph-autoresearch/tools'
import { classify, MAX_OFFICE_BYTES, renderOffice } from '../files.ts'
import { type ApiHandler, json } from './types.ts'

interface LiveSshSession {
  profile: SshProfile
  home: string
  authMode: SshAuthMode
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
    const data = await readSshBinary(profile, requested, MAX_OFFICE_BYTES)
    const html = await renderOffice(Buffer.from(data.base64, 'base64'), ext)
    return {
      path: data.path,
      kind: 'office',
      mime: 'text/html',
      size: data.size,
      content: html,
      truncated: false,
      note: '由远端文档在内存中渲染，不写入本机磁盘',
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
  // 整读而非按行截断：HTML/Markdown 是一份完整文档，截前 5000 行就是残缺的预览。
  const data = await readSshWholeText(profile, requested)
  return {
    path: data.path,
    kind: ext === '.md' || ext === '.mdx' ? 'markdown' : meta.kind,
    mime: meta.mime,
    language: meta.language,
    size: data.size,
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
      host?: string
      username?: string
      port?: number | string
      acceptNewHost?: boolean
      authMode?: 'system-key' | 'private-key' | 'password'
      password?: string
      privateKey?: string
      privateKeyPassphrase?: string
    } | null
    if (!body?.host?.trim()) return json({ error: '请输入 SSH 主机地址' }, 400)
    if (body.authMode && !['system-key', 'private-key', 'password'].includes(body.authMode)) {
      return json({ error: 'SSH 认证方式无效' }, 400)
    }
    const target = {
      host: body.host.trim(),
      ...(body.username?.trim() ? { username: body.username.trim() } : {}),
      port: Number(body.port ?? 22),
    }
    /*
     * 密码 / 私钥可以缺省：缺省时先取已保存的凭证（`tools/ssh.ts` 的 credentials 段）。
     * 没有保存过就回 401 让界面请用户输入；保存过却认证失败就清除并要求重输——
     * 失败的那份已经不可信，留着只会让每一次连接都撞同一堵墙。
     */
    let auth: SshConnectionAuth | undefined
    let usedStored = false
    if (body.authMode === 'password') {
      if (body.password) {
        if (body.password.length > 4096 || body.password.includes('\0')) {
          return json({ error: '请输入有效的 SSH 密码' }, 400)
        }
        auth = { mode: 'password', password: body.password }
      } else {
        const stored = await loadSshCredential(target)
        if (stored?.mode !== 'password') {
          return json(
            { error: 'need_credentials', message: '该主机没有保存密码，请输入密码后连接。' },
            401,
          )
        }
        auth = stored
        usedStored = true
      }
    } else if (body.authMode === 'private-key') {
      if (body.privateKey) {
        if (body.privateKey.length > 1024 * 1024 || body.privateKey.includes('\0')) {
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
      } else {
        const stored = await loadSshCredential(target)
        if (stored?.mode !== 'private-key') {
          return json(
            {
              error: 'need_credentials',
              message: '该主机没有保存私钥，请选择或粘贴私钥后连接。',
            },
            401,
          )
        }
        auth = stored
        usedStored = true
      }
    }
    try {
      const connected = await connectSshTarget(
        target,
        body.acceptNewHost === false ? 'strict' : 'accept-new',
        auth,
      )
      const authMode = body.authMode ?? 'system-key'
      await recordSshConnection(connected.profile, {
        authMode,
        hostKeyPolicy: connected.profile.hostKeyPolicy,
        home: connected.home,
      })
      // 这次显式提交的凭证，连接成功才落盘；用保存的连接成功则原样保留。
      if (auth && !usedStored) await saveSshCredential(target, auth)
      scheduleCliRefresh()
      const sessionId = crypto.randomUUID()
      liveSessions.set(sessionId, { ...connected, authMode, touchedAt: Date.now() })
      return json({
        sessionId,
        home: connected.home,
        message: connected.message,
        savedCredential: auth ? true : undefined,
        target: {
          host: connected.profile.host,
          username: connected.profile.username,
          port: connected.profile.port,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (usedStored && /认证失败|口令错误|Permission denied|bad passphrase/i.test(message)) {
        await clearSshCredential(target)
        return json({ error: `${message}。已保存的凭证已清除，请重新输入。` }, 502)
      }
      return json({ error: message }, 502)
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

  // 删除远程条目（目录连同内容）。破坏性操作：界面侧必须弹确认框再调这里。
  if (path === '/api/ssh/session/delete' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      sessionId?: string
      path?: string
    } | null
    const session = liveSession(body?.sessionId ?? '')
    if (!session) return json({ error: 'SSH 会话已断开，请重新连接' }, 410)
    if (!body?.path?.trim()) return json({ error: '缺少远程路径' }, 400)
    try {
      const removed = await deleteSshEntry(session.profile, body.path)
      return json({ ok: true, removed })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/workspace' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      sessionId?: string
      path?: string
      name?: string
      readOnly?: boolean
    } | null
    if (body?.readOnly !== undefined && typeof body.readOnly !== 'boolean') {
      return json({ error: '工作区访问模式无效' }, 400)
    }
    const session = liveSession(body?.sessionId ?? '')
    if (!session) return json({ error: 'SSH 会话已断开，请重新连接' }, 410)
    if (!body?.path?.trim()) return json({ error: '请选择远程文件夹' }, 400)
    try {
      const root = await inspectSshDirectory(session.profile, body.path)
      await recordSshConnection(session.profile, {
        authMode: session.authMode,
        hostKeyPolicy: session.profile.hostKeyPolicy,
        home: session.home,
        lastPath: root,
      })
      const profiles = await loadSshProfiles()
      const existing = profiles.find(
        (candidate) =>
          candidate.host === session.profile.host &&
          candidate.username === session.profile.username &&
          candidate.port === session.profile.port &&
          candidate.root === root,
      )
      if (existing) {
        const updated = { ...existing, readOnly: body.readOnly ?? existing.readOnly }
        await saveSshProfiles(
          profiles.map((profile) => (profile.id === existing.id ? updated : profile)),
        )
        scheduleCliRefresh()
        return json({ ok: true, profile: updated })
      }
      const id = profileId(session.profile, new Set(profiles.map((profile) => profile.id)))
      const saved: SshProfile = {
        ...session.profile,
        id,
        name: body.name?.trim() || `${session.profile.host}:${root}`,
        root,
        readOnly: body.readOnly ?? true,
      }
      await saveSshProfiles([...profiles, saved])
      scheduleCliRefresh()
      return json({ ok: true, profile: saved })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/profiles' && req.method === 'GET') {
    const [profiles, recentConnections, credentials] = await Promise.all([
      loadSshProfiles(),
      loadSshRecentConnections(),
      loadSshCredentials(),
    ])
    // 每条最近连接带上「有没有保存凭证」：界面靠它告诉用户点下去会不会被追问。
    return json({
      path: sshConfigPath(),
      profiles,
      recentConnections: recentConnections.map((recent) => ({
        ...recent,
        hasSavedCredential: sshCredentialKey(recent) in credentials,
      })),
    })
  }

  // 忘掉一条最近连接（同时清除该连接已保存的凭证）。界面侧必须弹确认框再调这里。
  if (path === '/api/ssh/recent/delete' && req.method === 'POST') {
    const body = (await req.json().catch(() => null)) as {
      host?: string
      username?: string
      port?: number
    } | null
    if (!body?.host?.trim() || !Number.isInteger(Number(body.port))) {
      return json({ error: '缺少连接目标' }, 400)
    }
    try {
      const target = normalizeSshTarget({
        host: body.host.trim(),
        ...(body.username?.trim() ? { username: body.username.trim() } : {}),
        port: Number(body.port),
      })
      const recentConnections = await forgetSshRecentConnection(target)
      return json({ ok: true, count: recentConnections.length })
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  if (path === '/api/ssh/profiles' && req.method === 'PUT') {
    const body = (await req.json().catch(() => null)) as { profiles?: unknown } | null
    try {
      const profiles = await saveSshProfiles(body?.profiles)
      scheduleCliRefresh()
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
