#!/usr/bin/env node
/**
 * 界面截图验证。
 *
 * 用 Node 而不是 Bun 驱动 Playwright：Bun 在 Windows 上对 `--remote-debugging-pipe`
 * 用到的 fd 3/4 管道支持不全，`chromium.launch()` 会挂到超时。所以这里分工——
 * Node 管浏览器，Bun 管服务，各自做自己稳的那部分。
 *
 * 同时验证真实发布路径：它启动的是 `oph serve --static`（静态托管构建产物），
 * 与开发时的 Vite 代理不是同一条路，那条路不测就等于没测。
 *
 *   node scripts/shoot-ui.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WS_DIR = join(ROOT, '.tmp', 'shoot-ws')
const OUT = join(ROOT, '.tmp', 'shots')
const BUN = process.env.OPH_BUN_EXE || 'bun'

const SHOTS = [
  { name: 'desktop-light', width: 1440, height: 900, scheme: 'light' },
  { name: 'desktop-dark', width: 1440, height: 900, scheme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, scheme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, scheme: 'dark' },
]

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
    p.on('error', reject)
  })
}

async function killTree(proc) {
  // shell: true 时 proc 是 cmd 壳，proc.kill() 只杀壳，bun serve 还握着 stdio 管道——
  // node 的退出被未闭合的 pipe 吊住，脚本就永远「执行中」却没有下一步输出。
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'])
    } catch {
      /* 进程已经没了就不必补刀 */
    }
  } else {
    proc.kill('SIGTERM')
  }
}

async function startServer() {
  await rm(WS_DIR, { recursive: true, force: true })
  await mkdir(WS_DIR, { recursive: true })
  await mkdir(join(WS_DIR, 'src'), { recursive: true })
  await writeFile(join(WS_DIR, 'index.ts'), 'export const hello = 1\n', 'utf8')
  await writeFile(join(WS_DIR, 'README.md'), '# demo\n\n用于界面截图的工作区。\n', 'utf8')
  await writeFile(
    join(WS_DIR, 'src/main.ts'),
    'export function add(a: number, b: number): number {\n  return a + b\n}\n',
    'utf8',
  )
  await writeFile(
    join(WS_DIR, 'ssh.json'),
    `${JSON.stringify(
      {
        profiles: [
          {
            id: 'oph-gpu',
            name: '眼科 GPU 数据目录',
            host: 'gpu-lab.example.org',
            username: 'researcher',
            port: 22,
            root: '/data/oph',
            readOnly: true,
            hostKeyPolicy: 'strict',
          },
        ],
        recentConnections: [
          {
            host: 'gpu-lab.example.org',
            username: 'researcher',
            port: 22,
            authMode: 'private-key',
            hostKeyPolicy: 'strict',
            home: '/home/researcher',
            lastPath: '/data/oph',
            lastConnectedAt: Date.now(),
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // 建成真实 git 仓库并留下未提交改动，否则 git 面板只能截到「不是 git 仓库」。
  const git = (...args) => run('git', ['-C', WS_DIR, ...args]).catch(() => {})
  await git('init', '-q')
  await git('config', 'user.email', 'demo@oph-autoresearch.dev')
  await git('config', 'user.name', 'oph-autoresearch')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'init')
  await writeFile(
    join(WS_DIR, 'src/main.ts'),
    'export function add(a: number, b: number): number {\n  return a + b\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b\n}\n',
    'utf8',
  )
  await writeFile(join(WS_DIR, 'src/util.ts'), 'export const noop = () => {}\n', 'utf8')

  // OPH_AUTORESEARCH_HOME 把配置与账本一起指到临时目录：既不污染用户的真实账本，
  // 也保证种子和 serve 读的是同一个库（config.dataPath() 就在这个目录下）。
  await run(BUN, [
    'run',
    join(ROOT, 'scripts/seed-demo.ts'),
    join(WS_DIR, 'oph-autoresearch.sqlite3'),
    WS_DIR,
  ])

  const proc = spawn(
    BUN,
    [
      'run',
      join(ROOT, 'packages/cli/src/index.ts'),
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--cwd',
      WS_DIR,
      '--static',
      join(ROOT, 'apps/web/dist'),
      '--print-token',
      // Windows 上 shell:true 时 proc 是 cmd.exe，proc.kill() 杀的是壳不是 bun，
      // 留下的服务占着 SQLite 的 WAL 锁，下次跑这个脚本会在 rm 工作区时报 EBUSY。
      // 让服务自己盯父进程——和 Tauri sidecar 用的是同一条兜底。
      '--parent-pid',
      String(process.pid),
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, OPH_AUTORESEARCH_HOME: WS_DIR },
    },
  )

  return new Promise((resolve, reject) => {
    let token = null
    let port = null
    let buf = ''
    const timer = setTimeout(() => reject(new Error('serve 启动超时')), 30_000)

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      // --print-token 的输出格式是稳定的两行 KEY=VALUE，供父进程按行读取。
      for (const line of buf.split('\n')) {
        const t = /^OPH_AUTORESEARCH_TOKEN=(.+)$/.exec(line.trim())
        if (t) token = t[1]
        const p = /^OPH_AUTORESEARCH_PORT=(\d+)$/.exec(line.trim())
        if (p) port = Number(p[1])
      }
      if (token && port) {
        clearTimeout(timer)
        resolve({ proc, token, port })
      }
    })
    proc.stderr.on('data', () => {})
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (!token) {
        clearTimeout(timer)
        reject(new Error(`serve 提前退出 code=${code}`))
      }
    })
  })
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const { proc, token, port } = await startServer()
  const base = `http://127.0.0.1:${port}`
  process.stdout.write(`服务已起：${base}\n`)

  const browser = await chromium.launch()
  const errors = []

  try {
    for (const shot of SHOTS) {
      const ctx = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        colorScheme: shot.scheme,
        deviceScaleFactor: 2,
      })
      const page = await ctx.newPage()
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${shot.name}] console: ${m.text()}`)
      })
      page.on('pageerror', (e) => errors.push(`[${shot.name}] pageerror: ${e.message}`))

      // 令牌走 fragment——与手机扫码进来的路径完全一致。
      await page.goto(`${base}/#t=${token}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(800)

      // 令牌必须已被从地址栏抹掉：留着会进浏览器历史、被分享、被截图。
      if (page.url().includes(token)) {
        errors.push(`[${shot.name}] 令牌残留在地址栏`)
      }
      // 连接状态条消失 = WebSocket 握手成功。它还在就说明没连上。
      const connBar = await page.locator('.conn-bar').count()
      if (connBar > 0) {
        const txt = await page.locator('.conn-bar').first().textContent()
        errors.push(`[${shot.name}] 未连上：${txt}`)
      }

      // 窄屏下右侧工作区默认覆盖全屏；先关掉它才能验证主工作区和左侧项目抽屉。
      if (shot.width < 820) {
        const closePanel = page.getByRole('button', { name: '关闭侧面板' })
        if (await closePanel.count()) await closePanel.click()
        await page.waitForTimeout(250)
      }

      await page.screenshot({ path: join(OUT, `${shot.name}.png`) })

      if (shot.name === 'desktop-light') {
        const todoToggle = page.locator('.run-todos-toggle').last()
        if ((await todoToggle.count()) === 0) {
          errors.push(`[${shot.name}] 本轮读数条没有 Todo Chain 摘要入口`)
        } else {
          await todoToggle.click()
          await page.locator('.run-todos-panel').last().waitFor({ state: 'visible', timeout: 3000 })
          await page.screenshot({ path: join(OUT, `${shot.name}-todo-chain.png`) })
          await todoToggle.click()
        }
      }

      if (shot.width < 820) {
        await page.click('.drawer-toggle').catch(() => {})
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(OUT, `${shot.name}-drawer.png`) })
        await page.locator('.sidebar-slot').getByRole('button', { name: '新建对话' }).click()
        await page.waitForTimeout(500)
        await page.screenshot({ path: join(OUT, `${shot.name}-research.png`) })
      } else {
        // 新研究首页是产品的核心入口，必须独立覆盖，不能只截已有会话。
        await page.getByRole('button', { name: '新建对话' }).click()
        await page.waitForTimeout(500)
        await page.screenshot({ path: join(OUT, `${shot.name}-research.png`) })

        await page.keyboard.press('Control+k')
        await page.waitForTimeout(350)
        await page.screenshot({ path: join(OUT, `${shot.name}-palette.png`) })
        await page.keyboard.press('Escape')

        // 文件与对话完全分栏：文件树在右侧，打开内容落到中央。
        // 截图之外再走一遍“根目录 → src → 根目录”的真实拖放，避免只有样式没有移动。
        const expandPanel = page.getByRole('button', { name: '展开侧面板' })
        if (await expandPanel.count()) await expandPanel.click()
        await page.getByRole('tab', { name: '文件', exact: true }).click()
        await page.locator('.workspace-file-tree').waitFor({ state: 'visible', timeout: 5000 })
        await page.screenshot({ path: join(OUT, `${shot.name}-files.png`) })

        if (shot.name === 'desktop-light') {
          const readme = page
            .locator('.workspace-tree-row')
            .filter({ hasText: 'README.md' })
            .first()
          const src = page.locator('.workspace-tree-row').filter({ hasText: 'src' }).first()
          await readme
            .dragTo(src)
            .catch((e) => errors.push(`[${shot.name}] 文件拖不到目录：${e.message}`))
          await page.waitForTimeout(500)
          await page.locator('.workspace-tree-row').filter({ hasText: 'src' }).first().click()
          const movedReadme = page
            .locator('.workspace-tree-row')
            .filter({ hasText: 'README.md' })
            .first()
          await movedReadme
            .waitFor({ state: 'visible', timeout: 5000 })
            .catch(() => errors.push(`[${shot.name}] 文件拖入目录后没有出现在目标目录`))
        }
        await page.screenshot({ path: join(OUT, `${shot.name}-drag-move.png`) })

        await page.locator('.workspace-tree-row').filter({ hasText: 'README.md' }).first().click()
        await page.waitForTimeout(500)
        await page.screenshot({ path: join(OUT, `${shot.name}-editor.png`) })

        // 右侧“流程”只承载研究执行链导航；顶栏只保留一个展开/收起入口。
        await page.getByRole('tab', { name: '流程', exact: true }).click()
        await page.waitForTimeout(500)
        if ((await page.locator('.workflow-todos').count()) > 0) {
          errors.push(`[${shot.name}] 流程页仍重复显示 Todo Chain`)
        }
        await page.screenshot({ path: join(OUT, `${shot.name}-workflow.png`) })

        // 右侧流程是导航，不承载详情：点击阶段后完整信息必须落到中央主区域。
        await page.locator('.workflow-nav-list button').nth(1).click()
        await page
          .locator('.research-stage-view')
          .waitFor({ state: 'visible', timeout: 5000 })
          .catch(() => errors.push(`[${shot.name}] 点击研究阶段后中央详情没有打开`))
        await page.screenshot({ path: join(OUT, `${shot.name}-stage-detail.png`) })

        // SSH 首页覆盖最近连接、已保存数据目录和窄中央区的无横向溢出布局。
        await page.getByRole('button', { name: 'Remote SSH' }).click()
        await page.waitForTimeout(350)
        const sshOverflow = await page
          .locator('.remote-ssh-workbench')
          .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
        if (sshOverflow) errors.push(`[${shot.name}] SSH 工作台出现横向溢出`)
        if (shot.name === 'desktop-light') {
          if ((await page.getByText('研究对话', { exact: true }).count()) > 0) {
            errors.push(`[${shot.name}] 左栏仍显示重复的“研究对话”分组标题`)
          }
          await page.getByRole('button', { name: '密码认证', exact: true }).click()
          const passwordOverflow = await page
            .locator('.remote-command-card')
            .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
          if (passwordOverflow) errors.push(`[${shot.name}] SSH 密码表单出现横向溢出`)
          await page.screenshot({ path: join(OUT, `${shot.name}-ssh-password.png`) })
          await page.getByRole('button', { name: '系统密钥', exact: true }).click()

          const invalid = await page.request.post(`${base}/api/ssh/connect`, {
            headers: { authorization: `Bearer ${token}` },
            data: {
              username: 'root',
              host: '49.233.290.200',
              port: 22,
              authMode: 'system-key',
            },
          })
          const error = await invalid.json().catch(() => ({}))
          if (invalid.status() !== 502 || !String(error.error).includes('0 到 255')) {
            errors.push(`[${shot.name}] 无效 IPv4 没有返回可恢复的 SSH 错误`)
          }
        }
        await page.screenshot({ path: join(OUT, `${shot.name}-ssh.png`) })

        if (shot.name === 'desktop-light') {
          // 用协议级假服务器走通连接后的“选择目录 → 打开工作区 → 预览文件”界面。
          // 真 SSH 的参数解析和错误路径由上面的真实服务请求覆盖；这里专门验布局与交互。
          await page.route('**/api/ssh/connect**', (route) =>
            route.fulfill({
              json: {
                sessionId: 'visual-test-session',
                home: '/home/researcher',
                message: '已连接 researcher@gpu-lab.example.org:22（系统密钥认证）',
                target: { host: 'gpu-lab.example.org', username: 'researcher', port: 22 },
              },
            }),
          )
          await page.route('**/api/ssh/session/list?**', (route) => {
            const path = new URL(route.request().url()).searchParams.get('path') || '/data/oph'
            route.fulfill({
              json: {
                path,
                entries: [
                  { name: 'fundus', path: `${path}/fundus`, kind: 'dir', size: 0, mtime: 0 },
                  {
                    name: 'analysis.py',
                    path: `${path}/analysis.py`,
                    kind: 'file',
                    size: 2460,
                    mtime: 0,
                  },
                ],
              },
            })
          })
          await page.route('**/api/ssh/workspace**', (route) =>
            route.fulfill({
              json: {
                profile: {
                  id: 'oph-gpu',
                  name: '眼科 GPU 数据目录',
                  host: 'gpu-lab.example.org',
                  username: 'researcher',
                  port: 22,
                  root: '/data/oph',
                  readOnly: true,
                  hostKeyPolicy: 'strict',
                },
              },
            }),
          )
          await page.route('**/api/ssh/session/preview?**', (route) =>
            route.fulfill({
              json: {
                path: '/data/oph/analysis.py',
                kind: 'text',
                mime: 'text/x-python',
                size: 2460,
                content: 'from pathlib import Path\n\nDATA_ROOT = Path("/data/oph/fundus")\n',
                language: 'python',
                truncated: false,
              },
            }),
          )
          await page.getByLabel('用户名').fill('researcher')
          await page.getByLabel('主机地址').fill('gpu-lab.example.org')
          await page.getByLabel('端口').fill('22')
          await page.getByRole('button', { name: '连接', exact: true }).click()
          await page.getByLabel('选择数据目录').fill('/data/oph')
          await page.getByRole('button', { name: '转到', exact: true }).click()
          await page.getByRole('button', { name: '设为 Agent 工作区' }).click()
          await page.locator('.remote-row').filter({ hasText: 'analysis.py' }).click()
          await page.waitForTimeout(350)
          const explorerOverflow = await page
            .locator('.remote-explorer')
            .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
          if (explorerOverflow) errors.push(`[${shot.name}] SSH 连接后资源管理器出现横向溢出`)
          await page.screenshot({ path: join(OUT, `${shot.name}-ssh-connected.png`) })

          // 远程接入只展示飞书；展开后验证配置卡的布局与宽度。
          await page.getByRole('button', { name: '系统设置' }).click()
          await page.getByRole('button', { name: '远程接入', exact: true }).click()
          await page.locator('.channel-catalog').waitFor({ state: 'visible', timeout: 5000 })
          const channelRows = page.locator('.channel-row')
          if ((await channelRows.count()) !== 1) {
            errors.push(`[${shot.name}] 远程接入没有只显示飞书通道`)
          }
          if ((await page.getByText('钉钉机器人', { exact: true }).count()) > 0) {
            errors.push(`[${shot.name}] 已移除的钉钉通道仍出现在界面`)
          }
          await page.getByRole('button', { name: /飞书机器人/ }).click()
          await page.locator('.channel-form').waitFor({ state: 'visible', timeout: 5000 })
          const channelOverflow = await page
            .locator('.channel-form')
            .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
          if (channelOverflow) errors.push(`[${shot.name}] 机器人配置卡出现横向溢出`)
          await page.screenshot({ path: join(OUT, `${shot.name}-remote-channels.png`) })
          await page.getByRole('button', { name: '关闭', exact: true }).click()
        }

        // 下一套颜色主题应从同一份干净目录开始。这里走真实移动 API 复位测试夹具，
        // 不把“拖回根目录”伪装成拖入文件夹这一条验收用例的一部分。
        if (shot.name === 'desktop-light') {
          const reset = await page.request.post(`${base}/api/files/move`, {
            headers: { authorization: `Bearer ${token}` },
            data: { path: 'src/README.md', destination: '' },
          })
          if (!reset.ok()) errors.push(`[${shot.name}] 拖放夹具复位失败：${reset.status()}`)
        }
      }
      await ctx.close()
    }
  } finally {
    await browser.close()
    await killTree(proc)
    proc.kill()
  }

  if (errors.length) {
    process.stdout.write('\n问题：\n')
    for (const e of errors) process.stdout.write(`  ✗ ${e}\n`)
    return 1
  }
  process.stdout.write(`\n截图已输出到 ${OUT}\n`)
  return 0
}

process.exit(await main())
