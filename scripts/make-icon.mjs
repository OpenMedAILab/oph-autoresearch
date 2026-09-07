#!/usr/bin/env node
/**
 * 准备桌面图标源图，再交给 `tauri icon` 派生各平台尺寸。
 *
 * 主源图放在 apps/desktop/icon-source.png，必须随仓库保存；放在 .tmp 里的文件
 * 构建机拿不到，下一次运行 icon 脚本就会退回旧图标。这里不重新绘制品牌图形，
 * 只把经过审阅的 1024×1024 源图复制到 Tauri 命令约定的位置。
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'apps', 'desktop', 'icon-source.png')
const OUT = join(ROOT, '.tmp', 'icon', 'source.png')

await mkdir(dirname(OUT), { recursive: true })
await copyFile(SOURCE, OUT)
process.stdout.write(`图标源图已准备：${OUT}\n`)
