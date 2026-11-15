'use strict';

/**
 * 协议适配层:OpenAI Chat Completions ⇄ Anthropic Messages ⇄ OpenAI Responses
 *
 *   POST /v1/chat/completions   OpenAI 原生(直接透传,不经过本文件)
 *   POST /v1/messages           Anthropic Messages  ← Claude Code、Cline、Roo Code、Zed、Continue…
 *   POST /v1/responses          OpenAI Responses    ← Codex CLI、新版 OpenAI SDK
 *
 * 两条外部协议都翻译成内部统一的 Chat Completions 形状,再翻译回各自的响应/流式事件。
 *
 * 上游(xiaohuanxiong.com,litellm 网关)实测结论,决定了下面的取舍:
 *   1. 支持 function calling,流式会发 `delta.tool_calls` 增量 → 工具调用可以完整透传;
 *   2. `stop` 参数直接回 400 "Unsupported parameter" → 请求参数必须白名单,不能原样转发;
 *   3. 不认识的模型名会被静默当成 raccoon-090dd3 → 客户端的 claude-* / gpt-* 需显式映射;
 *   4. max_tokens 给到 32000 也接受 → Claude Code 的默认上限不用裁剪。
 *
 * 本文件是纯逻辑(不依赖 fs / http / 全局状态),便于单测,也便于 CLI 与桌面版共用一份。
 */

/** 允许转发给上游的参数白名单(其余一律丢弃,避免像 stop 那样直接 400) */
const UPSTREAM_ALLOWED_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'frequency_penalty',
  'presence_penalty',
  'reasoning_effort',
];

/** 明显不属于本上游的模型名:客户端多半写的是别家的名字,统一映射到默认模型 */
const FOREIGN_MODEL = /^(claude|gpt-|gpt-?\d|chatgpt|o[1345](-|$)|codex|gemini|grok|moonshot|kimi|text-davinci|text-embedding|llama|mistral|qwen|glm|deepseek|ernie|hunyuan)/i;

// ---------------------------------------------------------------- 小工具

function rand(n = 8) {
  return Math.random().toString(36).slice(2, 2 + n);
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${rand(10)}`;
}

/** 极简 SSE 帧编码:同时写 event: 与 data:,两种解析习惯的客户端都能吃 */
function sse(event, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${body}\n\n`;
}

/** 把 Anthropic / Responses 的 content(字符串或块数组)拍平成纯文本 */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (typeof b.text === 'string') return b.text;
      if (typeof b.content === 'string') return b.content;
      return '';
    })
    .join('');
}

/** content 统一成块数组 */
function asBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && typeof b === 'object');
}

/** 工具入参:上游偶发给非法 JSON,不能因此把整轮对话打挂 */
/** custom 工具(自由文本)的入参只认 input 字段,拿不到就退回原始 arguments 文本 */
function customInputFromArgs(raw) {
  const parsed = safeParseObject(raw);
  if (parsed && typeof parsed === 'object' && parsed.input !== undefined) return String(parsed.input);
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw ?? '');
}

function safeParseObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { _raw: raw };
  }
}

function clampNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 模型名映射:本上游只认自己的模型目录,别家的名字一律换默认模型。
 * catalogIds 非空时,命中目录的名字原样保留(便于用户显式选模型)。
 */
function resolveModel(name, defaultModel, catalogIds = []) {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) return defaultModel;
  if (Array.isArray(catalogIds) && catalogIds.includes(raw)) return raw;
  if (FOREIGN_MODEL.test(raw)) return defaultModel;
  // 形如 claude-sonnet-4-5-20250929、gpt-5-codex 之外的未知名字:交给上游自己兜底,
  // 但为了不出现 404,只有明显像本上游目录的才透传
  if (/^(raccoon|sensechat|sensenova|internlm|nova)/i.test(raw)) return raw;
  return defaultModel;
}

/** 请求级扩展不能作为 SDK 关键字参数转发;消息和工具中的同名字段保持原样。 */
function sanitizeChatPayload(payload) {
  const { x_ext: _xExt, ...out } = payload;
  if (out.extra_body && typeof out.extra_body === 'object' && !Array.isArray(out.extra_body)) {
    const { x_ext: _extraExt, ...extraBody } = out.extra_body;
    out.extra_body = extraBody;
  }
  return out;
}

/** 把客户端参数白名单化后塞进 payload */
function applyAllowedParams(target, source) {
  for (const key of UPSTREAM_ALLOWED_PARAMS) {
    if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
  }
  return target;
}

// ---------------------------------------------------------------- Anthropic 请求 → Chat

function anthropicToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return undefined;
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return choice.name ? { type: 'function', function: { name: choice.name } } : 'required';
    default:
      return undefined;
  }
}

/** Anthropic 的 image 块 → OpenAI image_url 部件(vision 关闭时降级为文字占位) */
function anthropicImagePart(block, vision) {
  const src = block.source || {};
  const mediaType = src.media_type || 'image/png';
  if (src.type === 'url' && src.url && vision) return { type: 'image_url', image_url: { url: src.url } };
  if (src.type === 'base64' && src.data && vision) {
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } };
  }
  if (src.type === 'base64' && src.data) {
    // 上游是文本模型,塞 image_url 有把整轮请求打成 400 的风险,默认降级为占位说明
    return { type: 'text', text: `[图片已省略:当前上游不支持视觉输入${mediaType ? ` (${mediaType})` : ''}]` };
  }
  return null;
}

/**
 * Anthropic Messages 请求 → 内部 Chat Completions payload
 * @returns {{payload: object, stream: boolean, model: string}}
 */
function anthropicToChat(body, { defaultModel, catalogIds = [], vision = false } = {}) {
  const messages = [];

  const system = blocksToText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  let toolCounter = 0;
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const blocks = asBlocks(msg.content);

    if (msg.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (block.type === 'text') {
          if (block.text) texts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${toolCounter++}`,
            type: 'function',
            function: { name: block.name || 'unknown', arguments: JSON.stringify(block.input ?? {}) },
          });
        }
        // thinking / redacted_thinking / server_tool_use 丢弃:上游不支持,带上反而 400
      }
      const out = { role: 'assistant', content: texts.join('') };
      if (toolCalls.length) {
        out.tool_calls = toolCalls;
        if (!out.content) out.content = '';
      }
      // 纯 thinking 的 assistant 轮次没有可翻译内容,跳过
      if (out.content || toolCalls.length) messages.push(out);
      continue;
    }

    // user 轮:可能同时夹着 tool_result 与普通文本
    const textParts = [];
    const toolResults = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text) textParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const part = anthropicImagePart(block, vision);
        if (part) textParts.push(part);
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || `call_${toolCounter++}`,
          content: blocksToText(block.content) || (block.is_error ? '(tool error)' : '(no output)'),
        });
      } else if (block.type === 'document') {
        textParts.push({ type: 'text', text: '[文档内容已省略:上游不支持文件输入]' });
      }
    }
    // tool 消息必须紧跟 assistant 的 tool_calls,排在 user 文本之前
    messages.push(...toolResults);
    if (textParts.length) {
      const onlyText = textParts.every((p) => p.type === 'text');
      messages.push({
        role: 'user',
        content: onlyText ? textParts.map((p) => p.text).join('') : textParts,
      });
    }
  }

  const payload = {
    model: resolveModel(body.model, defaultModel, catalogIds),
    messages,
    stream: body.stream === true,
  };
  applyAllowedParams(payload, body);

  // Anthropic 的 max_tokens 是必填,语义与 OpenAI 一致
  if (body.max_tokens != null) payload.max_tokens = clampNumber(body.max_tokens, undefined);
  // stop_sequences 上游不支持(stop → 400),丢弃
  if (payload.stream) payload.stream_options = { include_usage: true };

  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t) => t && typeof t.name === 'string' && (t.input_schema || t.description) && !/^(web_search|computer|bash|text_editor|code_execution)/.test(String(t.type || '')))
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  if (tools.length) {
    payload.tools = tools;
    const choice = anthropicToolChoice(body.tool_choice);
    if (choice !== undefined) payload.tool_choice = choice;
  }

  // thinking(扩展思考)无法映射到上游,直接忽略
  return { payload, stream: payload.stream, model: body.model || defaultModel };
}

// ---------------------------------------------------------------- Chat → Anthropic 响应

function finishToAnthropic(reason, hasToolUse) {
  if (hasToolUse) return 'tool_use';
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

function usageFromChat(json) {
  const u = json?.usage || {};
  const usage = {
    input_tokens: Number(u.prompt_tokens) || 0,
    output_tokens: Number(u.completion_tokens) || 0,
  };
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens;
  if (cached != null) usage.cache_read_input_tokens = Number(cached) || 0;
  return usage;
}

/** Chat Completions 整包 → Anthropic message */
function chatToAnthropic(json, { model, requestModel }) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    const text = blocksToText(msg.content);
    if (text) content.push({ type: 'text', text });
  }

  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: tc.id || uid('toolu'),
      name: tc.function?.name || 'unknown',
      input: safeParseObject(tc.function?.arguments),
    });
  }

  const hasToolUse = content.some((b) => b.type === 'tool_use');
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: uid('msg'),
    type: 'message',
    role: 'assistant',
    model: requestModel || model,
    content,
    stop_reason: finishToAnthropic(choice.finish_reason, hasToolUse),
    stop_sequence: null,
    usage: usageFromChat(json),
  };
}

// ---------------------------------------------------------------- Anthropic 流式

class SseDecoder {
  constructor(onJson, onDone) {
    this.buf = '';
    this.onJson = onJson;
    this.onDone = onDone;
  }

  push(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this._line(line);
    }
  }

  end() {
    if (this.buf.trim()) this._line(this.buf.replace(/\r$/, ''));
    this.buf = '';
    this.onDone();
  }

  _line(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return;
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      this.onDone();
      return;
    }
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    this.onJson(json);
  }
}

/**
 * 把上游 OpenAI SSE 逐帧翻译成 Anthropic 事件流。
 * 文本与工具调用按需开块:文本块永远排在它之前已开启的块之后,工具每个 index 一个块。
 */
function createAnthropicStream({ model, requestModel, write, onFinish }) {
  const messageId = uid('msg');
  let started = false;
  let finished = false;
  let blockIndex = -1;
  let openKind = null; // null | 'text' | 'tool'
  const tools = new Map(); // openai tool index -> { blockIndex, id, name, args, opened }
  let finishReason = 'stop';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let openedAny = false;

  const emit = (event, data) => write(sse(event, data));

  const start = () => {
    if (started) return;
    started = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: requestModel || model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    });
    emit('ping', { type: 'ping' });
  };

  const closeBlock = () => {
    if (!openKind) return;
    emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    openKind = null;
  };

  const openTextBlock = () => {
    start();
    closeBlock();
    blockIndex += 1;
    openedAny = true;
    emit('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });
    openKind = 'text';
  };

  const openToolBlock = (state) => {
    start();
    closeBlock();
    blockIndex += 1;
    openedAny = true;
    state.blockIndex = blockIndex;
    state.opened = true;
    emit('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id: state.id, name: state.name || 'unknown', input: {} },
    });
    openKind = 'tool';
  };

  const flushToolArgs = (state) => {
    if (!state.args) return;
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'input_json_delta', partial_json: state.args },
    });
    state.args = '';
  };

  const onChunk = (json) => {
    if (finished) return;
    if (json.error) {
      fail(json.error.message || JSON.stringify(json.error));
      return;
    }
    if (json.usage) usage = { ...usage, ...usageFromChat(json) };

    const choice = json.choices?.[0];
    if (!choice) return;

    const delta = choice.delta || {};
    // 思考内容(部分模型会给 reasoning_content)不映射到 Anthropic 的 thinking 块,
    // 否则客户端会把它当成正式输出;直接丢弃。
    const textPiece = typeof delta.content === 'string' ? delta.content : '';
    if (textPiece) {
      if (openKind !== 'text') openTextBlock();
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: textPiece },
      });
    }

    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = tc.index ?? 0;
      let state = tools.get(key);
      if (!state) {
        state = { blockIndex: -1, id: tc.id || uid('toolu'), name: '', args: '', opened: false };
        tools.set(key, state);
      }
      if (tc.id && !state.opened) state.id = tc.id;
      const name = tc.function?.name;
      if (name && !state.name) state.name = name;
      const argsPiece = tc.function?.arguments;
      if (typeof argsPiece === 'string' && argsPiece) state.args += argsPiece;

      if (!state.opened) {
        // 名字要先到齐才能开块(Anthropic 的 content_block_start 必须带 name)
        if (state.name) {
          openToolBlock(state);
          flushToolArgs(state);
        }
      } else if (state.args) {
        flushToolArgs(state);
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    start();
    // 名字一直没到的工具(极少见)兜底开块,避免客户端拿到空响应
    for (const state of tools.values()) {
      if (!state.opened) {
        openToolBlock(state);
        flushToolArgs(state);
      }
    }
    closeBlock();
    if (!openedAny) {
      openTextBlock();
      closeBlock();
    }
    const hasToolUse = tools.size > 0;
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: finishToAnthropic(finishReason, hasToolUse), stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    emit('message_stop', { type: 'message_stop' });
    if (typeof onFinish === 'function') onFinish();
  };

  const state = {
    messageId,
    get finished() {
      return finished;
    },
    push(chunk) {
      decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    },
    end() {
      decoder.end();
    },
    fail(message) {
      if (finished) return;
      finished = true;
      start();
      emit('error', { type: 'error', error: { type: 'api_error', message: String(message || 'upstream error') } });
      if (typeof onFinish === 'function') onFinish();
    },
  };

  const decoder = new SseDecoder(onChunk, finish);
  // 立刻发 message_start:Claude Code 等收到这个事件才开始计时,
  // 若等上游首字节才发,长 prompt 的首字延迟会被误判成卡死。
  start();
  return state;
}

/** 由一段完整文本合成 Anthropic 事件流(上游降级成非流式时用) */
function anthropicStreamFromText(text, { model, requestModel, write }) {
  const stream = createAnthropicStream({ model, requestModel, write });
  const chunkSize = 12;
  const json = JSON.parse(text);
  const message = json?.choices?.[0]?.message || {};
  const content = typeof message.content === 'string' ? message.content : '';
  for (let i = 0; i < content.length; i += chunkSize) {
    stream.push(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) } }],
        usage: json?.usage,
      })}\n\n`
    );
  }
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    stream.push(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tc.id, function: { name: tc.function?.name, arguments: tc.function?.arguments } }] } }],
      })}\n\n`
    );
  }
  stream.push(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: json?.choices?.[0]?.finish_reason || 'stop' }] })}\n\n`
  );
  stream.push('data: [DONE]\n\n');
  stream.end();
}

// ---------------------------------------------------------------- Responses 请求 → Chat

/** Responses 的 input 条目 → 内部 messages */
function responsesItemsToMessages(input, { vision = false } = {}) {
  const messages = [];
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  // 连续的工具调用要合并进同一条 assistant 消息(OpenAI 要求 tool_calls 与 tool 结果相邻)
  let assistant = null;
  const flushAssistant = () => {
    if (assistant && (assistant.content || assistant.tool_calls?.length)) messages.push(assistant);
    assistant = null;
  };
  const pushToolCall = (call) => {
    if (!assistant) assistant = { role: 'assistant', content: '', tool_calls: [] };
    assistant.tool_calls.push(call);
  };

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message' || (!item.type && item.role)) {
      flushAssistant();
      const role = item.role === 'developer' ? 'system' : item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
      const parts = [];
      for (const part of asBlocks(item.content)) {
        const type = part.type || '';
        if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text') {
          if (part.text) parts.push({ type: 'text', text: part.text });
        } else if (type === 'refusal') {
          if (part.refusal) parts.push({ type: 'text', text: part.refusal });
        } else if (type === 'input_image') {
          const url = part.image_url || part.url;
          if (url && vision) parts.push({ type: 'image_url', image_url: { url } });
          else parts.push({ type: 'text', text: '[图片已省略:当前上游不支持视觉输入]' });
        } else if (type === 'input_file') {
          parts.push({ type: 'text', text: '[文件内容已省略:上游不支持文件输入]' });
        }
      }
      if (!parts.length) continue;
      const onlyText = parts.every((p) => p.type === 'text');
      messages.push({ role, content: onlyText ? parts.map((p) => p.text).join('') : parts });
      continue;
    }

    if (item.type === 'function_call') {
      pushToolCall({
        id: item.call_id || item.id || uid('call'),
        type: 'function',
        function: { name: item.name || 'unknown', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      });
      continue;
    }

    if (item.type === 'custom_tool_call') {
      // Codex 的 apply_patch 之类自由文本工具:包一层 {input} 复用 function calling
      pushToolCall({
        id: item.call_id || item.id || uid('call'),
        type: 'function',
        function: { name: item.name || 'unknown', arguments: JSON.stringify({ input: item.input ?? '' }) },
      });
      continue;
    }

    if (item.type === 'local_shell_call') {
      pushToolCall({
        id: item.call_id || item.id || uid('call'),
        type: 'function',
        function: { name: item.name || 'shell', arguments: JSON.stringify(item.action ?? {}) },
      });
      continue;
    }

    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output' || item.type === 'local_shell_call_output') {
      flushAssistant();
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id || '', content: output || '(no output)' });
      continue;
    }

    // reasoning / computer_call / web_search_call 等:上游无法表示,跳过
  }
  flushAssistant();
  return messages;
}

/**
 * Responses 请求 → 内部 Chat Completions payload
 * @returns {{payload: object, stream: boolean, model: string, customTools: Set<string>, request: object}}
 */
function responsesToChat(body, { defaultModel, catalogIds = [], vision = false } = {}) {
  const messages = [];
  const instructions = blocksToText(body.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });
  messages.push(...responsesItemsToMessages(body.input, { vision }));

  const payload = {
    model: resolveModel(body.model, defaultModel, catalogIds),
    messages,
    stream: body.stream === true,
  };
  applyAllowedParams(payload, body);
  if (body.max_output_tokens != null) payload.max_tokens = clampNumber(body.max_output_tokens, undefined);
  if (body.reasoning?.effort) payload.reasoning_effort = body.reasoning.effort;
  if (payload.stream) payload.stream_options = { include_usage: true };

  const customTools = new Set();
  const tools = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' && tool.name) {
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      });
      continue;
    }
    if (tool.type === 'custom' && tool.name) {
      // 自由文本工具(Codex apply_patch)伪装成只有一个字符串入参的 function
      customTools.add(tool.name);
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: [tool.description, tool.format?.definition ? `格式要求:\n${tool.format.definition}` : '']
            .filter(Boolean)
            .join('\n\n') || '自由文本输入工具',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string', description: '工具的原始文本输入(整体原样传入)' } },
            required: ['input'],
          },
        },
      });
      continue;
    }
    // local_shell / web_search 之类内置工具:上游没有对应能力,丢弃
  }
  if (tools.length) {
    payload.tools = tools;
    const choice = body.tool_choice;
    if (choice === 'auto' || choice === 'none' || choice === 'required') payload.tool_choice = choice;
    else if (choice && typeof choice === 'object' && choice.name) payload.tool_choice = { type: 'function', function: { name: choice.name } };
    else payload.tool_choice = 'auto';
  }

  return { payload, stream: payload.stream, model: body.model || defaultModel, customTools, request: body };
}

// ---------------------------------------------------------------- Chat → Responses 响应

function chatToResponses(json, { model, request, customTools = new Set() }) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const output = [];

  const text = typeof msg.content === 'string' ? msg.content : blocksToText(msg.content);
  if (text) {
    output.push({
      type: 'message',
      id: uid('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const name = tc.function?.name || 'unknown';
    const rawArgs = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {});
    const callId = tc.id || uid('call');
    if (customTools.has(name)) {
      output.push({
        type: 'custom_tool_call',
        id: uid('ctc'),
        call_id: callId,
        name,
        input: customInputFromArgs(rawArgs),
        status: 'completed',
      });
    } else {
      output.push({
        type: 'function_call',
        id: uid('fc'),
        call_id: callId,
        name,
        arguments: rawArgs || '{}',
        status: 'completed',
      });
    }
  }

  const usageIn = Number(json?.usage?.prompt_tokens) || 0;
  const usageOut = Number(json?.usage?.completion_tokens) || 0;

  return {
    id: uid('resp'),
    object: 'response',
    created_at: Number(json?.created) || Math.floor(Date.now() / 1000),
    status: 'completed',
    background: false,
    error: null,
    incomplete_details: choice.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    instructions: request?.instructions ?? null,
    max_output_tokens: request?.max_output_tokens ?? null,
    model: request?.model || model,
    output,
    output_text: text,
    parallel_tool_calls: request?.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: request?.reasoning ?? { effort: null, summary: null },
    store: false,
    temperature: request?.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: request?.tool_choice ?? 'auto',
    tools: Array.isArray(request?.tools) ? request.tools : [],
    top_p: request?.top_p ?? null,
    truncation: 'disabled',
    usage: {
      input_tokens: usageIn,
      input_tokens_details: { cached_tokens: Number(json?.usage?.prompt_tokens_details?.cached_tokens) || 0 },
      output_tokens: usageOut,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: Number(json?.usage?.total_tokens) || usageIn + usageOut,
    },
  };
}

// ---------------------------------------------------------------- Responses 流式

/**
 * 把上游 OpenAI SSE 翻译成 Responses 事件流。
 * 事件类型与字段顺序对齐官方实现,便于 Codex CLI / openai SDK 直接消费。
 */
function createResponsesStream({ model, request, customTools = new Set(), write, onFinish }) {
  const responseId = uid('resp');
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  let finished = false;
  let started = false;
  let outputIndex = -1;
  let textItem = null; // { id, index, text, closed }
  const tools = new Map(); // openai tool index -> { id, callId, name, args, index, opened, custom }
  let finishReason = 'stop';
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const finalOutput = [];

  const emit = (type, data) => write(sse(type, { type, sequence_number: seq++, ...data }));
  const skeleton = (status) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: request?.instructions ?? null,
    max_output_tokens: request?.max_output_tokens ?? null,
    model: request?.model || model,
    output: [],
    parallel_tool_calls: request?.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: request?.reasoning ?? { effort: null, summary: null },
    store: false,
    temperature: request?.temperature ?? null,
    text: { format: { type: 'text' } },
    tool_choice: request?.tool_choice ?? 'auto',
    tools: Array.isArray(request?.tools) ? request.tools : [],
    top_p: request?.top_p ?? null,
    truncation: 'disabled',
    usage: null,
  });

  const start = () => {
    if (started) return;
    started = true;
    emit('response.created', { response: skeleton('in_progress') });
    emit('response.in_progress', { response: skeleton('in_progress') });
  };

  const openTextItem = () => {
    start();
    outputIndex += 1;
    textItem = { id: uid('msg'), index: outputIndex, text: '', closed: false };
    emit('response.output_item.added', {
      output_index: textItem.index,
      item: { id: textItem.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    emit('response.content_part.added', {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const closeTextItem = () => {
    if (!textItem || textItem.closed) return;
    textItem.closed = true;
    emit('response.output_text.done', {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      text: textItem.text,
    });
    emit('response.content_part.done', {
      item_id: textItem.id,
      output_index: textItem.index,
      content_index: 0,
      part: { type: 'output_text', text: textItem.text, annotations: [] },
    });
    const item = {
      type: 'message',
      id: textItem.id,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textItem.text, annotations: [] }],
    };
    finalOutput.push(item);
    emit('response.output_item.done', { output_index: textItem.index, item });
  };

  const openToolItem = (state) => {
    start();
    outputIndex += 1;
    state.index = outputIndex;
    state.opened = true;
    emit('response.output_item.added', {
      output_index: state.index,
      item: state.custom
        ? { type: 'custom_tool_call', id: state.id, call_id: state.callId, name: state.name, input: '', status: 'in_progress' }
        : { type: 'function_call', id: state.id, call_id: state.callId, name: state.name, arguments: '', status: 'in_progress' },
    });
  };

  const onChunk = (json) => {
    if (finished) return;
    if (json.error) {
      fail(json.error.message || JSON.stringify(json.error));
      return;
    }
    if (json.usage) usage = { ...usage, ...usageFromChat(json), total_tokens: Number(json.usage.total_tokens) || 0 };

    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    const piece = typeof delta.content === 'string' ? delta.content : '';
    if (piece) {
      if (!textItem || textItem.closed) openTextItem();
      textItem.text += piece;
      emit('response.output_text.delta', {
        item_id: textItem.id,
        output_index: textItem.index,
        content_index: 0,
        delta: piece,
        logprobs: [],
      });
    }

    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = tc.index ?? 0;
      let state = tools.get(key);
      if (!state) {
        const name = tc.function?.name || 'unknown';
        state = {
          id: customTools.has(name) ? uid('ctc') : uid('fc'),
          callId: tc.id || uid('call'),
          name,
          args: '',
          index: -1,
          opened: false,
          custom: customTools.has(name),
        };
        tools.set(key, state);
      }
      if (tc.id && !state.opened) state.callId = tc.id;
      if (!state.name || state.name === 'unknown') {
        if (tc.function?.name) state.name = tc.function.name;
      }
      const argsPiece = tc.function?.arguments;
      if (!state.opened) {
        openToolItem(state);
      }
      if (typeof argsPiece === 'string' && argsPiece) {
        state.args += argsPiece;
        if (!state.custom) {
          emit('response.function_call_arguments.delta', {
            item_id: state.id,
            output_index: state.index,
            delta: argsPiece,
          });
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    start();
    closeTextItem();
    for (const state of tools.values()) {
      if (!state.opened) openToolItem(state);
      const item = state.custom
        ? {
            type: 'custom_tool_call',
            id: state.id,
            call_id: state.callId,
            name: state.name,
            input: customInputFromArgs(state.args),
            status: 'completed',
          }
        : {
            type: 'function_call',
            id: state.id,
            call_id: state.callId,
            name: state.name,
            arguments: state.args || '{}',
            status: 'completed',
          };
      if (!state.custom) {
        emit('response.function_call_arguments.done', {
          item_id: state.id,
          output_index: state.index,
          name: state.name,
          arguments: state.args || '{}',
        });
      }
      finalOutput.push(item);
      emit('response.output_item.done', { output_index: state.index, item });
    }
    if (!finalOutput.length) {
      openTextItem();
      closeTextItem();
    }

    const usageIn = usage.input_tokens || 0;
    const usageOut = usage.output_tokens || 0;
    const response = {
      ...skeleton(choiceStatus(finishReason)),
      output: finalOutput,
      output_text: finalOutput
        .filter((i) => i.type === 'message')
        .flatMap((i) => i.content.map((c) => c.text))
        .join(''),
      incomplete_details: finishReason === 'length' ? { reason: 'max_output_tokens' } : null,
      usage: {
        input_tokens: usageIn,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: usageOut,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.total_tokens || usageIn + usageOut,
      },
    };
    emit('response.completed', { response });
    if (typeof onFinish === 'function') onFinish();
  };

  const fail = (message) => {
    if (finished) return;
    finished = true;
    start();
    const response = {
      ...skeleton('failed'),
      output: finalOutput,
      error: { code: 'upstream_error', message: String(message || 'upstream error') },
      incomplete_details: null,
      usage: null,
    };
    emit('response.failed', { response });
    if (typeof onFinish === 'function') onFinish();
  };

  const decoder = new SseDecoder(onChunk, finish);
  // 立刻发 response.created / in_progress,让客户端知道连接已建立
  start();
  return {
    responseId,
    get finished() {
      return finished;
    },
    push(chunk) {
      decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    },
    end() {
      decoder.end();
    },
    fail,
  };
}

function choiceStatus(finishReason) {
  if (finishReason === 'length') return 'incomplete';
  return 'completed';
}

/** 由一段完整文本合成 Responses 事件流(上游降级成非流式时用) */
function responsesStreamFromText(text, { model, request, customTools = new Set(), write }) {
  const stream = createResponsesStream({ model, request, customTools, write });
  const json = JSON.parse(text);
  const message = json?.choices?.[0]?.message || {};
  const content = typeof message.content === 'string' ? message.content : '';
  for (let i = 0; i < content.length; i += 12) {
    stream.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: content.slice(i, i + 12) } }], usage: json?.usage })}\n\n`);
  }
  for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    stream.push(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tc.id, function: { name: tc.function?.name, arguments: tc.function?.arguments } }] } }],
      })}\n\n`
    );
  }
  stream.push(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: json?.choices?.[0]?.finish_reason || 'stop' }] })}\n\n`
  );
  stream.push('data: [DONE]\n\n');
  stream.end();
}

// ---------------------------------------------------------------- 错误形状

const ANTHROPIC_ERROR_TYPE = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  503: 'overloaded_error',
  529: 'overloaded_error',
};

/** 内部错误(OpenAI 形状的 body) → Anthropic 错误响应体 */
function anthropicError(status, rawBody) {
  let message = '';
  let upstreamType = '';
  try {
    const j = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    message = j?.error?.message || j?.message || '';
    upstreamType = j?.error?.type || j?.type || j?.error?.code || '';
  } catch {
    message = String(rawBody || '').slice(0, 500);
  }
  const type = ANTHROPIC_ERROR_TYPE[status] || (status >= 500 ? 'api_error' : 'invalid_request_error');
  return {
    type: 'error',
    error: {
      type,
      message: message || `upstream returned ${status}`,
      ...(upstreamType ? { upstream_type: String(upstreamType) } : {}),
    },
  };
}

/** 内部错误(OpenAI 形状的 body) → Responses 错误响应体 */
function responsesError(status, rawBody) {
  let message = '';
  let code = '';
  try {
    const j = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    message = j?.error?.message || j?.message || '';
    code = j?.error?.code || j?.error?.type || '';
  } catch {
    message = String(rawBody || '').slice(0, 500);
  }
  return {
    error: {
      message: message || `upstream returned ${status}`,
      type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error',
      code: code || `upstream_${status}`,
      param: null,
    },
  };
}

// ---------------------------------------------------------------- token 估算(/v1/messages/count_tokens)

/** 粗估 token:中文按 1 字≈1 token,英文按 4 字符≈1 token,只用于客户端预算判断 */
function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0xac00 && code <= 0xd7af) cjk += 1;
    else if (code >= 0x3040 && code <= 0x30ff) cjk += 1;
  }
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk + rest / 4));
}

function anthropicCountTokens(body) {
  const { payload } = anthropicToChat(body, { defaultModel: body?.model || 'raccoon-090dd3' });
  return { input_tokens: estimateTokens(JSON.stringify(payload.messages)) };
}

module.exports = {
  UPSTREAM_ALLOWED_PARAMS,
  sanitizeChatPayload,
  resolveModel,
  anthropicToChat,
  chatToAnthropic,
  createAnthropicStream,
  anthropicStreamFromText,
  responsesToChat,
  chatToResponses,
  createResponsesStream,
  responsesStreamFromText,
  anthropicError,
  responsesError,
  estimateTokens,
  anthropicCountTokens,
  SseDecoder,
};
