// dsh-input-optimize 浏览器半：
//   在 DSH 网页输入框右下角控制行（模型选择器左侧、发送按钮之前）渲染一个纯图标按钮。
//   点击后用当前选中的模型请 Host 优化草稿，写回时保留 @file 引用 chip；失败原因走 tooltip。
//
// 注意：本文件不是普通 ESM 模块，而是 DSH 客户端模块系统的单文件 bundle，
// 由 window.__ModuleLoader__.load({ id, factory }) 注册，因此没有 import/export 语句，
// 也没有构建步骤（无 TypeScript、无 JSX，零依赖）。
window.__ModuleLoader__.load({
  id: 'dsh-input-optimize',
  factory: (require) => {
    const module = { exports: {} }

    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    // primitives 属基线共享模块；Tooltip 缺失时降级为原生 title，绝不让整个插件崩掉。
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }
    const Tooltip =
      primitives === null || primitives === undefined
        ? null
        : typeof primitives.Tooltip === 'function'
          ? primitives.Tooltip
          : typeof primitives.TooltipRow === 'function'
            ? primitives.TooltipRow
            : null
    // DSH 通用「工具调用」图标（聊天里「工具调用」分组 / 通用工具用的就是它）；
    // primitives 不可用或被裁剪时退回下方同款内联 SVG，老版本 DSH 也长得一样。
    const SparkleIcon =
      primitives === null || primitives === undefined || typeof primitives.IconSparkleRegular !== 'function'
        ? null
        : primitives.IconSparkleRegular

    // ---------------------------------------------------------------------
    // 常量
    // ---------------------------------------------------------------------

    /** 插件名，同时是模块 id。 */
    const NAME = 'dsh-input-optimize'
    /** 占位的槽位：输入框右下角控制行，list + session 作用域，owner props 为空对象。 */
    const SLOT_NAME = 'conversation.input.right'
    /** 组件 id；升序 order，-10 保证排在模型选择器之前。 */
    const SLOT_ID = 'input-optimize'
    const SLOT_ORDER = -10
    /** 本地化命名空间（与 ui-plan 的 'plan'、dsh-pocket 的 'pocket' 同一惯例：短名）。 */
    const LOCALE_NS = 'input-optimize'
    /** Host RPC 通道与端点（与 Host 半的契约固定）。 */
    // 走 Connection 的共享 /api 通道：Endpoint 是 /api/input-optimize。
    // 独占前缀通道（/input-optimize）在 Electron shell carrier 下没有 webServer，
    // 会退回静态兜底并返回 405，因此共享通道才是稳定路径。
    const RPC_CHANNEL = '/api'
    const RPC_ENDPOINT_PATH = 'input-optimize'
    const RPC_ENDPOINT = 'optimize'
    /** tooltip 最大长度；超出截断并把完整文本放进 aria-live / console.warn。 */
    const TOOLTIP_LIMIT = 240
    /** 样式标签的稳定 id，重复 apply 时不会叠加多份样式。 */
    const STYLE_ID = 'dsh-input-optimize/style'
    /** 单次点击的空状态快照（无 Session 或选择器返回空时兜底）。 */
    const EMPTY_INPUT = Object.freeze({
      draft: '',
      attachmentIds: Object.freeze([]),
      draftRev: 0,
      phase: 'plain',
      occurrences: Object.freeze([]),
      queue: Object.freeze([]),
    })

    // ---------------------------------------------------------------------
    // 文案：中文为兜底字典（locale 未就绪或被裁剪时也一定有可读文案）
    // ---------------------------------------------------------------------

    const ZH = {
      'tooltip.idle': '优化提示词',
      'tooltip.empty': '输入为空，无需优化',
      'tooltip.running': '正在优化…',
      'tooltip.error': '优化失败：{message}',
      'aria.idle': '优化提示词',
      'aria.running': '正在优化提示词',
      'aria.error': '优化失败，查看原因',
      'error.staleDraft': '输入已变化，已放弃写回',
      'error.referencesDegraded': '引用已退化为文本',
      'error.emptyOutput': '模型返回了空内容',
      'error.missingReference': '模型输出丢失了引用 {token}',
      'error.duplicatedReference': '模型输出重复了引用 {token}',
      'error.reorderedReferences': '模型输出打乱了引用顺序',
      'error.unknown': '未知错误，请重试',
      'error.transport': '宿主未提供 RPC 通道，请检查 DSH 版本',
    }

    const EN = {
      'tooltip.idle': 'Optimize prompt',
      'tooltip.empty': 'Nothing to optimize: the draft is empty',
      'tooltip.running': 'Optimizing…',
      'tooltip.error': 'Optimize failed: {message}',
      'aria.idle': 'Optimize prompt',
      'aria.running': 'Optimizing prompt',
      'aria.error': 'Optimize failed, see details',
      'error.staleDraft': 'The draft changed, so the result was discarded',
      'error.referencesDegraded': 'References were flattened to plain text',
      'error.emptyOutput': 'The model returned empty content',
      'error.missingReference': 'The model output lost the reference {token}',
      'error.duplicatedReference': 'The model output duplicated the reference {token}',
      'error.reorderedReferences': 'The model output reordered the references',
      'error.unknown': 'Unknown error, please retry',
      'error.transport': 'The host exposes no RPC channel; check the DSH version',
    }

    // ---------------------------------------------------------------------
    // 纯工具函数
    // ---------------------------------------------------------------------

    /** 把 {name} 占位符替换成实参；没有 vars 时原样返回。 */
    function fill(template, vars) {
      let text = String(template)
      if (vars === undefined) return text
      for (const key of Object.keys(vars)) {
        text = text.split(`{${key}}`).join(String(vars[key]))
      }
      return text
    }

    /**
     * 把 locale 的 t 包一层：任何异常、空值或未命中的 key 都退回中文兜底字典，
     * 这样即使在测试或 locale 尚未注册时文案也永远可读。
     * @param {((key: string) => unknown) | undefined} t - 绑定到本命名空间的翻译函数。
     * @returns {(key: string, vars?: Record<string, string>) => string}
     */
    function translator(t) {
      return (key, vars) => {
        let text
        try {
          text = typeof t === 'function' ? t(key) : undefined
        } catch (error) {
          text = undefined
        }
        if (typeof text !== 'string' || text === '' || text === key) text = ZH[key] !== undefined ? ZH[key] : key
        return fill(text, vars)
      }
    }

    /** 取出非空字符串；其他类型一律 undefined（避免把对象塞进 tooltip）。 */
    function textOf(value) {
      if (typeof value === 'string') {
        const trimmed = value.trim()
        return trimmed === '' ? undefined : trimmed
      }
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return undefined
    }

    /**
     * 把 Occurrence 投影成 DraftReference：去掉运行期身份 occurrenceId，
     * 其余字段按契约原样保留（appearance / invalid 只在存在时携带）。
     * @param {object} occurrence - 契约 Occurrence。
     * @returns {object} 可写回 setDraft 的 DraftReference。
     */
    function toDraftReference(occurrence) {
      const source = occurrence && typeof occurrence === 'object' ? occurrence : {}
      const reference = {
        source: typeof source.source === 'string' ? source.source : '',
        ref: typeof source.ref === 'string' ? source.ref : '',
        offset: Number.isFinite(source.offset) ? source.offset : 0,
        length: Number.isFinite(source.length) ? source.length : 0,
        label: typeof source.label === 'string' ? source.label : '',
        clipboardText: typeof source.clipboardText === 'string' ? source.clipboardText : '',
      }
      if (source.appearance !== undefined && source.appearance !== null) reference.appearance = source.appearance
      if (source.invalid !== undefined) reference.invalid = source.invalid
      return reference
    }

    /**
     * 把草稿里的引用 chip 替换成 ⟦REFn⟧ 标记，供模型安全改写。
     * 只处理落在 [0, draft.length) 内且不重叠的 occurrence；编号按 offset 升序 1-based。
     * @param {string} draft - 剪贴板投影文本（chip 已展开为 @file 之类）。
     * @param {readonly object[]} occurrences - 按 offset 排好序的引用出现位置。
     * @returns {{ maskedText: string, slots: { token: string, start: number, end: number, reference: object }[] }}
     */
    function maskDraft(draft, occurrences) {
      const text = typeof draft === 'string' ? draft : ''
      const list = Array.isArray(occurrences) ? occurrences : []
      if (list.length === 0) return { maskedText: text, slots: [] }

      const ordered = list
        .filter((item) => item && typeof item === 'object' && Number.isFinite(item.offset) && Number.isFinite(item.length) && item.length > 0)
        .slice()
        .sort((left, right) => left.offset - right.offset)

      let maskedText = ''
      let cursor = 0
      const slots = []
      for (const occurrence of ordered) {
        const start = Math.max(occurrence.offset, cursor)
        const end = Math.min(occurrence.offset + occurrence.length, text.length)
        // 越界或与上一个 chip 重叠：跳过，保持投影与原文一致性优先。
        if (start >= text.length || end <= start) continue
        const reference = toDraftReference(occurrence)
        if (reference.clipboardText === '') reference.clipboardText = text.slice(start, end)
        const token = `⟦REF${slots.length + 1}⟧`
        maskedText += text.slice(cursor, start)
        slots.push({ token, start: maskedText.length, end: maskedText.length + token.length, reference })
        maskedText += token
        cursor = end
      }
      maskedText += text.slice(cursor)
      return { maskedText, slots }
    }

    /**
     * 把模型输出里的 ⟦REFn⟧ 还原成引用 chip 的剪贴板文本，并按构造过程算出新的 offset/length。
     * 逐项校验：每个 token 恰好出现一次，且顺序与槽位顺序一致。
     * @param {string} optimized - 模型输出。
     * @param {readonly { token: string, reference: object }[]} slots - maskDraft 的产物。
     * @returns {{ text: string, references: object[] } | { error: string }}
     */
    function unmaskDraft(optimized, slots) {
      const list = Array.isArray(slots) ? slots : []
      if (typeof optimized !== 'string' || optimized.trim() === '') {
        return { error: fill(ZH['error.emptyOutput']) }
      }
      if (list.length === 0) return { text: optimized, references: [] }

      const positions = []
      let previous = -1
      for (const slot of list) {
        const token = slot && typeof slot.token === 'string' ? slot.token : ''
        if (token === '') return { error: fill(ZH['error.unknown']) }
        const first = optimized.indexOf(token)
        if (first < 0) return { error: fill(ZH['error.missingReference'], { token }) }
        if (optimized.indexOf(token, first + token.length) >= 0) {
          return { error: fill(ZH['error.duplicatedReference'], { token }) }
        }
        if (first <= previous) return { error: fill(ZH['error.reorderedReferences']) }
        previous = first
        positions.push(first)
      }

      let text = ''
      let cursor = 0
      const references = []
      for (let index = 0; index < list.length; index += 1) {
        const slot = list[index]
        const at = positions[index]
        text += optimized.slice(cursor, at)
        const reference = toDraftReference(slot.reference)
        const replacement = reference.clipboardText
        if (replacement === '') return { error: fill(ZH['error.missingReference'], { token: slot.token }) }
        reference.offset = text.length
        reference.length = replacement.length
        references.push(reference)
        text += replacement
        cursor = at + slot.token.length
      }
      text += optimized.slice(cursor)
      return { text, references }
    }

    /**
     * 判断「草稿内容已经被发出去」，用于撤销在途优化请求。
     *
     * 两个信号都来自输入机快照，不会误伤普通编辑：
     *  - phase 进入 adjudicating / submitting：提交事务已经开始（命令式提交正在裁决/发送）；
     *  - 草稿被清空：默认发送的乐观 commit-draft 会清掉已发送内容（发送期间新键入的后缀除外）。
     * 用户只是改字（草稿仍非空、phase 仍是 plain / claimed）时返回 false，仍走原有的
     * 「结果作废」路径。发送期间又键入后缀的罕见场景由 watchSend 的发送回显兜住。
     * @param {{ draft?: unknown, phase?: unknown } | null | undefined} snapshot - InputState 快照。
     * @returns {boolean} true 表示内容已发出，应立即撤销在途请求。
     */
    function submissionStarted(snapshot) {
      const current = snapshot === null || typeof snapshot !== 'object' ? {} : snapshot
      const phase = current.phase
      if (phase === 'adjudicating' || phase === 'submitting') return true
      const draft = typeof current.draft === 'string' ? current.draft : ''
      return draft.trim() === ''
    }

    /**
     * 把各种失败形态归一成 { code, message }，保证 message 永远非空（它就是 tooltip 文案）。
     * 支持：{ kind: 'rpc' | 'unmask' | 'stale' | 'degraded' }、ConnectionRpcFailure、
     * 整包 RPC 结果、抛出的 Error、字符串。
     * @param {unknown} input - 失败来源。
     * @param {((key: string) => unknown) | undefined} t - 翻译函数（可缺省）。
     * @returns {{ code: string, message: string }}
     */
    function describeFailure(input, t) {
      const tr = translator(t)
      const generic = (code, key) => ({ code, message: tr(key) })

      if (typeof input === 'string') {
        const message = textOf(input)
        return message === undefined ? generic('unknown', 'error.unknown') : { code: 'error', message }
      }
      if (input && typeof input === 'object') {
        const kind = typeof input.kind === 'string' ? input.kind : undefined
        if (kind === 'stale') return generic('draft-changed', 'error.staleDraft')
        if (kind === 'degraded') return generic('references-degraded', 'error.referencesDegraded')
        if (kind === 'unmask') {
          const detail = textOf(input.error)
          return detail === undefined ? generic('unmask', 'error.unknown') : { code: 'unmask', message: detail }
        }
        if (kind === 'rpc') {
          const failure = input.error && typeof input.error === 'object' ? input.error : {}
          const message = textOf(failure.message) || textOf(failure.code)
          const code = textOf(failure.code) || 'rpc'
          return message === undefined ? generic(code, 'error.unknown') : { code, message }
        }
        // 未标记形态：整包 { ok:false, error } 结果、ConnectionRpcFailure，或抛出的 Error。
        if (input.error && typeof input.error === 'object') return describeFailure({ kind: 'rpc', error: input.error }, t)
        const message = textOf(input.message) || textOf(input.code)
        if (message !== undefined) return { code: textOf(input.code) || 'error', message }
      }
      return generic('unknown', 'error.unknown')
    }

    /**
     * tooltip 文案的唯一来源（四态表）。
     * @param {{ status?: string, canRun?: boolean, failure?: { code?: string, message?: string } | null }} state - 当前按钮状态。
     * @param {((key: string) => unknown) | undefined} t - 翻译函数（可缺省）。
     * @returns {string}
     */
    function tooltipOf(state, t) {
      const tr = translator(t)
      const current = state && typeof state === 'object' ? state : {}
      if (current.status === 'running') return tr('tooltip.running')
      if (current.status === 'error' && current.failure) {
        const detail =
          textOf(current.failure.message) || textOf(current.failure.code) || tr('error.unknown')
        return fill(tr('tooltip.error'), { message: detail })
      }
      if (current.canRun !== true) return tr('tooltip.empty')
      return tr('tooltip.idle')
    }

    /** 超过 limit 时截断并补省略号。 */
    function truncateText(text, limit) {
      const max = Number.isFinite(limit) ? limit : TOOLTIP_LIMIT
      const value = typeof text === 'string' ? text : String(text)
      return value.length <= max ? value : `${value.slice(0, max)}…`
    }

    // ---------------------------------------------------------------------
    // 运行期小工具（DOM / 浏览器能力都在这里做防御）
    // ---------------------------------------------------------------------

    /** 创建 AbortController；环境不支持时返回 null（RPC 调用就不带 signal）。 */
    function createAbortController() {
      try {
        if (typeof AbortController === 'function') return new AbortController()
      } catch (error) {
        /* 忽略：老运行时没有 AbortController */
      }
      return null
    }

    /** 判断异常是否来自主动取消（卸载 / 切换 Session），这类异常不该变成错误提示。 */
    function isAbortError(error) {
      if (error === null || typeof error !== 'object') return false
      return error.name === 'AbortError' || error.code === 'ABORT_ERR'
    }

    /** 是否要求减少动效；不支持 matchMedia 时当作不要求。 */
    function prefersReducedMotion() {
      try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
      } catch (error) {
        return false
      }
    }

    /** 注入唯一一份样式表；返回幂等的清理函数。 */
    function injectStylesheet() {
      if (typeof document === 'undefined' || document === null) return () => {}
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)
      const tag = existing === null || existing === undefined ? document.createElement('style') : existing
      if (existing === null || existing === undefined) {
        tag.setAttribute('data-plugin-css', STYLE_ID)
        tag.textContent = STYLESHEET
        document.head.appendChild(tag)
      }
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    // 28px 方形图标按钮，尺寸/圆角/悬停观感对齐输入框控制行的 ＋ 按钮；
    // 颜色全部走 DSH 设计令牌，并给出通用令牌与 currentColor 两级兜底。
    const STYLESHEET = `
.dsh-io-root{position:relative;display:inline-flex;align-items:center;flex:none}
.dsh-io-button{box-sizing:border-box;display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsh-text-secondary,currentColor));corner-shape:round;cursor:pointer;transition:background-color .12s,color .12s}
.dsh-io-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsh-interactive-bg-hover,rgba(127,127,127,.12)));color:var(--dsw-alias-label-primary,var(--dsh-text-primary,currentColor))}
.dsh-io-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,currentColor));outline-offset:-2px}
.dsh-io-button:disabled{opacity:.4;cursor:default}
.dsh-io-button[data-state="running"]{color:var(--dsw-alias-label-tertiary,var(--dsh-text-tertiary,currentColor))}
.dsh-io-button[data-state="error"]{color:var(--dsw-alias-state-error-primary,var(--dsh-text-danger,#dc2626))}
.dsh-io-icon{display:block;flex:none}
.dsh-io-spin{animation:dsh-io-spin .9s linear infinite}
@keyframes dsh-io-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-io-spin{animation:none}}
.dsh-io-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;white-space:nowrap;clip-path:inset(50%)}
`

    // ---------------------------------------------------------------------
    // 图标：空闲/错误态用 DSH 的通用「工具调用」图标（sparkle）；
    // 优先取 primitives 的 IconSparkleRegular，缺失时内联同款 SVG 兜底。
    // ---------------------------------------------------------------------

    /** 空闲/错误态：DSH 通用「工具调用」图标（三个四角星）。 */
    function sparkleIcon(className) {
      if (SparkleIcon !== null) return h(SparkleIcon, { className, size: 16 })
      return h(
        'svg',
        {
          className,
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          strokeWidth: '1',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z',
          stroke: 'currentColor',
        }),
        h('path', {
          d: 'M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z',
          stroke: 'currentColor',
        }),
        h('path', {
          d: 'M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z',
          stroke: 'currentColor',
        }),
      )
    }

    /** 进行中（允许动效）：旋转的四分之三圆弧。 */
    function spinnerIcon(className) {
      return h(
        'svg',
        {
          className,
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('circle', { cx: '8', cy: '8', r: '5.5', stroke: 'currentColor', strokeWidth: '1.5', opacity: '0.25' }),
        h('path', {
          d: 'M8 2.5a5.5 5.5 0 0 1 5.5 5.5',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
        }),
      )
    }

    /** 进行中 + prefers-reduced-motion：静态沙漏，不播放任何动画。 */
    function hourglassIcon(className) {
      return h(
        'svg',
        {
          className,
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M4.25 2.5h7.5M4.25 13.5h7.5',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M5.25 2.75v1.6c0 .45.2.88.55 1.17L8 7.5l2.2-1.98c.35-.29.55-.72.55-1.17v-1.6M5.25 13.25v-1.6c0-.45.2-.88.55-1.17L8 8.5l2.2 1.98c.35.29.55.72.55 1.17v1.6',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinejoin: 'round',
        }),
      )
    }

    // ---------------------------------------------------------------------
    // 按钮组件
    // ---------------------------------------------------------------------

    /**
     * 输入框右下角的优化按钮（纯图标）。
     * 标准 Session props 里用到 useInput / inputActions / sessionId；
     * inject face 提供 rpcCall / t / resolveAttachments / readSelection / watchSend。
     */
    function OptimizeButton(props) {
      const { useInput, inputActions, sessionId, rpcCall, resolveAttachments, readSelection, watchSend } = props
      // inject face 的 t 可能被框架的 locale t 覆盖，这里再包一层保证永远返回字符串。
      const tr = translator(props.t)

      const selected = typeof useInput === 'function' ? useInput((snapshot) => snapshot) : undefined
      const input = selected === undefined || selected === null ? EMPTY_INPUT : selected

      const [status, setStatus] = useState('idle')
      const [failure, setFailure] = useState(null)

      const activeRef = useRef(null)
      const aliveRef = useRef(true)
      const latestRef = useRef(input)
      const draftRef = useRef(typeof input.draft === 'string' ? input.draft : '')
      // 渲染期同步最新快照：RPC 落地时要拿「此刻」的 draftRev 做 CAS，而不是闭包里那份。
      latestRef.current = input

      const draft = typeof input.draft === 'string' ? input.draft : ''
      const phase = input.phase
      const phaseBusy = phase === 'adjudicating' || phase === 'submitting'
      const running = status === 'running'
      const writable = Boolean(inputActions) && typeof inputActions.setDraft === 'function'
      const callable = typeof rpcCall === 'function'
      const canRun = Boolean(sessionId) && draft.trim() !== '' && !phaseBusy && !running && writable && callable

      /**
       * 撤销一次在途请求：打标记、停发送监听、abort 传输，并释放请求槽位。
       * 幂等，而且不碰 React 状态（卸载路径也能调用）。
       * @param {{ revoked?: boolean, controller?: { abort?: () => void } | null, stopWatching?: (() => void) | null } | null} request
       * @returns {boolean} 是否真的从在途状态撤销了这次请求。
       */
      const revoke = (request) => {
        if (request === null || request === undefined || request.revoked === true) return false
        request.revoked = true
        if (activeRef.current === request) activeRef.current = null
        const stopWatching = request.stopWatching
        request.stopWatching = null
        if (typeof stopWatching === 'function') {
          try {
            stopWatching()
          } catch (error) {
            /* 退订失败不能影响撤销 */
          }
        }
        const controller = request.controller
        if (controller !== null && controller !== undefined) {
          try {
            if (typeof controller.abort === 'function') controller.abort()
          } catch (error) {
            /* 老运行时的 abort 可能抛错；请求仍按已撤销处理 */
          }
        }
        return true
      }

      /** 静默撤销：内容已经发出，不该再展示任何错误，直接回到空闲态。 */
      const revokeSilently = (request) => {
        if (!revoke(request)) return
        if (!aliveRef.current) return
        setFailure(null)
        setStatus((previous) => (previous === 'running' ? 'idle' : previous))
      }

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          revoke(activeRef.current)
          activeRef.current = null
        }
        // sessionId 变化等同卸载：作废旧 Session 的飞行中请求。
      }, [sessionId])

      useEffect(() => {
        if (draftRef.current === draft) return
        draftRef.current = draft
        // 用户又改了输入：上一次的失败提示立刻失效，不做自动超时。
        setFailure(null)
        setStatus((previous) => (previous === 'error' ? 'idle' : previous))
      }, [draft])

      useEffect(() => {
        // 内容已经被发出去：默认发送会清空输入框，命令提交会进入 adjudicating/submitting。
        // 结果已经不可能写回，立即撤销在途请求，并且不留错误提示。
        const request = activeRef.current
        if (request === null || request === undefined) return
        if (!submissionStarted({ draft, phase })) return
        revokeSilently(request)
      }, [draft, phase])

      /** 记录一次失败：错误态 + 完整文案进 aria-live（tooltip 只显示截断版，完整版同时进 console）。 */
      const report = (described) => {
        setFailure(described)
        setStatus('error')
        console.warn(`[${NAME}] ${tooltipOf({ status: 'error', canRun: true, failure: described }, tr)}`)
      }

      /** 组装 Host 请求（模型选择与附件名都在点击这一瞬间取）。 */
      const buildRequest = (snapshot, maskedText) => {
        const payload = {
          sessionId,
          maskedText,
          attachments: typeof resolveAttachments === 'function' ? resolveAttachments(snapshot.attachmentIds) : [],
        }
        const selection = typeof readSelection === 'function' ? readSelection(sessionId) : null
        if (selection && typeof selection === 'object') {
          if (textOf(selection.provider) !== undefined) payload.provider = selection.provider
          if (textOf(selection.model) !== undefined) payload.model = selection.model
          if (textOf(selection.reasoningEffort) !== undefined) payload.reasoningEffort = selection.reasoningEffort
        }
        return payload
      }

      const runOptimize = async () => {
        if (activeRef.current !== null || !canRun) return
        const snapshot = latestRef.current === undefined || latestRef.current === null ? EMPTY_INPUT : latestRef.current
        const revision = snapshot.draftRev
        const startedAt = Date.now()
        const { maskedText, slots } = maskDraft(snapshot.draft, snapshot.occurrences)

        const controller = createAbortController()
        const request = { controller, revoked: false, stopWatching: null }
        activeRef.current = request
        setFailure(null)
        setStatus('running')

        // 发送回显监听：composer 在真正发 prompt 之前就会登记本地发送回显，
        // 所以「发送期间又键入后缀」这类空草稿判断兜不住的情况也能立刻撤销。
        // 服务缺失/形状不符时 watchSend 会退化成 noop，仍有上面的兜底判断。
        try {
          if (typeof watchSend === 'function') {
            const stopped = watchSend(sessionId, startedAt, () => {
              revokeSilently(request)
            })
            request.stopWatching = typeof stopped === 'function' ? stopped : null
          }
        } catch (error) {
          // 监听装不上不影响优化本身。
          request.stopWatching = null
        }

        try {
          // watchSend 若同步发现已有新发送（理论上不会），这里也不会再发请求。
          if (request.revoked === true) return
          const result = await rpcCall(
            RPC_ENDPOINT,
            buildRequest(snapshot, maskedText),
            controller === null ? undefined : controller.signal,
          )
          // 中途被撤销（内容已发出）或已被新请求顶掉：结果全部丢弃，不写回也不报错。
          if (request.revoked === true || !aliveRef.current || activeRef.current !== request) return
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            report(describeFailure({ kind: 'rpc', error: result === null || typeof result !== 'object' ? undefined : result.error }, tr))
            return
          }

          const restored = unmaskDraft(result.value === null || typeof result.value !== 'object' ? undefined : result.value.optimized, slots)
          if (restored.error !== undefined) {
            report(describeFailure({ kind: 'unmask', error: restored.error }, tr))
            return
          }

          const latest = latestRef.current === undefined || latestRef.current === null ? EMPTY_INPUT : latestRef.current
          if (latest.draftRev !== revision) {
            report(describeFailure({ kind: 'stale' }, tr))
            return
          }

          let degraded = false
          try {
            // 运行期 setDraft 接受 DraftSnapshot：{ text, references } 会走 restoreDraft 从而保留 chip。
            inputActions.setDraft({ text: restored.text, references: restored.references })
          } catch (error) {
            // 老运行时只认字符串：退化成纯文本写回，并明确提示引用已退化。
            inputActions.setDraft(restored.text)
            degraded = true
          }
          if (degraded) {
            report(describeFailure({ kind: 'degraded' }, tr))
            return
          }
          setFailure(null)
        } catch (error) {
          // 主动撤销引发的 abort 不是错误，不该出现在 tooltip 里。
          if (request.revoked === true) return
          if (aliveRef.current && !isAbortError(error)) report(describeFailure(error, tr))
        } finally {
          const stopWatching = request.stopWatching
          request.stopWatching = null
          if (typeof stopWatching === 'function') {
            try {
              stopWatching()
            } catch (error) {
              /* 退订失败不影响请求收尾 */
            }
          }
          if (activeRef.current === request) {
            activeRef.current = null
            if (aliveRef.current) setStatus((previous) => (previous === 'running' ? 'idle' : previous))
          }
        }
      }

      // 输入框没有任何可优化的文本（含纯空白、只有附件）：直接不渲染，不占控制行位置。
      // 所有 hooks 都已在上方执行，隐藏与否不会改变 hook 顺序。
      if (draft.trim() === '') return null

      const label = tooltipOf({ status, canRun, failure }, tr)
      const truncatedLabel = truncateText(label)
      const ariaLabel =
        status === 'error' ? tr('aria.error') : status === 'running' ? tr('aria.running') : tr('aria.idle')
      const announcement = status === 'error' ? label : status === 'running' ? tr('tooltip.running') : ''

      let glyph
      if (status === 'running') glyph = prefersReducedMotion() ? hourglassIcon('dsh-io-icon') : spinnerIcon('dsh-io-icon dsh-io-spin')
      else glyph = sparkleIcon('dsh-io-icon')

      const buttonProps = {
        type: 'button',
        className: 'dsh-io-button',
        'data-state': status,
        'aria-label': ariaLabel,
        disabled: !canRun,
        // 不夺走编辑器焦点：与输入框内其他工具按钮一致。
        onMouseDown: (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
        },
        onClick: () => {
          void runOptimize()
        },
      }
      if (status === 'running') buttonProps['aria-busy'] = 'true'

      const button = h('button', buttonProps, glyph)
      // Tooltip 缺失时用原生 title 兜底（错误态仍是同一条截断文案）。
      const surface =
        Tooltip === null
          ? h('button', Object.assign({}, buttonProps, { title: truncatedLabel }), glyph)
          : h(Tooltip, { label: truncatedLabel, side: 'top', delayMs: status === 'error' ? 0 : 500, children: button })

      return h(
        'span',
        { className: 'dsh-io-root', 'data-state': status },
        surface,
        h('span', { className: 'dsh-io-live', role: 'status', 'aria-live': 'polite' }, announcement === '' ? null : announcement),
      )
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------

    const inject = ['slots', 'connection', 'locale', 'conversation', 'modelDirectories']

    /**
     * 注册词典、注入样式，并占用输入框右下角槽位。
     * @param {import('@deepseek-ai/cordis').Context} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      const tr = translator(readBoundTranslate(ctx))

      // 词典与样式都由 ctx.effect 托管，插件卸载时自动回收。
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }),
        'dsh-input-optimize: 中英文案词典',
      )
      ctx.effect(() => injectStylesheet(), 'dsh-input-optimize: 图标按钮样式')

      /** Host RPC：通道固定，端点 optimize；transport 缺失时给出可读失败而不是崩溃。 */
      const rpcCall = async (endpoint, payload, signal) => {
        const rpc = ctx.connection && ctx.connection.rpc
        if (!rpc || typeof rpc.call !== 'function') {
          return { ok: false, error: { code: 'transport-unavailable', message: tr('error.transport'), details: {} } }
        }
        return rpc.call(RPC_CHANNEL, `${RPC_ENDPOINT_PATH}/${endpoint}`, payload, signal)
      }

      /** 把 draft 附件 id 解析成 Host 需要的 { kind, name } 列表（只取名字，不传字节）。 */
      const resolveAttachments = (ids) => {
        const list = Array.isArray(ids) ? ids : []
        if (list.length === 0) return []
        try {
          const conversation = ctx.conversation
          if (!conversation || typeof conversation.resolveDraftAttachments !== 'function') return []
          const resolved = conversation.resolveDraftAttachments(list)
          return Array.from(resolved === null || resolved === undefined ? [] : resolved, (item) => {
            const kind = item && item.kind === 'image' ? 'image' : 'file'
            const name = item && item.file && typeof item.file.name === 'string' && item.file.name !== '' ? item.file.name : 'attachment'
            return { kind, name }
          })
        } catch (error) {
          return []
        }
      }

      /** 读取当前 Session 选中的模型；目录还没就绪时返回 null，由 Host 用默认模型。 */
      const readSelection = (sessionId) => {
        try {
          const directories = ctx.modelDirectories
          if (!directories || typeof directories.directoryFor !== 'function') return null
          const directory = directories.directoryFor(sessionId)
          const snapshot = directory && directory.store && typeof directory.store.getSnapshot === 'function' ? directory.store.getSnapshot() : undefined
          return snapshot && snapshot.current ? snapshot.current : null
        } catch (error) {
          return null
        }
      }

      /**
       * 监听「发起优化之后，本会话有内容被发送出去」。
       *
       * 走 Client Session 快照里的本地发送回显（pendingSubmissions）：composer 在真正发
       * prompt 之前就会同步登记它，因此「点发送」这一刻就能撤销优化请求，而不是等编辑器
       * 被清空。服务缺失、形状不符或老运行时都不抛错，返回 noop（组件里还有空草稿 /
       * phase 的兜底判断）。
       * @param {string} sessionId - 目标会话。
       * @param {number} startedAt - 优化请求发起时的客户端墙钟毫秒。
       * @param {() => void} onSend - 发现新发送时回调（只会调用一次）。
       * @returns {() => void} 取消监听。
       */
      const watchSend = (sessionId, startedAt, onSend) => {
        const noop = () => {}
        try {
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
          const session = binding && binding.session
          if (!session || typeof session.getSnapshot !== 'function' || typeof session.subscribe !== 'function') return noop

          const known = new Set()
          const baseline = session.getSnapshot()
          const baselineList = baseline && Array.isArray(baseline.pendingSubmissions) ? baseline.pendingSubmissions : []
          for (const submission of baselineList) {
            const id = submission && submission.requestId
            if (typeof id === 'string') known.add(id)
          }

          let done = false
          const check = () => {
            if (done) return
            let current
            try {
              current = session.getSnapshot()
            } catch (error) {
              return
            }
            const pending = current && Array.isArray(current.pendingSubmissions) ? current.pendingSubmissions : []
            for (const submission of pending) {
              if (submission === null || typeof submission !== 'object') continue
              const id = typeof submission.requestId === 'string' ? submission.requestId : undefined
              // 没有 requestId 的形态无法去重，也跟不上 DSH 契约，直接忽略。
              if (id === undefined) continue
              if (known.has(id)) continue
              // 只认发起优化之后开始的提交：更早的残留回显（例如上一轮尚未退场）不算。
              if (typeof submission.time === 'number' && submission.time < startedAt) {
                known.add(id)
                continue
              }
              done = true
              known.add(id)
              try {
                onSend()
              } catch (error) {
                /* 回调异常不能影响订阅链 */
              }
              return
            }
          }

          const unsubscribe = session.subscribe(check)
          return () => {
            done = true
            try {
              if (typeof unsubscribe === 'function') unsubscribe()
            } catch (error) {
              /* 退订失败不影响请求收尾 */
            }
          }
        } catch (error) {
          return noop
        }
      }

      ctx.slots.inject(SLOT_NAME, () =>
        ctx.slots.register(
          {
            name: SLOT_NAME,
            id: SLOT_ID,
            order: SLOT_ORDER,
            locale: LOCALE_NS,
            inject: () => ({ rpcCall, t: tr, resolveAttachments, readSelection, watchSend }),
          },
          OptimizeButton,
        ),
      )
    }

    /** 绑定本命名空间的 t；locale 服务异常时退回中文兜底字典。 */
    function readBoundTranslate(ctx) {
      try {
        const locale = ctx.locale
        if (!locale || typeof locale.bind !== 'function') return undefined
        return locale.bind(LOCALE_NS)
      } catch (error) {
        return undefined
      }
    }

    module.exports.name = NAME
    module.exports.inject = inject
    module.exports.apply = apply
    module.exports.maskDraft = maskDraft
    module.exports.unmaskDraft = unmaskDraft
    module.exports.describeFailure = describeFailure
    module.exports.tooltipOf = tooltipOf
    module.exports.submissionStarted = submissionStarted
    // 集成方（Host 半与测试）需要的契约常量，顺手暴露，避免字符串重复。
    module.exports.NS = LOCALE_NS
    module.exports.RPC_CHANNEL = RPC_CHANNEL
    module.exports.RPC_ENDPOINT_PATH = RPC_ENDPOINT_PATH
    module.exports.RPC_ENDPOINT = RPC_ENDPOINT
    module.exports.SLOT_NAME = SLOT_NAME

    return module.exports
  },
})
