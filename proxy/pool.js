'use strict';
/**
 * 反代账号池
 *
 * - 账号存储: accounts.json (0600),首次运行自动从旧 .token 迁移为 1 号账号
 * - 授权方式: 官方登录页扫码授权(不保存密码、不手工粘 token)
 *     创建会话 → 用户微信扫码/或打开授权页确认 → 轮询回调接口拿到 access_token
 * - 调度: 最少并发优先,每号独立并发槽;撞限速/额度耗尽/授权失效自动换号
 * - 额度: 每账号独立记录 available_points,低额度降权,耗尽后当日停用、次日恢复
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrCodec = require('./qr');

const UPSTREAM_ORIGIN = 'https://xiaohuanxiong.com';
const QR_CREATE_PATH = '/api/iam/v1/auth/mp/qrcode';
const QR_POLL_PATH = '/api/iam/v1/auth/mp/qrcode/login';
const QR_CANCEL_PATH = '/api/iam/v1/auth/mp/qrcode';
const CONFIRM_PATH = '/api/web/auth/v1/iam/confirm';
const USER_INFO_PATH = '/api/web/auth/v1/user_info';
const POINTS_PATH = '/api/web/points/v1/balance';

const ACCOUNTS_FILE = process.env.XHX_ACCOUNTS_FILE || path.join(__dirname, 'accounts.json');
const LEGACY_TOKEN_FILE = process.env.XHX_TOKEN_FILE || path.join(__dirname, '.token');
const LEGACY_DEVICE_FILE = process.env.XHX_DEVICE_FILE || path.join(__dirname, '.device.json');

const DEFAULT_CONCURRENCY = Number(process.env.XHX_ACCOUNT_CONCURRENCY) || 2; // 每账号在飞请求上限
const LOW_BALANCE = Number(process.env.XHX_LOW_BALANCE) || 50; // 低于该积分降权
const COOLDOWN_BASE_MS = Number(process.env.XHX_COOLDOWN_MS) || 60 * 1000;
const COOLDOWN_MAX_MS = 10 * 60 * 1000;
const AUTH_POLL_MIN_MS = 1000;
const AUTH_POLL_MAX_MS = 60 * 1000;
const QR_APPNAME = process.env.XHX_QR_APPNAME || '商汤小浣熊';

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function jwtExp(token) {
  const p = jwtPayload(token);
  return p && typeof p.exp === 'number' ? p.exp * 1000 : NaN;
}

function nextLocalMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function maskPhone(phone) {
  const s = String(phone || '');
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 判断上游失败类型,供换号/冷却决策
 * @returns {{kind:'rate'|'auth'|'quota'|'unconfirmed'|'transient'|'other'}}
 */
function classifyUpstream(status, text) {
  const raw = String(text || '');
  const json = tryJson(raw);
  const code = json && (json.code ?? json.error?.code);
  const msg = [json?.message, json?.msg, json?.error?.message, typeof json?.error === 'string' ? json.error : '', raw.slice(0, 400)]
    .filter(Boolean)
    .join(' ');

  if (status === 429) return { kind: 'rate', message: msg };
  if (status === 401 || status === 403) return { kind: 'auth', message: msg };
  if (status === 402) return { kind: 'quota', message: msg };
  if (code === 200901) return { kind: 'unconfirmed', message: msg };
  if (/积分|额度|配额|余额|points|quota|insufficient|exceed|超出|用尽|耗尽|不足/i.test(msg)) return { kind: 'quota', message: msg };
  if (/频繁|过多|限流|限速|too\s*many|rate\s*limit|slow\s*down/i.test(msg)) return { kind: 'rate', message: msg };
  if (/登录|认证|授权|会话|unauthorized|forbidden|expired|失效|invalid\s*token/i.test(msg)) return { kind: 'auth', message: msg };
  if (status >= 500) return { kind: 'transient', message: msg };
  return { kind: 'other', message: msg };
}

class AccountPool {
  /**
   * @param {object} deps
   * @param {(method:string, path:string, opts?:object)=>Promise<any>} deps.request 上游请求(返回 http res)
   * @param {(res:any, limit?:number)=>Promise<string>} deps.readJsonBody
   * @param {(msg:string)=>void} [deps.log]
   */
  constructor(deps) {
    this.request = deps.request;
    this.readJsonBody = deps.readJsonBody;
    this.log = deps.log || ((m) => console.log(`[raccoon-proxy] ${m}`));
    this.concurrency = Math.max(1, Number(deps.concurrency) || DEFAULT_CONCURRENCY);
    this.lowBalance = Number.isFinite(deps.lowBalance) ? deps.lowBalance : LOW_BALANCE;
    this.accounts = [];
    this.states = new Map();
    this.authSessions = new Map();
    this._load();
  }

  // ---- 持久化 ----
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.accounts) ? raw.accounts : [];
      this.accounts = list.filter((a) => a && typeof a.token === 'string' && a.token).map((a) => this._normalize(a));
    } catch {
      this.accounts = [];
    }
    if (!this.accounts.length) this._seedFromLegacy();
    for (const a of this.accounts) this._state(a.id);
    this._persist();
  }

  _seedFromLegacy() {
    let token = '';
    try {
      token = fs.readFileSync(LEGACY_TOKEN_FILE, 'utf8').trim();
    } catch {}
    if (!token) return;
    const exp = jwtExp(token);
    if (!Number.isFinite(exp) || exp < Date.now()) return;

    let deviceId = '';
    try {
      const j = JSON.parse(fs.readFileSync(LEGACY_DEVICE_FILE, 'utf8'));
      if (j && typeof j.clientDeviceId === 'string') deviceId = j.clientDeviceId;
    } catch {}

    const sub = jwtPayload(token)?.sub || `acc_${crypto.randomUUID()}`;
    this.accounts.push(
      this._normalize({
        id: sub,
        name: '主账号',
        token,
        tokenExp: exp,
        deviceId: deviceId || crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        lastAuthAt: new Date().toISOString(),
        enabled: true,
        authVia: 'migrated',
      })
    );
    this.log('已从旧 .token 迁移 1 个账号到账号池');
  }

  _normalize(a) {
    return {
      id: String(a.id || `acc_${crypto.randomUUID()}`),
      name: String(a.name || '未命名账号'),
      phone: a.phone ? String(a.phone) : '',
      token: String(a.token),
      tokenExp: Number(a.tokenExp) || jwtExp(a.token),
      deviceId: String(a.deviceId || crypto.randomUUID()),
      createdAt: a.createdAt || new Date().toISOString(),
      lastAuthAt: a.lastAuthAt || null,
      enabled: a.enabled !== false,
      authVia: String(a.authVia || 'qr'), // qr(扫码授权) | migrated(旧 .token 迁移)
    };
  }

  _persist() {
    const payload = JSON.stringify({ version: 1, accounts: this.accounts }, null, 2);
    try {
      const tmp = `${ACCOUNTS_FILE}.tmp`;
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, ACCOUNTS_FILE);
      fs.chmodSync?.(ACCOUNTS_FILE, 0o600);
    } catch (e) {
      this.log(`账号文件写入失败: ${e.message}`);
    }
  }

  _state(id) {
    if (!this.states.has(id)) {
      this.states.set(id, {
        status: 'active', // active | cooldown | exhausted | needs_auth | disabled
        inFlight: 0,
        cooldownUntil: 0,
        consecutiveRateLimit: 0,
        lastError: '',
        lastUsedAt: 0,
        availablePoints: null,
        dailyPoints: null,
        balanceAt: 0,
      });
    }
    return this.states.get(id);
  }

  // ---- 查询 ----
  getById(id) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  list() {
    return this.accounts.map((a) => {
      const st = this._state(a.id);
      return {
        id: a.id,
        name: a.name,
        phone: a.phone ? maskPhone(a.phone) : '',
        enabled: a.enabled,
        tokenExp: a.tokenExp,
        tokenExpiresAt: Number.isFinite(a.tokenExp) ? new Date(a.tokenExp).toISOString() : null,
        lastAuthAt: a.lastAuthAt,
        authVia: a.authVia || 'qr',
        status: a.enabled ? st.status : 'disabled',
        inFlight: st.inFlight,
        availablePoints: st.availablePoints,
        dailyPoints: st.dailyPoints,
        balanceAt: st.balanceAt ? new Date(st.balanceAt).toISOString() : null,
        cooldownUntil: st.cooldownUntil ? new Date(st.cooldownUntil).toISOString() : null,
        lastError: st.lastError || '',
      };
    });
  }

  summary() {
    const list = this.list();
    return {
      total: list.length,
      active: list.filter((a) => a.status === 'active').length,
      needsAuth: list.filter((a) => a.status === 'needs_auth').length,
      cooldown: list.filter((a) => a.status === 'cooldown').length,
      exhausted: list.filter((a) => a.status === 'exhausted').length,
      unavailable: list.filter((a) => a.status !== 'active').length,
      concurrency: this.concurrency,
    };
  }

  /** 账号是否可用于新请求(额度视角) */
  _tokenUsable(account) {
    return Number.isFinite(account.tokenExp) && account.tokenExp > Date.now() + 30 * 1000;
  }

  /**
   * 选号:最少并发优先 → 低额度降权 → 余额多者优先 → 最久未用优先
   * @param {Set<string>} [exclude] 本轮已试过的账号
   */
  pick(exclude) {
    const now = Date.now();
    const candidates = [];
    for (const a of this.accounts) {
      if (!a.enabled || (exclude && typeof exclude.has === 'function' && exclude.has(a.id))) continue;
      const st = this._state(a.id);
      if (st.status === 'needs_auth') continue;
      if (st.status === 'cooldown') {
        if (now < st.cooldownUntil) continue;
        st.status = 'active';
        st.cooldownUntil = 0;
      }
      if (st.status === 'exhausted') {
        if (now < nextLocalMidnight()) continue;
        st.status = 'active';
      }
      if (!this._tokenUsable(a)) {
        st.status = 'needs_auth';
        st.lastError = 'token 已过期,需重新扫码授权';
        this.log(`账号 ${a.name} token 过期,标记为待授权`);
        continue;
      }
      if (st.inFlight >= this.concurrency) continue;
      candidates.push({ account: a, state: st });
    }

    candidates.sort((x, y) => {
      if (x.state.inFlight !== y.state.inFlight) return x.state.inFlight - y.state.inFlight;
      const lx = x.state.availablePoints != null && x.state.availablePoints <= this.lowBalance;
      const ly = y.state.availablePoints != null && y.state.availablePoints <= this.lowBalance;
      if (lx !== ly) return lx ? 1 : -1; // 低额度降权
      const px = x.state.availablePoints ?? Infinity;
      const py = y.state.availablePoints ?? Infinity;
      if (px !== py) return py - px;
      return x.state.lastUsedAt - y.state.lastUsedAt;
    });

    return candidates.length ? candidates[0].account : null;
  }

  acquire(account) {
    const st = this._state(account.id);
    st.inFlight += 1;
    st.lastUsedAt = Date.now();
  }

  release(account) {
    const st = this._state(account.id);
    st.inFlight = Math.max(0, st.inFlight - 1);
  }

  // ---- 状态迁移 ----
  markSuccess(account) {
    const st = this._state(account.id);
    st.status = 'active';
    st.cooldownUntil = 0;
    st.consecutiveRateLimit = 0;
    st.lastError = '';
  }

  markRateLimited(account, message) {
    const st = this._state(account.id);
    st.consecutiveRateLimit = Math.min(st.consecutiveRateLimit + 1, 5);
    const wait = Math.min(COOLDOWN_BASE_MS * 2 ** (st.consecutiveRateLimit - 1), COOLDOWN_MAX_MS);
    st.status = 'cooldown';
    st.cooldownUntil = Date.now() + wait;
    st.lastError = `限速冷却 ${Math.round(wait / 1000)}s: ${String(message || '').slice(0, 160)}`;
    this.log(`账号 ${account.name} ${st.lastError}`);
  }

  markExhausted(account, message) {
    const st = this._state(account.id);
    st.status = 'exhausted';
    st.availablePoints = 0;
    st.lastError = `额度耗尽: ${String(message || '').slice(0, 160)}`;
    this.log(`账号 ${account.name} ${st.lastError},今日停用`);
  }

  markNeedsAuth(account, message) {
    const st = this._state(account.id);
    st.status = 'needs_auth';
    st.lastError = `需重新授权: ${String(message || '').slice(0, 160)}`;
    this.log(`账号 ${account.name} ${st.lastError}`);
  }

  noteBalance(account, data) {
    const st = this._state(account.id);
    if (!data || typeof data !== 'object') return;
    if (Number.isFinite(Number(data.available_points))) st.availablePoints = Number(data.available_points);
    if (Number.isFinite(Number(data.daily_points))) st.dailyPoints = Number(data.daily_points);
    st.balanceAt = Date.now();
  }

  /** 账号当前调度状态 */
  statusOf(account) {
    return this._state(account.id).status;
  }

  setEnabled(id, enabled) {
    const a = this.getById(id);
    if (!a) return null;
    a.enabled = !!enabled;
    const st = this._state(a.id);
    st.status = enabled ? 'active' : 'disabled';
    st.lastError = '';
    this._persist();
    return a;
  }

  remove(id) {
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    this.accounts.splice(idx, 1);
    this.states.delete(id);
    this._persist();
    return true;
  }

  // ---- 外部注入 token(自动登录/迁移) ----
  upsertFromToken(token, meta = {}) {
    const exp = jwtExp(token);
    const payload = jwtPayload(token) || {};
    const id = meta.id || payload.sub || `acc_${crypto.randomUUID()}`;
    let account = this.getById(id);
    if (!account) {
      account = this._normalize({
        id,
        name: meta.name || '未命名账号',
        phone: meta.phone || '',
        token,
        tokenExp: exp,
        deviceId: meta.deviceId || crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        lastAuthAt: new Date().toISOString(),
        enabled: true,
        authVia: meta.authVia || 'qr',
      });
      this.accounts.push(account);
    } else {
      account.token = token;
      account.tokenExp = exp;
      account.lastAuthAt = new Date().toISOString();
      if (meta.name) account.name = meta.name;
      if (meta.phone) account.phone = meta.phone;
      if (meta.authVia) account.authVia = meta.authVia;
      account.enabled = true;
    }
    const st = this._state(account.id);
    st.status = 'active';
    st.cooldownUntil = 0;
    st.consecutiveRateLimit = 0;
    st.lastError = '';
    this._persist();
    return account;
  }

  /** 账号的独立设备标识(各号绑定各自的"可信设备") */
  deviceIdOf(account) {
    return account.deviceId;
  }

  // ---- 官方扫码授权 ----
  async _upstream(method, urlPath, { token, body = '{}', timeoutMs = 20000 } = {}) {
    const res = await this.request(method, urlPath, { body: method === 'POST' || method === 'PUT' ? body : undefined, token, timeoutMs });
    const text = await this.readJsonBody(res);
    return { status: res.statusCode, text, json: tryJson(text) };
  }

  /**
   * 创建授权会话(无需任何凭证)
   * @returns {Promise<{authId:string, url:string, qrSvg:string, expiresIn:number, pollInterval:number}>}
   */
  async startAuth(meta = {}) {
    const created = await this._upstream('POST', QR_CREATE_PATH, { body: '{}' });
    const data = created.json && (created.json.data || created.json);
    if (created.status !== 200 || !data || !data.qrcode_code || !data.scan_path) {
      throw new Error(`创建授权会话失败: HTTP ${created.status} ${created.text.slice(0, 200)}`);
    }
    const expiresIn = Number(data.expires_in) || 300;
    const pollInterval = Number(data.poll_interval) || 2;

    const url = new URL(data.scan_path, `${UPSTREAM_ORIGIN}/`);
    url.search = '';
    url.searchParams.set('code', data.qrcode_code);
    url.searchParams.set('appname', QR_APPNAME);
    url.searchParams.set('source', 'platform');

    const qr = qrCodec.encode(url.href, { level: 'M' });
    const authId = `auth_${crypto.randomUUID()}`;
    const session = {
      id: authId,
      accountId: meta.accountId || null, // 指定则视为重新授权
      name: meta.name || '',
      qrcodeCode: data.qrcode_code,
      url: url.href,
      status: 'pending',
      error: '',
      createdAt: Date.now(),
      expiresAt: Date.now() + expiresIn * 1000,
      pollIntervalMs: Math.max(AUTH_POLL_MIN_MS, Math.min(AUTH_POLL_MAX_MS, pollInterval * 1000)),
    };
    this.authSessions.set(authId, session);
    this._pollAuthLoop(session).catch(() => {});

    return {
      authId,
      url: url.href,
      qrSvg: qrCodec.toSvg(qr, { scale: 8, quiet: 4 }),
      qrText: qrCodec.toText(qr, { quiet: 2 }),
      expiresIn,
      pollInterval,
    };
  }

  getAuthSession(authId) {
    const s = this.authSessions.get(authId);
    if (!s) return null;
    return {
      id: s.id,
      status: s.status,
      url: s.url,
      error: s.error,
      accountId: s.accountId || null,
      name: s.name || '',
      expiresAt: new Date(s.expiresAt).toISOString(),
      remaining: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
    };
  }

  getAuthSessionInternal(authId) {
    return this.authSessions.get(authId) || null;
  }

  async cancelAuth(authId) {
    const s = this.authSessions.get(authId);
    if (!s || s.status !== 'pending') return false;
    s.status = 'canceled';
    await this._upstream('PUT', QR_CANCEL_PATH, { body: JSON.stringify({ qrcode_code: s.qrcodeCode, status: 'canceled' }) }).catch(() => {});
    return true;
  }

  async _pollAuthLoop(session) {
    while (session.status === 'pending') {
      if (Date.now() >= session.expiresAt) {
        session.status = 'expired';
        session.error = '授权二维码已过期';
        return;
      }
      await new Promise((r) => setTimeout(r, session.pollIntervalMs));
      if (session.status !== 'pending') return;
      let resp;
      try {
        resp = await this._upstream('POST', QR_POLL_PATH, { body: JSON.stringify({ qrcode_code: session.qrcodeCode }) });
      } catch (e) {
        session.status = 'failed';
        session.error = `轮询失败: ${e.message}`;
        return;
      }
      const data = (resp.json && (resp.json.data || resp.json)) || {};
      if (data.poll_interval && Number.isFinite(Number(data.poll_interval))) {
        session.pollIntervalMs = Math.max(AUTH_POLL_MIN_MS, Math.min(AUTH_POLL_MAX_MS, Number(data.poll_interval) * 1000));
      }
      if (data.status === 'success' && typeof data.access_token === 'string' && data.access_token) {
        try {
          const account = await this._finalizeAuth(session, data.access_token);
          session.status = 'success';
          session.accountId = account.id;
          session.name = account.name;
        } catch (e) {
          session.status = 'failed';
          session.error = `保存账号失败: ${e.message}`;
        }
        return;
      }
      if (data.status === 'canceled') {
        session.status = 'canceled';
        session.error = '授权已被取消';
        return;
      }
      if (data.status === 'expired') {
        session.status = 'expired';
        session.error = '授权二维码已过期';
        return;
      }
    }
  }

  /** 授权成功:confirm → 拉用户信息 → 落盘账号 */
  async _finalizeAuth(session, token) {
    // 与官网一致:首次使用前 confirm 一次
    await this._upstream('POST', CONFIRM_PATH, { token, body: '{}' }).catch(() => {});
    const info = await this._upstream('GET', USER_INFO_PATH, { token }).catch(() => null);
    const data = (info && info.json && info.json.data) || {};

    const account = this.upsertFromToken(token, {
      name: session.name || data.name || (data.phone ? maskPhone(data.phone) : '') || '新账号',
      phone: data.phone || '',
      id: session.accountId || jwtPayload(token)?.sub,
    });
    this.log(`账号 ${account.name} 授权成功 (到期 ${Number.isFinite(account.tokenExp) ? new Date(account.tokenExp).toISOString() : '?'})`);
    this.refreshBalance(account, true).catch(() => {});
    return account;
  }

  // ---- 额度 ----
  async refreshBalance(account, force = false) {
    const st = this._state(account.id);
    if (!force && st.balanceAt && Date.now() - st.balanceAt < 60 * 1000) return st.availablePoints;
    const resp = await this._upstream('GET', POINTS_PATH, { token: account.token }).catch(() => null);
    if (!resp || resp.status !== 200 || !resp.json || resp.json.code !== 0 || !resp.json.data) return st.availablePoints;
    this.noteBalance(account, resp.json.data);
    if (st.availablePoints === 0 && st.status === 'active') this.markExhausted(account, '额度为 0');
    return st.availablePoints;
  }

  async refreshAllBalances() {
    for (const a of this.accounts) {
      if (!a.enabled || !this._tokenUsable(a)) continue;
      await this.refreshBalance(a, true).catch(() => {});
    }
  }
}

module.exports = { AccountPool, classifyUpstream, jwtExp, jwtPayload, maskPhone, nextLocalMidnight };
