// dsh-input-optimize —— Host 半。
//
// 浏览器输入框的「优化」按钮通过 Connection 共享 /api 通道调到这里，
// 路由是 /api/input-optimize/optimize，方法名 input-optimize/optimize。
// 我们用用户当前选中的模型把草稿改写成更清晰的指令，再把纯文本回给前端。
//
// 两条底线：
//   1. handler 绝不向外抛异常 —— RPC 传输层会把抛错变成 HTTP 500，
//      浏览器侧就只能看到一个坏掉的请求，而不是可展示的失败原因；
//   2. 绝不在失败（error / aborted / 空内容）时把半截文本当成功返回。

import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { SYSTEM_PROMPT, buildUserPrompt, stripFences, isValidOutput } from './prompt.js';

/** 插件名（cordis 用于诊断与 logger 名）。 */
export const name = 'input-optimize';

/** 依赖：connection 提供 RPC 注册表，llm 提供模型调用。
 * webServer 必须在顶层声明 —— 备用前缀通道注册时 Connection 会直接读
 * `owner.webServer`，缺了它会抛错（dsh-pocket 的注释记录了同一坑）。 */
export const inject = ['connection', 'llm', 'webServer'];

/** Connection RPC 通道名，必须匹配 /^\/[A-Za-z0-9._~-]+$/。 */
export const CHANNEL = '/input-optimize';

/** 通道下唯一的业务 endpoint。 */
export const ENDPOINT = 'optimize';

/**
 * 一次性请求里 user 消息的来源标记。
 *
 * 与已安装可用的 dsh-prompt-optimizer 保持一致，使用 plugin kind 标注生产者。
 * 运行时 createUserMessage 不校验 source，消费方对未知 kind 一律透传；
 * 这条消息只属于本次请求，不会写入会话日志。
 */
const MESSAGE_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'input-optimize' });

/** 成功结果包装。 */
function succeed(value) {
  return { ok: true, value };
}

/** 失败结果包装；details 必须是对象（浏览器侧按 record 校验）。 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

/** 读取非空字符串，其余一律视为「没给」。 */
function readString(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** 判断一个值是不是普通对象。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读取会话当前选中的模型选项。
 *
 * 走 agents 服务：`ctx.get('agents').get(sessionId).options`。
 * 会话不存在、服务缺失都只当作「没有可回退的模型」，绝不抛错。
 */
function readAgentOptions(ctx, sessionId) {
  try {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const agents = ctx.get?.('agents');
    if (!agents || typeof agents.get !== 'function') return undefined;
    const agent = agents.get(sessionId);
    const options = agent?.options;
    return isRecord(options) ? options : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析本次调用要用的模型。
 *
 * 优先用请求里带的 provider/model（前端拿的是输入框当前选择，最新鲜），
 * 缺的字段再回退到会话 agent 的 options；两者都凑不齐才算失败。
 * 解析结果同时写入 meta，供调用结束后统一打日志。
 */
function resolveModel(ctx, input, meta) {
  const requestProvider = readString(input.provider);
  const requestModel = readString(input.model);
  const requestEffort = readString(input.reasoningEffort);

  let provider = requestProvider;
  let model = requestModel;
  let reasoningEffort = requestEffort;
  let modelSource = 'request';

  if (provider === undefined || model === undefined) {
    const options = readAgentOptions(ctx, input.sessionId);
    let filledFromAgent = false;

    if (provider === undefined && readString(options?.provider) !== undefined) {
      provider = readString(options.provider);
      filledFromAgent = true;
    }
    if (model === undefined && readString(options?.model) !== undefined) {
      model = readString(options.model);
      filledFromAgent = true;
    }
    if (reasoningEffort === undefined) {
      reasoningEffort = readString(options?.reasoningEffort);
    }
    modelSource = filledFromAgent ? 'agent' : 'request';
  }

  meta.modelSource = modelSource;
  meta.provider = provider;
  meta.model = model;

  if (provider === undefined || model === undefined) {
    meta.modelSource = 'none';
    return undefined;
  }
  return { provider, model, reasoningEffort };
}

/**
 * 把流式 chunk 收敛成文本与终止原因。
 *
 * `FinishReason` 是可合并扩展的判别联合（{ kind: 'error' | 'aborted' | ... }），
 * 这里同时容忍裸字符串形状，避免不同适配器/版本之间出现形状差异时误判成功。
 */
async function collectStream(stream) {
  let text = '';
  let finishReason;

  for await (const chunk of stream) {
    if (!isRecord(chunk)) continue;
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text;
      continue;
    }
    if (chunk.type === 'finish') finishReason = chunk.reason;
  }

  const finishKind = typeof finishReason === 'string'
    ? finishReason
    : isRecord(finishReason)
      ? finishReason.kind
      : undefined;

  return { text, finishKind };
}

/** 从异常里取一句短小可读的原因，用于拼「模型调用失败：<原因>」。 */
function describeError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (text === '') return '未知错误';
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * 解析并执行一次优化请求，返回 RPC 结果对象。
 *
 * 所有失败路径都在这里收敛成 { ok:false, error }，调用方只需记日志。
 */
async function runOptimize(ctx, endpoint, payload, signal, meta) {
  // 两种调用形态都接受：独占通道用 'optimize'，共享 /api 通道用
  // 'input-optimize/optimize'（后者由 Connection 的方法名语义决定）。
  if (endpoint !== ENDPOINT && endpoint !== API_ENDPOINT) {
    return fail('bad-request', `unknown endpoint: ${String(endpoint)}`);
  }

  const input = isRecord(payload) ? payload : {};
  const maskedText = typeof input.maskedText === 'string' ? input.maskedText : '';
  meta.hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;

  if (maskedText.trim() === '') {
    return fail('bad-request', '提示词内容为空，无法优化');
  }

  const resolved = resolveModel(ctx, input, meta);
  if (resolved === undefined) {
    return fail('bad-request', '当前没有可用模型，无法优化');
  }

  const options = {
    provider: resolved.provider,
    model: resolved.model,
    system: SYSTEM_PROMPT,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: buildUserPrompt({ attachments: input.attachments, maskedText }) }],
        source: MESSAGE_SOURCE,
      }),
    ],
  };
  if (resolved.reasoningEffort !== undefined) options.reasoningEffort = resolved.reasoningEffort;
  if (signal !== undefined) options.signal = signal;

  // 前端关掉按钮/切走页面会 abort，此时不必再发请求，直接给可读的取消原因
  if (signal?.aborted === true) {
    return fail('internal', '模型调用失败或已被取消，请重新尝试', { reason: 'aborted' });
  }

  const { text, finishKind } = await collectStream(ctx.llm.stream(options));

  if (finishKind === 'error' || finishKind === 'aborted') {
    // 终态失败：已收到的文本可能只是半句，绝不作为成功结果返回
    return fail('internal', '模型调用失败或已被取消，请重新尝试', { reason: finishKind });
  }
  if (finishKind === undefined) {
    // 流正常结束但没有 finish chunk，说明内容可能被截断，同样不算成功
    return fail('internal', '模型返回不完整，请重新尝试', { reason: 'missing-finish' });
  }

  const optimized = stripFences(text);
  if (!isValidOutput(optimized)) {
    return fail('internal', '模型返回了空内容', { reason: 'empty-output' });
  }

  return succeed({ optimized });
}

/**
 * 打一行调用日志。
 *
 * 只记录元信息（模型来源、provider/model、是否有附件、耗时、失败码），
 * 绝不记录提示词正文或附件名 —— 那是用户内容。
 * logger 缺失、形状不符或抛错都不允许影响 RPC 返回值。
 */
function logCall(ctx, info) {
  const fields = [
    `modelSource=${info.modelSource ?? 'none'}`,
    `model=${info.provider ?? '-'}/${info.model ?? '-'}`,
    `attachments=${info.hasAttachments === true ? 'yes' : 'no'}`,
    `elapsedMs=${info.elapsedMs}`,
  ];
  if (info.ok !== true) fields.push(`code=${info.code ?? 'unknown'}`);

  const line = `input-optimize: optimize ${info.ok === true ? 'ok' : 'failed'} ${fields.join(' ')}`;
  try {
    // 服务形状随版本可变，统一走可选调用；外层再兜一层 try，日志永不影响业务结果
    if (info.ok === true) ctx?.logger?.info?.(line);
    else ctx?.logger?.warn?.(line);
  } catch {
    // 日志失败不能影响业务结果
  }
}

/**
 * 构造 RPC handler（导出以便测试注入假 ctx）。
 *
 * 签名与 Connection 的 handler 契约一致：`(endpoint, payload, signal, peer)`。
 * 无论内部发生什么，返回的都一定是 { ok, ... } 形状的 RPC 结果。
 */
export function createOptimizeHandler(ctx) {
  return async function handleInputOptimize(endpoint, payload, signal) {
    const startedAt = Date.now();
    const meta = {
      endpoint,
      modelSource: 'none',
      provider: undefined,
      model: undefined,
      hasAttachments: false,
    };

    let result;
    try {
      result = await runOptimize(ctx, endpoint, payload, signal, meta);
    } catch (error) {
      // 兜底：任何漏网异常都不能冒泡成 HTTP 500。
      // abort 引发的异常同样给出统一的取消话术，避免把 AbortError 原文弹给用户。
      const aborted = signal?.aborted === true || error?.name === 'AbortError';
      result = aborted
        ? fail('internal', '模型调用失败或已被取消，请重新尝试', { reason: 'aborted' })
        : fail('internal', `模型调用失败：${describeError(error)}`);
    }

    logCall(ctx, {
      ...meta,
      ok: result?.ok === true,
      code: result?.ok === false ? result.error?.code : undefined,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  };
}

/**
 * 注册 RPC 通道。
 *
 * 注册动作必须发生在「注入了 webServer 的 context」上：Connection 的
 * `rpc.handle` 会在读取 connection 的那个 fiber 上登记路由，而登记内部要用
 * webServer，所以先 inject(['webServer'])，再在回调里注册，最后用 effect
 * 把通道绑定到插件生命周期 —— 插件卸载时通道自动移除。
 */
/**
 * 共享 `/api` 通道上的精确路由。
 *
 * Connection 的浏览器客户端把一次调用拼成 `` `${channel}/${endpoint}` `` 并去掉
 * 开头的斜杠再 fetch，因此 channel=/api、endpoint=input-optimize/optimize 时
 * 真实请求路径就是 /api/input-optimize/optimize —— 路由必须精确等于这个路径，
 * 否则 shared fetch handler 直接 404。
 */
export const API_ROUTE = '/api/input-optimize/optimize';

/** 共享通道里的方法名，必须与客户端 calls 的 method 一致。 */
export const API_ENDPOINT = 'input-optimize/optimize';

/** 共享通道名：Connection 唯一的 Fetch/拦截器共享通道。 */
const API_CHANNEL = '/api';

/**
 * 构造一个符合 shared-channel 契约的 Fetch 响应（信封与 rpcFetchHandler 一致）。
 * @param {string} rpcId - 客户端关联 id。
 * @param {unknown} result - { ok:true, value } 或 { ok:false, error }。
 * @returns {Response} JSON 响应。
 */
function rpcResponse(rpcId, result) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 把共享通道上的一个 endpoint 请求翻译成 handler 调用。
 *
 * 与 dsh-client-connection 的 rpcFetchHandler 保持同一套信封语义：
 * 只接受 POST，只接受 application/json，method 必须与 endpoint 一致，
 * handler 抛错要变成 error 结果而不是 500。
 * @param {string} endpoint - 期望的端点名。
 * @param {(endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>} handler
 * @returns {(request: Request) => Promise<Response>}
 */
function createFetchEndpoint(endpoint, handler) {
  return async function handleRequest(request) {
    if (request.method !== 'POST') return new Response('not found', { status: 404 });
    const type = request.headers.get('content-type') || '';
    if (type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('body is not JSON', { status: 400 });
    }
    if (!isRecord(body) || typeof body.rpcId !== 'string') {
      return new Response('invalid client-request message', { status: 400 });
    }
    if (body.method !== endpoint) {
      return rpcResponse(body.rpcId, fail('bad-request', `unknown endpoint: ${String(body.method)}`));
    }
    let result;
    try {
      result = await handler(endpoint, body.payload, request.signal);
    } catch (error) {
      result = fail('internal', `模型调用失败：${describeError(error)}`);
    }
    return rpcResponse(body.rpcId, result);
  };
}

export function apply(ctx) {
  const handler = createOptimizeHandler(ctx);

  // 诊断：确认 Host 半确实被加载（可在桌面端日志里看到）
  try {
    ctx?.logger?.info?.('input-optimize: host half ACTIVATED');
  } catch {
    // 日志不可用不影响注册
  }

  // 首选：共享 /api Fetch 路由。Connection 的 Fetch 注册表由 carrier 直接分发，
  // 不需要 webServer 服务，因此在 Electron shell carrier 与 dsh web 下都成立，
  // 也能拿到完整的浏览器鉴权（非 owner peer 会被 403 拒绝）。
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: API_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createFetchEndpoint(API_ENDPOINT, handler),
    }),
    'input-optimize: /api Fetch route',
  );

  // 备用：独占前缀通道（旧版 dsh 或没有 Fetch 注册表时）。
  // Connection 注册通道时会直接读 `owner.webServer`，所以 webServer 必须在
  // 顶层 inject 里（dsh-pocket 的注释记录了这个坑）；任一缺失就跳过，不让
  // 插件加载失败。
  try {
    if (ctx.connection && typeof ctx.connection.rpc?.handle === 'function') {
      ctx.effect(
        () => ctx.connection.rpc.handle(CHANNEL, handler),
        'input-optimize: rpc channel',
      );
    }
  } catch (error) {
    ctx?.logger?.warn?.(`input-optimize: prefix channel unavailable: ${describeError(error)}`);
  }
}
