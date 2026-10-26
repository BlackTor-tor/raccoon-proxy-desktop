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
const path = require('path');
const http = require('http');
const https = require('https');

const UPSTREAM_HOST = 'xiaohuanxiong.com';
const LOGIN_URL_PATH = '/api/iam/v1/auth/login/password/phone';
const CONFIRM_URL_PATH = '/api/web/auth/v1/iam/confirm';
const CHAT_URL_PATH = '/api/web/llm/v2/chat/completions';
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

function request(method, urlPath, { body, token, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/event-stream, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: `https://${UPSTREAM_HOST}`,
      Referer: `https://${UPSTREAM_HOST}/login`,
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
  const res = await request('POST', LOGIN_URL_PATH, { body });
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
  const confirm = await request('POST', CONFIRM_URL_PATH, { body: '{}', token });
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

// 已知可用模型名(上游统一路由,model 字段仅作展示/透传)
const KNOWN_MODELS = [
  { id: 'SenseChat-5', note: '默认对话模型' },
  { id: 'SenseChat-5-Vision', note: '视觉模型(多模态消息格式)' },
  { id: 'sensenova-u1-pro', note: 'U1 Pro' },
  { id: 'sensenova-u1.5-lite', note: 'U1.5 Lite' },
];

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
  if (typeof payload.model !== 'string' || !payload.model) payload.model = 'SenseChat-5';

  const isStream = payload.stream === true;
  const jsonBody = JSON.stringify(payload);

  let upstream;
  let retriedAuth = false;
  let retriedBadGateway = 0;
  while (true) {
    const token = await getToken();
    const started = Date.now();
    upstream = await request('POST', CHAT_URL_PATH, { body: jsonBody, token });
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
      return sendJson(res, 200, {
        object: 'list',
        data: KNOWN_MODELS.map((m) => ({ id: m.id, object: 'model', created: 1700000000, owned_by: 'raccoon-proxy', note: m.note })),
      });
    }

    if ((route === 'POST /v1/chat/completions' || route === 'POST /chat/completions')) {
      return await proxyChat(req, res);
    }

    if (route === 'GET /health') {
      const token = await getToken();
      return sendJson(res, 200, { ok: true, token_exp: new Date(jwtExp(token)).toISOString(), models: KNOWN_MODELS.map((m) => m.id) });
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
  try {
    const token = await getToken();
    const exp = jwtExp(token);
    log(`token ready (expires ${isFiniteNum(exp) ? new Date(exp).toISOString() : '?'})`);
  } catch (e) {
    console.error(`[raccoon-proxy] initial login failed: ${e.message}`);
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
