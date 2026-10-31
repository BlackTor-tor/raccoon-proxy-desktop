#!/usr/bin/env node
/**
 * RaccoonProxy 网关服务进程
 *
 * 本地 OpenAI 兼容 API 网关:自动登录上游、维护 token、透传 /v1/chat/completions(支持 SSE 流式)。
 * 由 Electron 主进程以子进程方式启动,也可独立运行:
 *   node proxy/server.js
 *   PORT=9000 node proxy/server.js
 *   XHX_PHONE=... XHX_PASSWORD=... node proxy/server.js
 *   PROXY_API_KEY=sk-local-xxx node proxy/server.js   # 给本地端口加一道鉴权(可选)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const UPSTREAM_HOST = 'xiaohuanxiong.com';
const LOGIN_URL_PATH = '/api/iam/v1/auth/login/password/phone';
const CONFIRM_URL_PATH = '/api/web/auth/v1/iam/confirm';
const CHAT_URL_PATH = '/api/web/llm/v2/chat/completions';
const CATALOG_URL_PATH = '/api/web/llm/v2/model_catalog';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const POINTS_URL_PATH = '/api/web/points/v1/balance';
const BILLS_URL_PATH = '/api/web/points/v2/bills';
const DEVICE_BIND_PATH = '/api/web/auth/v1/devices_current_bind';
const DEVICE_HEARTBEAT_PATH = '/api/web/auth/v1/devices_current_heartbeat';
const SETTING_INFO_PATH = '/api/web/office/v3/setting_info'; // 官方网页聚焦时调用,服务端在此补发每日积分
const CHECKIN_FILE = process.env.XHX_CHECKIN_FILE || path.join(__dirname, '.checkin');
const DEVICE_FILE = process.env.XHX_DEVICE_FILE || path.join(__dirname, '.device.json');
const CHECKIN_INTERVAL_MS = 30 * 60 * 1000; // 未到账时每 30 分钟重试,成功后当天不再请求
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 设备心跳保持在线
const CLIENT_PLATFORM = process.env.XHX_CLIENT_PLATFORM || 'desktop-windows';
const CLIENT_VERSION = process.env.XHX_CLIENT_VERSION || '1.1.5';
// 网页端(每日积分按 web 会话发放)使用的标识
const WEB_PLATFORM = 'web';
const WEB_VERSION = '156.0.0.0';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// 凭证一律来自环境变量(桌面端由主进程注入,来自用户在设置页填写的账号)
const PHONE = process.env.XHX_PHONE || '';
const PASSWORD = process.env.XHX_PASSWORD || '';
const NATION_CODE = process.env.XHX_NATION_CODE || '+86';
const PORT = Number(process.env.PORT || 8317);
const HOST = process.env.HOST || '127.0.0.1';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const TOKEN_FILE = process.env.XHX_TOKEN_FILE || path.join(__dirname, '.token');

// 登录接口的凭证加密(AES-128-CFB,输出 base64(IV||密文),IV 每次随机)
const AES_KEY = Buffer.from(process.env.XHX_AES_KEY || 'senseraccoon2023', 'utf8');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function encryptCredential(plain) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(`aes-${AES_KEY.length * 8}-cfb`, AES_KEY, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, ct]).toString('base64');
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

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : NaN;
  } catch {
    return NaN;
  }
}

function isFiniteNum(v) {
  return Number.isFinite(v);
}

let tokenPromise = null;

function loadSavedToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    const exp = jwtExp(t);
    if (t && isFiniteNum(exp) && exp > Date.now() + 10 * 60 * 1000) return t;
  } catch {}
  return null;
}

async function loginOnce() {
  if (!PHONE || !PASSWORD) {
    throw new Error('账号未配置:请在设置的「账号」中填写手机号与密码');
  }
  const body = JSON.stringify({
    nation_code: NATION_CODE,
    phone: encryptCredential(PHONE),
    password: encryptCredential(PASSWORD),
  });
  const res = await request('POST', LOGIN_URL_PATH, { body, headers: clientHeaders() });
  const text = await readJsonBody(res);
  let token = null;
  try {
    const json = JSON.parse(text);
    if (json?.data?.access_token && json.data.token_type?.toLowerCase() === 'bearer') {
      token = json.data.access_token;
    }
  } catch {}
  if (!token) throw new Error(`登录失败: HTTP ${res.statusCode} ${text.slice(0, 300)}`);
  // 上游 token 首次使用前需要 confirm 一次
  const confirm = await request('POST', CONFIRM_URL_PATH, { body: '{}', token, headers: clientHeaders() });
  await readJsonBody(confirm).catch(() => {});
  try {
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  } catch {}
  return token;
}

// 串行化的取 token:优先用缓存/磁盘,失效或强制刷新时重新登录
async function getToken(forceRefresh = false) {
  if (!forceRefresh) {
    const saved = loadSavedToken();
    if (saved) return saved;
  }
  if (!tokenPromise) {
    tokenPromise = loginOnce()
      .catch((e) => {
        throw e;
      })
      .finally(() => {
        tokenPromise = null;
      });
  }
  return tokenPromise;
}

// ---- 每日积分自动领取与可信设备 ----
// 上游按「可信设备会话」发放每日积分(+300):每日以设备身份完整登录一次,
// 绑定可信设备并发心跳,随后以官方账单是否出现当日「每日积分发放」为准确认到账。
function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let checkinState = { date: null, lastResult: '' };
try {
  const j = JSON.parse(fs.readFileSync(CHECKIN_FILE, 'utf8'));
  if (j && typeof j.date === 'string') checkinState.date = j.date;
  if (j && typeof j.lastResult === 'string') checkinState.lastResult = j.lastResult;
} catch {}

function saveCheckinState() {
  try {
    fs.writeFileSync(CHECKIN_FILE, JSON.stringify({ date: checkinState.date, lastResult: checkinState.lastResult, at: new Date().toISOString() }), 'utf8');
  } catch {}
}

// 本机代理的设备身份(与官方客户端各自独立),首次运行生成并落盘
let deviceIdentity = null;
function loadDeviceIdentity() {
  if (deviceIdentity) return deviceIdentity;
  try {
    const j = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
    if (j && typeof j.clientDeviceId === 'string' && j.clientDeviceId) {
      deviceIdentity = { clientDeviceId: j.clientDeviceId, createdAt: j.createdAt || new Date().toISOString() };
      return deviceIdentity;
    }
  } catch {}
  deviceIdentity = { clientDeviceId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  try {
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(deviceIdentity, null, 2), 'utf8');
  } catch {}
  return deviceIdentity;
}

function clientHeaders() {
  return {
    'X-Client-Platform': CLIENT_PLATFORM,
    'X-Client-Device-ID': loadDeviceIdentity().clientDeviceId,
    'X-Client-Version': CLIENT_VERSION,
    'X-Request-Id': crypto.randomUUID(),
  };
}

function deviceOsName() {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
}

async function sendHeartbeat() {
  return authedJson('POST', DEVICE_HEARTBEAT_PATH, { headers: clientHeaders(), timeoutMs: 20000 });
}

// 以账单为准判断今天是否已发放每日积分
async function hasDailyGrantToday() {
  const today = localDateStr();
  const { items } = await fetchBills(30);
  return items.some((b) => String(b.at).startsWith(today) && /每日积分发放/.test(b.event));
}

// 网页会话登录:与官网登录页一致(不带 X-Client-* 头),成功后写回 token 文件
async function loginWebSession() {
  const body = JSON.stringify({ nation_code: NATION_CODE, phone: encryptCredential(PHONE), password: encryptCredential(PASSWORD) });
  const res = await request('POST', LOGIN_URL_PATH, { body });
  const text = await readJsonBody(res);
  let token = null;
  try {
    const j = JSON.parse(text);
    if (j?.data?.access_token) token = j.data.access_token;
  } catch {}
  if (!token) throw new Error(`web login HTTP ${res.statusCode}: ${text.slice(0, 160)}`);
  await request('POST', CONFIRM_URL_PATH, { body: '{}', token }).then((r) => readJsonBody(r)).catch(() => {});
  try {
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  } catch {}
  return token;
}

function webHeaders(deviceId) {
  return { 'X-Client-Platform': WEB_PLATFORM, 'X-Client-Version': WEB_VERSION, 'X-Client-Device-ID': deviceId, 'X-Request-Id': crypto.randomUUID() };
}

// 把当前会话绑定为「网页可信设备」
async function bindWebDevice(token) {
  const id = loadDeviceIdentity().clientDeviceId;
  const body = JSON.stringify({
    application: 'web',
    client_device_id: id,
    client_device_id_source: id,
    client_platform: WEB_PLATFORM,
    client_version: WEB_VERSION,
    device_name: 'Chrome',
    os: deviceOsName(),
    os_version: '10',
    push_permission: 'granted',
  });
  const res = await request('POST', DEVICE_BIND_PATH, { body, token, headers: webHeaders(id), timeoutMs: 20000 });
  const text = await readJsonBody(res);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (res.statusCode !== 200 || (json && json.code !== 0)) throw new Error(`web trusted device bind HTTP ${res.statusCode}: ${text.slice(0, 160)}`);
  return (json && json.data) || {};
}

async function sendWebHeartbeat(token, serverDeviceId) {
  const res = await request('POST', DEVICE_HEARTBEAT_PATH, { token, headers: webHeaders(serverDeviceId), timeoutMs: 20000 });
  await readJsonBody(res).catch(() => {});
  if (res.statusCode !== 200) throw new Error(`web heartbeat HTTP ${res.statusCode}`);
}

async function fetchServerDeviceId(token) {
  const res = await request('GET', '/api/web/auth/v1/user_info', { token, headers: webHeaders(loadDeviceIdentity().clientDeviceId), timeoutMs: 20000 });
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

// 每日领取:网页会话登录 → 绑定 web 可信设备 → 心跳 → setting_info 触发放发 → 账单确认
async function doCheckin(reason) {
  const token = await loginWebSession();
  await bindWebDevice(token).catch((e) => log(`网页可信设备绑定失败: ${String(e?.message || e)}`));
  const serverDeviceId = await fetchServerDeviceId(token).catch(() => '');
  await sendWebHeartbeat(token, serverDeviceId || loadDeviceIdentity().clientDeviceId).catch((e) => log(`网页会话心跳失败: ${String(e?.message || e)}`));
  await triggerDailyGrant(token).catch((e) => log(`每日积分触发失败: ${String(e?.message || e)}`));
  let confirmed = false;
  for (let i = 0; i < 4 && !confirmed; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    confirmed = await hasDailyGrantToday().catch(() => false);
  }
  return { confirmed };
}

// 带 token 且 401/403 自动重登一次的 JSON 请求
async function authedJson(method, urlPath, { headers = {}, timeoutMs = 20000 } = {}) {
  let token = await getToken();
  let res = await request(method, urlPath, { body: method === 'POST' ? '{}' : undefined, token, headers, timeoutMs });
  if ([401, 403].includes(res.statusCode)) {
    token = await getToken(true);
    res = await request(method, urlPath, { body: method === 'POST' ? '{}' : undefined, token, headers, timeoutMs });
  }
  const text = await readJsonBody(res);
  if (res.statusCode !== 200) throw new Error(`${urlPath} HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

let pointsCache = { at: 0, data: null };

async function fetchPoints(force = false) {
  if (!force && pointsCache.data && Date.now() - pointsCache.at < 30000) return pointsCache.data;
  const json = await authedJson('GET', POINTS_URL_PATH);
  if (json?.code !== 0 || !json.data) throw new Error(`points balance: unexpected response ${JSON.stringify(json).slice(0, 120)}`);
  pointsCache = { at: Date.now(), data: json.data };
  return pointsCache.data;
}

// 官方积分账单(消耗/发放流水):GET /api/web/points/v2/bills,游标分页
async function fetchBills(limit = 50, cursor = null) {
  const qs = new URLSearchParams({ 'paging.limit': String(limit), type: 'all' });
  if (cursor) qs.set('cursor', cursor);
  const json = await authedJson('GET', `${BILLS_URL_PATH}?${qs.toString()}`);
  if (json?.code !== 0) throw new Error(`points bills: code=${json?.code} ${json?.message || ''}`);
  const data = json.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const nextCursor = data.next_cursor ?? data.cursor ?? data.paging?.next_cursor ?? data.paging?.cursor ?? null;
  const hasMore = Boolean((data.has_more ?? data.paging?.has_more ?? Boolean(nextCursor)) && nextCursor);
  return { items: items.map(mapBill), nextCursor, hasMore };
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

function recordUsage({ model, usage, at }) {
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  const cached = Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens) || 0;
  // 限免模型(有效倍率 0)官方不生成账单,记下计费状态让明细显示「免费」而不是「待入账」
  const cat = catalogCache.models && catalogCache.models.find((m) => m.id === model);
  const free = !!(cat && Number(cat.effectiveMultiplier) === 0);
  const rec = {
    id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    at: new Date(at || Date.now()).toISOString(),
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
function reconcileUsage(billItems, minAgeMs = 5000) {
  const used = new Set(usageLog.map((r) => r.billId).filter(Boolean));
  const now = Date.now();
  let changed = false;
  for (const rec of usageLog) {
    if (rec.billId) continue;
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
function buildBillsView(billItems, limit = 100) {
  reconcileUsage(billItems);
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
  return { id: rec.id, kind: 'usage', at: rec.at, event: rec.model, points: Number.isFinite(rec.points) ? rec.points : null, prompt: rec.prompt, completion: rec.completion, cached: rec.cached, total: rec.total, free: !!free, billingNote: note };
}

async function autoCheckin(reason) {
  const today = localDateStr();
  if (checkinState.date === today) return;
  try {
    const { confirmed } = await doCheckin(reason);
    if (confirmed) {
      checkinState.date = today;
      checkinState.lastResult = `daily-granted(${reason})`;
      saveCheckinState();
      pointsCache = { at: 0, data: null };
      const b = await fetchPoints(true).catch(() => null);
      log(`每日积分已自动领取${b ? `:今日 ${b.daily_points}` : ''}`);
    } else {
      checkinState.lastResult = 'pending';
      saveCheckinState();
      log(`每日积分尚未到账,${CHECKIN_INTERVAL_MS / 60000} 分钟后重试`);
    }
  } catch (e) {
    checkinState.lastResult = `failed: ${String(e?.message || e).slice(0, 160)}`;
    saveCheckinState();
    log(`每日积分自动领取失败(${CHECKIN_INTERVAL_MS / 60000} 分钟后重试): ${e.message}`);
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
  const pull = async (token) => {
    const res = await request('GET', CATALOG_URL_PATH, { token, timeoutMs: 15000 });
    const text = await readJsonBody(res);
    return { res, text };
  };
  let token = await getToken();
  let { res, text } = await pull(token);
  if (res.statusCode === 401 || res.statusCode === 403) {
    token = await getToken(true); // token 失效,强制重登一次
    ({ res, text } = await pull(token));
  }
  if (res.statusCode !== 200) throw new Error(`catalog HTTP ${res.statusCode}`);
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
  if (/账号未配置/.test(msg)) return 'no_account';
  if (/登录失败|login failed|password/i.test(msg)) return 'login_failed';
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

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function authorized(req) {
  if (!PROXY_API_KEY) return true;
  const auth = req.headers.authorization || '';
  const key = auth.replace(/^Bearer\s+/i, '').trim() || new URL(req.url, 'http://x').searchParams.get('key') || '';
  return key === PROXY_API_KEY;
}

async function proxyChat(req, res) {
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } });
  }
  if (!Array.isArray(payload.messages)) {
    return sendJson(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request_error' } });
  }
  if (typeof payload.model !== 'string' || !payload.model) payload.model = catalogCache.defaultModel || 'SenseChat-5';

  const isStream = payload.stream === true;
  const jsonBody = JSON.stringify(payload);

  let upstream;
  let retriedAuth = false;
  let retriedBadGateway = 0;
  while (true) {
    const token = await getToken();
    const started = Date.now();
    // 上游对复用 keep-alive 连接的流式响应不计费(实测),强制新连接确保每笔对话都入账
    upstream = await request('POST', CHAT_URL_PATH, { body: jsonBody, token, headers: { Connection: 'close' } });
    log(`upstream ${upstream.statusCode} in ${Date.now() - started}ms (stream=${isStream}, retry502=${retriedBadGateway}, model=${payload.model})`);
    // 上游偶发 502(网关瞬时故障)-> 小退避重试
    if (upstream.statusCode === 502 && retriedBadGateway < 2) {
      await readJsonBody(upstream).catch(() => {});
      retriedBadGateway++;
      await new Promise((r) => setTimeout(r, 800 * retriedBadGateway));
      continue;
    }
    // token 失效 -> 强制重登一次
    if ([401, 403].includes(upstream.statusCode) && !retriedAuth) {
      await readJsonBody(upstream).catch(() => {});
      retriedAuth = true;
      await getToken(true);
      continue;
    }
    break;
  }

  const status = upstream.statusCode || 502;
  const headers = {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };
  const ct = upstream.headers['content-type'];
  if (ct) headers['Content-Type'] = ct;
  res.writeHead(status, headers);
  // 边转发边留存响应体,结束后解析 usage(token 读取/写入/缓存)记入本地流水
  const captured = [];
  let capturedSize = 0;
  upstream.on('data', (chunk) => {
    if (capturedSize < USAGE_CAPTURE_LIMIT) {
      captured.push(chunk);
      capturedSize += chunk.length;
    }
  });
  upstream.on('end', () => {
    if (status < 200 || status >= 300) return;
    const usage = extractUsage(ct, Buffer.concat(captured).toString('utf8'));
    if (usage) recordUsage({ model: payload.model, usage });
  });
  upstream.pipe(res);
  upstream.on('error', () => res.destroy());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  if (!authorized(req)) {
    return sendJson(res, 401, { error: { message: 'invalid proxy api key', type: 'invalid_request_error' } });
  }

  try {
    if (route === 'GET /v1/models' || route === 'GET /models') {
      try {
        await fetchCatalog(); // 命中缓存时零开销;未命中时拉一次目录(401 自动重登)
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
      const out = { ok: true, upstream: upstreamSnapshot(), models: modelListForApi(), default_model: catalogCache.defaultModel };
      try {
        const token = await getToken();
        out.token_exp = new Date(jwtExp(token)).toISOString();
      } catch (e) {
        out.token_exp = null;
        out.upstream = { state: classifyUpstreamError(e), checkedAt: new Date().toISOString(), error: String(e?.message || e).slice(0, 200) };
      }
      return sendJson(res, 200, out);
    }

    if (route === 'GET /api/points') {
      const points = await fetchPoints();
      return sendJson(res, 200, { ok: true, points, checkin: { date: checkinState.date, today: localDateStr(), lastResult: checkinState.lastResult } });
    }

    if (route === 'GET /api/points/bills') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const bills = await fetchBills(limit);
      const points = await fetchPoints().catch(() => null);
      return sendJson(res, 200, { ok: true, items: buildBillsView(bills.items, limit), points, checkin: { date: checkinState.date, today: localDateStr(), lastResult: checkinState.lastResult } });
    }

    if (route === 'POST /api/checkin') {
      const today = localDateStr();
      const already = checkinState.date === today;
      let confirmed = already;
      if (!already) {
        const r = await doCheckin('manual').catch((e) => ({ confirmed: false, error: String(e?.message || e) }));
        confirmed = !!r.confirmed;
        checkinState.lastResult = confirmed ? 'daily-granted(manual)' : r.error ? `failed: ${r.error.slice(0, 160)}` : 'pending';
        if (confirmed) {
          checkinState.date = today;
          pointsCache = { at: 0, data: null };
        }
        saveCheckinState();
      }
      const points = await fetchPoints(true).catch(() => null);
      return sendJson(res, 200, { ok: true, granted: confirmed, already, pending: !confirmed && !already, points, checkin: { date: checkinState.date, today, lastResult: checkinState.lastResult } });
    }

    return sendJson(res, 404, { error: { message: `unknown route ${route}`, type: 'invalid_request_error' } });
  } catch (e) {
    log(`error: ${String(e?.message || e)}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: String(e?.message || e), type: 'proxy_error' } });
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
    const token = await getToken();
    const exp = jwtExp(token);
    log(`token ready (expires ${isFiniteNum(exp) ? new Date(exp).toISOString() : '?'})`);
    // 启动即尝试当日自动领取(设备登录+绑定+心跳);之后每 30 分钟补一次,当日到账后跳过
    autoCheckin('startup').catch(() => {});
    setInterval(() => autoCheckin('timer').catch(() => {}), CHECKIN_INTERVAL_MS);
    // 在线期间周期性心跳,维持可信设备在线
    setInterval(() => sendHeartbeat().catch(() => {}), HEARTBEAT_INTERVAL_MS);
  } catch (e) {
    console.error(`[raccoon-proxy] initial login failed: ${e.message}`);
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
