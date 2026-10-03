/**
 * dsh-whale-bank 冒烟测试。
 *
 * 不依赖运行中的 DSH：Host 半用假 ctx（webServer / on / effect）驱动，客户端半
 * 用假 __ModuleLoader__ 与假 react 评估，只验证结构与算法。运行：npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** 每个测试用例一个隔离的 DSH_HOME。 */
async function freshHome(name) {
  const home = await mkdtemp(join(tmpdir(), 'whale-bank-' + name + '-'))
  process.env.DSH_HOME = home
  return home
}

const mod = await import('../lib/index.js')

function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  return {
    routes,
    listeners,
    disposers,
    emit(event, ...args) {
      const handler = listeners.get(event)
      if (handler !== undefined) handler(...args)
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    get() {
      return undefined
    },
  }
}

function fakeReq({ ip = '127.0.0.1', host = '127.0.0.1:14826', method = 'GET', headers = {} } = {}) {
  return { method, socket: { remoteAddress: ip }, headers: { host, ...headers } }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(body) {
      if (body !== undefined) this.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
    text() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
    json() {
      return JSON.parse(this.text())
    },
  }
}

/** 一个请求/回复的用户回合：先报路由，再报用量。 */
function emitTurn(ctx, { provider = 'deepseek-official', model = 'deepseek-flash', usage } = {}) {
  const session = { id: 'session-test' }
  ctx.emit('session/event', session, { type: 'request/header', data: { header: { config: { provider, model } } } })
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: {
      usage: usage ?? { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 },
    },
  })
}

const DEFAULT_OPTIONS = {
  enabled: true,
  tokensPerYuan: 1_000_000,
  retainDays: 180,
  includeAllProviders: false,
  importDshUsageLedger: false,
}

test('导出的插件形状符合 DSH 约定', () => {
  assert.equal(mod.name, 'dsh-whale-bank')
  assert.deepEqual(mod.inject, ['webServer'])
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config !== undefined, 'Config 必须导出，宿主据此生成本行设置页')
})

test('resolveConfig 支持 volatile 引用与非法值兜底', () => {
  const resolved = mod.resolveConfig({
    enabled: { get: () => false },
    tokensPerYuan: { get: () => 1000 },
    retainDays: { get: () => 30 },
    includeAllProviders: { get: () => true },
    importDshUsageLedger: { get: () => false },
  })
  assert.deepEqual(resolved, {
    enabled: false,
    tokensPerYuan: 1000,
    retainDays: 30,
    includeAllProviders: true,
    importDshUsageLedger: false,
  })
  const fallback = mod.resolveConfig({ tokensPerYuan: { get: () => Number.NaN }, retainDays: { get: () => 1 } })
  assert.equal(fallback.tokensPerYuan, 1_000_000)
  assert.equal(fallback.retainDays, 180)
  assert.equal(fallback.enabled, true)
})

test('折叠会话用量：只统计 DeepSeek 官方通道', async () => {
  await freshHome('fold')
  const ctx = makeCtx()
  const service = new mod.WhaleBankService(ctx, { ...DEFAULT_OPTIONS })
  service.start()

  emitTurn(ctx)
  emitTurn(ctx, { provider: 'openai-codex', model: 'gpt-6-astra' })
  emitTurn(ctx, { provider: 'deepseek', model: 'deepseek-v4-pro', usage: { inputTokens: 500, outputTokens: 100 } })

  const state = service.state()
  assert.equal(state.tokens, 3500 + 600, '非 DeepSeek 路由不计入默认口径')
  assert.equal(state.calls, 2)
  assert.equal(state.face, 1, '三千多 token 按百万汇率仍铸出最小面额 1')
  assert.equal(state.serial, '000000001')
  assert.equal(state.scope, 'deepseek')
  assert.equal(state.empty, false)
  // state 里的费用按分取整，小额用量可能落到 0.00；估价函数本身单独断言，
  // 免得这个用例的成败随峰谷时段漂移。
  const spend = mod.deepseekModelSpend('deepseek-flash', {
    inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0,
  }, Date.now())
  assert.ok(spend > 0, 'DeepSeek 官方路由应当带费用估算')
  assert.ok(state.cost >= 0)
  await service.stop()
})

test('includeAllProviders 打开后把全部路由算进票面', async () => {
  await freshHome('all')
  const ctx = makeCtx()
  const service = new mod.WhaleBankService(ctx, { ...DEFAULT_OPTIONS, includeAllProviders: true })
  service.start()
  emitTurn(ctx, { provider: 'openai-codex', model: 'gpt-6-astra' })
  const state = service.state()
  assert.equal(state.scope, 'all')
  assert.equal(state.tokens, 3500)
  assert.equal(state.cost, 0, '非 DeepSeek 路由不估价')
  await service.stop()
})

test('面额按汇率换算并带上限流水号', async () => {
  await freshHome('rate')
  const ctx = makeCtx()
  const service = new mod.WhaleBankService(ctx, { ...DEFAULT_OPTIONS, tokensPerYuan: 1000 })
  service.start()
  emitTurn(ctx, { usage: { inputTokens: 1_081_639_000, outputTokens: 0 } })
  const state = service.state()
  assert.equal(state.tokens, 1_081_639_000)
  assert.equal(state.face, 1_081_639)
  assert.equal(state.serial, '001081639')
  await service.stop()
})

test('台账落盘后可被新实例读回', async () => {
  const home = await freshHome('persist')
  const ctx = makeCtx()
  const first = new mod.WhaleBankService(ctx, { ...DEFAULT_OPTIONS })
  first.start()
  await first.loadPersisted()
  emitTurn(ctx)
  await first.flushLedger()
  await first.stop()

  const raw = JSON.parse(await readFile(join(home, 'dsh-whale-bank', 'ledger.json'), 'utf8'))
  assert.equal(raw.version, 1)
  assert.ok(Object.keys(raw.days).length >= 1)

  const second = new mod.WhaleBankService(makeCtx(), { ...DEFAULT_OPTIONS })
  await second.loadPersisted()
  assert.equal(second.state().tokens, first.state().tokens)
  await second.stop()
})

test('从 dsh-usage 台账导入历史用量', async () => {
  const home = await freshHome('import')
  const upstream = join(home, 'dsh-usage')
  await mkdir(upstream, { recursive: true })
  await writeFile(join(upstream, 'usage-ledger.json'), JSON.stringify({
    version: 1,
    days: {
      '2026-08-29': {
        'deepseek-official': {
          'deepseek-flash': { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 5_000_000, cacheWriteTokens: 0, reasoningTokens: 0, calls: 120, cost: 3.5 },
        },
        'openai-codex': {
          'gpt-6-astra': { inputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 },
        },
      },
      '2026-09-10': {
        deepseek: {
          'deepseek-v4-pro': { inputTokens: 300_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 40, cost: 1.2 },
        },
      },
    },
  }), 'utf8')

  const service = new mod.WhaleBankService(makeCtx(), { ...DEFAULT_OPTIONS })
  await service.loadPersisted()
  const result = await service.importFromDshUsage()
  assert.equal(result.ok, true)
  assert.equal(result.days, 2)

  const state = service.state()
  assert.equal(state.tokens, 6_200_000 + 400_000)
  assert.equal(state.calls, 160)
  assert.equal(state.from, '2026-08-29')
  assert.equal(state.to, '2026-09-10')
  assert.equal(state.face, 7, '6.6M tokens / 1M 四舍五入到 7')
  assert.equal(state.days, 2)
  assert.ok(state.importedAt > 0)
  await service.stop()

  // 缺文件时给出可读原因而不是抛错。
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'whale-bank-missing-'))
  const lonely = new mod.WhaleBankService(makeCtx(), { ...DEFAULT_OPTIONS })
  const missing = await lonely.importFromDshUsage()
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'not-found')
})

test('保留期剪枝丢弃超期日期', async () => {
  await freshHome('prune')
  const ctx = makeCtx()
  const service = new mod.WhaleBankService(ctx, { ...DEFAULT_OPTIONS, retainDays: 7 })
  service.start()
  const old = Date.now() - 40 * 86_400_000
  mod.foldUsage(service.ledger, old, 'deepseek-official', 'deepseek-flash', {
    inputTokens: 5_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 5, cost: 0,
  })
  mod.foldUsage(service.ledger, Date.now(), 'deepseek-official', 'deepseek-flash', {
    inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0,
  })
  service.pruneIfNeeded()
  assert.equal(service.state().tokens, 10)
  await service.stop()
})

test('apply 注册三条路由，且只放行回环请求', async () => {
  await freshHome('routes')
  const ctx = makeCtx()
  mod.apply(ctx, {})
  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/api/whale-bank/art',
    '/api/whale-bank/import',
    '/api/whale-bank/state',
  ])

  const session = { id: 's' }
  ctx.emit('session/event', session, { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } })
  ctx.emit('session/event', session, { type: 'assistant/message', data: { usage: { inputTokens: 2_000_000, outputTokens: 0 } } })

  const stateRoute = ctx.routes.get('/api/whale-bank/state')
  const okRes = fakeRes()
  await stateRoute.handler(fakeReq(), okRes)
  assert.equal(okRes.statusCode, 200)
  assert.equal(okRes.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(okRes.json().tokens, 2_000_000)

  const denied = fakeRes()
  await stateRoute.handler(fakeReq({ ip: '10.0.0.5', host: '10.0.0.5:14826' }), denied)
  assert.equal(denied.statusCode, 403)

  const crossSite = fakeRes()
  await stateRoute.handler(fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } }), crossSite)
  assert.equal(crossSite.statusCode, 403)

  const wrongMethod = fakeRes()
  await stateRoute.handler(fakeReq({ method: 'POST' }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  // art 路由返回真实 JPEG 字节。
  const artRes = fakeRes()
  await ctx.routes.get('/api/whale-bank/art').handler(fakeReq(), artRes)
  assert.equal(artRes.statusCode, 200)
  const bytes = Buffer.concat(artRes.chunks)
  assert.ok(bytes.length > 100_000, '票券底图应当随包分发')
  assert.equal(bytes[0], 0xFF)
  assert.equal(bytes[1], 0xD8)
  assert.equal(artRes.headers['content-type'], 'image/jpeg', 'content-type 必须按真实字节给出')
  assert.ok(typeof artRes.headers.etag === 'string' && artRes.headers.etag.length > 0, '底图要带 ETag')

  // 条件请求：ETag 命中时回 304，不重传底图。
  const notModified = fakeRes()
  await ctx.routes.get('/api/whale-bank/art').handler(fakeReq({ headers: { 'if-none-match': artRes.headers.etag } }), notModified)
  assert.equal(notModified.statusCode, 304)
  assert.equal(notModified.chunks.length, 0)

  // 换贴图免重启：底图缓存按 mtime 失效，文件时间戳一变就重读。
  const service = new mod.WhaleBankService(makeCtx(), { ...DEFAULT_OPTIONS })
  const before = await service.readArt()
  assert.ok(before.mtimeMs > 0, 'readArt 必须回报 mtime，供换图失效使用')
  const again = await service.readArt()
  assert.equal(again, before, '未改动时命中缓存（同一对象）')
  const stamp = new Date(Date.now() + 1000)
  await utimes(before.path, stamp, stamp)
  const after = await service.readArt()
  assert.notEqual(after, before, 'mtime 变化后必须重读底图')
  assert.equal(after.bytes.length, before.bytes.length)

  // 停用配置不挂任何路由。
  const offCtx = makeCtx()
  mod.apply(offCtx, { enabled: { get: () => false } })
  assert.equal(offCtx.routes.size, 0)
  offCtx.disposers.forEach((dispose) => typeof dispose === 'function' && dispose())
})

test('挂载失败时静默降级，绝不抛出到宿主', async () => {
  await freshHome('dormant')
  const broken = {
    webServer: {
      register() {
        throw new Error('route path already taken')
      },
    },
    on() {
      throw new Error('listener seam unavailable')
    },
    effect() {
      throw new Error('effect seam unavailable')
    },
    get() {
      return undefined
    },
  }
  assert.doesNotThrow(() => mod.apply(broken, {}), 'apply 绝不能让宿主的加载流程炸掉')
})

test('客户端半可在模块加载器约定下评估并注册设置区', async () => {
  const source = await readFile(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  let captured
  const windowStub = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  // 与浏览器一致：脚本以 window 为全局执行。
  new Function('window', 'document', source)(windowStub, { documentElement: { lang: 'zh' } })
  assert.ok(captured !== undefined, '客户端脚本必须调用 __ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-whale-bank')

  const reactStub = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const clientExports = captured.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error('unexpected require: ' + id)
  })
  assert.equal(typeof clientExports.apply, 'function')
  assert.deepEqual(clientExports.inject, ['slots'])
  assert.equal(typeof clientExports.WhaleBankSection, 'function', '设置区组件必须是个组件')

  let registered
  const clientCtx = {
    slots: {
      inject(name, factory) {
        assert.equal(name, 'settings.section')
        factory()
      },
      register(spec, component) {
        registered = { spec, component }
        return () => {}
      },
    },
  }
  clientExports.apply(clientCtx)
  assert.equal(registered.spec.name, 'settings.section')
  assert.equal(registered.spec.id, 'dsh-whale-bank')
  assert.equal(typeof registered.spec.order, 'number')
  assert.equal(registered.spec.label(), '鲸元银行')
  assert.equal(registered.component, clientExports.WhaleBankSection)
})
