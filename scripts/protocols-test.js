// 三套协议(/v1/chat/completions、/v1/messages、/v1/responses)的回归测试。
// 上游 https 全量打桩,不消耗真实额度,也不依赖账号。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

process.env.TZ = 'Asia/Shanghai';

const ROOT = path.resolve(__dirname, '../..');
const CLI_FILE = path.join(ROOT, 'server.js');
const DESKTOP_FILE = path.resolve(__dirname, '../proxy/server.js');
const HAS_CLI = ['server.js', 'pool.js', 'protocols.js', 'qr.js'].every((file) => fs.existsSync(path.join(ROOT, file)));
const protocols = require('../proxy/protocols');

// ---------------------------------------------------------------- 测试数据

const CHAT_TEXT_JSON = JSON.stringify({
  id: 'chatcmpl-1',
  created: 1700000000,
  model: 'raccoon-090dd3',
  object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '你好' } }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
});

const XEXT_ERROR = JSON.stringify({
  error: { type: 'InternalServerError', message: "AsyncCompletions.create() got an unexpected keyword argument 'x_ext'" },
});

const CHAT_TOOL_JSON = JSON.stringify({
  id: 'chatcmpl-2',
  created: 1700000000,
  model: 'raccoon-090dd3',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"city":"北京"}' } }],
      },
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
});

function sseFrames(frames) {
  return `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
}

const STREAM_TEXT = sseFrames([
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] },
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '好' } }] },
  { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } },
]);

const STREAM_TOOL = sseFrames([
  {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '' } }],
        },
      },
    ],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 } },
]);

function parseEvents(body) {
  return body
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = (block.match(/^event: (.+)$/m) || [])[1] || null;
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {}
      return { event, data, json };
    });
}

// ---------------------------------------------------------------- 网关加载器(打桩 https)

function makeGateway(file, { router, env = {} } = {}) {
  const requireFromProxy = createRequire(file);
  const poolModule = requireFromProxy('./pool');
  const protocolsModule = requireFromProxy('./protocols');
  let clock = Date.now();
  const account = {
    id: 'test-account',
    name: '测试账号',
    token: 'test-token',
    tokenExp: Date.now() + 3650 * 86400000,
    deviceId: 'test-device',
    enabled: true,
  };
  class TestPool extends poolModule.AccountPool {
    _load() {
      this.accounts = [account];
    }
    _persist() {}
  }

  const server = { listen() {}, on() {}, close() {} };
  const calls = [];
  let handler;

  const toStream = (reply) => {
    if (reply instanceof Readable) return reply;
    const chunks = Array.isArray(reply.chunks) ? reply.chunks : [reply.chunks ?? ''];
    const stream = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))));
    stream.statusCode = reply.status ?? 200;
    stream.headers = reply.headers || {};
    return stream;
  };

  const context = vm.createContext({
    require(name) {
      if (name === './pool') return { ...poolModule, AccountPool: TestPool };
      if (name === './protocols') return protocolsModule;
      if (name === 'fs') return { readFileSync() { throw new Error('isolated filesystem'); }, writeFileSync() {} };
      if (name === 'http') return { createServer(fn) { handler = fn; return server; } };
      if (name === 'https') {
        return {
          request(options, cb) {
            let body = '';
            const req = {
              on() {
                return req;
              },
              write(chunk) {
                body += chunk;
              },
              end() {
                const call = { path: options.path, headers: options.headers, body };
                calls.push(call);
                const reply = router(call);
                setImmediate(() => cb(toStream(reply)));
              },
              destroy() {},
            };
            return req;
          },
        };
      }
      return requireFromProxy(name);
    },
    __dirname: path.dirname(file),
    Buffer,
    AbortController,
    URL,
    URLSearchParams,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    },
    console: { log() {}, error() {} },
    process: { env, argv: [], on() {}, stdout: { write() {} } },
    setTimeout(fn) {
      queueMicrotask(fn);
    },
    setInterval() {},
  });

  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });

  const send = async ({ method = 'POST', url, body, headers = {}, onResponse } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, url, headers });
    const res = makeRes();
    if (onResponse) onResponse(res);
    await handler(req, res);
    await res.done;
    return res;
  };

  return { calls, send, pool: vm.runInContext('pool', context), sdkFailures: vm.runInContext('sdkFailures', context), advance(ms) { clock += ms; } };
}

function makeRes() {
  const chunks = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const res = Object.assign(new EventEmitter(), {
    status: null,
    headers: {},
    headersSent: false,
    body: '',
    done,
    writeHead(status, headers) {
      res.headersSent = true;
      res.status = status;
      res.headers = headers || {};
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) res.write(chunk);
      res.body = chunks.join('');
      resolveDone();
    },
    destroy() {
      res.destroyed = true;
      res.emit('close');
      resolveDone();
    },
  });
  return res;
}

const FILES = [[DESKTOP_FILE, 'desktop']];
// 独立桌面仓库不依赖父目录;有完整 CLI 源码时追加双份回归。
if (HAS_CLI) FILES.unshift([CLI_FILE, 'CLI']);

const ANTHROPIC_TOOLS = [
  {
    name: 'get_time',
    description: '查询某城市当前时间',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

// ---------------------------------------------------------------- 纯逻辑:Anthropic

test('Anthropic→Chat:system/tool_use/tool_result 正确映射,stop_sequences 必须丢弃', () => {
  const { payload } = protocols.anthropicToChat(
    {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      stream: true,
      system: [{ type: 'text', text: '你是助手' }],
      stop_sequences: ['\n\nHuman:'],
      top_p: 0.9,
      tools: ANTHROPIC_TOOLS,
      tool_choice: { type: 'any' },
      messages: [
        { role: 'user', content: '北京几点' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我查一下' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_time', input: { city: '北京' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '12:00' }] }] },
      ],
    },
    { defaultModel: 'raccoon-090dd3' }
  );

  assert.equal(payload.model, 'raccoon-090dd3', 'claude-* 必须映射到上游认识的模型');
  assert.equal(payload.stop, undefined, '上游不支持 stop,带上会直接 400');
  assert.equal(payload.top_p, 0.9);
  assert.equal(payload.max_tokens, 4096);
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal(payload.tool_choice, 'required');
  assert.equal(payload.tools.length, 1);
  assert.equal(payload.tools[0].function.name, 'get_time');
  assert.deepEqual(payload.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(payload.messages[2].tool_calls[0].function.arguments, '{"city":"北京"}');
  assert.equal(payload.messages[3].tool_call_id, 'toolu_1');
  assert.equal(payload.messages[3].content, '12:00');
});

test('Chat原生 image_url:vision 关闭时降级,开启时保持原样', () => {
  const payload = { model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] };
  const stripped = protocols.stripChatImages(payload);
  assert.deepEqual(stripped.messages[0].content, [{ type: 'text', text: '看图' }, { type: 'text', text: '[图片已省略:当前上游不支持视觉输入]' }]);
  assert.equal(payload.messages[0].content[1].type, 'image_url');
});

test('Anthropic→Chat:图片默认降级成占位文字,vision 开启才转发 image_url', () => {
  const body = {
    model: 'claude-x',
    max_tokens: 100,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: '看图' }] }],
  };
  const off = protocols.anthropicToChat(body, { defaultModel: 'raccoon-090dd3' }).payload;
  const offText = JSON.stringify(off.messages[0].content);
  assert.ok(offText.includes('图片已省略'), '默认不能让上游因为 image_url 报 400');
  assert.ok(!offText.includes('image_url'));

  const on = protocols.anthropicToChat(body, { defaultModel: 'raccoon-090dd3', vision: true }).payload;
  assert.ok(Array.isArray(on.messages[0].content));
  assert.equal(on.messages[0].content[0].type, 'image_url');
  assert.ok(on.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,'));
});

test('Chat→Anthropic:tool_calls 变成 tool_use,finish_reason 映射为 tool_use', () => {
  const msg = protocols.chatToAnthropic(JSON.parse(CHAT_TOOL_JSON), { model: 'raccoon-090dd3', requestModel: 'claude-x' });
  assert.equal(msg.type, 'message');
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.model, 'claude-x', '回包模型名要回显客户端请求的名字');
  assert.equal(msg.stop_reason, 'tool_use');
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'tool_use');
  assert.equal(msg.content[0].name, 'get_time');
  assert.deepEqual(msg.content[0].input, { city: '北京' });
  assert.equal(msg.usage.input_tokens, 20);
  assert.equal(msg.usage.output_tokens, 8);
});

test('Anthropic 流式:文本增量和工具调用都翻成合法事件序列', () => {
  const out = [];
  const stream = protocols.createAnthropicStream({ model: 'raccoon-090dd3', requestModel: 'claude-x', write: (s) => out.push(s) });
  stream.push(STREAM_TOOL);
  stream.end();
  const text = out.join('');
  const events = parseEvents(text);

  assert.equal(events[0].event, 'message_start');
  assert.equal(events[events.length - 1].event, 'message_stop');

  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 1, '一个工具只能开一个块,不能重复 content_block_start');
  assert.equal(starts[0].json.content_block.type, 'tool_use');
  assert.equal(starts[0].json.content_block.name, 'get_time');
  assert.equal(starts[0].json.content_block.id, 'call_1');

  const args = events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => e.json.delta.partial_json)
    .join('');
  assert.equal(args, '{"city":"北京"}');

  const stop = events.filter((e) => e.event === 'content_block_stop');
  assert.equal(stop.length, 1);
  const delta = events.find((e) => e.event === 'message_delta');
  assert.equal(delta.json.delta.stop_reason, 'tool_use');
  assert.equal(delta.json.usage.output_tokens, 9);
});

test('Anthropic 流式:纯文本要先开文本块再补 stop', () => {
  const out = [];
  const stream = protocols.createAnthropicStream({ model: 'raccoon-090dd3', requestModel: 'claude-x', write: (s) => out.push(s) });
  stream.push(STREAM_TEXT);
  stream.end();
  const events = parseEvents(out.join(''));
  const textDeltas = events.filter((e) => e.event === 'content_block_delta');
  assert.equal(textDeltas.map((e) => e.json.delta.text).join(''), '你好');
  assert.equal(events.find((e) => e.event === 'message_delta').json.delta.stop_reason, 'end_turn');
});

// ---------------------------------------------------------------- 纯逻辑:Responses

test('Responses→Chat:instructions、function_call 历史与 custom 工具都能翻译', () => {
  const { payload, customTools } = protocols.responsesToChat(
    {
      model: 'gpt-5-codex',
      instructions: '你是编码助手',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '改一下文件' }] },
        { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_9' },
        { type: 'function_call_output', call_id: 'call_9', output: 'a.txt' },
        { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call_10' },
        { type: 'custom_tool_call_output', call_id: 'call_10', output: 'done' },
      ],
      tools: [
        { type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } },
        { type: 'custom', name: 'apply_patch', description: '打补丁' },
        { type: 'web_search' },
      ],
      stream: true,
    },
    { defaultModel: 'raccoon-090dd3' }
  );

  assert.equal(payload.model, 'raccoon-090dd3');
  assert.deepEqual(payload.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
  assert.equal(payload.messages[2].tool_calls[0].function.name, 'shell');
  assert.equal(payload.messages[4].tool_calls[0].function.arguments, '{"input":"*** Begin Patch"}');
  assert.equal(payload.tools.length, 2, 'web_search 这类内置工具必须丢弃');
  assert.ok(customTools.has('apply_patch'));
  const patchTool = payload.tools.find((t) => t.function.name === 'apply_patch');
  assert.deepEqual(patchTool.function.parameters.required, ['input']);
  assert.equal(payload.stream_options.include_usage, true);
});

test('Chat→Responses:工具调用按是否 custom 输出不同 item 类型', () => {
  const json = JSON.parse(CHAT_TOOL_JSON);
  const resp = protocols.chatToResponses(json, {
    model: 'raccoon-090dd3',
    request: { model: 'gpt-5-codex' },
    customTools: new Set(['get_time']),
  });
  assert.equal(resp.object, 'response');
  assert.equal(resp.status, 'completed');
  assert.equal(resp.model, 'gpt-5-codex');
  assert.equal(resp.output.length, 1);
  assert.equal(resp.output[0].type, 'custom_tool_call');
  assert.equal(resp.output[0].input, '{"city":"北京"}');
  assert.equal(resp.usage.total_tokens, 28);

  const normal = protocols.chatToResponses(json, { model: 'raccoon-090dd3', request: { model: 'gpt-5-codex' } });
  assert.equal(normal.output[0].type, 'function_call');
  assert.equal(normal.output[0].arguments, '{"city":"北京"}');
});

test('Responses 流式:事件序列完整,response.completed 带 usage 与工具 item', () => {
  const out = [];
  const stream = protocols.createResponsesStream({ model: 'raccoon-090dd3', request: { model: 'gpt-5-codex' }, write: (s) => out.push(s) });
  stream.push(STREAM_TOOL);
  stream.end();
  const events = parseEvents(out.join(''));
  const names = events.map((e) => e.event);

  assert.equal(names[0], 'response.created');
  assert.ok(names.includes('response.output_item.added'));
  assert.ok(names.includes('response.function_call_arguments.delta'));
  assert.equal(names[names.length - 1], 'response.completed');

  const seqs = events.map((e) => e.json.sequence_number);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'sequence_number 必须连续递增');

  const completed = events.find((e) => e.event === 'response.completed').json.response;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.usage.output_tokens, 9);
  assert.equal(completed.usage.input_tokens, 30);
  assert.equal(completed.output[0].type, 'function_call');
  assert.equal(completed.output[0].name, 'get_time');
  assert.equal(completed.output[0].arguments, '{"city":"北京"}');

  // 客户端普遍会读 output_text 便捷字段
  const textEvents = [
    { choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] },
  ];
  const out2 = [];
  const stream2 = protocols.createResponsesStream({ model: 'raccoon-090dd3', request: {}, write: (s) => out2.push(s) });
  stream2.push(sseFrames(textEvents));
  stream2.end();
  const done2 = parseEvents(out2.join('')).find((e) => e.event === 'response.completed').json.response;
  assert.equal(done2.output_text, 'OK');
  assert.equal(done2.output[0].content[0].type, 'output_text');
});

test('错误形状:429 在 Anthropic 侧是 rate_limit_error', () => {
  const err = protocols.anthropicError(429, JSON.stringify({ error: { message: '账号冷却中', type: 'rate_limit_error' } }));
  assert.equal(err.type, 'error');
  assert.equal(err.error.type, 'rate_limit_error');
  assert.equal(err.error.message, '账号冷却中');

  assert.equal(protocols.anthropicError(503, 'oops').error.type, 'overloaded_error');
  assert.equal(protocols.responsesError(429, JSON.stringify({ error: { message: '限速' } })).error.type, 'rate_limit_error');
});

test('count_tokens:给出正数估算', () => {
  const r = protocols.anthropicCountTokens({ model: 'claude-x', messages: [{ role: 'user', content: '你好,帮我看看这个函数' }] });
  assert.ok(r.input_tokens > 0);
});

// ---------------------------------------------------------------- 网关端到端

test('两份 protocols.js 必须保持一致(CLI 与桌面共用一个实现)', { skip: HAS_CLI ? false : '独立桌面仓库无 CLI 源码' }, () => {
  const cli = fs.readFileSync(path.join(ROOT, 'protocols.js'), 'utf8');
  const desktop = fs.readFileSync(path.resolve(__dirname, '../proxy/protocols.js'), 'utf8');
  assert.equal(cli, desktop, 'desktop/proxy/protocols.js 需要从根目录同步复制');
});

for (const [file, name] of FILES) {
  const jsonRouter = (body) => () => ({ headers: { 'content-type': 'application/json' }, chunks: [body] });
  const sseRouter = (body) => () => ({ headers: { 'content-type': 'text/event-stream; charset=utf-8' }, chunks: [body] });

  test(`${name}: 清除请求级x_ext但保留消息和工具中的同名数据`, async () => {
    const payload = {
      model: 'sn-kimi-k3',
      messages: [{ role: 'user', content: '{"x_ext":"这是用户内容"}' }],
      tools: [{ type: 'function', function: { name: 'read_ext', parameters: { type: 'object', properties: { x_ext: { type: 'string' } } } } }],
      tool_choice: 'auto',
      temperature: 0.2,
      x_ext: { tracing: true },
      extra_body: { x_ext: { tracing: true }, reasoning_effort: 'low' },
    };
    const gw = makeGateway(file, {
      router(call) {
        const upstream = JSON.parse(call.body);
        const unsafe = Object.hasOwn(upstream, 'x_ext') || Object.hasOwn(upstream.extra_body || {}, 'x_ext');
        return { status: unsafe ? 500 : 200, headers: { 'content-type': 'application/json' }, chunks: [unsafe ? XEXT_ERROR : CHAT_TEXT_JSON] };
      },
    });
    const res = await gw.send({ url: '/v1/chat/completions', body: payload });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).choices[0].message.content, '你好');
    assert.equal(gw.calls.length, 1);
    const upstream = JSON.parse(gw.calls[0].body);
    assert.equal(Object.hasOwn(upstream, 'x_ext'), false);
    assert.equal(Object.hasOwn(upstream.extra_body, 'x_ext'), false);
    assert.equal(upstream.extra_body.reasoning_effort, 'low');
    assert.equal(upstream.model, 'sn-kimi-k3');
    assert.equal(upstream.messages[0].content, '{"x_ext":"这是用户内容"}');
    assert.deepEqual(upstream.tools[0].function.parameters.properties, { x_ext: { type: 'string' } });
    assert.equal(upstream.tool_choice, 'auto');
    assert.equal(upstream.temperature, 0.2);
    assert.equal(payload.x_ext.tracing, true);
  });

  test(`${name}: v1降级请求也不会携带客户端x_ext`, async () => {
    const gw = makeGateway(file, {
      router(call) {
        if (call.path.includes('/v2/')) return { status: 429, headers: { 'content-type': 'application/json' }, chunks: ['{"error":{"type":"rate_limit_error"}}'] };
        const upstream = JSON.parse(call.body);
        const unsafe = Object.hasOwn(upstream, 'x_ext');
        return { status: unsafe ? 500 : 200, headers: { 'content-type': 'application/json' }, chunks: [unsafe ? XEXT_ERROR : CHAT_TEXT_JSON] };
      },
    });
    const res = await gw.send({
      url: '/v1/chat/completions',
      body: { model: 'sn-kimi-k3', x_ext: { tracing: true }, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['X-Raccoon-Model-Fallback'], 'raccoon-090dd3');
    assert.equal(gw.calls.length, 2);
    const upstream = JSON.parse(gw.calls[1].body);
    assert.equal(Object.hasOwn(upstream, 'x_ext'), false);
    assert.equal(upstream.model, 'raccoon-090dd3');
    assert.equal(upstream.stream, false);
  });

  for (const [url, body] of [
    ['/v1/chat/completions', { model: 'sn-kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/messages', { model: 'claude-x', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/responses', { model: 'gpt-5-codex', stream: true, input: 'hi' }],
  ]) {
    test(`${name}: ${url}遇x_ext兼容错误直接切通道且流式响应完整`, async () => {
      const gw = makeGateway(file, {
        router(call) {
          return { status: call.path.includes('/v2/') ? 500 : 200, headers: { 'content-type': 'application/json' }, chunks: [call.path.includes('/v2/') ? XEXT_ERROR : CHAT_TEXT_JSON] };
        },
      });
      const res = await gw.send({ url, body });
      assert.equal(res.status, 200);
      assert.equal(res.headers['X-Raccoon-Sse-Replay'], '1');
      assert.deepEqual(gw.calls.map((call) => call.path), ['/api/web/llm/v2/chat/completions', '/api/web/llm/v1/chat/completions']);
      const events = parseEvents(res.body);
      if (url === '/v1/chat/completions') {
        assert.equal(events.filter((e) => e.json?.choices?.[0]?.delta?.content).map((e) => e.json.choices[0].delta.content).join(''), '你好');
        assert.equal(events.at(-1).data, '[DONE]');
        assert.equal(res.headers['X-Raccoon-Model-Fallback'], 'raccoon-090dd3');
      } else if (url === '/v1/messages') {
        assert.equal(events.at(-1).event, 'message_stop');
        assert.equal(events.filter((e) => e.event === 'content_block_delta').map((e) => e.json.delta.text).join(''), '你好');
      } else {
        assert.equal(events.at(-1).event, 'response.completed');
        assert.equal(events.at(-1).json.response.output_text, '你好');
      }
      assert.equal(gw.pool.accounts[0].enabled, true);
      assert.equal(gw.pool.statusOf(gw.pool.accounts[0]), 'active');
      assert.equal(gw.pool.list()[0].inFlight, 0);
    });
  }

  test(`${name}: 持续x_ext错误不原地重试且不误报无可用账号`, async () => {
    const gw = makeGateway(file, {
      env: { XHX_XEXT_RETRIES: '12' },
      router: () => ({ status: 500, headers: { 'content-type': 'application/json' }, chunks: [XEXT_ERROR] }),
    });
    const res = await gw.send({ url: '/v1/chat/completions', body: { model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(res.status, 502);
    const error = JSON.parse(res.body).error;
    assert.equal(error.code, 'upstream_sdk_incompatible');
    assert.equal(error.type, 'upstream_compatibility_error');
    assert.equal(error.retryable, false);
    assert.match(error.message, /x_ext/);
    assert.doesNotMatch(error.message, /无可用账号|扫码|积分不足|限速/);
    assert.deepEqual(gw.calls.map((call) => call.path), ['/api/web/llm/v2/chat/completions', '/api/web/llm/v1/chat/completions']);
    assert.equal(gw.pool.accounts[0].enabled, true);
    assert.equal(gw.pool.statusOf(gw.pool.accounts[0]), 'active');
    assert.equal(gw.pool.list()[0].inFlight, 0);
  });

  test(`${name}: x_ext首帧SSE错误在发给客户端前处理`, async () => {
    const gw = makeGateway(file, {
      router(call) {
        if (call.path.includes('/v2/')) return { headers: { 'content-type': 'text/event-stream' }, chunks: [': ping\r\n\r\ndata: {"err', `${XEXT_ERROR.slice(5)}\r\n\r\ndata: [DONE]\r\n\r\n`] };
        return { headers: { 'content-type': 'application/json' }, chunks: [CHAT_TEXT_JSON] };
      },
    });
    const res = await gw.send({ url: '/v1/messages', body: { model: 'claude-x', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
    const events = parseEvents(res.body);
    assert.equal(events.at(-1).event, 'message_stop');
    assert.equal(events.filter((e) => e.event === 'content_block_delta').map((e) => e.json.delta.text).join(''), '你好');
    assert.equal(events.some((e) => e.event === 'error'), false);
    assert.equal(res.headers['X-Raccoon-Sse-Replay'], '1');
    assert.equal(gw.calls.length, 2);
  });

  test(`${name}: 兼容故障按模型隔离,短期跳过坏通道并在到期后再探测`, async () => {
    const gw = makeGateway(file, {
      router(call) {
        const model = JSON.parse(call.body).model;
        if (call.path.includes('/v2/') && model === 'sn-kimi-k3') return { status: 500, headers: { 'content-type': 'application/json' }, chunks: [XEXT_ERROR] };
        return { headers: { 'content-type': 'application/json' }, chunks: [CHAT_TEXT_JSON] };
      },
    });
    const send = (model) => gw.send({ url: '/v1/chat/completions', body: { model, messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal((await send('sn-kimi-k3')).status, 200);
    assert.equal((await send('sn-kimi-k3')).status, 200);
    assert.equal((await send('SenseChat-5')).status, 200);
    gw.advance(10 * 60 * 1000);
    assert.equal((await send('sn-kimi-k3')).status, 200);
    assert.deepEqual(gw.calls.map((call) => call.path), [
      '/api/web/llm/v2/chat/completions', '/api/web/llm/v1/chat/completions',
      '/api/web/llm/v1/chat/completions', '/api/web/llm/v2/chat/completions',
      '/api/web/llm/v2/chat/completions', '/api/web/llm/v1/chat/completions',
    ]);
    assert.equal(gw.pool.statusOf(gw.pool.accounts[0]), 'active');
    assert.equal(gw.pool.list()[0].inFlight, 0);
  });

  for (const sdkChannel of ['v1', 'v2']) {
    test(`${name}: SDK故障与限流并存时保留可恢复的429(${sdkChannel})`, async () => {
      const gw = makeGateway(file, {
        router(call) {
          const sdk = call.path.includes(`/${sdkChannel}/`);
          return { status: sdk ? 500 : 429, headers: { 'content-type': 'application/json' }, chunks: [sdk ? XEXT_ERROR : '{"error":{"type":"rate_limit_error","message":"Too many requests"}}'] };
        },
      });
      const res = await gw.send({ url: '/v1/chat/completions', body: { model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] } });
      assert.equal(res.status, 429);
      assert.equal(JSON.parse(res.body).error.type, 'rate_limit_error');
      assert.ok(Number(res.headers['Retry-After']) > 0);
      assert.equal(gw.pool.statusOf(gw.pool.accounts[0]), 'cooldown');
      assert.equal(gw.pool.list()[0].inFlight, 0);
      assert.equal(gw.calls.length, 2);
    });
  }

  test(`${name}: 过期SDK隔离不影响其他模型且内存记录被回收`, async () => {
    const gw = makeGateway(file, { router: () => ({ status: 500, headers: { 'content-type': 'application/json' }, chunks: [XEXT_ERROR] }) });
    for (let i = 0; i < 4; i++) {
      await gw.send({ url: '/v1/chat/completions', body: { model: `test-model-${i}`, messages: [{ role: 'user', content: 'hi' }] } });
    }
    assert.equal(gw.sdkFailures.size, 5);
    gw.advance(120000);
    await gw.send({ url: '/v1/chat/completions', body: { model: 'new-model', messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(gw.sdkFailures.size, 2);
  });

  for (const chunks of [[], [': ping\n\n'], ['data: [DONE]']]) {
    test(`${name}: 空或仅心跳SSE会完成响应并释放并发槽(${JSON.stringify(chunks)})`, async () => {
      const gw = makeGateway(file, { router: () => ({ headers: { 'content-type': 'text/event-stream' }, chunks }) });
      const timeout = Symbol('timeout');
      const result = await Promise.race([
        gw.send({ url: '/v1/chat/completions', body: { model: 'sn-kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] } }),
        new Promise((resolve) => setTimeout(() => resolve(timeout), 100)),
      ]);
      assert.notEqual(result, timeout, '上游结束后本地响应不能永远挂起');
      assert.equal(result.body, chunks.join(''));
      assert.equal(gw.pool.list()[0].inFlight, 0);
      assert.equal(gw.calls.length, 1);
    });
  }

  test(`${name}: 等首帧期间客户端断开会销毁上游并释放并发槽`, async () => {
    const upstream = new Readable({ read() {} });
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'text/event-stream' };
    let resolveAttached;
    const attached = new Promise((resolve) => { resolveAttached = resolve; });
    const on = upstream.on.bind(upstream);
    upstream.on = (event, fn) => {
      const result = on(event, fn);
      if (event === 'data') resolveAttached();
      return result;
    };
    const gw = makeGateway(file, { router: () => upstream });
    let res;
    const sending = gw.send({
      url: '/v1/chat/completions',
      body: { model: 'sn-kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      onResponse(value) { res = value; },
    });
    await attached;
    res.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstream.destroyed, true);
    assert.equal(gw.pool.list()[0].inFlight, 0);
    assert.equal(res.headersSent, false);
    const timeout = Symbol('timeout');
    assert.notEqual(await Promise.race([sending, new Promise((resolve) => setTimeout(() => resolve(timeout), 100))]), timeout);
    assert.equal(gw.calls.length, 1);
  });

  test(`${name}: 已建立并输出的SSE不会被重放或切通道`, async () => {
    const gw = makeGateway(file, { router: sseRouter(STREAM_TEXT) });
    const res = await gw.send({ url: '/v1/chat/completions', body: { model: 'sn-kimi-k3', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(res.body, STREAM_TEXT);
    assert.equal(gw.calls.length, 1);
  });

  test(`${name}: 普通临时500仍能小退避恢复`, async () => {
    let failures = 0;
    const gw = makeGateway(file, {
      router() {
        if (failures++ === 0) return { status: 500, headers: { 'content-type': 'application/json' }, chunks: ['{"error":{"message":"temporary backend failure"}}'] };
        return { headers: { 'content-type': 'application/json' }, chunks: [CHAT_TEXT_JSON] };
      },
    });
    const res = await gw.send({ url: '/v1/chat/completions', body: { model: 'sn-kimi-k3', messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(res.status, 200);
    assert.deepEqual(gw.calls.map((call) => call.path), ['/api/web/llm/v2/chat/completions', '/api/web/llm/v2/chat/completions']);
  });

  test(`${name}: /v1/chat/completions 仍按 OpenAI 形状透传`, async () => {
    const gw = makeGateway(file, { router: jsonRouter(CHAT_TEXT_JSON) });
    const res = await gw.send({ url: '/v1/chat/completions', body: { model: 'raccoon-090dd3', messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).choices[0].message.content, '你好');
    assert.equal(gw.calls.length, 1);
    assert.equal(gw.calls[0].path, '/api/web/llm/v2/chat/completions');
  });

  test(`${name}: /v1/messages 非流式:请求被翻译,回包是 Anthropic message`, async () => {
    const gw = makeGateway(file, { router: jsonRouter(CHAT_TOOL_JSON) });
    const res = await gw.send({
      url: '/v1/messages',
      headers: { 'x-api-key': 'any' },
      body: {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        stream: false,
        stop_sequences: ['STOP'],
        tools: ANTHROPIC_TOOLS,
        messages: [{ role: 'user', content: '北京几点' }],
      },
    });

    assert.equal(res.status, 200);
    const upstream = JSON.parse(gw.calls[0].body);
    assert.equal(upstream.model, 'raccoon-090dd3');
    assert.equal(upstream.stop, undefined);
    assert.equal(upstream.tools.length, 1);
    assert.equal(upstream.messages.at(-1).content, '北京几点');

    const out = JSON.parse(res.body);
    assert.equal(out.type, 'message');
    assert.equal(out.role, 'assistant');
    assert.equal(out.stop_reason, 'tool_use');
    assert.equal(out.content[0].type, 'tool_use');
    assert.equal(out.content[0].name, 'get_time');
    assert.deepEqual(out.content[0].input, { city: '北京' });
    assert.equal(out.usage.input_tokens, 20);
  });

  test(`${name}: /v1/messages 流式:上游 SSE 被翻成 Anthropic 事件流`, async () => {
    const gw = makeGateway(file, { router: sseRouter(STREAM_TEXT) });
    const res = await gw.send({
      url: '/v1/messages',
      body: { model: 'claude-x', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /event-stream/);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'message_start');
    assert.equal(events[events.length - 1].event, 'message_stop');
    assert.equal(
      events.filter((e) => e.event === 'content_block_delta').map((e) => e.json.delta.text).join(''),
      '你好'
    );
    assert.equal(events.find((e) => e.event === 'message_delta').json.delta.stop_reason, 'end_turn');
  });

  test(`${name}: /v1/responses 流式:工具调用走 Responses 事件`, async () => {
    const gw = makeGateway(file, { router: sseRouter(STREAM_TOOL) });
    const res = await gw.send({
      url: '/v1/responses',
      body: {
        model: 'gpt-5-codex',
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '北京几点' }] }],
        tools: [{ type: 'function', name: 'get_time', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      },
    });

    assert.equal(res.status, 200);
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'response.created');
    assert.equal(events[events.length - 1].event, 'response.completed');
    const completed = events.find((e) => e.event === 'response.completed').json.response;
    assert.equal(completed.output[0].type, 'function_call');
    assert.equal(completed.usage.output_tokens, 9);

    const upstream = JSON.parse(gw.calls[0].body);
    assert.equal(upstream.model, 'raccoon-090dd3', 'gpt-5-codex 必须映射到上游模型');
    assert.equal(upstream.messages[0].content, '北京几点');
  });

  test(`${name}: /v1/responses 非流式回包形状完整`, async () => {
    const gw = makeGateway(file, { router: jsonRouter(CHAT_TEXT_JSON) });
    const res = await gw.send({ url: '/v1/responses', body: { model: 'gpt-5-codex', input: 'hi' } });
    assert.equal(res.status, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.object, 'response');
    assert.equal(out.status, 'completed');
    assert.equal(out.output[0].type, 'message');
    assert.equal(out.output[0].content[0].text, '你好');
    assert.equal(out.output_text, '你好');
  });

  test(`${name}: /v1/messages/count_tokens 返回估算值`, async () => {
    const gw = makeGateway(file, { router: jsonRouter(CHAT_TEXT_JSON) });
    const res = await gw.send({ url: '/v1/messages/count_tokens', body: { model: 'claude-x', messages: [{ role: 'user', content: '你好' }] } });
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.body).input_tokens > 0);
    assert.equal(gw.calls.length, 0, 'count_tokens 不该打上游');
  });

  test(`${name}: 设置了 PROXY_API_KEY 时 x-api-key 也能通过鉴权`, async () => {
    const gw = makeGateway(file, { router: jsonRouter(CHAT_TEXT_JSON), env: { PROXY_API_KEY: 'sk-test' } });

    const denied = await gw.send({ url: '/v1/chat/completions', headers: { 'x-api-key': 'wrong' }, body: { model: 'raccoon-090dd3', messages: [] } });
    assert.equal(denied.status, 401);

    const anthropicOk = await gw.send({
      url: '/v1/messages',
      headers: { 'x-api-key': 'sk-test' },
      body: { model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(anthropicOk.status, 200);

    const bearerOk = await gw.send({
      url: '/v1/responses',
      headers: { authorization: 'Bearer sk-test' },
      body: { model: 'gpt-5-codex', input: 'hi' },
    });
    assert.equal(bearerOk.status, 200);
  });

  test(`${name}: 上游降级成整包时,流式客户端仍能拿到合成的事件流`, async () => {
    // 模拟 v1 通道:非流式回包,但客户端要 stream:true
    const gw = makeGateway(file, { router: jsonRouter(CHAT_TEXT_JSON) });
    const res = await gw.send({
      url: '/v1/messages',
      body: { model: 'claude-x', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['X-Raccoon-Sse-Replay'], '1');
    const events = parseEvents(res.body);
    assert.equal(events[0].event, 'message_start');
    assert.equal(events[events.length - 1].event, 'message_stop');
    assert.equal(
      events.filter((e) => e.event === 'content_block_delta').map((e) => e.json.delta.text).join(''),
      '你好'
    );
  });
}
