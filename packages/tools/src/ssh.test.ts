import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSshProfiles,
  loadSshRecentConnections,
  normalizePrivateKey,
  normalizeSshTarget,
  parseSshCommand,
  recordSshConnection,
  resolveSshPath,
  type SshProfile,
  saveSshProfiles,
} from './ssh.ts'

const profile: SshProfile = {
  id: 'gpu-lab',
  name: 'GPU 实验服务器',
  host: 'gpu.example.org',
  username: 'researcher',
  port: 22,
  root: '/data/oph',
  readOnly: true,
  hostKeyPolicy: 'strict',
}

describe('SSH 路径边界', () => {
  test('相对路径只在允许根目录内解析', () => {
    expect(resolveSshPath(profile, 'fundus/train')).toBe('/data/oph/fundus/train')
    expect(resolveSshPath(profile)).toBe('/data/oph')
  })

  test('绝对路径和 .. 都不能越过允许根目录', () => {
    expect(() => resolveSshPath(profile, '/etc/passwd')).toThrow('越过允许根目录')
    expect(() => resolveSshPath(profile, '../../etc/passwd')).toThrow('越过允许根目录')
  })
})

describe('SSH 命令入口', () => {
  test('解析 VS Code Remote SSH 常用命令形状', () => {
    expect(parseSshCommand('ssh researcher@gpu-lab -p 2202')).toEqual({
      host: 'gpu-lab',
      username: 'researcher',
      port: 2202,
    })
    expect(parseSshCommand('ssh -l retina -p22 cluster')).toEqual({
      host: 'cluster',
      username: 'retina',
      port: 22,
    })
  })

  test('高级选项必须进入 ssh config，命令不会交给 shell', () => {
    expect(() => parseSshCommand('ssh -i C:/secret.key gpu-lab')).toThrow('~/.ssh/config')
    expect(() => parseSshCommand('ssh gpu-lab; touch /tmp/x')).toThrow()
  })

  test('纯 IPv4 地址逐段校验', () => {
    expect(() => parseSshCommand('ssh root@49.233.290.200')).toThrow('0 到 255')
    expect(parseSshCommand('ssh root@49.233.190.200')).toMatchObject({
      host: '49.233.190.200',
      username: 'root',
    })
  })
})

describe('SSH 独立连接字段', () => {
  test('规范化用户名、主机与端口', () => {
    expect(
      normalizeSshTarget({ username: ' root ', host: ' 49.233.190.200 ', port: '22' }),
    ).toEqual({ username: 'root', host: '49.233.190.200', port: 22 })
  })

  test('拒绝无效地址、端口与命令注入字符', () => {
    expect(() => normalizeSshTarget({ host: '49.233.290.200', port: 22 })).toThrow('0 到 255')
    expect(() => normalizeSshTarget({ host: 'server; reboot', port: 22 })).toThrow('主机地址无效')
    expect(() =>
      normalizeSshTarget({ username: 'root -o ProxyCommand=x', host: 'server' }),
    ).toThrow('用户名无效')
    expect(() => normalizeSshTarget({ host: 'server', port: 70000 })).toThrow('端口无效')
  })
})

describe('SSH 私钥输入', () => {
  test('接受 OpenSSH 与 PEM 私钥外壳并规范换行', () => {
    expect(
      normalizePrivateKey(
        '-----BEGIN OPENSSH PRIVATE KEY-----\r\ntest\r\n-----END OPENSSH PRIVATE KEY-----',
      ),
    ).toBe('-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n')
    expect(
      normalizePrivateKey('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----'),
    ).toEndWith('\n')
    expect(
      normalizePrivateKey('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----'),
    ).toEndWith('\n')
  })

  test('拒绝公钥、不完整私钥与 PuTTY PPK', () => {
    expect(() => normalizePrivateKey('ssh-ed25519 AAAA')).toThrow('私钥格式无效')
    expect(() => normalizePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nx')).toThrow(
      '缺少结束标记',
    )
    expect(() => normalizePrivateKey('PuTTY-User-Key-File-3: ssh-rsa')).toThrow('PuTTY PPK')
  })
})

describe('SSH 配置', () => {
  test('只保存连接元数据，不接受密码或私钥字段', async () => {
    const previous = process.env.OPH_AUTORESEARCH_HOME
    process.env.OPH_AUTORESEARCH_HOME = await mkdtemp(join(tmpdir(), 'oph-ssh-'))
    try {
      await saveSshProfiles([{ ...profile, password: 'secret', privateKey: 'key bytes' }])
      const [saved] = await loadSshProfiles()
      expect(saved).toEqual(profile)
      expect('password' in (saved as unknown as Record<string, unknown>)).toBe(false)
      expect('privateKey' in (saved as unknown as Record<string, unknown>)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPH_AUTORESEARCH_HOME
      else process.env.OPH_AUTORESEARCH_HOME = previous
    }
  })

  test('拒绝命令注入形状的主机名', async () => {
    await expect(saveSshProfiles([{ ...profile, host: 'server; touch /tmp/x' }])).rejects.toThrow(
      '无效',
    )
  })

  test('成功连接会留下不含凭证的最近记录，并保留已有工作区', async () => {
    const previous = process.env.OPH_AUTORESEARCH_HOME
    process.env.OPH_AUTORESEARCH_HOME = await mkdtemp(join(tmpdir(), 'oph-ssh-recent-'))
    try {
      await saveSshProfiles([profile])
      await recordSshConnection(profile, {
        authMode: 'password',
        hostKeyPolicy: 'accept-new',
        home: '/home/researcher',
        connectedAt: 100,
      })
      await recordSshConnection(profile, {
        authMode: 'private-key',
        hostKeyPolicy: 'strict',
        home: '/home/researcher',
        lastPath: '/data/oph',
        connectedAt: 200,
      })

      expect(await loadSshProfiles()).toEqual([profile])
      const recent = await loadSshRecentConnections()
      expect(recent).toEqual([
        {
          host: profile.host,
          username: 'researcher',
          port: profile.port,
          authMode: 'private-key',
          hostKeyPolicy: 'strict',
          home: '/home/researcher',
          lastPath: '/data/oph',
          lastConnectedAt: 200,
        },
      ])
      expect('password' in (recent[0] as unknown as Record<string, unknown>)).toBe(false)
      expect('privateKey' in (recent[0] as unknown as Record<string, unknown>)).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPH_AUTORESEARCH_HOME
      else process.env.OPH_AUTORESEARCH_HOME = previous
    }
  })
})
