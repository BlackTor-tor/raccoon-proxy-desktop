#!/usr/bin/env node
/**
 * RaccoonProxy 网关服务进程 — 账号池版
 *
 * 本地 OpenAI 兼容 API 网关:账号池调度(最少并发+故障换号)、维护 token、透传 /v1/chat/completions(支持 SSE 流式)。
 * 由 Electron 主进程以子进程方式启动,也可独立运行:
 *   node proxy/server.js
 *   PORT=9000 node proxy/server.js
 *   PROXY_API_KEY=sk-local-xxx node proxy/server.js   # 给本地端口加一道鉴权(可选)
 *
 * 账号来源:官方登录页微信扫码授权,token 存 accounts.json(不保存密码、不手工粘 token)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { AccountPool, classifyUpstream, parseRetryAfter, jwtExp } = require('./pool');
const qrCodec = require('./qr');

const UPSTREAM_HOST = 'xiaohuanxiong.com';
const CONFIRM_URL_PATH = '/api/web/auth/v1/iam/confirm';
/**
 * 模型对话通道。两条通道是不同后端、不同限流桶:
 *  - v2 按「用户」维度限流(user_model_rate_limited),窗口 6 发 + 冷却 >15 分钟
 *  - v1 独立桶,但服务端会注入 x_ext,部分旧实例报 500,换实例重试即可通过
 * 撞 v2 限流时先在同号内降级到 v1,再考虑换号。
 *
 * 实测: v1 只有默认模型 raccoon-090dd3 能通(约 47%),其余模型在 v1 上稳定 500,
 * 所以 v1 通道只对 V1_MODELS 里的模型开放。
 */
const CHAT_CHANNELS = [
  { id: 'v2', path: '/api/web/llm/v2/chat/completions', platform: 'web', version: '156.0.0.0' },
  { id: 'v1', path: '/api/web/llm/v1/chat/completions', platform: 'desktop-windows', version: '1.1.5' },
];
const V1_MODELS = new Set(['raccoon-090dd3']);
const DEFAULT_MODEL = 'raccoon-090dd3'; // 降级改写的目标模型,也是 v1 唯一能通的模型
const CATALOG_URL_PATH = '/api/web/llm/v2/model_catalog';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const POINTS_URL_PATH = '/api/web/points/v1/balance';
const BILLS_URL_PATH = '/api/web/points/v2/bills';
const DEVICE_BIND_PATH = '/api/web/auth/v1/devices_current_bind';
const DEVICE_HEARTBEAT_PATH = '/api/web/auth/v1/devices_current_heartbeat';
const SETTING_INFO_PATH = '/api/web/office/v3/setting_info'; // 官方网页聚焦时调用,服务端在此补发每日积分
const CHECKIN_FILE = process.env.XHX_CHECKIN_FILE || path.join(__dirname, '.checkin.json');
const CHECKIN_INTERVAL_MS = 30 * 60 * 1000; // 未到账时每 30 分钟重试,成功后当天不再请求
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 设备心跳保持在线
const BALANCE_REFRESH_MS = 5 * 60 * 1000; // 账号额度刷新
const CLIENT_PLATFORM = process.env.XHX_CLIENT_PLATFORM || 'desktop-windows';
const CLIENT_VERSION = process.env.XHX_CLIENT_VERSION || '1.1.5';
// 网页端(每日积分按 web 会话发放)使用的标识
const WEB_PLATFORM = 'web';
const WEB_VERSION = '156.0.0.0';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// 凭证不落盘、不来自配置:账号一律通过微信扫码授权获得
const PORT = Number(process.env.PORT || 8317);
const HOST = process.env.HOST || '127.0.0.1';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const MAX_CHAT_ATTEMPTS = Math.max(2, Number(process.env.XHX_MAX_ATTEMPTS) || 4); // 一次请求最多换几个号
const MAX_XEXT_RETRIES = Math.max(1, Number(process.env.XHX_XEXT_RETRIES) || 12); // v1 通道 x_ext 500 的原地重试上限
const COOLDOWN_WAIT_MS = Number(process.env.XHX_COOLDOWN_WAIT_MS) || 25 * 1000; // 全池冷却时最多等多久再重试
const SLOT_WAIT_MS = Number(process.env.XHX_SLOT_WAIT_MS) || 60 * 1000; // 并发槽位满时最多排队等多久

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function request(method, urlPath, { body, token, headers: extraHeaders, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/event-stream, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: `https://${UPSTREAM_HOST}`,
      Referer: `https://${UPSTREAM_HOST}/login`,
      ...extraHeaders,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.request(
      { hostname: UPSTREAM_HOST, path: urlPath, method, headers, timeout: timeoutMs },
      (res) => resolve(res)
    );
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function readJsonBody(res, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        res.destroy();
        return reject(new Error('response too large'));
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

function isFiniteNum(v) {
  return Number.isFinite(v);
}

function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function webHeaders(deviceId) {
  return { 'X-Client-Platform': WEB_PLATFORM, 'X-Client-Version': WEB_VERSION, 'X-Client-Device-ID': deviceId, 'X-Request-Id': crypto.randomUUID() };
}

function deviceOsName() {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
}

// ---- 账号池 ----
const pool = new AccountPool({
  request,
  readJsonBody,
  log,
  concurrency: Number(process.env.XHX_ACCOUNT_CONCURRENCY) || 2,
  lowBalance: Number(process.env.XHX_LOW_BALANCE) || 50,
});

// ---- 每日积分与可信设备(按账号独立) ----
// 数据形如 { byAccount: { [accountId]: { date, lastResult } } },兼容旧的单账号格式
let checkinState = { byAccount: {} };
try {
  const j = JSON.parse(fs.readFileSync(CHECKIN_FILE, 'utf8'));
  if (j && j.byAccount && typeof j.byAccount === 'object') checkinState.byAccount = j.byAccount;
  else if (j && typeof j.date === 'string') checkinState.legacy = { date: j.date, lastResult: j.lastResult || '' };
} catch {}

function saveCheckinState() {
  try {
    fs.writeFileSync(CHECKIN_FILE, JSON.stringify({ ...checkinState, at: new Date().toISOString() }), 'utf8');
  } catch {}
}

function checkinOf(account) {
  if (!checkinState.byAccount[account.id]) checkinState.byAccount[account.id] = { date: null, lastResult: '' };
  return checkinState.byAccount[account.id];
}

// 旧格式(全局单账号)迁移给 1 号账号
if (checkinState.legacy && pool.accounts[0]) {
  checkinState.byAccount[pool.accounts[0].id] = { ...checkinState.legacy };
  delete checkinState.legacy;
  saveCheckinState();
}

// 把账号会话绑定为「网页可信设备」(设备标识按账号独立)
async function bindWebDevice(account, token, deviceId = account.deviceId) {
  const body = JSON.stringify({
    application: 'web',
    client_device_id: deviceId,
    client_device_id_source: deviceId,
    client_platform: WEB_PLATFORM,
    client_version: WEB_VERSION,
    device_name: 'Chrome',
    os: deviceOsName(),
    os_version: '10',
    push_permission: 'granted',
  });
  const res = await request('POST', DEVICE_BIND_PATH, { body, token, headers: webHeaders(deviceId), timeoutMs: 20000 });
  const text = await readJsonBody(res);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (res.statusCode !== 200 || (json && json.code !== 0)) throw new Error(`web trusted device bind HTTP ${res.statusCode}: ${text.slice(0, 160)}`);
  return (json && json.data) || {};
}

async function sendWebHeartbeat(token, serverDeviceId, deviceId) {
  const res = await request('POST', DEVICE_HEARTBEAT_PATH, { token, headers: webHeaders(serverDeviceId || deviceId), timeoutMs: 20000 });
  await readJsonBody(res).catch(() => {});
  if (res.statusCode !== 200) throw new Error(`web heartbeat HTTP ${res.statusCode}`);
}

async function fetchServerDeviceId(token, deviceId) {
  const res = await request('GET', '/api/web/auth/v1/user_info', { token, headers: webHeaders(deviceId), timeoutMs: 20000 });
  const json = JSON.parse(await readJsonBody(res));
  return (json && json.data && json.data.trusted_device && json.data.trusted_device.device_id) || '';
}

// 触发每日积分补发:官方网页在窗口聚焦时调用的账户设置接口(setting_info)
async function triggerDailyGrant(token) {
  const res = await request('GET', SETTING_INFO_PATH, { token, headers: { 'X-Client-Platform': WEB_PLATFORM, 'X-Client-Version': WEB_VERSION }, timeoutMs: 20000 });
  const text = await readJsonBody(res);
  if (res.statusCode !== 200) throw new Error(`setting_info HTTP ${res.statusCode}: ${text.slice(0, 160)}`);
  return true;
}

async function sendHeartbeat(account) {
  const res = await request('POST', DEVICE_HEARTBEAT_PATH, { body: '{}', token: account.token, headers: { 'X-Client-Platform': CLIENT_PLATFORM, 'X-Client-Device-ID': account.deviceId, 'X-Client-Version': CLIENT_VERSION, 'X-Request-Id': crypto.randomUUID() }, timeoutMs: 20000 });
  await readJsonBody(res).catch(() => {});
  return res.statusCode;
}

// 「今日领取」来自当天的正向发放账单,daily_points 仅代表每日积分剩余余额。
const todayGrantCache = new Map();
const todayGrantInFlight = new Map();

function billDateStr(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : localDateStr(d);
}

function isDailyGrantBill(bill) {
  return bill.points > 0 && (bill.bizType === 'daily_grant' || (!bill.bizType && /每日积分发放|daily[ _-]?grant/i.test(bill.event)));
}

async function fetchTodayDailyGrant(account, firstPage = null, force = false) {
  const today = localDateStr();
  const cached = todayGrantCache.get(account.id);
  if (!force && cached && cached.token === account.token && cached.date === today && Date.now() - cached.at < 30000) return cached.data;
  const active = todayGrantInFlight.get(account.id);
  if (active && active.token === account.token && active.date === today) {
    if (!force) return active.promise;
    await active.promise.catch(() => {});
  }
  const task = { token: account.token, date: today };
  task.promise = (async () => {
    let page = firstPage || await fetchBills(account, 100, null, force);
    let points = 0;
    let found = false;
    const seenIds = new Set();
    const seenCursors = new Set();
    for (let i = 0; ; i++) {
      let hasOlder = false;
      for (const bill of page.items) {
        const date = billDateStr(bill.at);
        if (date && date < today) hasOlder = true;
        if (date !== today || !isDailyGrantBill(bill) || (bill.id && seenIds.has(bill.id))) continue;
        if (bill.id) seenIds.add(bill.id);
        points += bill.points;
        found = true;
      }
      if (hasOlder || !page.hasMore) break;
      if (!page.items.length || !page.nextCursor || seenCursors.has(page.nextCursor) || i >= 19) throw new Error('当日账单分页不完整,稍后重试');
      seenCursors.add(page.nextCursor);
      page = await fetchBills(account, 100, page.nextCursor, force);
    }
    if (today !== localDateStr()) throw new Error('统计期间日期已变化,请刷新');
    const data = { points, found };
    if (task.token === account.token) todayGrantCache.set(account.id, { at: Date.now(), token: task.token, date: today, data });
    return data;
  })();
  todayGrantInFlight.set(account.id, task);
  try {
    return await task.promise;
  } finally {
    if (todayGrantInFlight.get(account.id) === task) todayGrantInFlight.delete(account.id);
  }
}

async function hasDailyGrantToday(account) {
  return (await fetchTodayDailyGrant(account, null, true)).found;
}

async function pointsWithTodayGrant(account, force = false, firstBills = null) {
  const points = await fetchPoints(account, force);
  const today = await fetchTodayDailyGrant(account, firstBills, force).catch((e) => {
    log(`[${account.name}] 当日积分流水获取失败: ${String(e?.message || e)}`);
    return null;
  });
  if (today) {
    const st = checkinOf(account);
    if (today.found && st.date !== localDateStr()) {
      st.date = localDateStr();
      st.lastResult = 'daily-granted(bills)';
      saveCheckinState();
    } else if (!today.found && st.date === localDateStr()) {
      st.date = null;
      st.lastResult = '';
      saveCheckinState();
    }
  }
  return { ...points, today_points: today ? today.points : null };
}

// 每日领取:复用账号自身 token → 绑定 web 可信设备 → 心跳 → setting_info 触发放发 → 账单确认
// (token 由扫码授权获得,30 天有效;过期后重新扫码,不依赖密码)
const checkinInFlight = new Map();
async function doCheckin(account, reason) {
  if (checkinInFlight.has(account.id)) return checkinInFlight.get(account.id);
  const task = performCheckin(account, reason);
  checkinInFlight.set(account.id, task);
  try {
    return await task;
  } finally {
    checkinInFlight.delete(account.id);
  }
}

async function performCheckin(account, reason) {
  if (await hasDailyGrantToday(account)) return { confirmed: true };
  const token = account.token;
  const deviceId = account.deviceId;
  await bindWebDevice(account, token, deviceId).catch((e) => log(`[${account.name}] 网页可信设备绑定失败: ${String(e?.message || e)}`));
  const serverDeviceId = await fetchServerDeviceId(token, deviceId).catch(() => '');
  await sendWebHeartbeat(token, serverDeviceId, deviceId).catch((e) => log(`[${account.name}] 网页会话心跳失败: ${String(e?.message || e)}`));
  await triggerDailyGrant(token).catch((e) => log(`[${account.name}] 每日积分触发失败: ${String(e?.message || e)}`));
  let confirmed = false;
  for (let i = 0; i < 4 && !confirmed; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    if (pool.statusOf(account) === 'needs_auth') break; // token 已失效,不再重试轰炸
    confirmed = await hasDailyGrantToday(account);
  }
  return { confirmed };
}

// 积分/账单的限速独立退避;重复刷新共享GET请求,不会绕过上游Retry-After。
const jsonReadCache = new Map();
const jsonInFlight = new Map();
const jsonBackoff = new Map();
async function authedJson(account, method, urlPath, { headers = {}, body, timeoutMs = 20000, force = false } = {}) {
  const key = `${account.id}:${account.token}:${method}:${urlPath}`;
  const rateKey = `${account.id}:${account.token}:${urlPath.split('?')[0]}`;
  const blocked = jsonBackoff.get(rateKey);
  if (blocked && blocked.until > Date.now()) {
    const error = new Error(`${urlPath}: 上游请求频率超限,请稍后重试`);
    Object.assign(error, { statusCode: 429, type: 'rate_limit_error', retryAfter: Math.max(1, Math.ceil((blocked.until - Date.now()) / 1000)) });
    throw error;
  }
  if (blocked) jsonBackoff.delete(rateKey);
  const cached = jsonReadCache.get(key);
  if (method === 'GET' && !force && cached && Date.now() - cached.at < 30000) return cached.data;
  if (!force && jsonInFlight.has(key)) return jsonInFlight.get(key);
  const task = (async () => {
    const res = await request(method, urlPath, { body: body === undefined && method === 'POST' ? '{}' : body, token: account.token, headers, timeoutMs });
    const text = await readJsonBody(res);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const businessError = json && (json.error || (json.code !== undefined && Number(json.code) !== 0));
    if (res.statusCode !== 200 || businessError) {
      const cls = classifyUpstream(res.statusCode, text);
      const error = new Error(`${urlPath} HTTP ${res.statusCode}: ${String(cls.message || text).slice(0, 200)}`);
      error.statusCode = 502;
      if (cls.kind === 'auth') {
        pool.markNeedsAuth(account, `HTTP ${res.statusCode} ${text.slice(0, 120)}`);
        error.type = 'pool_auth_required';
      } else if (cls.kind === 'rate') {
        const wait = Math.max(1000, parseRetryAfter(res.headers['retry-after']) || 20000);
        jsonBackoff.set(rateKey, { until: Date.now() + wait });
        Object.assign(error, { statusCode: 429, type: 'rate_limit_error', retryAfter: Math.ceil(wait / 1000) });
      }
      throw error;
    }
    if (!json || typeof json !== 'object') throw new Error(`${urlPath}: 上游未返回有效JSON`);
    if (method === 'GET') {
      if (jsonReadCache.size >= 200) jsonReadCache.delete(jsonReadCache.keys().next().value);
      jsonReadCache.set(key, { at: Date.now(), data: json });
    }
    return json;
  })();
  jsonInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (jsonInFlight.get(key) === task) jsonInFlight.delete(key);
  }
}

const pointsCache = new Map(); // accountId -> { at, data }

async function fetchPoints(account, force = false) {
  const cached = pointsCache.get(account.id);
  if (!force && cached && cached.token === account.token && cached.data && Date.now() - cached.at < 30000) return cached.data;
  const json = await authedJson(account, 'GET', POINTS_URL_PATH, { force });
  if (json?.code !== 0 || !json.data) throw new Error(`points balance: unexpected response ${JSON.stringify(json).slice(0, 120)}`);
  pointsCache.set(account.id, { at: Date.now(), token: account.token, data: json.data });
  pool.noteBalance(account, json.data);
  return json.data;
}

// 官方积分账单(消耗/发放流水):GET /api/web/points/v2/bills,游标分页
async function fetchBills(account, limit = 50, cursor = null, force = false) {
  const qs = new URLSearchParams({ 'paging.limit': String(limit), type: 'all' });
  if (cursor) qs.set('cursor', cursor);
  const json = await authedJson(account, 'GET', `${BILLS_URL_PATH}?${qs.toString()}`, { force });
  if (json?.code !== 0) throw new Error(`points bills: code=${json?.code} ${json?.message || ''}`);
  const data = json.data || {};
  if (!Array.isArray(data.items)) throw new Error('points bills: 上游缺少账单列表');
  const nextCursor = data.next_cursor ?? data.cursor ?? data.paging?.next_cursor ?? data.paging?.cursor ?? null;
  const hasMore = Boolean(data.has_more ?? data.paging?.has_more ?? Boolean(nextCursor));
  return { items: data.items.map(mapBill), nextCursor, hasMore };
}

function mapBill(item) {
  return {
    id: String(item?.bill_id || ''),
    at: String(item?.created_at || ''),
    event: String(item?.event_name || ''),
    points: Number(item?.points) || 0,
    bizType: String(item?.biz_type || ''),
    client: String(item?.client_type || ''),
  };
}

// ---- 本地请求 usage 记录:与官方账单合并,给每笔请求补上 token 读取/写入/缓存 ----
const USAGE_FILE = process.env.XHX_USAGE_FILE || path.join(__dirname, '.usage.json');
const USAGE_LIMIT = 300;
const USAGE_CAPTURE_LIMIT = 4 * 1024 * 1024;
let usageLog = [];
try {
  const j = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  if (Array.isArray(j)) usageLog = j.slice(0, USAGE_LIMIT);
} catch {}

function saveUsageLog() {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usageLog.slice(0, USAGE_LIMIT)), 'utf8');
  } catch {}
}

// 从上游响应里取 usage(流式取最后一个带 usage 的 SSE 帧)
function extractUsage(contentType, text) {
  if (!text) return null;
  if (!/event-stream/i.test(contentType || '')) {
    try {
      const j = JSON.parse(text);
      return j?.usage || null;
    } catch {
      return null;
    }
  }
  const frames = text.split('\n').filter((l) => l.startsWith('data:'));
  for (let i = frames.length - 1; i >= 0; i--) {
    const raw = frames[i].slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const j = JSON.parse(raw);
      if (j?.usage) return j.usage;
    } catch {}
  }
  return null;
}

function recordUsage({ account, model, usage, at }) {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  const cached = Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens) || 0;
  // 限免模型(有效倍率 0)官方不生成账单,记下计费状态让明细显示「免费」而不是「待入账」
  const cat = catalogCache.models && catalogCache.models.find((m) => m.id === model);
  const free = !!(cat && Number(cat.effectiveMultiplier) === 0);
  const rec = {
    id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    at: new Date(at || Date.now()).toISOString(),
    accountId: account ? account.id : '',
    accountName: account ? account.name : '',
    model: String(model || ''),
    prompt,
    completion,
    cached,
    total: Number(usage?.total_tokens) || prompt + completion,
    points: null,
    billId: null,
    free,
    billingNote: cat ? cat.billingNote || '' : '',
  };
  usageLog.unshift(rec);
  if (usageLog.length > USAGE_LIMIT) usageLog.length = USAGE_LIMIT;
  saveUsageLog();
}

// 把未匹配的本地请求与官方消耗账单按时间就近配对(账单通常 1~3 秒内生成)
function reconcileUsage(billItems, minAgeMs = 5000, accountId = null) {
  const used = new Set(usageLog.map((r) => r.billId).filter(Boolean));
  const now = Date.now();
  let changed = false;
  for (const rec of usageLog) {
    if (rec.billId) continue;
    if (accountId && rec.accountId && rec.accountId !== accountId) continue;
    const t = Date.parse(rec.at);
    if (!Number.isFinite(t) || now - t < minAgeMs) continue;
    let best = null;
    let bestDiff = Infinity;
    for (const b of billItems) {
      if (b.points >= 0 || used.has(b.id)) continue;
      const diff = Math.abs((Date.parse(b.at) || 0) - t);
      if (diff <= 10000 && diff < bestDiff) {
        best = b;
        bestDiff = diff;
      }
    }
    if (best) {
      rec.billId = best.id;
      rec.points = best.points;
      used.add(best.id);
      changed = true;
    }
  }
  if (changed) saveUsageLog();
}

// 合并视图:本地 usage 行(带 token)优先,其余账单行照常展示;整体只保留最近 limit 条
function buildBillsView(billItems, limit = 100, accountId = null) {
  reconcileUsage(billItems, 5000, accountId);
  const byBill = new Map();
  for (const rec of usageLog) if (rec.billId) byBill.set(rec.billId, rec);
  const rows = [];
  const seen = new Set();
  for (const b of billItems) {
    const u = byBill.get(b.id);
    if (u) {
      rows.push(usageRow(u));
      seen.add(u.id);
    } else {
      rows.push({ id: b.id, kind: 'bill', at: b.at, event: b.event, points: b.points, prompt: null, completion: null, cached: null, total: null });
    }
  }
  for (const rec of usageLog) {
    if (rec.billId || seen.has(rec.id)) continue;
    if (accountId && rec.accountId && rec.accountId !== accountId) continue;
    rows.push(usageRow(rec));
  }
  rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return rows.slice(0, limit);
}

function usageRow(rec) {
  // 旧记录没有 free 标记(1.8.0 之前写入),按当前模型目录补判限免
  let free = rec.free;
  let note = rec.billingNote || '';
  if (free === undefined) {
    const cat = catalogCache.models && catalogCache.models.find((m) => m.id === rec.model);
    free = !!(cat && Number(cat.effectiveMultiplier) === 0);
    note = note || (cat ? cat.billingNote || '' : '');
  }
  return {
    id: rec.id,
    kind: 'usage',
    at: rec.at,
    event: rec.model,
    points: Number.isFinite(rec.points) ? rec.points : null,
    prompt: rec.prompt,
    completion: rec.completion,
    cached: rec.cached,
    total: rec.total,
    free: !!free,
    billingNote: note,
    accountId: rec.accountId || '',
    accountName: rec.accountName || '',
  };
}

async function autoCheckin(account, reason) {
  if (!account.enabled) return;
  if (pool.statusOf(account) === 'needs_auth') return; // 待重新授权,跳过
  const st = checkinOf(account);
  const today = localDateStr();
  if (st.date === today) return;
  try {
    const { confirmed } = await doCheckin(account, reason);
    if (confirmed) {
      st.date = today;
      st.lastResult = `daily-granted(${reason})`;
      saveCheckinState();
      pointsCache.delete(account.id);
      const b = await fetchPoints(account, true).catch(() => null);
      log(`[${account.name}] 每日积分已自动领取${b ? `:可用 ${b.available_points}` : ''}`);
    } else {
      st.lastResult = 'pending';
      saveCheckinState();
      log(`[${account.name}] 每日积分尚未到账,${CHECKIN_INTERVAL_MS / 60000} 分钟后重试`);
    }
  } catch (e) {
    st.lastResult = `failed: ${String(e?.message || e).slice(0, 160)}`;
    saveCheckinState();
    console.error(`[${new Date().toISOString()}] [raccoon-proxy] [${account.name}] 每日积分自动领取失败(${CHECKIN_INTERVAL_MS / 60000} 分钟后重试): ${e.message}`);
  }
}

// 目录不可用时的兜底模型名(上游对未知名称按默认模型路由)
const FALLBACK_MODELS = [
  { id: 'SenseChat-5', note: '默认对话模型' },
  { id: 'SenseChat-5-Vision', note: '视觉模型(多模态消息格式)' },
  { id: 'sensenova-u1-pro', note: 'U1 Pro' },
  { id: 'sensenova-u1.5-lite', note: 'U1.5 Lite' },
];

// ---- 上游模型目录 + 账号状态探针(目录 GET 不消耗积分) ----
let catalogCache = { at: 0, models: null, defaultModel: null };
let upstreamStatus = { state: 'checking', checkedAt: null, error: '', modelCount: 0 };
let upstreamCheckInFlight = null;

async function fetchCatalog(force = false) {
  if (!force && catalogCache.models && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache;
  const account = pool.pick() || pool.accounts.find((a) => a.enabled && isFiniteNum(a.tokenExp) && a.tokenExp > Date.now());
  if (!account) throw new Error('账号池无可用账号:请扫码授权添加账号');
  const res = await request('GET', CATALOG_URL_PATH, { token: account.token, timeoutMs: 15000 });
  if ([401, 403].includes(res.statusCode)) {
    await readJsonBody(res).catch(() => {});
    pool.markNeedsAuth(account, 'catalog 401');
    throw new Error(`catalog HTTP ${res.statusCode}`);
  }
  if (res.statusCode !== 200) throw new Error(`catalog HTTP ${res.statusCode}`);
  const text = await readJsonBody(res);
  const json = JSON.parse(text);
  const models = [];
  let defaultModel = null;
  for (const cat of json?.data?.categories || []) {
    if (cat.default_model) defaultModel = cat.default_model;
    for (const m of cat?.models || []) {
      models.push({
        id: m.name,
        display: m.description || m.name,
        note: m.display_description || '',
        billing: m.billing_category || '',
        effectiveMultiplier: typeof m.billing_effective_multiplier === 'number' ? m.billing_effective_multiplier : null,
        billingNote: m.billing_status_note || '',
        visible: m.visible !== false,
      });
    }
  }
  if (!models.length) throw new Error('empty catalog');
  catalogCache = { at: Date.now(), models, defaultModel };
  return catalogCache;
}

function classifyUpstreamError(e) {
  const msg = String(e?.message || e);
  if (/账号未配置|无可用账号|扫码授权/.test(msg)) return 'no_account';
  if (/timeout|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|network/i.test(msg)) return 'unreachable';
  return 'error';
}

async function refreshUpstream() {
  if (!upstreamCheckInFlight) {
    upstreamCheckInFlight = (async () => {
      try {
        const cat = await fetchCatalog();
        upstreamStatus = {
          state: 'ok',
          checkedAt: new Date().toISOString(),
          error: '',
          modelCount: cat.models.filter((m) => m.visible).length,
        };
        log(`upstream ok: ${upstreamStatus.modelCount} visible models (default ${cat.defaultModel || '?'})`);
      } catch (e) {
        const state = classifyUpstreamError(e);
        upstreamStatus = { state, checkedAt: new Date().toISOString(), error: String(e?.message || e).slice(0, 200) };
        log(`upstream ${state}: ${upstreamStatus.error}`);
      }
    })().finally(() => {
      upstreamCheckInFlight = null;
    });
  }
  return upstreamCheckInFlight;
}

function upstreamSnapshot() {
  // 超过 1 分钟未检查就后台刷新,/health 立即返回缓存值不阻塞
  if (!upstreamStatus.checkedAt || Date.now() - new Date(upstreamStatus.checkedAt).getTime() > 60000) {
    refreshUpstream().catch(() => {});
  }
  return upstreamStatus;
}

function modelListForApi() {
  if (catalogCache.models) {
    return catalogCache.models.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'raccoon-proxy',
      display: m.display,
      note: m.note,
      billing: m.billing,
      visible: m.visible,
    }));
  }
  return FALLBACK_MODELS.map((m) => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'raccoon-proxy', note: m.note, fallback: true }));
}

/**
 * 把非流式 chat.completion 整包拆成 SSE 帧, 供客户端要流式但只能走 v1 的场景回放。
 * 文本按 12 字一组切块, 最后补 finish_reason 与 [DONE]。
 */
function replayAsSse(text, model) {
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  const msg = json?.choices?.[0]?.message || {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  const id = json.id || `chatcmpl-${Date.now().toString(36)}`;
  const created = json.created || Math.floor(Date.now() / 1000);
  const frame = (delta, finish) =>
    `data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish || null }],
    })}\n\n`;
  const out = [frame({ role: 'assistant', content: '' })];
  for (const [key, src] of [['reasoning_content', reasoning], ['content', content]]) {
    if (!src) continue;
    for (let i = 0; i < src.length; i += 12) out.push(frame({ [key]: src.slice(i, i + 12) }));
  }
  out.push(frame({}, json?.choices?.[0]?.finish_reason || 'stop'));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function authorized(req) {
  if (!PROXY_API_KEY) return true;
  const auth = req.headers.authorization || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim() || new URL(req.url, 'http://x').searchParams.get('key') || '';
  return key === PROXY_API_KEY;
}

function readRequestBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 对话转发:最少并发选号 → 撞限速/额度耗尽/授权失效换号 → 成功即流式输出
 * 换号发生在响应头之前,客户端无感知
 */
/**
 * 发一次上游对话请求并分类。
 * 成功(含流式)返回未消费的 upstream;失败返回已读干净的正文与分类结果。
 */
async function chatOnce(account, channel, jsonBody) {
  const upstream = await request('POST', channel.path, {
    body: jsonBody,
    token: account.token,
    // 上游对复用 keep-alive 连接的流式响应不计费(实测),强制新连接确保每笔对话都入账
    headers: {
      Connection: 'close',
      'X-Client-Platform': channel.platform,
      'X-Client-Version': channel.version,
      'X-Client-Device-ID': account.deviceId,
    },
  });

  const status = upstream.statusCode || 502;
  const ct = String(upstream.headers['content-type'] || '');
  const isEventStream = /event-stream/i.test(ct);

  // 失败响应 / 非流式响应:先读完整 body 再决策
  if (status >= 300 || !isEventStream) {
    const text = await readJsonBody(upstream);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const businessError = json && (json.error || (json.code !== undefined && Number(json.code) !== 0));
    if (status >= 200 && status < 300 && !businessError) return { ok: true, upstream, status, ct, text };
    return { ok: false, status, ct, text, cls: classifyUpstream(status, text) };
  }

  // 流式: 先暂停,避免 await 期间数据流走丢失
  upstream.pause();
  return { ok: true, upstream, status, ct, stream: true };
}

/**
 * 对话转发:最少并发选号 → 通道内失败处理 → 撞限速降级/换号 → 成功即流式输出
 * 换号与降级都发生在响应头之前,客户端无感知
 */
async function proxyChat(req, res) {
  let body;
  try {
    body = await readRequestBody(req);
  } catch (e) {
    return sendJson(res, 413, { error: { message: e.message, type: 'invalid_request_error' } });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
  }
  if (!Array.isArray(payload.messages)) {
    return sendJson(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
  }
  if (typeof payload.model !== 'string' || !payload.model) payload.model = catalogCache.defaultModel || DEFAULT_MODEL;

  const isStream = payload.stream === true;
  const jsonBody = JSON.stringify(payload);
  // 降级到 v1 的请求体: 模型换成默认模型(v1 只认它), 且必须 stream:false
  // 实测 v1 对 stream:true 稳定 500(0/10), 非流式则约五成可通;
  // 客户端要流式时由本代理把整包 JSON 拆成 SSE 帧回放
  const wantStream = payload.stream === true;
  const fallbackBody = JSON.stringify({ ...payload, model: DEFAULT_MODEL, stream: false });
  const canFallback = payload.model !== DEFAULT_MODEL;

  const tried = new Set();
  let lastFailure = null;
  let badGatewayRetries = 0;
  let attempts = 0;
  let waitedForSlot = false;

  while (attempts < MAX_CHAT_ATTEMPTS) {
    const account = pool.pick(tried);
    if (!account) {
      // 全池暂时不可用:并发槽位满(等待很短)或限速冷却(等待较长)都先等一会儿再试,
      // 避免并发一上来就直接 503。冷却等待只给一次,槽位等待给到 SLOT_WAIT_MS。
      const waitMs = pool.nextReadyIn();
      const limitMs = pool.summary().active > 0 ? SLOT_WAIT_MS : COOLDOWN_WAIT_MS;
      if (waitMs != null && waitMs <= limitMs && !(waitedForSlot && pool.summary().active === 0)) {
        waitedForSlot = true;
        tried.clear();
        log(`账号池暂不可用,${Math.max(1, Math.ceil(waitMs / 1000))}s 后重试`);
        await new Promise((r) => setTimeout(r, Math.max(120, waitMs + 80)));
        continue;
      }
      break;
    }
    attempts++;
    tried.add(account.id);
    pool.acquire(account);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      pool.release(account);
    };

    // 本号内逐通道尝试: v2 撞限流不冷却账号,降级 v1;v1 也撞才冷却换号
    // v1 只认默认模型,所以非默认模型降级时把 model 改写成默认模型(auto 路由)
    const channels = V1_MODELS.has(payload.model) ? [...CHAT_CHANNELS] : [CHAT_CHANNELS[0], CHAT_CHANNELS[1]];
    let nextAccount = false;
    for (const channel of channels) {
      // v1 通道一律用默认模型,其余通道用原模型
      const body = channel.id === 'v1' ? fallbackBody : jsonBody;
      let xextRetries = 0;
      while (!nextAccount) {
        const started = Date.now();
        let r;
        try {
          r = await chatOnce(account, channel, body);
        } catch (e) {
          lastFailure = { kind: 'network', message: String(e?.message || e) };
          log(`[${account.name}] ${channel.id} 上游网络错误: ${lastFailure.message}`);
          nextAccount = true;
          break;
        }

        log(`[${account.name}] ${channel.id} upstream ${r.status} (stream=${isStream}, model=${channel.id === 'v1' ? DEFAULT_MODEL : payload.model})`);

        if (r.ok) {
          log(`[${account.name}] ${channel.id} upstream ${r.status} ok in ${Date.now() - started}ms`);
          // 降级改写过模型时,用响应头告知客户端实际模型
          const modelHeader = channel.id === 'v1' && canFallback ? { 'X-Raccoon-Model-Fallback': DEFAULT_MODEL } : {};
          const usedModel = channel.id === 'v1' && canFallback ? DEFAULT_MODEL : payload.model;
          if (!r.stream) {
            // 成功(非流式):记录 usage 后返回;客户端原本要流式则把整包拆成 SSE 回放
            pool.markSuccess(account);
            const usage = extractUsage(r.ct, r.text);
            if (usage) recordUsage({ account, model: usedModel, usage });
            release();
            if (wantStream) {
              const sse = replayAsSse(r.text, payload.model);
              if (sse) {
                log(`[${account.name}] ${channel.id} 非流式结果已回放为 SSE`);
                res.writeHead(200, {
                  'Cache-Control': 'no-store',
                  'Access-Control-Allow-Origin': '*',
                  'Content-Type': 'text/event-stream; charset=utf-8',
                  'X-Raccoon-Sse-Replay': '1',
                  ...modelHeader,
                });
                res.end(sse);
                return;
              }
            }
            res.writeHead(r.status, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Content-Type': r.ct || 'application/json; charset=utf-8', ...modelHeader });
            res.end(r.text);
            return;
          }
          // 流式成功:边转发边留存,结束后记录 usage
          pool.markSuccess(account);
          res.writeHead(r.status, {
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            ...(r.ct ? { 'Content-Type': r.ct } : {}),
            ...modelHeader,
          });
          const captured = [];
          let capturedSize = 0;
          r.upstream.on('data', (chunk) => {
            if (capturedSize < USAGE_CAPTURE_LIMIT) {
              captured.push(chunk);
              capturedSize += chunk.length;
            }
          });
          r.upstream.on('end', () => {
            const usage = extractUsage(r.ct, Buffer.concat(captured).toString('utf8'));
            if (usage) recordUsage({ account, model: usedModel, usage });
            release();
          });
          r.upstream.on('error', () => {
            release();
            res.destroy();
          });
          res.on('close', release);
          r.upstream.pipe(res);
          return;
        }

        const cls = r.cls;
        log(`[${account.name}] ${channel.id} 上游 ${r.status} ${cls.kind} in ${Date.now() - started}ms: ${String(cls.message || '').slice(0, 160)}`);
        lastFailure = cls;

        if (cls.kind === 'xext' && xextRetries < MAX_XEXT_RETRIES) {
          // 旧实例不认识注入的 x_ext: 换实例重试,不计冷却
          xextRetries++;
          await new Promise((resolve) => setTimeout(resolve, 80 + xextRetries * 60));
          continue;
        }
        if (cls.kind === 'rate') {
          // 还有下一条通道可降级就先降级,账号仍可用;已是最后一条才冷却换号
          const hasNext = channels.indexOf(channel) < channels.length - 1;
          if (hasNext) {
            const next = channels[channels.indexOf(channel) + 1];
            if (next.id === 'v1' && canFallback) log(`[${account.name}] v2 限流,降级 v1 并把模型 ${payload.model} → ${DEFAULT_MODEL}`);
            else log(`[${account.name}] ${channel.id} 限流,降级 ${next.id}`);
            break;
          }
          pool.markRateLimited(account, cls.message, undefined);
          nextAccount = true;
          break;
        }
        if (cls.kind === 'quota') {
          pool.markExhausted(account, cls.message);
          nextAccount = true;
          break;
        }
        if (cls.kind === 'auth' || cls.kind === 'unconfirmed') {
          if (cls.kind === 'unconfirmed') {
            // IAM 会话未 confirm:补一次后同号重试
            await request('POST', CONFIRM_URL_PATH, { body: '{}', token: account.token }).then((rr) => readJsonBody(rr)).catch(() => {});
            tried.delete(account.id);
          } else {
            pool.markNeedsAuth(account, cls.message);
            nextAccount = true;
          }
          break;
        }
        if (r.status >= 500 && badGatewayRetries < 2) {
          // 上游偶发 5xx(瞬时的) -> 同通道小退避重试
          badGatewayRetries++;
          tried.delete(account.id);
          await new Promise((resolve) => setTimeout(resolve, 800 * badGatewayRetries));
          continue;
        }

        // 保留上游错误正文,HTTP200里的业务失败不能作为对话成功返回。
        release();
        res.writeHead(r.status >= 300 ? r.status : 502, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Content-Type': r.ct || 'application/json; charset=utf-8' });
        res.end(r.text);
        return;
      }
      if (nextAccount) break;
    }

    release();
  }

  // 全池不可用:按原因返回精确状态码,便于客户端正确退避(而不是一律 503)
  const summary = pool.summary();
  const detail = lastFailure ? String(lastFailure.message || lastFailure.kind).slice(0, 160) : '';
  const cooling = pool.accounts.filter((a) => a.enabled && pool.statusOf(a) === 'cooldown');
  const needsAuth = pool.accounts.filter((a) => a.enabled && pool.statusOf(a) === 'needs_auth');
  const exhausted = pool.accounts.filter((a) => a.enabled && pool.statusOf(a) === 'exhausted');

  // 1) 只是撞限速冷却:429 + Retry-After,客户端可退避重试
  if (cooling.length) {
    const retryAfter = Math.max(1, Math.ceil((pool.nextReadyIn() || 0) / 1000));
    const body = JSON.stringify({
      error: {
        message: `上游提示请求频率超限,账号冷却中,请约 ${retryAfter} 秒后重试`,
        type: 'rate_limit_error',
        code: 'account_rate_limited',
        retry_after: retryAfter,
        ...(detail ? { detail } : {}),
        pool: summary,
      },
    });
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Retry-After': String(retryAfter),
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(body);
  }

  // 2) 额度耗尽:429 insufficient_quota(非临时错误,不建议重试)
  if (!needsAuth.length && !cooling.length && exhausted.length) {
    return sendJson(res, 429, {
      error: {
        message: '全部账号今日额度已用尽(积分不足),请明天再试或扫码添加新账号',
        type: 'insufficient_quota',
        code: 'pool_exhausted',
        pool: summary,
      },
    });
  }

  // 3) 授权失效:明确提示重新扫码
  if (needsAuth.length && !cooling.length && !exhausted.length) {
    return sendJson(res, 503, {
      error: {
        message: `全部账号授权已失效,请在设置页「账号池」重新扫码授权(${needsAuth.map((a) => a.name).join('、')})`,
        type: 'pool_auth_required',
        code: 'pool_auth_required',
        pool: summary,
      },
    });
  }

  sendJson(res, 503, {
    error: {
      message: `账号池无可用账号${detail ? `(${detail})` : ''}。请在设置页「账号池」中扫码添加/续期账号`,
      type: 'pool_unavailable',
      pool: summary,
    },
  });
}

// ---- 本地扫码授权页 ----
function authPageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RaccoonProxy · 扫码授权</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:32px;display:flex;justify-content:center}
  .card{max-width:560px;width:100%;border:1px solid #8884;border-radius:14px;padding:28px}
  h1{font-size:20px;margin:0 0 6px}
  p.sub{margin:0 0 20px;color:#888;font-size:13px}
  .qr{display:flex;justify-content:center;padding:16px;background:#fff;border-radius:12px;min-height:220px;align-items:center}
  .qr svg{width:100%;max-width:300px;height:auto}
  .status{margin-top:18px;font-size:14px;display:flex;gap:10px;align-items:center}
  .dot{width:9px;height:9px;border-radius:50%;background:#e5a50a}
  .dot.ok{background:#2aa952}.dot.err{background:#d33}
  .meta{margin-top:14px;font-size:12px;color:#888;word-break:break-all}
  button{margin-top:16px;padding:9px 18px;border-radius:9px;border:1px solid #8886;background:transparent;font-size:14px;cursor:pointer}
  button:hover{background:#8881}
</style></head>
<body><div class="card">
  <h1>扫码添加 / 续期账号</h1>
  <p class="sub">用微信扫描二维码,在小程序中确认授权。授权信息只保存在本机 accounts.json。</p>
  <div class="qr" id="qr"></div>
  <div class="status"><span class="dot" id="dot"></span><span id="msg">正在创建授权会话…</span></div>
  <div class="meta" id="meta"></div>
  <button id="again" style="display:none">重新生成二维码</button>
</div>
<script>
let authId = null;
async function start() {
  document.getElementById('again').style.display = 'none';
  document.getElementById('msg').textContent = '正在创建授权会话…';
  document.getElementById('dot').className = 'dot';
  try {
    const r = await fetch('/api/accounts/auth', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error && j.error.message || '创建失败');
    authId = j.authId;
    document.getElementById('qr').innerHTML = j.qrSvg;
    document.getElementById('meta').textContent = '授权链接: ' + j.url;
    document.getElementById('msg').textContent = '等待扫码确认… (有效期 ' + j.expiresIn + ' 秒)';
    poll();
  } catch (e) {
    document.getElementById('dot').className = 'dot err';
    document.getElementById('msg').textContent = '创建失败: ' + e.message;
    document.getElementById('again').style.display = 'inline-block';
  }
}
async function poll() {
  if (!authId) return;
  try {
    const r = await fetch('/api/accounts/auth/' + authId);
    const j = await r.json();
    const st = j.session;
    if (st && st.status === 'success') {
      document.getElementById('dot').className = 'dot ok';
      document.getElementById('msg').textContent = '授权成功!' + (st.name ? '账号「' + st.name + '」' : '账号') + '已加入账号池,可关闭本页。';
      document.getElementById('meta').textContent = '回到客户端「设置 → 账号池」点「刷新」即可看到最新状态。';
      document.getElementById('qr').innerHTML = '';
      document.getElementById('again').textContent = '再添加一个账号';
      document.getElementById('again').style.display = 'inline-block';
      return;
    }
    if (st && st.status !== 'pending') {
      document.getElementById('dot').className = 'dot err';
      document.getElementById('msg').textContent = '授权未完成: ' + (st.error || st.status);
      document.getElementById('again').style.display = 'inline-block';
      return;
    }
    if (st) document.getElementById('msg').textContent = '等待扫码确认… 剩余 ' + st.remaining + ' 秒';
  } catch (e) {}
  setTimeout(poll, 2000);
}
document.getElementById('again').onclick = start;
start();
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  // 本地扫码授权页/授权接口不校验 PROXY_API_KEY(页面只操作本机账号池,不泄露对话能力)
  const isLocalAuth = url.pathname === '/auth/add' || url.pathname.startsWith('/api/accounts/auth');

  if (!isLocalAuth && !authorized(req)) {
    return sendJson(res, 401, { error: { message: 'invalid proxy api key', type: 'invalid_request_error' } });
  }

  try {
    if (route === 'GET /v1/models' || route === 'GET /models') {
      try {
        await fetchCatalog(); // 命中缓存时零开销;未命中时用可用账号拉一次目录
      } catch {}
      return sendJson(res, 200, {
        object: 'list',
        default_model: catalogCache.defaultModel,
        data: modelListForApi(),
      });
    }

    if ((route === 'POST /v1/chat/completions' || route === 'POST /chat/completions')) {
      return await proxyChat(req, res);
    }

    if (route === 'GET /health') {
      const out = { ok: true, upstream: upstreamSnapshot(), models: modelListForApi(), default_model: catalogCache.defaultModel, pool: pool.summary() };
      const first = pool.pick() || pool.accounts[0] || null;
      out.token_exp = first && isFiniteNum(first.tokenExp) ? new Date(first.tokenExp).toISOString() : null;
      return sendJson(res, 200, out);
    }

    // ---- 账号管理 ----
    if (route === 'GET /api/accounts') {
      return sendJson(res, 200, { ok: true, pool: pool.summary(), accounts: pool.list() });
    }

    if (route === 'POST /api/accounts/auth') {
      const body = await readRequestBody(req, 64 * 1024).catch(() => '{}');
      let meta = {};
      try {
        meta = JSON.parse(body || '{}') || {};
      } catch {}
      const session = await pool.startAuth({ name: meta.name, accountId: meta.accountId });
      return sendJson(res, 200, { ok: true, ...session });
    }

    const authCancelMatch = url.pathname.match(/^\/api\/accounts\/auth\/([^/]+)\/cancel$/);
    if (authCancelMatch && req.method === 'POST') {
      const ok = await pool.cancelAuth(decodeURIComponent(authCancelMatch[1]));
      return sendJson(res, 200, { ok });
    }

    const authMatch = url.pathname.match(/^\/api\/accounts\/auth\/([^/]+)$/);
    if (authMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error' } });
      }
      const session = pool.getAuthSession(decodeURIComponent(authMatch[1]));
      if (!session) return sendJson(res, 404, { ok: false, error: { message: '授权会话不存在或已失效' } });
      return sendJson(res, 200, { ok: true, session });
    }

    if (route === 'GET /auth/add') {
      return sendHtml(res, 200, authPageHtml());
    }

    const accountOpMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/(enable|disable)$/);
    if (accountOpMatch && req.method === 'POST') {
      const account = pool.setEnabled(decodeURIComponent(accountOpMatch[1]), accountOpMatch[2] === 'enable');
      if (!account) return sendJson(res, 404, { ok: false, error: { message: '账号不存在' } });
      return sendJson(res, 200, { ok: true, accounts: pool.list() });
    }

    const accountDeleteMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (accountDeleteMatch && req.method === 'DELETE') {
      const removed = pool.remove(decodeURIComponent(accountDeleteMatch[1]));
      return sendJson(res, removed ? 200 : 404, removed ? { ok: true, accounts: pool.list() } : { ok: false, error: { message: '账号不存在' } });
    }

    // ---- 账号视角的积分/签到 ----
    const resolveAccount = () => {
      const id = url.searchParams.get('account');
      if (id) {
        const a = pool.getById(id);
        if (!a) throw new Error(`账号不存在: ${id}`);
        return a;
      }
      const a = pool.pick() || pool.accounts.find((x) => x.enabled) || pool.accounts[0];
      if (!a) throw new Error('账号池为空,请先在设置页扫码添加账号');
      return a;
    };

    if (route === 'GET /api/points') {
      const account = resolveAccount();
      const points = await pointsWithTodayGrant(account);
      const st = checkinOf(account);
      return sendJson(res, 200, {
        ok: true,
        account: { id: account.id, name: account.name },
        points,
        checkin: { date: st.date, today: localDateStr(), lastResult: st.lastResult },
        pool: pool.summary(),
      });
    }

    if (route === 'GET /api/points/bills') {
      const account = resolveAccount();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const bills = await fetchBills(account, limit);
      const points = await pointsWithTodayGrant(account, false, bills).catch(() => null);
      const st = checkinOf(account);
      return sendJson(res, 200, {
        ok: true,
        account: { id: account.id, name: account.name },
        items: buildBillsView(bills.items, limit, account.id),
        points,
        checkin: { date: st.date, today: localDateStr(), lastResult: st.lastResult },
      });
    }

    if (route === 'POST /api/checkin') {
      const account = resolveAccount();
      const st = checkinOf(account);
      const today = localDateStr();
      const already = st.date === today;
      let confirmed = already;
      if (!already) {
        const r = await doCheckin(account, 'manual').catch((e) => {
          st.lastResult = `failed: ${String(e?.message || e).slice(0, 160)}`;
          saveCheckinState();
          throw e;
        });
        confirmed = !!r.confirmed;
        st.lastResult = confirmed ? 'daily-granted(manual)' : 'pending';
        if (confirmed) {
          st.date = today;
          pointsCache.delete(account.id);
        }
        saveCheckinState();
      }
      const points = await pointsWithTodayGrant(account, true).catch(() => null);
      return sendJson(res, 200, {
        ok: true,
        account: { id: account.id, name: account.name },
        granted: confirmed,
        already,
        pending: !confirmed && !already,
        points,
        checkin: { date: st.date, today, lastResult: st.lastResult },
      });
    }

    return sendJson(res, 404, { error: { message: `unknown route ${route}`, type: 'invalid_request_error' } });
  } catch (e) {
    log(`error: ${String(e?.message || e)}`);
    if (!res.headersSent) {
      sendJson(res, e.statusCode || 502, { error: { message: String(e?.message || e), type: e.type || 'proxy_error', ...(e.retryAfter ? { retry_after: e.retryAfter } : {}) } }, e.retryAfter ? { 'Retry-After': String(e.retryAfter), 'Access-Control-Expose-Headers': 'Retry-After' } : {});
    } else {
      res.destroy();
    }
  }
});

server.on('error', (e) => {
  console.error(`[raccoon-proxy] server error: ${e.message} (port ${PORT})`);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  log(`listening on http://${HOST}:${PORT}/v1`);
  refreshUpstream().catch(() => {}); // 启动即做一次目录拉取 + 账号状态检查
  setInterval(() => refreshUpstream().catch(() => {}), UPSTREAM_CHECK_INTERVAL_MS);
  try {
    const summary = pool.summary();
    log(`账号池: 共 ${summary.total} 个,可用 ${summary.active} 个,并发上限 ${summary.concurrency}/号`);
    for (const a of pool.list()) {
      log(`  - ${a.name}${a.phone ? `(${a.phone})` : ''} 状态=${a.status} 到期=${a.tokenExpiresAt || '?'}${a.availablePoints != null ? ` 积分=${a.availablePoints}` : ''}`);
    }
    if (!summary.total) {
      log('暂无账号:请在设置页「账号池」扫码添加,或在设置中填写手机号与密码');
    }
    // 启动即尝试当日自动领取(每账号独立);之后每 30 分钟补一次,当日到账后跳过
    for (const account of pool.accounts) {
      autoCheckin(account, 'startup').catch(() => {});
      sendHeartbeat(account).catch(() => {});
    }
    setInterval(() => {
      for (const account of pool.accounts) autoCheckin(account, 'timer').catch(() => {});
    }, CHECKIN_INTERVAL_MS);
    // 在线期间周期性心跳,维持可信设备在线
    setInterval(() => {
      for (const account of pool.accounts) sendHeartbeat(account).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    setInterval(() => pool.refreshAllBalances().catch(() => {}), BALANCE_REFRESH_MS);
  } catch (e) {
    console.error(`[raccoon-proxy] 启动初始化失败: ${e.message}`);
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
