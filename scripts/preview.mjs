/**
 * 开发用预览脚本：按客户端 drawVoucher 的几何比例，把示例面额合成到票券底图上，
 * 生成 docs/preview.png 供 README 与人工核对使用。不随包分发。
 *
 * 依赖 sharp —— 借用本机 profile 里已有的那份，避免为一张预览图装依赖。
 * 用法：node scripts/preview.mjs
 */

import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const require = createRequire('file:///D:/DeepSeekData/dsh-home/profiles/web/')
const sharp = require('sharp')

const meta = await sharp(join(root, 'assets', 'jingyuan-note.jpg')).metadata()
const WIDTH = meta.width ?? 1400
const HEIGHT = meta.height ?? 714

/** 与 lib/client.js 的 drawVoucher 同一套比例。 */
const sample = {
  face: '1,081,639',
  serial: '001081639',
  from: '2026-08-29',
  to: '2026-09-10',
}

const centerX = Math.round(WIDTH * 0.67)
const denominationY = Math.round(HEIGHT * 0.71)
const captionY = Math.round(HEIGHT * 0.755)
const serialY = Math.round(HEIGHT * 0.8)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
  <text x="${centerX}" y="${denominationY}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${Math.round(HEIGHT * 0.088)}" fill="#2b2f38">${sample.face}</text>
  <text x="${centerX}" y="${captionY}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="600" font-size="${Math.round(HEIGHT * 0.028)}" fill="#2b2f38">whale yuan</text>
  <text x="${centerX}" y="${serialY}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="500" font-size="${Math.round(HEIGHT * 0.022)}" fill="#9a3b2c">NO.${sample.serial} ${sample.from} - ${sample.to}</text>
</svg>`

await mkdir(join(root, 'docs'), { recursive: true })
await sharp(join(root, 'assets', 'jingyuan-note.jpg'))
  .composite([{ input: Buffer.from(svg) }])
  .png()
  .toFile(join(root, 'docs', 'voucher-preview.png'))

console.log('wrote docs/voucher-preview.png')
