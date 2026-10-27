// dsh-input-optimize 浏览器半的单元测试（node --test，零依赖）。
//
// client/client.js 不是可导入的 ESM 模块，而是一个向 window.__ModuleLoader__
// 注册 factory 的浏览器脚本。这里用 new Function('window', 'document', src)
// 求值源码，截获注册项，再用最小 React 替身物化模块，从而既能测纯函数，
// 也能真正走一遍组件返回的元素树（断言按钮内没有任何文本节点）。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const SOURCE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const MODULE_ID = 'dsh-input-optimize'
const PRIMITIVES_ID = '@deepseek-ai/dsh-client-ui-primitives'

// ---------------------------------------------------------------------
// 测试脚手架：最小 React（记录元素树 + 手写 hooks）、模块加载器、树遍历
// ---------------------------------------------------------------------

/**
 * 造一份最小 React 替身：createElement 把元素记成
 * { type, props, children }，hooks 用实例槽位保存状态，setState 只置脏标记，
 * 由 render() 决定何时重渲染。
 * @returns {object} 替身 React（额外带 __instance 供 render 使用）
 */
function createFakeReact() {
  const instance = { idx: 0, states: [], refs: [], deps: [], dirty: false }
  const React = {
    __instance: instance,
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children }
    },
    useState(initial) {
      const slot = instance.idx++
      if (!(slot in instance.states)) instance.states[slot] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        instance.states[slot] = typeof next === 'function' ? next(instance.states[slot]) : next
        instance.dirty = true
      }
      return [instance.states[slot], set]
    },
    useRef(initial) {
      const slot = instance.idx++
      if (!(slot in instance.refs)) instance.refs[slot] = { current: initial }
      return instance.refs[slot]
    },
    useEffect(effect, deps) {
      const slot = instance.idx++
      const previous = instance.deps[slot]
      const changed =
        previous === undefined ||
        deps === undefined ||
        deps.length !== previous.length ||
        deps.some((value, index) => !Object.is(value, previous[index]))
      if (!changed) return
      instance.deps[slot] = deps === undefined ? [] : deps.slice()
      effect()
    },
  }
  return React
}

/** 最小 document 替身：够 injectStylesheet 注入并移除一个 <style> 标签。 */
function createFakeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
      return node
    },
    removeChild(node) {
      this.children = this.children.filter((item) => item !== node)
      node.parentNode = null
      return node
    },
  }
  return {
    head,
    querySelector() {
      return null
    },
    createElement() {
      return { parentNode: null, attributes: {}, textContent: '', setAttribute(name, value) { this.attributes[name] = value } }
    },
  }
}

/**
 * 求值 browser bundle 并物化模块。
 * @param {{ primitives?: object | null, react?: object, document?: object }} options
 *   primitives 为 null 时模拟「primitives 不可用」；react 可复用以便渲染间保留状态。
 * @returns {{ registration: object, exports: object, react: object, document: object }}
 */
function loadPlugin(options = {}) {
  const {
    primitives = { Tooltip: (props) => props.children },
    react = createFakeReact(),
    document = createFakeDocument(),
    matchMedia = () => ({ matches: false }),
  } = options
  let registration
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
    matchMedia,
  }
  // 源码里的 window / document 都通过形参遮蔽，测试进程不需要真实 DOM。
  const evaluate = new Function('window', 'document', SOURCE)
  evaluate(window, document)
  assert.ok(registration !== undefined, '源码必须调用 window.__ModuleLoader__.load')

  const exports = registration.factory((id) => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx: react.createElement, jsxs: react.createElement }
    if (id === PRIMITIVES_ID) {
      if (primitives === null) throw new Error('primitives 不可用')
      return primitives
    }
    throw new Error(`未预期的 require("${id}")`)
  })
  return { registration, exports, react, document }
}

/** 造渲染器：同一实例可重复渲染，hooks 状态跨渲染保留。 */
function createRenderer(react, component) {
  const instance = react.__instance
  return (props) => {
    instance.idx = 0
    instance.dirty = false
    let tree = component(props)
    let guard = 0
    while (instance.dirty && guard < 50) {
      instance.idx = 0
      instance.dirty = false
      tree = component(props)
      guard += 1
    }
    return tree
  }
}

/**
 * 唯一的组件装配路径：求值插件 → 用假 ctx 跑 apply() → 从 slots.register
 * 回调里取出槽位组件。组件本身不导出，所有用例都必须走这一条路；
 * 以前两个 describe 各自内联了一套 ctx，注册形状/取值形状容易互相错位。
 * @param {{ primitives?: object | null, matchMedia?: (query: string) => { matches: boolean } }} options
 *   传给 loadPlugin 的选项；primitives 传 null 可模拟 Tooltip 不可用。
 * @param {object} [ctxOverrides] - 覆盖 ctx 上的服务（例如把 connection 置空测降级）。
 * @returns {{ exports: object, react: object, document: object, ctx: object, registration: object, component: Function, render: Function }}
 */
function mountPlugin(options = {}, ctxOverrides = {}) {
  const loaded = loadPlugin(options)
  const captured = []
  const ctx = {
    effect: () => () => {},
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(name, callback) {
        callback()
      },
      register(registration, component) {
        captured.push({ registration, component })
        return () => {}
      },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    conversation: { resolveDraftAttachments: () => [] },
    modelDirectories: { directoryFor: () => null },
    ...ctxOverrides,
  }
  loaded.exports.apply(ctx)
  assert.equal(captured.length, 1, 'apply() 必须注册恰好一个槽位组件')
  return {
    ...loaded,
    ctx,
    registration: captured[0].registration,
    component: captured[0].component,
    render: createRenderer(loaded.react, captured[0].component),
  }
}

/** 展开一个元素的全部子节点：位置参数 children 与 props.children 都要算（Tooltip 属于后者）。 */
function childrenOf(node) {
  const positional = Array.isArray(node.children) ? node.children : []
  const propChild = node.props === undefined || node.props === null ? undefined : node.props.children
  if (propChild === undefined) return positional
  return positional.concat([propChild])
}

/** 在元素树里按谓词找第一个元素。 */
function findElement(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of childrenOf(node)) {
    const hit = findElement(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 收集子树里所有文本节点（用于断言「纯图标」）。 */
function textWithin(node, collected = []) {
  for (const child of childrenOf(node)) {
    if (typeof child === 'string' || typeof child === 'number') collected.push(child)
    else if (child !== null && typeof child === 'object') textWithin(child, collected)
  }
  return collected
}

/** 让已排队的 promise 链跑完，再渲染一次取最新树。 */
async function settle(render, props) {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
  return render(props)
}

/** 一个 draft/occurrences 的便捷构造器（模拟剪贴板投影坐标）。 */
function occurrence(fields) {
  return {
    occurrenceId: 1,
    source: 'attachment',
    ref: 'ref',
    label: '附件',
    appearance: 'file',
    ...fields,
  }
}

const SAMPLE_OCCURRENCE = occurrence({ occurrenceId: 7, ref: 'a', offset: 4, length: 6, label: 'a.txt', clipboardText: '@a.txt' })

// ---------------------------------------------------------------------
// 1. 模块契约
// ---------------------------------------------------------------------

describe('模块注册契约', () => {
  test('注册 id、导出面与 inject 依赖', () => {
    const { registration, exports } = loadPlugin()
    assert.equal(registration.id, MODULE_ID)
    assert.equal(typeof registration.factory, 'function')
    assert.equal(exports.name, MODULE_ID)
    assert.equal(typeof exports.apply, 'function')
    assert.deepEqual(exports.inject, ['slots', 'connection', 'locale', 'conversation', 'modelDirectories'])
    for (const helper of ['maskDraft', 'unmaskDraft', 'submissionStarted', 'describeFailure', 'tooltipOf']) {
      assert.equal(typeof exports[helper], 'function', `${helper} 必须导出以便单测`)
    }
    // 共享 /api 通道（carrier 无关），方法名为 input-optimize/<endpoint>。
    assert.equal(exports.RPC_CHANNEL, '/api')
    assert.equal(exports.RPC_ENDPOINT, 'optimize')
    assert.equal(exports.RPC_ENDPOINT_PATH, 'input-optimize')
    assert.equal(exports.SLOT_NAME, 'conversation.input.right')
  })

  test('primitives 不可用时 factory 仍能物化（Tooltip 走降级）', () => {
    const { exports } = loadPlugin({ primitives: null })
    assert.equal(typeof exports.apply, 'function')
    assert.equal(typeof exports.maskDraft, 'function')
  })
})

// ---------------------------------------------------------------------
// 2. maskDraft
// ---------------------------------------------------------------------

describe('maskDraft', () => {
  test('没有引用时原样返回', () => {
    const draft = '帮我把这段话改得更正式'
    assert.deepEqual(loadPlugin().exports.maskDraft(draft, []), { maskedText: draft, slots: [] })
    assert.deepEqual(loadPlugin().exports.maskDraft(draft, undefined), { maskedText: draft, slots: [] })
  })

  test('单个引用被替换成 ⟦REF1⟧ 且槽位记录坐标', () => {
    const { exports } = loadPlugin()
    const draft = '请总结 @a.txt 的内容'
    const { maskedText, slots } = exports.maskDraft(draft, [SAMPLE_OCCURRENCE])
    assert.equal(maskedText, '请总结 ⟦REF1⟧ 的内容')
    assert.equal(slots.length, 1)
    assert.equal(slots[0].token, '⟦REF1⟧')
    assert.equal(maskedText.slice(slots[0].start, slots[0].end), '⟦REF1⟧')
    assert.equal(slots[0].reference.clipboardText, '@a.txt')
    assert.equal(slots[0].reference.offset, 4)
    assert.equal('occurrenceId' in slots[0].reference, false)
  })

  test('三个引用按 offset 升序编号（即使入参乱序）', () => {
    const { exports } = loadPlugin()
    const draft = '@a.txt 与 @b.txt 还有 @c.txt'
    const occurrences = [
      occurrence({ ref: 'c', offset: 19, length: 6, clipboardText: '@c.txt' }),
      occurrence({ ref: 'a', offset: 0, length: 6, clipboardText: '@a.txt' }),
      occurrence({ ref: 'b', offset: 9, length: 6, clipboardText: '@b.txt' }),
    ]
    const { maskedText, slots } = exports.maskDraft(draft, occurrences)
    assert.equal(maskedText, '⟦REF1⟧ 与 ⟦REF2⟧ 还有 ⟦REF3⟧')
    assert.deepEqual(
      slots.map((slot) => slot.reference.clipboardText),
      ['@a.txt', '@b.txt', '@c.txt'],
    )
    for (const slot of slots) assert.equal(maskedText.slice(slot.start, slot.end), slot.token)
  })

  test('越界与重叠的引用被安全跳过', () => {
    const { exports } = loadPlugin()
    const draft = '@a.txt 尾巴'
    const { maskedText, slots } = exports.maskDraft(draft, [
      occurrence({ offset: 0, length: 6, clipboardText: '@a.txt' }),
      occurrence({ offset: 2, length: 4, clipboardText: '@a.t' }),
      occurrence({ offset: 900, length: 5, clipboardText: '@zzz' }),
    ])
    assert.equal(maskedText, '⟦REF1⟧ 尾巴')
    assert.equal(slots.length, 1)
  })
})

// ---------------------------------------------------------------------
// 3. unmaskDraft
// ---------------------------------------------------------------------

describe('unmaskDraft', () => {
  const slots = () => loadPlugin().exports.maskDraft('请总结 @a.txt 的内容', [SAMPLE_OCCURRENCE]).slots

  test('无引用时直接返回模型文本', () => {
    const { exports } = loadPlugin()
    assert.deepEqual(exports.unmaskDraft('优化后的文本', []), { text: '优化后的文本', references: [] })
  })

  test('还原引用并算出正确的 offset/length', () => {
    const { exports } = loadPlugin()
    const restored = exports.unmaskDraft('麻烦你总结一下 ⟦REF1⟧ 的核心结论', slots())
    assert.equal(restored.error, undefined)
    assert.equal(restored.text, '麻烦你总结一下 @a.txt 的核心结论')
    assert.equal(restored.references.length, 1)
    const [reference] = restored.references
    assert.equal(reference.clipboardText, '@a.txt')
    assert.equal(reference.offset, '麻烦你总结一下 '.length)
    assert.equal(reference.length, '@a.txt'.length)
    assert.equal(restored.text.slice(reference.offset, reference.offset + reference.length), '@a.txt')
    assert.equal('occurrenceId' in reference, false)
    assert.equal(reference.appearance, 'file')
  })

  test('三个引用全部还原后 offset 递增且与文本一致', () => {
    const { exports } = loadPlugin()
    const draft = '@a.txt 与 @b.txt 还有 @c.txt'
    const masked = exports.maskDraft(draft, [
      occurrence({ ref: 'a', offset: 0, length: 6, clipboardText: '@a.txt' }),
      occurrence({ ref: 'b', offset: 9, length: 6, clipboardText: '@b.txt' }),
      occurrence({ ref: 'c', offset: 19, length: 6, clipboardText: '@c.txt' }),
    ])
    const restored = exports.unmaskDraft(`先读 ⟦REF1⟧，再读 ⟦REF2⟧，最后读 ⟦REF3⟧。`, masked.slots)
    assert.equal(restored.error, undefined)
    assert.equal(restored.text, '先读 @a.txt，再读 @b.txt，最后读 @c.txt。')
    assert.equal(restored.references.length, 3)
    let previousEnd = 0
    for (const reference of restored.references) {
      assert.ok(reference.offset >= previousEnd, '引用不能重叠')
      assert.equal(restored.text.slice(reference.offset, reference.offset + reference.length), reference.clipboardText)
      previousEnd = reference.offset + reference.length
    }
  })

  test('模型丢掉 token → 可读错误', () => {
    const { exports } = loadPlugin()
    const result = exports.unmaskDraft('完全没提到引用', slots())
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.includes('⟦REF1⟧'))
  })

  test('模型重复 token → 可读错误', () => {
    const { exports } = loadPlugin()
    const result = exports.unmaskDraft('⟦REF1⟧ 和 ⟦REF1⟧', slots())
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.includes('重复'))
  })

  test('模型打乱 token 顺序 → 可读错误', () => {
    const { exports } = loadPlugin()
    const masked = exports.maskDraft('@a.txt 与 @b.txt', [
      occurrence({ ref: 'a', offset: 0, length: 6, clipboardText: '@a.txt' }),
      occurrence({ ref: 'b', offset: 9, length: 6, clipboardText: '@b.txt' }),
    ])
    const result = exports.unmaskDraft('⟦REF2⟧ 与 ⟦REF1⟧', masked.slots)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.includes('顺序'))
  })

  test('模型返回空内容 → 可读错误', () => {
    const { exports } = loadPlugin()
    for (const empty of ['', '   ', undefined, null]) {
      const result = exports.unmaskDraft(empty, slots())
      assert.equal(typeof result.error, 'string')
      assert.ok(result.error.length > 0)
    }
  })
})

// ---------------------------------------------------------------------
// 4. describeFailure
// ---------------------------------------------------------------------

describe('describeFailure', () => {
  test('所有分支都给出非空 message', () => {
    const { exports } = loadPlugin()
    const cases = {
      'rpc failure': { kind: 'rpc', error: { code: 'llm-error', message: '模型调用失败', details: {} } },
      'rpc failure 只有 code': { kind: 'rpc', error: { code: 'llm-error' } },
      'rpc failure 空对象': { kind: 'rpc', error: {} },
      '整包 ok:false': { ok: false, error: { code: 'no-model', message: '没有可用模型', details: {} } },
      '抛出的 Error': new Error('网络中断'),
      '抛出的字符串': '网关 502',
      '抛出的空对象': {},
      'unmask 失败': { kind: 'unmask', error: '模型输出丢失了引用 ⟦REF1⟧' },
      '草稿漂移': { kind: 'stale' },
      '写回退化': { kind: 'degraded' },
      'undefined': undefined,
      'null': null,
    }
    for (const [label, input] of Object.entries(cases)) {
      const described = exports.describeFailure(input)
      assert.equal(typeof described.code, 'string', `${label}: code 必须是字符串`)
      assert.ok(described.code.length > 0, `${label}: code 不能为空`)
      assert.equal(typeof described.message, 'string', `${label}: message 必须是字符串`)
      assert.ok(described.message.trim().length > 0, `${label}: message 不能为空`)
    }
    assert.equal(exports.describeFailure({ ok: false, error: { code: 'x', message: '中间层报错' } }).message, '中间层报错')
    assert.equal(exports.describeFailure(new Error('网络中断')).message, '网络中断')
    assert.ok(exports.describeFailure({ kind: 'stale' }).message.includes('输入已变化'))
    assert.ok(exports.describeFailure({ kind: 'degraded' }).message.includes('引用已退化'))
  })

  test('t 可注入：翻译命中时用翻译结果', () => {
    const { exports } = loadPlugin()
    const described = exports.describeFailure({ kind: 'stale' }, (key) => (key === 'error.staleDraft' ? 'draft changed' : key))
    assert.equal(described.message, 'draft changed')
    assert.equal(described.code, 'draft-changed')
  })
})

// ---------------------------------------------------------------------
// 5. tooltipOf
// ---------------------------------------------------------------------

describe('tooltipOf', () => {
  test('四态文案', () => {
    const { exports } = loadPlugin()
    assert.equal(exports.tooltipOf({ status: 'idle', canRun: true }, undefined), '优化提示词')
    assert.equal(exports.tooltipOf({ status: 'idle', canRun: false }, undefined), '输入为空，无需优化')
    assert.equal(exports.tooltipOf({ status: 'running', canRun: true }, undefined), '正在优化…')
    assert.equal(
      exports.tooltipOf({ status: 'error', canRun: true, failure: { code: 'llm-error', message: '模型调用失败' } }, undefined),
      '优化失败：模型调用失败',
    )
  })

  test('错误态缺 message 时退回 code', () => {
    const { exports } = loadPlugin()
    assert.equal(
      exports.tooltipOf({ status: 'error', canRun: true, failure: { code: 'llm-error', message: '' } }, undefined),
      '优化失败：llm-error',
    )
    const empty = exports.tooltipOf({ status: 'error', canRun: true, failure: {} }, undefined)
    assert.ok(empty.startsWith('优化失败：'))
    assert.ok(empty.length > '优化失败：'.length)
  })

  test('t 可注入', () => {
    const { exports } = loadPlugin()
    const t = (key) => (key === 'tooltip.idle' ? 'Optimize prompt' : key)
    assert.equal(exports.tooltipOf({ status: 'idle', canRun: true }, t), 'Optimize prompt')
  })
})

// ---------------------------------------------------------------------
// 6. submissionStarted / watchSend：内容发出后撤销在途请求
// ---------------------------------------------------------------------

describe('submissionStarted', () => {
  test('草稿非空且相位是 plain / claimed：不算发送', () => {
    const { exports } = loadPlugin()
    assert.equal(exports.submissionStarted({ draft: '写个测试', phase: 'plain' }), false)
    assert.equal(exports.submissionStarted({ draft: '写个测试', phase: 'claimed' }), false)
  })

  test('提交事务开始（adjudicating / submitting）就算发送', () => {
    const { exports } = loadPlugin()
    assert.equal(exports.submissionStarted({ draft: '/goal x', phase: 'adjudicating' }), true)
    assert.equal(exports.submissionStarted({ draft: '写个测试', phase: 'submitting' }), true)
  })

  test('输入框被清空就算发送（默认发送的乐观 commit-draft）', () => {
    const { exports } = loadPlugin()
    for (const draft of ['', '   ', '\n\t']) {
      assert.equal(exports.submissionStarted({ draft, phase: 'plain' }), true, `draft=${JSON.stringify(draft)}`)
    }
  })

  test('异常入参不抛错；取不到草稿按已清空处理', () => {
    const { exports } = loadPlugin()
    for (const value of [undefined, null, {}, { draft: 42 }, 'oops']) {
      assert.doesNotThrow(() => exports.submissionStarted(value))
    }
    // 没有可用快照时宁可撤销，也不把结果写进未知状态。
    assert.equal(exports.submissionStarted(undefined), true)
    assert.equal(exports.submissionStarted({ draft: 42, phase: 'plain' }), true)
    assert.equal(exports.submissionStarted({ draft: '保留', phase: 'claimed' }), false)
  })
})

describe('watchSend（本地发送回显监听）', () => {
  /** 造一个可手动 publish 的假 Session 快照。 */
  function createSession(initial) {
    const listeners = new Set()
    let snapshot = initial
    return {
      session: {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      publish(next) {
        snapshot = next
        for (const listener of Array.from(listeners)) listener()
      },
    }
  }

  test('只认发起之后新出现的发送回显，而且只触发一次', () => {
    const fake = createSession({ pendingSubmissions: [{ requestId: 'old', time: 1000 }] })
    const sessions = { binding: (id) => (id === 'session-1' ? { session: fake.session } : undefined) }
    const { registration } = mountPlugin({}, { get: (name) => (name === 'sessions' ? sessions : undefined) })
    const face = registration.inject('session-1')

    let fired = 0
    const stop = face.watchSend('session-1', 2000, () => {
      fired += 1
    })
    assert.equal(fired, 0, '基线里已有的回显不算新发送')

    // 比发起时刻更早的残留回显也不算新发送。
    fake.publish({ pendingSubmissions: [{ requestId: 'old', time: 1000 }, { requestId: 'residual', time: 1500 }] })
    assert.equal(fired, 0)

    // 发起之后新登记的发送回显：触发一次。
    fake.publish({ pendingSubmissions: [{ requestId: 'new', time: 2001 }] })
    assert.equal(fired, 1)

    // 同一份快照重复 publish 不重复触发。
    fake.publish({ pendingSubmissions: [{ requestId: 'new', time: 2001 }] })
    assert.equal(fired, 1)

    stop()
    fake.publish({ pendingSubmissions: [{ requestId: 'newer', time: 3000 }] })
    assert.equal(fired, 1, '退订后不再触发')
  })

  test('sessions 服务缺失 / 形状不符时返回 noop，不抛错', () => {
    const { registration } = mountPlugin()
    const face = registration.inject('session-1')
    for (const sessionId of ['session-1', undefined]) {
      const stop = face.watchSend(sessionId, 0, () => assert.fail('不该触发'))
      assert.equal(typeof stop, 'function')
      stop()
    }

    const weird = mountPlugin({}, {
      get: (name) => (name === 'sessions' ? { binding: () => ({ session: { subscribe: 1 } }) } : undefined),
    })
    const stop = weird.registration.inject('session-1').watchSend('session-1', 0, () => assert.fail('不该触发'))
    assert.equal(typeof stop, 'function')
    stop()
  })
})

// ---------------------------------------------------------------------
// 7. apply：槽位 / 词典 / 样式
// ---------------------------------------------------------------------

describe('apply', () => {
  test('注册 conversation.input.right（order -10，先于模型选择器）并注入依赖面', () => {
    const { exports } = loadPlugin()
    const injections = []
    const registrations = []
    const effects = []
    const localeDictionaries = []
    const ctx = {
      effect(fn, label) {
        effects.push({ fn, label })
        return () => {}
      },
      locale: {
        register(ns, dicts) {
          localeDictionaries.push({ ns, dicts })
          return () => {}
        },
        bind(ns) {
          return (key) => key
        },
      },
      slots: {
        inject(name, callback) {
          injections.push(name)
          registrations.push(callback())
        },
        register(options, component) {
          return { options, component }
        },
      },
      connection: { rpc: { call: async () => ({ ok: true, value: { optimized: '' } }) } },
      conversation: { resolveDraftAttachments: () => [] },
      modelDirectories: { directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: 'p', model: 'm' } }) } }) },
    }

    exports.apply(ctx)
    // ctx.effect 延迟到作用域建立时才执行；这里手动跑一遍并保留释放函数。
    const disposers = effects.map(({ fn }) => fn())

    assert.deepEqual(injections, ['conversation.input.right'])
    assert.equal(registrations.length, 1)
    const { options, component } = registrations[0]
    assert.equal(options.name, 'conversation.input.right')
    assert.equal(options.id, 'input-optimize')
    assert.equal(options.order, -10)
    assert.equal(options.locale, 'input-optimize')
    assert.equal(typeof component, 'function')
    const face = options.inject('session-1')
    for (const key of ['rpcCall', 't', 'resolveAttachments', 'readSelection', 'watchSend']) {
      assert.equal(typeof face[key], 'function', `inject face 需要 ${key}`)
    }
    assert.equal(typeof face.t('tooltip.idle'), 'string')

    // 词典：中英双语同键，且真的注册了
    assert.equal(localeDictionaries.length, 1)
    assert.equal(localeDictionaries[0].ns, 'input-optimize')
    assert.deepEqual(Object.keys(localeDictionaries[0].dicts).sort(), ['en', 'zh'])
    assert.deepEqual(Object.keys(localeDictionaries[0].dicts.zh).sort(), Object.keys(localeDictionaries[0].dicts.en).sort())

    // 两个 effect：词典与样式，都必须可释放
    assert.equal(effects.length, 2)
    for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  })

  test('样式只注入一份并在释放时移除', () => {
    const { exports, document } = loadPlugin()
    const disposers = []
    const styleTags = []
    const documentWithQuery = {
      ...document,
      querySelector() {
        return styleTags.find((tag) => tag.attributes['data-plugin-css'] === 'dsh-input-optimize/style') ?? null
      },
      createElement() {
        const tag = { parentNode: null, attributes: {}, textContent: '', setAttribute(name, value) { this.attributes[name] = value } }
        styleTags.push(tag)
        return tag
      },
    }
    // 重新套用一份带样式记录的 document：apply 内部的 injectStylesheet 读的是全局 document，
    // 这里通过再次求值把注入的 document 换成可观测版本。
    const reloaded = (() => {
      let registration
      const window = { __ModuleLoader__: { load(entry) { registration = entry } }, matchMedia: () => ({ matches: false }) }
      new Function('window', 'document', SOURCE)(window, documentWithQuery)
      return registration.factory((id) => (id === 'react' ? createFakeReact() : { Tooltip: (props) => props.children }))
    })()

    const ctx = {
      effect(fn) {
        disposers.push(fn())
        return () => {}
      },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: { inject(name, callback) { callback() }, register: () => ({}) },
      connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
      conversation: { resolveDraftAttachments: () => [] },
      modelDirectories: { directoryFor: () => null },
    }
    reloaded.apply(ctx)

    assert.equal(styleTags.length, 1, '只应创建一个 style 标签')
    const [tag] = styleTags
    assert.equal(tag.attributes['data-plugin-css'], 'dsh-input-optimize/style')
    assert.ok(tag.textContent.includes('.dsh-io-button'), '样式必须使用 dsh-io- 前缀')
    assert.ok(tag.textContent.includes('prefers-reduced-motion'), '必须尊重减少动效偏好')
    assert.equal(typeof disposers[1], 'function')
    disposers[1]()
    assert.equal(documentWithQuery.head.children.length, 0, '释放后 style 标签被移除')
    // 未使用的变量兜底：确保两个加载器都是有效的模块
    assert.equal(typeof exports.apply, 'function')
  })
})

// ---------------------------------------------------------------------
// 8. 组件：纯图标按钮
// ---------------------------------------------------------------------

describe('按钮渲染', () => {
  const baseProps = (overrides = {}) => ({
    sessionId: 'session-1',
    inputActions: { setDraft: () => {} },
    rpcCall: async () => ({ ok: true, value: { optimized: '优化结果' } }),
    resolveAttachments: () => [],
    readSelection: () => null,
    t: (key) => key,
    ...overrides,
  })
  const inputState = (overrides = {}) => ({
    draft: '帮我把这段话改得更正式',
    attachmentIds: [],
    draftRev: 1,
    phase: 'plain',
    occurrences: [],
    queue: [],
    ...overrides,
  })

  test('按钮内只有一个 16x16 SVG，没有任何文本子节点', () => {
    const props = baseProps({ useInput: (selector) => selector(inputState()) })
    const tree = mountPlugin().render(props)
    const button = findElement(tree, (node) => node.type === 'button')
    assert.ok(button, '必须渲染一个 button')
    const kids = childrenOf(button)
    assert.equal(kids.length, 1, '按钮必须只有一个子节点（图标）')
    const icon = kids[0]
    assert.equal(icon.type, 'svg')
    assert.equal(icon.props.viewBox, '0 0 16 16')
    assert.equal(icon.props.width, 16)
    assert.equal(icon.props.height, 16)
    // 空闲态是 DSH 通用「工具调用」图标：三个描边的四角星（sparkle），不是实心魔杖。
    assert.equal(icon.props.fill, 'none')
    assert.equal(icon.props.strokeWidth, '1')
    const paths = childrenOf(icon)
    assert.equal(paths.length, 3, 'sparkle 由三个四角星组成')
    for (const path of paths) {
      assert.equal(path.type, 'path')
      assert.equal(path.props.stroke, 'currentColor')
    }
    assert.deepEqual(textWithin(button), [], '按钮内不能出现任何文本节点')
    assert.ok(button.props['aria-label'].length > 0)
    assert.equal(typeof button.props.title, 'undefined', '有 Tooltip 时不该退化用 title')
  })

  test('primitives 提供 IconSparkleRegular 时优先使用（跟随 DSH 版本）', () => {
    const IconSparkleRegular = (iconProps) => ({ type: 'dsh-sparkle', props: iconProps })
    const props = baseProps({ useInput: (selector) => selector(inputState()) })
    const tree = mountPlugin({
      primitives: { Tooltip: (tooltipProps) => tooltipProps.children, IconSparkleRegular },
    }).render(props)

    const icon = findElement(tree, (node) => node.type === IconSparkleRegular)
    assert.ok(icon, '必须优先使用 primitives 导出的 IconSparkleRegular')
    assert.equal(icon.props.size, 16)
    assert.equal(icon.props.className, 'dsh-io-icon')
    assert.equal(findElement(tree, (node) => node.type === 'svg'), undefined, '有 primitives 图标时不该退回内联 SVG')
  })

  test('空闲可用态：按钮启用，Tooltip 文案为「优化提示词」', () => {
    const props = baseProps({ useInput: (selector) => selector(inputState()) })
    const tree = mountPlugin().render(props)
    const button = findElement(tree, (node) => node.type === 'button')
    assert.equal(button.props.disabled, false)
    assert.equal(button.props['aria-busy'], undefined)
    assert.equal(button.props['data-state'], 'idle')
    const tooltip = findElement(tree, (node) => typeof node.type === 'function' && 'label' in node.props)
    assert.ok(tooltip, '必须使用 Tooltip')
    assert.equal(tooltip.props.label, '优化提示词')
    assert.equal(tooltip.props.side, 'top')
    // aria-live 区域必须存在，且空闲态不播报
    const live = findElement(tree, (node) => node.props && node.props['aria-live'] === 'polite')
    assert.ok(live, '必须有 aria-live 区域')
    assert.deepEqual(textWithin(live), [])
  })

  test('输入框为空（空串 / 纯空白 / 只有附件）时按钮隐藏、不占位', () => {
    for (const draft of ['', '   ', '\n\t']) {
      const props = baseProps({ useInput: (selector) => selector(inputState({ draft })) })
      assert.equal(mountPlugin().render(props), null, `draft=${JSON.stringify(draft)} 时不应渲染按钮`)
    }
    const attachmentOnly = baseProps({
      useInput: (selector) => selector(inputState({ draft: '', attachmentIds: ['att-1'] })),
      resolveAttachments: () => [{ kind: 'image', name: 'att-1.png' }],
    })
    assert.equal(mountPlugin().render(attachmentOnly), null, '只有附件时也没有可优化的提示词')
  })

  test('提交中（phase=submitting）被禁用', () => {
    const props = baseProps({ useInput: (selector) => selector(inputState({ phase: 'submitting' })) })
    const tree = mountPlugin().render(props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props.disabled, true)
  })

  test('adjudicating 期间被禁用（与 submitting 同属忙碌相位）', () => {
    const props = baseProps({ useInput: (selector) => selector(inputState({ phase: 'adjudicating' })) })
    const tree = mountPlugin().render(props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props.disabled, true)
  })

  test('claimed 相位仍然可用（契约只禁用 adjudicating/submitting）', () => {
    const props = baseProps({ useInput: (selector) => selector(inputState({ phase: 'claimed' })) })
    const tree = mountPlugin().render(props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props.disabled, false)
  })

  test('没有 sessionId 时被禁用', () => {
    const props = baseProps({ sessionId: undefined, useInput: (selector) => selector(inputState()) })
    const tree = mountPlugin().render(props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props.disabled, true)
  })

  test('primitives 不可用时退回原生 title', () => {
    // 必须把 primitives: null 一路传进 mountPlugin，否则会重新装载出带 Tooltip 的模块。
    const props = baseProps({ useInput: (selector) => selector(inputState()) })
    const tree = mountPlugin({ primitives: null }).render(props)
    const button = findElement(tree, (node) => node.type === 'button')
    assert.ok(button)
    assert.equal(button.props.title, '优化提示词')
    assert.deepEqual(textWithin(button), [])
  })

  test('prefers-reduced-motion 时用静态字形（不挂旋转动画类）', () => {
    // matchMedia 命中 reduce：running 态必须用静态沙漏，而不是带 dsh-io-spin 的旋转弧。
    // 让组件进入 running 态：点击后 RPC 挂起，重渲染即 running。
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const props = baseProps({
      useInput: (selector) => selector(inputState()),
      rpcCall: () => pending,
    })
    const { render } = mountPlugin({ matchMedia: (query) => ({ matches: query.includes('prefers-reduced-motion') }) })
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = render(props)
    const button = findElement(tree, (node) => node.type === 'button')
    assert.equal(button.props['aria-busy'], 'true')
    const icon = childrenOf(button)[0]
    assert.equal(icon.props.className, 'dsh-io-icon', '减少动效时必须使用静态字形')
    assert.ok(!String(icon.props.className).includes('dsh-io-spin'))
    release({ ok: true, value: { optimized: '⟦REF1⟧' } })
  })

  test('允许动效时 running 态使用旋转弧', () => {
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const props = baseProps({
      useInput: (selector) => selector(inputState()),
      rpcCall: () => pending,
    })
    const { render } = mountPlugin()
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = render(props)
    const icon = childrenOf(findElement(tree, (node) => node.type === 'button'))[0]
    assert.match(icon.props.className, /dsh-io-spin/)
    release({ ok: true, value: { optimized: '⟦REF1⟧' } })
  })

})

// ---------------------------------------------------------------------
// 9. 点击流程
// ---------------------------------------------------------------------

describe('点击流程', () => {
  const inputState = (overrides = {}) => ({
    draft: '请总结 @a.txt 的内容',
    attachmentIds: [],
    draftRev: 1,
    phase: 'plain',
    occurrences: [SAMPLE_OCCURRENCE],
    queue: [],
    ...overrides,
  })

  test('RPC 失败：错误文案进 tooltip，延迟为 0，aria-label 变为「查看原因」', async () => {
    const { render } = mountPlugin()
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: () => assert.fail('失败时不该写回') },
      useInput: (selector) => selector(inputState()),
      rpcCall: async () => ({ ok: false, error: { code: 'llm-error', message: '模型调用失败，请稍后重试', details: {} } }),
      resolveAttachments: () => [],
      readSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      t: (key) => key,
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = await settle(render, props)

    const button = findElement(tree, (node) => node.type === 'button')
    assert.equal(button.props['data-state'], 'error')
    assert.equal(button.props['aria-label'], '优化失败，查看原因')
    assert.deepEqual(textWithin(button), [])
    const tooltip = findElement(tree, (node) => typeof node.type === 'function' && 'label' in node.props)
    assert.equal(tooltip.props.label, '优化失败：模型调用失败，请稍后重试')
    assert.equal(tooltip.props.delayMs, 0)
    const live = findElement(tree, (node) => node.props && node.props['aria-live'] === 'polite')
    assert.match(textWithin(live).join(''), /模型调用失败/)
  })

  test('成功：写回 DraftSnapshot（保留引用），并回到空闲态', async () => {
    const { render } = mountPlugin()
    const writes = []
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: (value) => writes.push(value) },
      useInput: (selector) => selector(inputState()),
      rpcCall: async () => ({ ok: true, value: { optimized: '麻烦总结一下 ⟦REF1⟧ 的核心结论' } }),
      resolveAttachments: () => [],
      readSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }),
      t: (key) => key,
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = await settle(render, props)

    assert.equal(writes.length, 1)
    const written = writes[0]
    assert.equal(typeof written, 'object', '必须写回 { text, references } 以保留 chip')
    assert.equal(written.text, '麻烦总结一下 @a.txt 的核心结论')
    assert.equal(written.references.length, 1)
    assert.equal('occurrenceId' in written.references[0], false)
    assert.equal(findElement(tree, (node) => node.type === 'button').props['data-state'], 'idle')
  })

  test('RPC 请求体按契约携带 sessionId / maskedText / 模型 / 附件名', async () => {
    const { render } = mountPlugin()
    const calls = []
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: () => {} },
      useInput: (selector) => selector(inputState({ attachmentIds: ['att-1', 'att-2'] })),
      rpcCall: async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { optimized: '⟦REF1⟧ 的核心结论' } }
      },
      resolveAttachments: (ids) => ids.map((id, index) => ({ kind: index === 0 ? 'image' : 'file', name: `${id}.png` })),
      readSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' }),
      t: (key) => key,
    }
    const tree0 = render(props)
    findElement(tree0, (node) => node.type === 'button').props.onClick()
    await settle(render, props)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].endpoint, 'optimize')
    assert.deepEqual(calls[0].payload, {
      sessionId: 'session-1',
      maskedText: '请总结 ⟦REF1⟧ 的内容',
      attachments: [
        { kind: 'image', name: 'att-1.png' },
        { kind: 'file', name: 'att-2.png' },
      ],
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'medium',
    })
  })

  test('飞行中草稿被改动：放弃写回并提示「输入已变化，已放弃写回」', async () => {
    const { render } = mountPlugin()
    let release
    let requestSignal
    const pending = new Promise((resolve) => { release = resolve })
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: () => assert.fail('漂移后不该写回') },
      useInput: (selector) => selector(inputState({ draftRev: 1 })),
      rpcCall: (endpoint, payload, signal) => {
        requestSignal = signal
        return pending
      },
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = render(props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props['aria-busy'], 'true')

    // 同一个草稿文本、但 revision 前进了一次：视为用户改过输入。
    // 普通编辑不该 abort 在途请求（只有「内容被发出去」才撤销）。
    release({ ok: true, value: { optimized: '⟦REF1⟧ 的核心结论' } })
    props.useInput = (selector) => selector(inputState({ draftRev: 2 }))
    render(props)
    assert.equal(requestSignal.aborted, false, '普通编辑不应 abort 请求')
    tree = await settle(render, props)

    const tooltip = findElement(tree, (node) => typeof node.type === 'function' && 'label' in node.props)
    assert.match(tooltip.props.label, /输入已变化，已放弃写回/)
  })

  test('老运行时（对象写回抛错）：降级为纯文本并提示「引用已退化为文本」', async () => {
    const { render } = mountPlugin()
    const writes = []
    const props = {
      sessionId: 'session-1',
      inputActions: {
        setDraft(value) {
          if (typeof value !== 'string') throw new TypeError('setDraft expects string')
          writes.push(value)
        },
      },
      useInput: (selector) => selector(inputState()),
      rpcCall: async () => ({ ok: true, value: { optimized: '麻烦总结一下 ⟦REF1⟧ 的核心结论' } }),
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = await settle(render, props)

    assert.deepEqual(writes, ['麻烦总结一下 @a.txt 的核心结论'])
    const tooltip = findElement(tree, (node) => typeof node.type === 'function' && 'label' in node.props)
    assert.match(tooltip.props.label, /引用已退化为文本/)
  })

  test('连续点击只发一次请求（重入保护）', async () => {
    const { render } = mountPlugin()
    let calls = 0
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: () => {} },
      useInput: (selector) => selector(inputState()),
      rpcCall: () => {
        calls += 1
        return pending
      },
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
    }
    let tree = render(props)
    const onClick = findElement(tree, (node) => node.type === 'button').props.onClick
    onClick()
    onClick()
    onClick()
    tree = render(props)
    assert.equal(calls, 1)
    release({ ok: true, value: { optimized: '⟦REF1⟧' } })
    await settle(render, props)
  })

  test('transport / 服务缺失时给出可读失败而不是崩溃', async () => {
    // 三个服务全置空：rpcCall 必须返回结构化失败，其余注入面必须安全降级。
    const { registration } = mountPlugin({}, { connection: undefined, conversation: undefined, modelDirectories: undefined })
    const face = registration.inject('session-1')
    const result = await face.rpcCall('optimize', {})
    assert.equal(result.ok, false)
    assert.equal(typeof result.error.message, 'string')
    assert.ok(result.error.message.length > 0)
    assert.equal(face.readSelection('session-1'), null)
    assert.deepEqual(face.resolveAttachments(['att-1']), [])
  })

  test('飞行中内容被发出（输入框清空）：立即 abort、静默回到空闲态、不写回', async () => {
    const { render } = mountPlugin()
    let requestSignal
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const writes = []
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: (value) => writes.push(value) },
      useInput: (selector) => selector(inputState({ draftRev: 1 })),
      rpcCall: (endpoint, payload, signal) => {
        requestSignal = signal
        return pending
      },
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = render(props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props['aria-busy'], 'true')
    assert.equal(requestSignal.aborted, false)

    // 按发送：默认发送会乐观清空输入框，draftRev 前进。
    props.useInput = (selector) => selector(inputState({ draft: '', draftRev: 2 }))
    tree = render(props)

    assert.equal(requestSignal.aborted, true, '内容发出后必须 abort 传输')
    assert.equal(tree, null, '输入框被清空后按钮应隐藏')
    assert.deepEqual(writes, [], '撤销后不该写回')

    // 迟到的成功结果也不能写回、不能把状态翻成错误（输入框重新有内容时是空闲态）。
    release({ ok: true, value: { optimized: '优化结果' } })
    tree = await settle(render, props)
    assert.equal(tree, null)
    assert.deepEqual(writes, [])
    props.useInput = (selector) => selector(inputState({ draft: '新草稿', draftRev: 3 }))
    tree = render(props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props['data-state'], 'idle')
  })

  test('飞行中命令提交（phase=adjudicating）：同样撤销且不报错', async () => {
    const { render } = mountPlugin()
    let requestSignal
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: () => assert.fail('撤销后不该写回') },
      useInput: (selector) => selector(inputState({ draftRev: 1 })),
      rpcCall: (endpoint, payload, signal) => {
        requestSignal = signal
        return pending
      },
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = render(props)
    assert.equal(requestSignal.aborted, false)

    props.useInput = (selector) => selector(inputState({ phase: 'adjudicating', draftRev: 2 }))
    tree = render(props)

    assert.equal(requestSignal.aborted, true)
    assert.equal(findElement(tree, (node) => node.type === 'button').props['data-state'], 'idle')
    const tooltip = findElement(tree, (node) => typeof node.type === 'function' && 'label' in node.props)
    assert.doesNotMatch(tooltip.props.label, /优化失败/)

    release({ ok: true, value: { optimized: '优化结果' } })
    tree = await settle(render, props)
    assert.equal(findElement(tree, (node) => node.type === 'button').props['data-state'], 'idle')
  })

  test('abort 引发的拒绝不会变成错误提示（取消不是失败）', async () => {
    const { render } = mountPlugin()
    let requestSignal
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: () => assert.fail('撤销后不该写回') },
      useInput: (selector) => selector(inputState({ draftRev: 1 })),
      rpcCall: (endpoint, payload, signal) =>
        new Promise((resolve, reject) => {
          requestSignal = signal
          signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = render(props)
    assert.equal(requestSignal.aborted, false)

    props.useInput = (selector) => selector(inputState({ draft: '', draftRev: 2 }))
    tree = render(props)
    assert.equal(requestSignal.aborted, true)
    assert.equal(tree, null, '输入框被清空后按钮应隐藏')

    tree = await settle(render, props)
    assert.equal(tree, null)
    props.useInput = (selector) => selector(inputState({ draft: '新草稿', draftRev: 3 }))
    tree = render(props)
    assert.equal(
      findElement(tree, (node) => node.type === 'button').props['data-state'],
      'idle',
      '取消不是错误态：重新出现时必须是空闲态',
    )
  })

  test('watchSend 报告发送回显时撤销请求，并在撤销时退订', async () => {
    const { render } = mountPlugin()
    let watched
    let stopped = 0
    let requestSignal
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: () => assert.fail('撤销后不该写回') },
      useInput: (selector) => selector(inputState()),
      rpcCall: (endpoint, payload, signal) => {
        requestSignal = signal
        return pending
      },
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
      watchSend: (sessionId, startedAt, onSend) => {
        watched = { sessionId, startedAt, onSend }
        return () => {
          stopped += 1
        }
      },
    }
    let tree = render(props)
    findElement(tree, (node) => node.type === 'button').props.onClick()
    tree = render(props)

    assert.equal(watched.sessionId, 'session-1', '必须监听当前会话')
    assert.equal(typeof watched.startedAt, 'number', '必须带上发起时间')
    assert.equal(stopped, 0)

    watched.onSend()
    tree = render(props)
    assert.equal(requestSignal.aborted, true, '发送回显必须 abort 传输')
    assert.equal(stopped, 1, '撤销时立刻退订，避免泄漏')
    assert.equal(findElement(tree, (node) => node.type === 'button').props['data-state'], 'idle')

    release({ ok: true, value: { optimized: '优化结果' } })
    tree = await settle(render, props)
    assert.equal(stopped, 1, '收尾时不再重复退订')
  })

  test('watchSend 抛错时请求照常完成并写回', async () => {
    const { render } = mountPlugin()
    const writes = []
    const props = {
      sessionId: 'session-1',
      inputActions: { setDraft: (value) => writes.push(value) },
      useInput: (selector) => selector(inputState()),
      rpcCall: async () => ({ ok: true, value: { optimized: '⟦REF1⟧ 的核心结论' } }),
      resolveAttachments: () => [],
      readSelection: () => null,
      t: (key) => key,
      watchSend: () => {
        throw new Error('boom')
      },
    }
    const tree0 = render(props)
    findElement(tree0, (node) => node.type === 'button').props.onClick()
    const tree = await settle(render, props)

    assert.equal(writes.length, 1)
    assert.equal(writes[0].text, '@a.txt 的核心结论')
    assert.equal(findElement(tree, (node) => node.type === 'button').props['data-state'], 'idle')
  })
})
