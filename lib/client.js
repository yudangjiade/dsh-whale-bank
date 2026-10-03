/**
 * dsh-whale-bank — Client 半。
 *
 * 在「设置」里挂一个一级设置区「鲸元银行」：把 Host 铸好的鲸元券画到 canvas 上，
 * 并提供保存图片 / 分享 / 刷新 / 导入上游台账。全部绘制在浏览器本地完成，
 * 这里只读 Host 的三条路由（state / art / import），不碰任何凭据。
 *
 * 该文件不经过打包器：它直接以 DSH 客户端模块加载器的 `__ModuleLoader__.load`
 * 约定书写，`require()` 只能取 package.json 里 `dsh.client.inject` 声明过的模块。
 * @module dsh-whale-bank/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-bank',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // -----------------------------------------------------------------
    // 文案（按文档语言取一份，两套 key 完全对齐）
    // -----------------------------------------------------------------

    const zh = {
      title: '鲸元银行',
      voucher: '鲸元券',
      hint: '官方 API 每消耗 {rate} tokens 铸造 1 鲸元；保存或分享这张票券。',
      scopeAll: '当前口径：全部供应商',
      scopeDeepSeek: '当前口径：DeepSeek 官方通道',
      empty: '还没有可铸的用量：插件启用后开始统计，也可以点「导入 dsh-usage 台账」把历史用量补进来。',
      loading: '正在取台账…',
      error: '读取失败：{error}',
      minted: '累计铸造 {minted} 鲸元（{tokens} tokens）',
      spend: '消费估算：约 ¥{cost}',
      calls: '{n} 次调用',
      window: '统计窗口 {from} ~ {to} · 共 {days} 天',
      imported: '已于 {time} 从上游台账导入 {days} 天数据',
      save: '保存图片',
      share: '分享',
      refresh: '刷新',
      importing: '导入中…',
      importLedger: '导入 dsh-usage 台账',
      importOk: '导入成功：{days} 天数据已并入台账。',
      importNotFound: '没找到上游台账（{path}），先装一次 dsh-usage 并跑一会儿再来。',
      importEmpty: '上游台账里没有可用数据。',
      importUnreadable: '上游台账读不出来，已跳过。',
      drawError: '票券生成失败：{error}',
      shareUnsupported: '当前环境不支持系统分享，用「保存图片」吧。',
    }

    const en = {
      title: 'Whale Bank',
      voucher: 'Whale-yuan voucher',
      hint: 'Every {rate} tokens spent on the official API mint one whale yuan; save or share the note.',
      scopeAll: 'Scope: every provider',
      scopeDeepSeek: 'Scope: official DeepSeek routes',
      empty: 'Nothing to mint yet: counting starts when the plugin is enabled, or import the dsh-usage ledger for history.',
      loading: 'Loading the ledger…',
      error: 'Failed to load: {error}',
      minted: 'Minted {minted} whale yuan ({tokens} tokens)',
      spend: 'Estimated spend: about ¥{cost}',
      calls: '{n} calls',
      window: 'Window {from} - {to} ({days} days)',
      imported: 'Imported {days} days from the upstream ledger at {time}',
      save: 'Save image',
      share: 'Share',
      refresh: 'Refresh',
      importing: 'Importing…',
      importLedger: 'Import dsh-usage ledger',
      importOk: 'Imported: {days} days merged into the ledger.',
      importNotFound: 'No upstream ledger at {path}; install dsh-usage and let it run first.',
      importEmpty: 'The upstream ledger has no usable data.',
      importUnreadable: 'The upstream ledger could not be parsed; skipped.',
      drawError: 'Failed to render the voucher: {error}',
      shareUnsupported: 'System share is unavailable here; use Save image.',
    }

    function dictionary() {
      const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
      return String(lang).toLowerCase().startsWith('en') ? en : zh
    }

    function t(key, params) {
      let text = dictionary()[key] ?? zh[key] ?? key
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) text = text.split('{' + name + '}').join(String(value))
      }
      return text
    }

    // -----------------------------------------------------------------
    // Host API
    // -----------------------------------------------------------------

    const FETCH_TIMEOUT_MS = 15000

    async function apiFetch(path, method) {
      const response = await fetch(path, {
        ...(method === 'POST' ? { method: 'POST' } : {}),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok && !(body && body.ok === false)) {
        throw new Error(path + ' failed: ' + response.status)
      }
      return body
    }

    // 文档相对路径：GUI 以 <base href="./"> 提供，子路径部署也能命中。
    const api = {
      state: () => apiFetch('api/whale-bank/state', 'GET'),
      importLedger: () => apiFetch('api/whale-bank/import', 'POST'),
      artUrl: 'api/whale-bank/art',
    }

    // -----------------------------------------------------------------
    // 数字与日期
    // -----------------------------------------------------------------

    function formatDenomination(value) {
      return Math.max(0, Math.round(value)).toLocaleString('en-US')
    }

    function formatTokens(value) {
      const n = Math.max(0, Math.round(value))
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
      return String(n)
    }

    function formatRate(value) {
      const n = Math.max(1, Math.round(value))
      if (n >= 1e6) return formatTokens(n)
      return formatDenomination(n)
    }

    function formatTime(ms) {
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    // -----------------------------------------------------------------
    // 票券绘制（版面与上游票券保持一致，全部在本地 canvas 完成）
    // -----------------------------------------------------------------

    let artPromise

    /** 取一次票券底图；失败就退回手绘票面，绝不让整块面板挂掉。 */
    function loadArt() {
      artPromise ??= new Promise((resolve) => {
        const image = new Image()
        image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight })
        image.onerror = () => {
          artPromise = undefined
          resolve(undefined)
        }
        image.src = api.artUrl
      })
      return artPromise
    }

    const INK = '#2b2f38'
    const SEAL_RED = '#9a3b2c'
    const PAPER = '#f2ead6'
    const SERIF = "Georgia, 'Times New Roman', serif"
    const SANS = "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

    /** 没有底图时手绘一张素票。 */
    function drawPlainNote(ctx, width, height) {
      ctx.fillStyle = PAPER
      ctx.fillRect(0, 0, width, height)
      ctx.strokeStyle = INK
      ctx.lineWidth = Math.max(2, Math.round(height * 0.012))
      ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, width - ctx.lineWidth * 2, height - ctx.lineWidth * 2)
      ctx.lineWidth = Math.max(1, Math.round(height * 0.004))
      ctx.strokeRect(height * 0.04, height * 0.04, width - height * 0.08, height - height * 0.08)
      ctx.textAlign = 'center'
      ctx.fillStyle = INK
      ctx.font = `600 ${Math.round(height * 0.06)}px ${SANS}`
      ctx.fillText('Deepseek 鲸元银行', Math.round(width * 0.67), Math.round(height * 0.3))
      ctx.font = `700 ${Math.round(height * 0.1)}px ${SERIF}`
      ctx.fillText('鲸元券', Math.round(width * 0.67), Math.round(height * 0.5))
      ctx.textAlign = 'left'
      ctx.font = `600 ${Math.round(height * 0.05)}px ${SANS}`
      ctx.fillText('鲸萬', Math.round(width * 0.06), Math.round(height * 0.2))
      ctx.fillText('鲸萬', Math.round(width * 0.06), Math.round(height * 0.95))
    }

    /**
     * 把面额盖到票面上：主数字排在票面右侧空档，下面是小写币名与
     * 盖章式流水号（纯数字 + ISO 日期，脱离语言）。
     */
    function drawVoucher(canvas, art, data) {
      const width = art?.width ?? 1400
      const height = art?.height ?? 714
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('canvas 2d context unavailable')
      if (art !== undefined) ctx.drawImage(art.image, 0, 0, width, height)
      else drawPlainNote(ctx, width, height)

      const centerX = Math.round(width * 0.67)
      const denomination = formatDenomination(data.face)

      let size = Math.round(height * 0.115)
      const minSize = Math.round(height * 0.055)
      const maxWidth = width * 0.28
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = INK
      while (size > minSize) {
        ctx.font = `700 ${size}px ${SERIF}`
        if (ctx.measureText(denomination).width <= maxWidth) break
        size -= 2
      }
      ctx.fillText(denomination, centerX, Math.round(height * 0.71))

      ctx.font = `600 ${Math.round(height * 0.032)}px ${SERIF}`
      ctx.fillText('whale yuan', centerX, Math.round(height * 0.755))

      ctx.fillStyle = SEAL_RED
      ctx.font = `500 ${Math.round(height * 0.026)}px ${SERIF}`
      ctx.fillText(`NO.${data.serial} ${data.from} - ${data.to}`, centerX, Math.round(height * 0.8))
    }

    // -----------------------------------------------------------------
    // 样式（跟随主题：只用 currentColor 与半透明底色，浅色深色都成立）
    // -----------------------------------------------------------------

    const styles = {
      wrap: { padding: '4px 2px 24px', display: 'flex', flexDirection: 'column', gap: '12px' },
      card: {
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        background: 'rgba(127,127,127,0.05)',
      },
      title: { fontSize: '15px', fontWeight: 600 },
      muted: { fontSize: '13px', opacity: 0.7, lineHeight: 1.5 },
      fact: { fontSize: '14px', fontWeight: 500 },
      canvas: { width: '100%', maxWidth: '760px', height: 'auto', borderRadius: '6px', display: 'block' },
      row: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      button: {
        font: 'inherit',
        fontSize: '13px',
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        font: 'inherit',
        fontSize: '13px',
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'rgba(127,127,127,0.16)',
        color: 'inherit',
        cursor: 'pointer',
      },
      note: { fontSize: '13px', lineHeight: 1.5 },
      error: { fontSize: '13px', color: '#c0392b', lineHeight: 1.5 },
    }

    // -----------------------------------------------------------------
    // 面板
    // -----------------------------------------------------------------

    function WhaleBankSection() {
      const [state, setState] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const [drawError, setDrawError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const canvasRef = useRef(null)
      const seqRef = useRef(0)

      const load = useCallback(() => {
        const seq = seqRef.current + 1
        seqRef.current = seq
        api.state().then(
          (snapshot) => {
            if (seq !== seqRef.current) return
            setState(snapshot)
            setError(undefined)
          },
          (failure) => {
            if (seq !== seqRef.current) return
            setError(failure instanceof Error ? failure.message : String(failure))
          },
        )
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(load, 30000)
        return () => clearInterval(timer)
      }, [load])

      // 台账或底图变化时重画票面。
      const drawKey = state === undefined ? 'none' : `${state.face}:${state.from}:${state.to}:${state.serial}`

      useEffect(() => {
        if (state === undefined || canvasRef.current === null) return
        let cancelled = false
        loadArt().then((art) => {
          if (cancelled || canvasRef.current === null) return
          try {
            drawVoucher(canvasRef.current, art, state)
            setDrawError(undefined)
          } catch (failure) {
            setDrawError(failure instanceof Error ? failure.message : String(failure))
          }
        })
        return () => {
          cancelled = true
        }
      }, [drawKey, state])

      const toBlob = useCallback(
        () =>
          new Promise((resolve, reject) => {
            const canvas = canvasRef.current
            if (canvas === null) return reject(new Error('canvas unavailable'))
            canvas.toBlob((blob) => (blob === null ? reject(new Error('toBlob failed')) : resolve(blob)), 'image/png')
          }),
        [],
      )

      const fileName = () => `whale-yuan-voucher-${state?.to ?? 'note'}.png`

      const onSave = useCallback(async () => {
        try {
          const blob = await toBlob()
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = fileName()
          anchor.click()
          setTimeout(() => URL.revokeObjectURL(url), 10000)
        } catch (failure) {
          setNotice(String(failure instanceof Error ? failure.message : failure))
        }
      }, [toBlob, state])

      const shareSupported = typeof navigator !== 'undefined'
        && typeof navigator.canShare === 'function'
        && typeof navigator.share === 'function'

      const onShare = useCallback(async () => {
        try {
          const blob = await toBlob()
          const file = new File([blob], fileName(), { type: 'image/png' })
          if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
            setNotice(t('shareUnsupported'))
            return
          }
          await navigator.share({ files: [file], title: t('voucher') })
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure)
          if (!/abort/i.test(message)) setNotice(message)
        }
      }, [toBlob, state])

      const onImport = useCallback(async () => {
        setBusy(true)
        setNotice(undefined)
        try {
          const result = await api.importLedger()
          if (result?.ok) {
            setNotice(t('importOk', { days: result.days ?? 0 }))
            load()
          } else if (result?.error === 'not-found') {
            setNotice(t('importNotFound', { path: result.path ?? '' }))
          } else if (result?.error === 'empty') {
            setNotice(t('importEmpty'))
          } else {
            setNotice(t('importUnreadable'))
          }
        } catch (failure) {
          setNotice(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [load])

      if (state === undefined) {
        return h('div', { style: styles.wrap },
          h('div', { style: styles.card },
            h('div', { style: styles.title }, t('voucher')),
            h('div', { style: styles.muted }, error === undefined ? t('loading') : t('error', { error }))))
      }

      return h('div', { style: styles.wrap },
        h('div', { style: styles.card },
          h('div', { style: styles.title }, t('voucher')),
          h('div', { style: styles.muted }, t('hint', { rate: formatRate(state.rate) })),
          h('div', { style: styles.muted }, state.scope === 'all' ? t('scopeAll') : t('scopeDeepSeek')),
          state.empty
            ? h('div', { style: styles.muted }, t('empty'))
            : h('canvas', { ref: canvasRef, style: styles.canvas, 'aria-label': t('voucher') }),
          drawError !== undefined ? h('div', { style: styles.error }, t('drawError', { error: drawError })) : null,
          state.empty
            ? null
            : h('div', { style: styles.fact }, t('minted', {
              minted: formatDenomination(state.face),
              tokens: formatTokens(state.tokens),
            })),
          state.empty
            ? null
            : h('div', { style: styles.muted },
              t('spend', { cost: Number(state.cost ?? 0).toFixed(2) }) + ' · ' + t('calls', { n: formatDenomination(state.calls) })),
          state.empty
            ? null
            : h('div', { style: styles.muted }, t('window', { from: state.from, to: state.to, days: state.days })),
          state.importedAt !== undefined
            ? h('div', { style: styles.muted }, t('imported', { time: formatTime(state.importedAt), days: state.importedDays ?? 0 }))
            : null,
          h('div', { style: styles.row },
            h('button', { type: 'button', style: styles.button, onClick: load }, t('refresh')),
            h('button', { type: 'button', style: styles.primary, onClick: onSave }, t('save')),
            shareSupported ? h('button', { type: 'button', style: styles.button, onClick: onShare }, t('share')) : null,
            h('button', { type: 'button', style: styles.button, disabled: busy, onClick: onImport },
              busy ? t('importing') : t('importLedger'))),
          notice !== undefined ? h('div', { style: styles.note }, notice) : null,
          error !== undefined ? h('div', { style: styles.error }, t('error', { error })) : null))
    }

    // -----------------------------------------------------------------
    // 插件体
    // -----------------------------------------------------------------

    /** 一级设置区的位置：排在使用统计（151）之后。 */
    const SECTION_ORDER = 153

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => {
        try {
          const unregister = ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-whale-bank',
            order: SECTION_ORDER,
            label: () => t('title'),
          }, WhaleBankSection)
          return () => {
            unregister()
          }
        } catch {
          return () => {}
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.WhaleBankSection = WhaleBankSection
    return module.exports
  },
})
