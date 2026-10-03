/**
 * dsh-whale-bank — Host 半。
 *
 * 鲸元银行：把 DeepSeek 官方通道（或全部供应商，可配置）的 token 台账折叠成
 * 一份按天 / provider / model 的文档，并按「每 N tokens 铸造 1 鲸元」的汇率
 * 铸出一张鲸元券，供 Web 端「设置 → 鲸元银行」渲染、保存与分享。
 *
 * 数据来源只有两条，均为本机只读：
 *   1. 运行时的 `session/event` 流（request/header 归属 + assistant/message 用量）；
 *   2. 可选的 @linxin666/dsh-usage 台账文件 `$DSH_HOME/dsh-usage/usage-ledger.json`
 *      （同构格式，导入后历史用量立刻可铸券）。
 *
 * 台账落在 `$DSH_HOME/dsh-whale-bank/ledger.json`，只保存聚合 token 与费用，
 * 不含提示词、回复或文件路径。三条路由（state / import / art）只接受回环请求。
 * @module dsh-whale-bank
 */

import { mkdir, readFile, rename, stat as statFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** 插件名，与 package.json 保持一致。 */
export const name = 'dsh-whale-bank'

/** 需要宿主提供的服务：HTTP 路由注册表。 */
export const inject = ['webServer']

/** 本插件所有路由的前缀。 */
export const API_PREFIX = '/api/whale-bank'

/** `$DSH_HOME` 下的持久化目录名。 */
const PERSIST_DIR = 'dsh-whale-bank'

/** 台账文件名。 */
const LEDGER_FILE = 'ledger.json'

/** 折叠后的写盘防抖（毫秒）。 */
const FLUSH_DEBOUNCE_MS = 2_000

/** 上游 dsh-usage 的台账相对路径，导入时读取。 */
const UPSTREAM_LEDGER = ['dsh-usage', 'usage-ledger.json']

/**
 * 票券底图候选：随包分发的是 jpg；本机若另放了 jpg 之外的同尺寸贴图，
 * 只要命名一致也会被选中（顺序即优先级）。
 */
const ART_CANDIDATES = [
  fileURLToPath(new URL('../assets/jingyuan-note.jpg', import.meta.url)),
  fileURLToPath(new URL('../assets/jingyuan-note.png', import.meta.url)),
]

/** 按文件魔数判断图片类型，扩展名与真实格式不一致时也不会发错 content-type。 */
function sniffImageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 11 && bytes.subarray(0, 4).toString('latin1') === 'RIFF') return 'image/webp'
  return 'application/octet-stream'
}

/** DeepSeek 官方通道的路由 id。 */
const DEEPSEEK_ROUTE_IDS = new Set(['deepseek', 'deepseek-official'])

/**
 * 插件配置。`volatile()` 字段由宿主生成设置页并支持热更新：保存设置不会重挂
 * 插件行，只把新值写回引用并广播 `loader/volatile-update`。
 */
export const Config = buildConfig()

/**
 * 构造配置 schema。宿主若因版本差异拒绝了 schema（例如不认 volatile），
 * 就退回最小 schema —— 这一行的设置页会少几个开关，但模块本身仍然可加载。
 */
function buildConfig() {
  try {
    return z.object({
      enabled: z.boolean().default(true).volatile(),
      tokensPerYuan: z.number().min(1).max(1_000_000_000).default(1_000_000).volatile(),
      retainDays: z.number().min(7).max(730).default(180).volatile(),
      includeAllProviders: z.boolean().default(false).volatile(),
      importDshUsageLedger: z.boolean().default(true).volatile(),
    })
  } catch (error) {
    reportFailure('config schema', error)
    try {
      return z.object({})
    } catch {
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 有限数字，其余归零。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 空 bucket。 */
function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
    cost: 0,
  }
}

/** 就地累加一个 bucket。 */
function addTotals(target, source) {
  target.inputTokens += num(source.inputTokens)
  target.outputTokens += num(source.outputTokens)
  target.cacheReadTokens += num(source.cacheReadTokens)
  target.cacheWriteTokens += num(source.cacheWriteTokens)
  target.reasoningTokens += num(source.reasoningTokens)
  target.calls += num(source.calls)
  target.cost += num(source.cost)
}

/** 计费 token 合计（输入 + 缓存读 + 缓存写 + 输出）。 */
function totalTokens(totals) {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
}

/** 本地日期键 `YYYY-MM-DD`。 */
function localDateKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** bucket 键来自外部数据（落盘 JSON、provider/model id），必须避开原型链名字。 */
function isSafeBucketKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

/** 是否属于 DeepSeek 官方通道。 */
export function isDeepSeekRoute(provider) {
  const id = String(provider ?? '').toLowerCase()
  return DEEPSEEK_ROUTE_IDS.has(id) || id.startsWith('deepseek')
}

/** 解析 DSH_HOME：环境变量优先，否则退回 `~/.dsh`。 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw === '') return join(home, '.dsh')
  const expanded = raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? join(home, raw.slice(2)) : raw
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
}

/** 当前 DSH_HOME。 */
export function dshHome() {
  return resolveDshHome()
}

// ---------------------------------------------------------------------------
// 台账：按天 / provider / model 的纯折叠
// ---------------------------------------------------------------------------

/** 空台账文档。 */
export function createLedgerDocument() {
  return { version: 1, days: {}, meta: {} }
}

/** 把一个用量样本折叠进台账（就地）。 */
export function foldUsage(doc, atMs, provider, model, totals) {
  if (!isSafeBucketKey(provider) || !isSafeBucketKey(model)) return
  if (totals.calls <= 0 && totalTokens(totals) <= 0) return
  const dayKey = localDateKey(atMs)
  const day = doc.days[dayKey] ?? {}
  const models = day[provider] ?? {}
  const bucket = models[model] ?? emptyTotals()
  addTotals(bucket, totals)
  models[model] = bucket
  day[provider] = models
  doc.days[dayKey] = day
}

/** 丢弃超过保留期的日期，返回被剪掉的天数。 */
export function pruneLedger(doc, todayKey, retainDays) {
  const cutoff = new Date(todayKey + 'T00:00:00')
  cutoff.setDate(cutoff.getDate() - retainDays)
  const cutoffKey = localDateKey(cutoff.getTime())
  let pruned = 0
  for (const key of Object.keys(doc.days)) {
    if (key < cutoffKey) {
      delete doc.days[key]
      pruned += 1
    }
  }
  return pruned
}

/** 从不可信 JSON 还原台账；形状不认识就退回空文档，永不出错。 */
export function deserializeLedger(value) {
  const doc = createLedgerDocument()
  if (typeof value !== 'object' || value === null) return doc
  const source = value
  if (typeof source.meta === 'object' && source.meta !== null) doc.meta = source.meta
  const days = source.days
  if (typeof days !== 'object' || days === null) return doc
  for (const [dateKey, providers] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || typeof providers !== 'object' || providers === null) continue
    // 回环校验日期：不存在的日期解析成 NaN，跨月日期会落到另一天，两者都会污染台账。
    const atMs = new Date(dateKey + 'T12:00:00').getTime()
    if (!Number.isFinite(atMs) || localDateKey(atMs) !== dateKey) continue
    for (const [provider, models] of Object.entries(providers)) {
      if (typeof models !== 'object' || models === null) continue
      for (const [model, totals] of Object.entries(models)) {
        if (typeof totals !== 'object' || totals === null) continue
        const revived = emptyTotals()
        for (const key of Object.keys(revived)) revived[key] = num(totals[key])
        foldUsage(doc, atMs, provider, model, revived)
      }
    }
  }
  return doc
}

/** 原子写 JSON：先写临时文件再改名，避免半截文件。 */
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  await rename(tmp, path)
}

// ---------------------------------------------------------------------------
// DeepSeek 官方峰谷计价（估算口径，CNY / 百万 tokens）
// 峰段：北京时间周一至周五 09:00-12:00、14:00-18:00，其余时段半价。
// ---------------------------------------------------------------------------

const PEAK_WINDOWS = [
  { from: 9 * 60, to: 12 * 60 },
  { from: 14 * 60, to: 18 * 60 },
]

const BEIJING_UTC_OFFSET_MS = 8 * 3_600_000

const FLASH_PRICE = {
  cacheHit: { offPeak: 0.02, peak: 0.04 },
  inputMiss: { offPeak: 1.0, peak: 2.0 },
  output: { offPeak: 4.0, peak: 8.0 },
}

const PRO_PRICE = {
  cacheHit: { offPeak: 0.15, peak: 0.3 },
  inputMiss: { offPeak: 4.5, peak: 9.0 },
  output: { offPeak: 13.5, peak: 27.0 },
}

/** `deepseek-v4-pro` 自该时刻起由 V4.1-Flash 承接，按 flash 档计价。 */
const V4_PRO_FOLDED_INTO_FLASH_AT_MS = Date.UTC(2026, 8, 14, 4, 0)

/** 某个时刻是否处于 DeepSeek 峰段（北京时间）。 */
export function deepseekPeriodAt(ms) {
  const shifted = new Date(ms + BEIJING_UTC_OFFSET_MS)
  const weekday = shifted.getUTCDay()
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  const current = weekday >= 1 && weekday <= 5
    ? PEAK_WINDOWS.find((window) => minuteOfDay >= window.from && minuteOfDay < window.to)
    : undefined
  return { peak: current !== undefined }
}

/** 一个用量样本的 DeepSeek 花费估算（CNY）。 */
export function deepseekModelSpend(model, totals, atMs) {
  const id = String(model ?? '')
  const price = id.includes('v4-pro') && atMs < V4_PRO_FOLDED_INTO_FLASH_AT_MS ? PRO_PRICE : FLASH_PRICE
  const column = deepseekPeriodAt(atMs).peak ? 'peak' : 'offPeak'
  const spend = (totals.cacheReadTokens * price.cacheHit[column]
    + (totals.inputTokens + totals.cacheWriteTokens) * price.inputMiss[column]
    + totals.outputTokens * price.output[column]) / 1_000_000
  return Math.round(spend * 1e6) / 1e6
}

// ---------------------------------------------------------------------------
// 回环信任围栏
// ---------------------------------------------------------------------------

function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** 请求级围栏：回环 socket + 回环 Host，外加浏览器同源标记。 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 回环，或（装了 remote-web-ui 时）一个已配对的局域网设备。 */
function isAllowed(ctx, request) {
  if (isLoopbackRequest(request)) return true
  let pairing
  try {
    pairing = typeof ctx.get === 'function' ? ctx.get('remoteWebUiPairing', false) : undefined
  } catch {
    pairing = undefined
  }
  return typeof pairing?.isPairedDevice === 'function' && pairing.isPairedDevice(request) === true
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/** 读取 volatile 配置字段：既支持引用，也支持普通值。 */
function readField(field, fallback) {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

/** 解析本次激活生效的配置。 */
export function resolveConfig(config) {
  const rate = Number(readField(config?.tokensPerYuan, 1_000_000))
  const retainDays = Number(readField(config?.retainDays, 180))
  return {
    enabled: readField(config?.enabled, true) !== false,
    tokensPerYuan: Number.isFinite(rate) && rate >= 1 ? rate : 1_000_000,
    retainDays: Number.isFinite(retainDays) && retainDays >= 7 ? Math.min(730, Math.floor(retainDays)) : 180,
    includeAllProviders: readField(config?.includeAllProviders, false) === true,
    importDshUsageLedger: readField(config?.importDshUsageLedger, true) !== false,
  }
}

/** 鲸元券台账服务：折叠、持久化、铸券。 */
export class WhaleBankService {
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.dir = join(dshHome(), PERSIST_DIR)
    this.ledgerPath = join(this.dir, LEDGER_FILE)
    this.ledger = createLedgerDocument()
    this.sessionRoutes = new WeakMap()
    this.disposeSession = undefined
    this.flushTimer = undefined
    this.flushChain = Promise.resolve()
    this.loaded = false
    this.disposed = false
    this.artCache = undefined
  }

  /** 订阅会话用量事件并载入落盘台账。 */
  start() {
    this.disposeSession = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    void this.loadPersisted()
  }

  /** 退订并冲刷台账。 */
  async stop() {
    this.disposed = true
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    try {
      this.disposeSession?.()
    } catch {
      // 宿主关闭过程中 fiber 可能已释放。
    }
    await this.flushLedger()
  }

  /** 生效配置变化：保留期缩短时立刻剪枝。 */
  applyOptions(options) {
    this.options = options
    this.pruneIfNeeded()
  }

  // -- 会话事件折叠 ---------------------------------------------------------

  onSessionEvent(session, event) {
    try {
      if (event.type === 'request/header') {
        const config = event.data?.header?.config
        if (typeof config?.provider === 'string') {
          this.sessionRoutes.set(session, { provider: config.provider, model: config.model ?? '' })
        }
        return
      }
      if (event.type === 'request/context') {
        const data = event.data
        if (typeof data?.provider === 'string') {
          this.sessionRoutes.set(session, { provider: data.provider, model: data.model ?? '' })
        }
        return
      }
      if (event.type !== 'assistant/message') return
      const usage = event.data?.usage
      if (usage === undefined) return
      const route = this.sessionRoutes.get(session)
      if (route === undefined || route.provider === '') return
      const model = route.model || 'unknown'
      const totals = emptyTotals()
      totals.inputTokens = num(usage.inputTokens)
      totals.outputTokens = num(usage.outputTokens)
      totals.cacheReadTokens = num(usage.cacheReadTokens)
      totals.cacheWriteTokens = num(usage.cacheWriteTokens)
      totals.reasoningTokens = num(usage.reasoningTokens)
      totals.calls = 1
      if (isDeepSeekRoute(route.provider)) totals.cost = deepseekModelSpend(model, totals, Date.now())
      foldUsage(this.ledger, Date.now(), route.provider, model, totals)
      this.pruneIfNeeded()
      this.scheduleFlush()
    } catch {
      // 单个畸形事件不能打断会话循环。
    }
  }

  // -- 持久化 ---------------------------------------------------------------

  async loadPersisted() {
    try {
      const raw = await readFile(this.ledgerPath, 'utf8').catch(() => undefined)
      if (raw !== undefined) {
        const loaded = deserializeLedger(JSON.parse(raw))
        // 合并而非替换：读盘窗口内落进来的折叠必须保留。
        for (const [dayKey, providers] of Object.entries(loaded.days)) {
          const atMs = new Date(dayKey + 'T12:00:00').getTime()
          for (const [provider, models] of Object.entries(providers)) {
            for (const [model, totals] of Object.entries(models)) {
              foldUsage(this.ledger, atMs, provider, model, totals)
            }
          }
        }
        if (typeof loaded.meta === 'object' && loaded.meta !== null) this.ledger.meta = loaded.meta
      }
    } catch {
      // 损坏的台账从空开始，下一次写盘会覆盖它。
    } finally {
      this.loaded = true
    }
    this.pruneIfNeeded()
    if (this.options.importDshUsageLedger && Object.keys(this.ledger.days).length === 0) {
      await this.importFromDshUsage().catch(() => undefined)
    }
    this.scheduleFlush()
  }

  scheduleFlush() {
    if (this.flushTimer !== undefined || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushLedger()
    }, FLUSH_DEBOUNCE_MS)
    if (typeof this.flushTimer?.unref === 'function') this.flushTimer.unref()
  }

  flushLedger() {
    const next = this.flushChain.then(() => this.writeLedgerOnce())
    this.flushChain = next.catch(() => {})
    return next
  }

  async writeLedgerOnce() {
    if (!this.loaded) return
    try {
      await mkdir(dirname(this.ledgerPath), { recursive: true })
      await writeJsonAtomic(this.ledgerPath, this.ledger)
    } catch {
      // 落盘失败静默降级：内存台账继续计数。
    }
  }

  pruneIfNeeded() {
    const todayKey = localDateKey(Date.now())
    if (this.lastPruneDay === todayKey && this.lastPruneRetain === this.options.retainDays) return
    this.lastPruneDay = todayKey
    this.lastPruneRetain = this.options.retainDays
    if (pruneLedger(this.ledger, todayKey, this.options.retainDays) > 0) this.scheduleFlush()
  }

  // -- 铸券 ----------------------------------------------------------------

  /** 当前票券状态（浏览器要的整份文档）。 */
  state() {
    const includeAll = this.options.includeAllProviders
    const totals = emptyTotals()
    let from
    let to
    let days = 0
    for (const key of Object.keys(this.ledger.days).sort()) {
      const day = this.ledger.days[key] ?? {}
      let hit = false
      for (const [provider, models] of Object.entries(day)) {
        if (!includeAll && !isDeepSeekRoute(provider)) continue
        if (typeof models !== 'object' || models === null) continue
        for (const bucket of Object.values(models)) {
          addTotals(totals, bucket)
          hit = true
        }
      }
      if (!hit) continue
      if (from === undefined) from = key
      to = key
      days += 1
    }
    const tokens = totalTokens(totals)
    const rate = this.options.tokensPerYuan
    const face = tokens > 0 ? Math.max(1, Math.round(tokens / rate)) : 0
    const meta = this.ledger.meta ?? {}
    return {
      ok: true,
      updatedAt: Date.now(),
      scope: includeAll ? 'all' : 'deepseek',
      rate,
      retainDays: this.options.retainDays,
      tokens,
      calls: totals.calls,
      cost: Math.round(totals.cost * 100) / 100,
      face,
      serial: String(face % 1_000_000_000).padStart(9, '0'),
      from: from ?? localDateKey(Date.now()),
      to: to ?? localDateKey(Date.now()),
      days,
      empty: tokens <= 0,
      ...(typeof meta.importedAt === 'number' ? { importedAt: meta.importedAt } : {}),
      ...(typeof meta.importedDays === 'number' ? { importedDays: meta.importedDays } : {}),
      ...(typeof meta.importedFrom === 'string' ? { importedFrom: meta.importedFrom } : {}),
    }
  }

  /**
   * 从上游 @linxin666/dsh-usage 的台账导入历史用量（同构格式）。
   * 只读、容错：文件不存在或格式不认识都返回人话原因，不改动现有台账。
   */
  async importFromDshUsage() {
    const path = join(dshHome(), ...UPSTREAM_LEDGER)
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return { ok: false, error: 'not-found', path }
    }
    let loaded
    try {
      loaded = deserializeLedger(JSON.parse(raw))
    } catch {
      return { ok: false, error: 'unreadable', path }
    }
    const keys = Object.keys(loaded.days)
    if (keys.length === 0) return { ok: false, error: 'empty', path }
    for (const [dayKey, providers] of Object.entries(loaded.days)) {
      const atMs = new Date(dayKey + 'T12:00:00').getTime()
      for (const [provider, models] of Object.entries(providers)) {
        for (const [model, bucket] of Object.entries(models)) {
          foldUsage(this.ledger, atMs, provider, model, bucket)
        }
      }
    }
    this.ledger.meta = {
      ...(this.ledger.meta ?? {}),
      importedAt: Date.now(),
      importedDays: keys.length,
      importedFrom: path,
    }
    this.pruneIfNeeded()
    await this.flushLedger()
    return { ok: true, days: keys.length, path, state: this.state() }
  }

  /**
   * 票券底图：按候选顺序取第一张存在的图，缓存字节与 mtime。文件被替换
   * （更新贴图）时 mtime 变化，下一次请求自动重读，不需要重启宿主。
   * @returns {Promise<{bytes: Buffer, contentType: string, path: string, mtimeMs: number}>} 底图与元信息。
   */
  async readArt() {
    for (const candidate of ART_CANDIDATES) {
      let info
      try {
        info = await statFile(candidate)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      const cached = this.artCache
      if (cached !== undefined && cached.path === candidate && cached.mtimeMs === info.mtimeMs) return cached
      const bytes = await readFile(candidate)
      const entry = { bytes, contentType: sniffImageType(bytes), path: candidate, mtimeMs: info.mtimeMs }
      this.artCache = entry
      return entry
    }
    throw new Error('art asset missing')
  }
}

// ---------------------------------------------------------------------------
// 插件体
// ---------------------------------------------------------------------------

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主根上下文。
 * @param {object} [config] 本行的配置（volatile 字段为引用）。
 */
/**
 * 对外入口：所有挂载异常都在这里收口。宿主进程里同时跑着用户的其他会话，
 * 一行插件挂载失败绝不能把整个 profile 拖下水 —— 失败即静默休眠。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主根上下文。
 * @param {object} [config] 本行的配置（volatile 字段为引用）。
 */
export const apply = (ctx, config) => {
  try {
    return mount(ctx, config)
  } catch (error) {
    reportFailure('mount', error)
  }
}

/** 记录一次失败；连日志都可能不可用，所以再包一层。 */
function reportFailure(scope, error) {
  try {
    console.warn('[dsh-whale-bank] ' + scope + ' failed, staying dormant:', error)
  } catch {
    // 忽略：没有日志也要活着。
  }
}

/** 真正的挂载体。 */
function mount(ctx, config) {
  let live = true
  let service
  let disposers = []

  const mountRoutes = (instance) => {
    const routes = [
      {
        kind: 'exact',
        path: API_PREFIX + '/state',
        handler: (req, res) => {
          if (!isAllowed(ctx, req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
          writeJson(res, 200, instance.state())
        },
      },
      {
        kind: 'exact',
        path: API_PREFIX + '/import',
        handler: async (req, res) => {
          if (!isAllowed(ctx, req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const result = await instance.importFromDshUsage()
            writeJson(res, result.ok ? 200 : 404, result)
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'import failed' })
          }
        },
      },
      {
        kind: 'exact',
        path: API_PREFIX + '/art',
        handler: async (req, res) => {
          if (!isAllowed(ctx, req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
          try {
            const art = await instance.readArt()
            const etag = '"' + Math.round(art.mtimeMs) + '-' + art.bytes.length + '"'
            if (req.headers['if-none-match'] === etag) {
              res.writeHead(304, { etag, 'cache-control': 'no-cache' })
              res.end()
              return
            }
            res.writeHead(200, {
              'content-type': art.contentType,
              'content-length': String(art.bytes.length),
              'cache-control': 'no-cache',
              etag,
            })
            res.end(art.bytes)
          } catch {
            writeJson(res, 404, { ok: false, error: 'art asset missing' })
          }
        },
      },
    ]
    const mounted = []
    for (const route of routes) {
      try {
        mounted.push(ctx.webServer.register(route))
      } catch (error) {
        // 路径已被占用或 webServer 不可用：只丢这一条路由，别连累宿主启动。
        reportFailure('route ' + route.path, error)
      }
    }
    return mounted
  }

  const launch = () => {
    if (!live || service !== undefined) return
    const options = resolveConfig(config)
    if (!options.enabled) return
    const instance = new WhaleBankService(ctx, options)
    service = instance
    instance.start()
    disposers = mountRoutes(instance)
  }

  const stop = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 关闭过程中路由 fiber 可能已释放。
      }
    }
    disposers = []
    void service?.stop()
    service = undefined
  }

  const rearm = () => {
    const options = resolveConfig(config)
    if (!options.enabled) return stop()
    if (service !== undefined) return service.applyOptions(options)
    launch()
  }

  // 设置页保存 volatile 字段后走这条路：不重挂行，只重新生效一次配置。
  try {
    if (typeof ctx.on === 'function') ctx.on('loader/volatile-update', () => rearm())
  } catch (error) {
    reportFailure('volatile listener', error)
  }

  try {
    ctx.effect(() => {
      rearm()
      return () => {
        live = false
        stop()
      }
    }, 'dsh-whale-bank: runtime')
  } catch (error) {
    // 连 effect 都挂不上时退一步同步挂一次，至少这一行还能用。
    reportFailure('effect', error)
    try {
      rearm()
    } catch (inner) {
      reportFailure('synchronous mount', inner)
    }
  }
}
