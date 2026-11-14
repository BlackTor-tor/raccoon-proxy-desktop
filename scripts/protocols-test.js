// 三套协议(/v1/chat/completions、/v1/messages、/v1/responses)的回归测试。
// 上游 https 全量打桩,不消耗真实额度,也不依赖账号。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');

process.env.TZ = 'Asia/Shanghai';

const ROOT = path.resolve(__dirname, '../..');
const CLI_FILE = path.join(ROOT, 'server.js');
const DESKTOP_FILE = path.resolve(__dirname, '../proxy/server.js');
const protocols = require(path.join(ROOT, 'protocols.js'));

// ---------------------------------------------------------------- 测试数据

const CHAT_TEXT_JSON = JSON.stringify({
  id: 'chatcmpl-1',
  created: 1700000000,
  model: 'raccoon-090dd3',
  object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '你好' } }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
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
    URL,
    URLSearchParams,
    Date,
    console: { log() {}, error() {} },
    process: { env, argv: [], on() {}, stdout: { write() {} } },
    setTimeout(fn) {
      queueMicrotask(fn);
    },
    setInterval() {},
  });

  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });

  const send = async ({ method = 'POST', url, body, headers = {} }) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, url, headers });
    const res = makeRes();
    await handler(req, res);
    await res.done;
    return res;
  };

  return { calls, send };
}

function makeRes() {
  const chunks = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const res = {
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
      resolveDone();
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
  };
  return res;
}

const FILES = [
  [CLI_FILE, 'CLI'],
  [DESKTOP_FILE, 'desktop'],
];

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

test('两份 protocols.js 必须保持一致(CLI 与桌面共用一个实现)', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'protocols.js'), 'utf8');
  const desktop = fs.readFileSync(path.resolve(__dirname, '../proxy/protocols.js'), 'utf8');
  assert.equal(cli, desktop, 'desktop/proxy/protocols.js 需要从根目录同步复制');
});

for (const [file, name] of FILES) {
  const jsonRouter = (body) => () => ({ headers: { 'content-type': 'application/json' }, chunks: [body] });
  const sseRouter = (body) => () => ({ headers: { 'content-type': 'text/event-stream; charset=utf-8' }, chunks: [body] });

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
