// 积分日期、账单分页与上游限流回归:隔离文件系统和网络,同时验证 CLI 与桌面网关。
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');

process.env.TZ = 'Asia/Shanghai';

function loadProxy(file) {
  const requireFromProxy = createRequire(file);
  const poolModule = requireFromProxy('./pool');
  let clock = Date.parse('2026-11-14T04:00:00Z');
  const account = { id: 'test-account', name: '测试账号', token: 'test-token', tokenExp: Date.now() + 3650 * 86400000, deviceId: 'test-device', enabled: true };
  class TestPool extends poolModule.AccountPool {
    _load() { this.accounts = [account]; }
    _persist() {}
  }
  const server = { listen() {}, on() {}, close() {} };
  let handler;
  const context = vm.createContext({
    require(name) {
      if (name === './pool') return { ...poolModule, AccountPool: TestPool };
      if (name === 'fs') return { readFileSync() { throw new Error('isolated filesystem'); }, writeFileSync() {} };
      if (name === 'http') return { createServer(fn) { handler = fn; return server; } };
      return requireFromProxy(name);
    },
    __dirname: path.dirname(file),
    Buffer, URL, URLSearchParams,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    },
    console: { log() {}, error() {} },
    process: { env: {}, argv: [], on() {}, stdout: { write() {} } },
    setTimeout(fn) { queueMicrotask(fn); },
    setInterval() {},
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const get = (expression) => vm.runInContext(expression, context);
  const set = (name, value) => {
    context.__replacement = value;
    vm.runInContext(`${name} = __replacement`, context);
    delete context.__replacement;
  };
  return { account, context, get, set, handler, advance(ms) { clock += ms; } };
}

function response(status, json, headers = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(json))]);
  stream.statusCode = status;
  stream.headers = { 'content-type': 'application/json', ...headers };
  return stream;
}

async function route(proxy, method, url, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url, headers: {} });
  const result = { headers: {}, status: null, json: null };
  const res = {
    headersSent: false,
    writeHead(status, headers) { this.headersSent = true; result.status = status; result.headers = headers; },
    end(text) { result.json = JSON.parse(text); },
    destroy() { throw new Error('unexpected connection destruction'); },
  };
  await proxy.handler(req, res);
  return result;
}

const files = [path.resolve(__dirname, '../proxy/server.js')];
const cliFile = path.resolve(__dirname, '../../server.js');
// 独立桌面仓库只测内置网关;父目录有CLI源码时一并验证同步结果。
if (fs.existsSync(cliFile) && fs.existsSync(path.join(path.dirname(cliFile), 'pool.js'))) files.unshift(cliFile);
for (const file of files) {
  const name = file.includes(`${path.sep}proxy${path.sep}`) ? 'desktop' : 'CLI';
  test(`${name}: 今日只统计当天的正向每日发放,余额不参与统计`, async () => {
    const proxy = loadProxy(file);
    proxy.set('fetchPoints', async () => ({ available_points: 7668, daily_points: 1312, reward_points: 6356 }));
    proxy.set('fetchBills', async () => ({
      items: [
        { id: 'today', at: '2026-11-13T16:09:46Z', event: '每日积分发放', bizType: 'daily_grant', points: 300 },
        { id: 'yesterday', at: '2026-11-13T12:00:00+08:00', event: '每日积分发放', bizType: 'daily_grant', points: 300 },
        { id: 'reward', at: '2026-11-14T01:00:00+08:00', event: '活动奖励', bizType: 'reward', points: 6000 },
        { id: 'debit', at: '2026-11-14T02:00:00+08:00', event: '每日积分扣回', bizType: 'daily_grant', points: -100 },
      ], hasMore: false, nextCursor: null,
    }));
    const result = await proxy.get('pointsWithTodayGrant')(proxy.account);
    assert.equal(result.daily_points, 1312);
    assert.equal(result.reward_points, 6356);
    assert.equal(result.today_points, 300);
  });

  test(`${name}: 发放记录被100条消耗挤出首页时继续翻页且去重`, async () => {
    const proxy = loadProxy(file);
    let calls = 0;
    const grant = { id: 'grant', at: '2026-11-14T00:09:00+08:00', event: '文案变化', bizType: 'daily_grant', points: 300 };
    proxy.set('fetchBills', async (_account, _limit, cursor) => {
      calls++;
      if (!cursor) return { items: Array.from({ length: 100 }, (_, i) => ({ id: 'chat' + i, at: '2026-11-14T10:00:00+08:00', event: '对话消耗', points: -1 })), hasMore: true, nextCursor: 'page2' };
      return { items: [grant, grant, { id: 'old', at: '2026-11-13T12:00:00+08:00', bizType: 'daily_grant', points: 300 }], hasMore: true, nextCursor: 'page3' };
    });
    const result = await proxy.get('fetchTodayDailyGrant')(proxy.account);
    assert.equal(result.points, 300);
    assert.equal(result.found, true);
    assert.equal(calls, 2);
  });

  test(`${name}: 分页异常不能把不完整统计当成0并缓存`, async () => {
    const proxy = loadProxy(file);
    proxy.set('fetchBills', async () => ({ items: [], hasMore: true, nextCursor: 'loop' }));
    await assert.rejects(proxy.get('fetchTodayDailyGrant')(proxy.account), /分页|完整|cursor/i);
    proxy.set('fetchBills', async () => ({ items: [], hasMore: false, nextCursor: null }));
    const result = await proxy.get('fetchTodayDailyGrant')(proxy.account);
    assert.equal(result.points, 0);
    assert.equal(result.found, false);
  });

  test(`${name}: 并发查询共享当日流水,跨日自动重新计算`, async () => {
    const proxy = loadProxy(file);
    let calls = 0;
    proxy.set('fetchBills', async () => { calls++; return { items: [], hasMore: false, nextCursor: null }; });
    await Promise.all(Array.from({ length: 6 }, () => proxy.get('fetchTodayDailyGrant')(proxy.account)));
    assert.equal(calls, 1);
    proxy.advance(86400000);
    await proxy.get('fetchTodayDailyGrant')(proxy.account);
    assert.equal(calls, 2);
  });

  test(`${name}: 账单故障时当日统计为未知,可用余额仍正常`, async () => {
    const proxy = loadProxy(file);
    proxy.set('fetchPoints', async () => ({ available_points: 500, daily_points: 500 }));
    proxy.set('fetchBills', async () => { throw new Error('HTTP 429'); });
    const result = await proxy.get('pointsWithTodayGrant')(proxy.account);
    assert.equal(result.available_points, 500);
    assert.equal(result.today_points, null);
  });

  test(`${name}: 积分接口429透传Retry-After并阻止立即重复打上游`, async () => {
    const proxy = loadProxy(file);
    let calls = 0;
    proxy.set('request', async () => { calls++; return response(429, { error: { message: 'Too many requests' } }, { 'retry-after': '90' }); });
    const first = await route(proxy, 'GET', '/api/points');
    assert.equal(first.status, 429);
    assert.equal(first.headers['Retry-After'], '90');
    assert.equal(first.json.error.type, 'rate_limit_error');
    await route(proxy, 'GET', '/api/points');
    assert.equal(calls, 1);
  });

  test(`${name}: 并发余额查询只发一次上游请求`, async () => {
    const proxy = loadProxy(file);
    let calls = 0;
    proxy.set('request', async () => { calls++; return response(200, { code: 0, data: { available_points: 100, daily_points: 100 } }); });
    const results = await Promise.all(Array.from({ length: 6 }, () => proxy.get('fetchPoints')(proxy.account)));
    assert.equal(calls, 1);
    assert.ok(results.every(p => p.available_points === 100));
  });

  test(`${name}: 查询账单恢复真实领取状态,手动领取响应也携带当日统计`, async () => {
    const proxy = loadProxy(file);
    proxy.set('request', async (method, endpoint) => {
      assert.equal(method, 'GET');
      if (endpoint.includes('/balance')) return response(200, { code: 0, data: { available_points: 7668, daily_points: 1312, reward_points: 6356 } });
      return response(200, { code: 0, data: { items: [{ bill_id: 'grant', created_at: '2026-11-14T00:09:00+08:00', biz_type: 'daily_grant', event_name: '每日积分发放', points: 300 }], has_more: false } });
    });
    const points = await route(proxy, 'GET', '/api/points');
    assert.equal(points.json.points.today_points, 300);
    assert.equal(points.json.checkin.date, points.json.checkin.today);
    const checkin = await route(proxy, 'POST', '/api/checkin', {});
    assert.equal(checkin.json.already, true);
    assert.equal(checkin.json.points.today_points, 300);
  });

  test(`${name}: 自动和手动领取共享任务,遇到429停止后续领取步骤`, async () => {
    const proxy = loadProxy(file);
    let calls = 0;
    proxy.set('request', async () => { calls++; return response(429, { error: { type: 'rate_limit_error' } }, { 'retry-after': '90' }); });
    const results = await Promise.allSettled([proxy.get('doCheckin')(proxy.account, 'auto'), proxy.get('doCheckin')(proxy.account, 'manual')]);
    assert.equal(calls, 1);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.statusCode === 429));
    const manual = await route(proxy, 'POST', '/api/checkin', {});
    assert.equal(manual.status, 429);
    assert.equal(calls, 1);
  });

  test(`${name}: 对话限流尊重90秒等待,不在当前请求里提前重试`, async () => {
    const proxy = loadProxy(file);
    let calls = 0;
    proxy.set('request', async () => { calls++; return response(429, { error: { code: 'user_model_rate_limited', type: 'rate_limit_error', message: '您的模型请求频率超限，请稍后重试' } }, { 'retry-after': '90' }); });
    const result = await route(proxy, 'POST', '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'test' }] });
    assert.equal(result.status, 429);
    assert.ok(Number(result.headers['Retry-After']) >= 89);
    assert.equal(calls, 1);
  });

  test(`${name}: HTTP200业务限流也应返回429`, async () => {
    const proxy = loadProxy(file);
    proxy.set('request', async () => response(200, { code: 500429, message: '请求过于频繁，请稍后重试' }));
    const result = await route(proxy, 'POST', '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'test' }] });
    assert.equal(result.status, 429);
    assert.equal(result.json.error.type, 'rate_limit_error');
  });
}

test('限流:429中的明确余额不足应归额度,TPM/RPM超限应归限速', () => {
  const { classifyUpstream } = require('../proxy/pool');
  assert.equal(classifyUpstream(429, JSON.stringify({ error: { type: 'insufficient_quota', message: '积分不足' } })).kind, 'quota');
  assert.equal(classifyUpstream(429, JSON.stringify({ error: { message: 'Rate limit exceeded: tokens per minute' } })).kind, 'rate');
  assert.equal(classifyUpstream(400, JSON.stringify({ message: 'Rate limit exceeded' })).kind, 'rate');
});

test('限流:尊重Retry-After且旧请求成功不能提前清除冷却', () => {
  const { AccountPool } = require('../proxy/pool');
  const pool = Object.create(AccountPool.prototype);
  pool.states = new Map();
  pool.log = () => {};
  const account = { id: 'test' };
  const now = Date.now();
  pool.markRateLimited(account, 'rate limit', '90');
  pool.markSuccess(account);
  assert.equal(pool.statusOf(account), 'cooldown');
  assert.ok(pool._state(account.id).cooldownUntil >= now + 90000);
});

test('限流:Retry-After支持HTTP日期', () => {
  const { parseRetryAfter } = require('../proxy/pool');
  const now = Date.parse('2026-11-14T04:00:00Z');
  assert.equal(parseRetryAfter('Sat, 14 Nov 2026 04:01:30 GMT', now), 90000);
  assert.equal(parseRetryAfter('1.5', now), 1500);
  assert.equal(parseRetryAfter('invalid', now), 0);
});

test('额度:次日恢复和余额回升恢复均不永久停用账号', () => {
  const { AccountPool } = require('../proxy/pool');
  const pool = Object.create(AccountPool.prototype);
  Object.assign(pool, { states: new Map(), log() {}, accounts: [], concurrency: 2, lowBalance: 50 });
  const account = { id: 'test', name: 'test', enabled: true, tokenExp: Date.now() + 86400000 };
  pool.accounts.push(account);
  pool.markExhausted(account, '积分不足');
  pool._state(account.id).exhaustedUntil = Date.now() - 1;
  assert.equal(pool.pick(), account);
  pool.markExhausted(account, '积分不足');
  pool.noteBalance(account, { available_points: 300, daily_points: 300 });
  assert.equal(pool.pick(), account);
});
