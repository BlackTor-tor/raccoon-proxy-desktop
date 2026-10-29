'use strict';
/* RaccoonProxy 渲染层逻辑
 * 桥接契约: window.raccoonProxy = { getStatus, startService, stopService, saveSettings, onLog, onState, onHealth }
 * 页面: 仪表盘 / 设置 / 对话调试(含历史对话子菜单,localStorage 持久化)
 */
const $ = id => document.getElementById(id);
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem('raccoonproxy.' + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('raccoonproxy.' + key, JSON.stringify(value)); return true; } catch { return false; } },
};
const saved = storage.get('preferences', {});
const state = {
  page: 'dashboard', running: true, busy: false, sending: false,
  theme: storage.get('theme', 'light'),
  variant: 'setup', // 客户端形态:setup(安装版)/ portable(便携版),由主进程状态同步
  settings: {
    countryCode: typeof saved.countryCode === 'string' && /^\+\d{1,4}$/.test(saved.countryCode) ? saved.countryCode : '+86',
    phone: '', password: '',
    port: Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535 ? saved.port : 8317,
    apiKey: '', autoStart: saved.autoStart === true,
  },
  autoStartDraft: false, messages: [], logCount: 4, keyVisible: false, controller: null,
  conversations: storage.get('conversations', []), currentId: null,
};
const bridge = window.raccoonProxy;
const nativeService = !!(bridge && typeof bridge.getStatus === 'function' && typeof bridge.startService === 'function' && typeof bridge.stopService === 'function');
const baseUrl = () => `http://127.0.0.1:${state.settings.port}/v1`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let toastTimer;

/* ---------- 通用 ---------- */

function toast(text, action) {
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.onClick(); };
  }
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2800);
}
function hideToast() { $('toast').classList.remove('visible'); }

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

/* ---------- 导航 / 主题 ---------- */

function navigate(page) {
  if (!['dashboard', 'settings', 'playground'].includes(page)) page = 'dashboard';
  state.page = page;
  document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== 'page-' + page);
  document.querySelectorAll('[data-page]').forEach(el => { const active = el.dataset.page === page; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('breadcrumb-current').textContent = { dashboard: '仪表盘', settings: '设置', playground: '对话调试' }[page];
  storage.set('page', page);
}
function setTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light'; document.documentElement.dataset.theme = state.theme;
  const label = state.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  $('theme-toggle').setAttribute('aria-label', label); $('theme-toggle').title = label;
  $('theme-icon').setAttribute('href', state.theme === 'dark' ? '#i-sun' : '#i-moon'); storage.set('theme', state.theme);
}

/* ---------- 日志 ---------- */

function addLog(message, level = 'info') {
  const lines = $('log-lines');
  const empty = lines.querySelector('.log-empty'); if (empty) empty.remove();
  const row = document.createElement('div'); row.className = 'log-row';
  const values = [new Date().toLocaleTimeString('zh-CN', { hour12: false }), { info: '信息', error: '错误', warn: '提示' }[level] || '信息', String(message)];
  ['t', 'lv' + (level === 'error' ? ' err' : level === 'warn' ? ' warn' : ''), 'm'].forEach((cls, i) => { const span = document.createElement('span'); span.className = cls; span.textContent = values[i]; row.appendChild(span); });
  lines.appendChild(row); state.logCount++; while (lines.children.length > 150) lines.firstElementChild.remove();
  $('log-count').textContent = `${state.logCount} 条`; lines.scrollTop = lines.scrollHeight;
}

/* ---------- 仪表盘 ---------- */

function updateService() {
  $('service-toggle').setAttribute('aria-checked', String(state.running)); $('service-toggle').disabled = state.busy;
  $('service-title').textContent = state.busy ? (state.running ? '正在停止服务…' : '正在启动服务…') : state.running ? '服务运行中' : '服务已停止';
  $('service-description').textContent = state.running ? '以 OpenAI 兼容格式,连接你的开发工具。' : '开启服务后,即可通过本地地址调用模型。';
  $('sidebar-status').textContent = (nativeService ? '' : '演示') + (state.running ? '网关运行中' : '网关已停止');
  document.body.dataset.run = state.running ? 'on' : 'off';
  $('service-dot').classList.toggle('off', !state.running);
  $('listen-address').textContent = `127.0.0.1:${state.settings.port}`; $('base-url').textContent = baseUrl();
  $('log-port').textContent = state.settings.port; $('chat-endpoint').textContent = `127.0.0.1:${state.settings.port}/v1/chat/completions`;
  $('api-key-display').textContent = state.settings.apiKey ? (state.keyVisible ? state.settings.apiKey : '••••••••••••••••') : '未设置 · 无需鉴权';
  $('reveal-key').hidden = !state.settings.apiKey; $('copy-api-key').disabled = !state.settings.apiKey;
  $('copy-api-key').title = state.settings.apiKey ? '复制 API Key' : '尚未设置 API Key';
  $('key-hint').textContent = state.settings.apiKey ? '仅用于本地网关鉴权,请妥善保管' : '若工具要求必填,可填入任意非空占位值';
}
async function toggleService() {
  if (state.busy) return; if (state.sending) { toast('请先停止当前生成，再切换服务'); return; }
  const next = !state.running; state.busy = true; updateService();
  try { if (nativeService) { const result = await (next ? bridge.startService() : bridge.stopService()); if (result && result.ok === false) throw new Error(); } else await sleep(500); state.running = next; addLog((nativeService ? '' : '演示：') + (next ? `服务已启动，监听 127.0.0.1:${state.settings.port}` : '服务已停止')); toast((nativeService ? '' : '演示：') + (next ? '服务已启动' : '服务已停止')); }
  catch { toast('服务操作失败，请检查进程状态'); addLog('服务操作失败，请检查进程状态', 'error'); }
  finally { state.busy = false; updateService(); }
}
async function copy(text, label, button) {
  try { if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text); else { const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select(); const success = document.execCommand('copy'); area.remove(); if (!success) throw new Error(); } toast(`已复制${label}`); if (button) { const use = button.querySelector('use'); if (use) { use.setAttribute('href', '#i-check'); setTimeout(() => use.setAttribute('href', '#i-copy'), 1500); } } }
  catch { toast('复制未完成，请手动选择并复制'); }
}

/* ---------- 上游目录与状态 ---------- */

const DEFAULT_MODELS = [['SenseChat-5', '默认对话模型'], ['SenseChat-5-Vision', '视觉模型'], ['sensenova-u1-pro', 'U1 Pro'], ['sensenova-u1.5-lite', 'U1.5 Lite']];
state.models = DEFAULT_MODELS.map(([id, note]) => ({ id, note }));
function renderModels() {
  const tbody = $('model-list'); if (!tbody) return;
  tbody.replaceChildren();
  for (const m of state.models) {
    const tr = document.createElement('tr');
    tr.title = '模型 ID: ' + m.id + '\n点击行尾按钮复制';
    const name = document.createElement('td'); name.className = 'name'; name.textContent = m.display || m.id;
    const note = document.createElement('td'); note.className = 'note'; note.textContent = m.note || '—';
    const type = document.createElement('td');
    const tag = document.createElement('span');
    const lite = m.billing === 'lite';
    tag.className = 'tag' + (lite ? ' lite' : '');
    tag.textContent = lite ? '轻量' : '标准';
    type.appendChild(tag);
    const act = document.createElement('td'); act.style.textAlign = 'right';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'rowcopy'; btn.title = '复制模型 ID'; btn.setAttribute('aria-label', '复制模型 ID ' + m.id);
    btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-copy"/></svg>';
    btn.addEventListener('click', () => copy(m.id, '模型 ID'));
    act.appendChild(btn);
    tr.append(name, note, type, act);
    tbody.appendChild(tr);
  }
  $('models-badge').textContent = state.models.length + ' 个可用';
}
function applyUpstream(h) {
  if (!h) return;
  const models = Array.isArray(h.models) ? h.models : null;
  if (models && models.length) {
    state.models = models.map((m) => (typeof m === 'string' ? { id: m } : { id: m.id, display: m.display, note: m.note, billing: m.billing, visible: m.visible }));
    renderModels();
    const sel = $('chat-model'); const prev = sel.value;
    sel.replaceChildren();
    for (const m of state.models) { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.display || m.id; sel.appendChild(opt); }
    if (prev && state.models.some((m) => m.id === prev)) sel.value = prev;
    else if (h.defaultModel && state.models.some((m) => m.id === h.defaultModel)) sel.value = h.defaultModel;
  }
  const el = $('token-expiry'); if (!el) return;
  const up = h.upstream || {};
  const map = { ok: ['正常', 'var(--green-ink)'], no_account: ['未配置账号', 'var(--red)'], login_failed: ['登录失败', 'var(--red)'], unreachable: ['上游不可达', 'var(--red)'], error: ['异常', 'var(--red)'], checking: ['检测中…', 'var(--ink-3)'] };
  const [text, color] = map[up.state] || ['未知', 'var(--ink-3)'];
  let full = text;
  if (up.state === 'ok') {
    if (h.tokenExpiresAt && Number.isFinite(new Date(h.tokenExpiresAt).getTime())) {
      const days = Math.max(0, Math.round((new Date(h.tokenExpiresAt) - Date.now()) / 86400000));
      full += ',token 约 ' + days + ' 天后到期';
    }
  } else if (up.error) full += ':' + String(up.error).slice(0, 50);
  el.textContent = full; el.style.color = color;
}

/* ---------- 设置 ---------- */

function populateSettings() { const s = state.settings; $('country-code').value = s.countryCode; $('phone').value = s.phone; $('password').value = s.password; $('port').value = s.port; $('local-key').value = s.apiKey; state.autoStartDraft = s.autoStart; $('auto-start').setAttribute('aria-checked', String(s.autoStart)); }
function validateSettings() {
  ['phone', 'password', 'port', 'key'].forEach(id => $(id + '-error').textContent = '');
  ['phone', 'country-code', 'password', 'port', 'local-key'].forEach(id => $(id).removeAttribute('aria-invalid'));
  const value = { countryCode: $('country-code').value.trim(), phone: $('phone').value.trim(), password: $('password').value, port: Number($('port').value), apiKey: $('local-key').value.trim(), autoStart: state.autoStartDraft };
  let valid = true;
  const error = (field, text, input) => { $(field + '-error').textContent = text; $(input || field).setAttribute('aria-invalid', 'true'); valid = false; };
  if (!/^\+\d{1,4}$/.test(value.countryCode)) error('phone', '请输入正确的国际区号，例如 +86', 'country-code');
  if (value.phone && !/^\d{6,15}$/.test(value.phone)) error('phone', '手机号应为 6–15 位数字');
  if (value.phone && !value.password) error('password', '填写手机号后，请同时填写密码');
  if (value.password && !value.phone) error('phone', '请填写与密码对应的手机号');
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) error('port', '请输入 1024–65535 之间的整数端口');
  if (value.apiKey && !/^[\x21-\x7E]{1,256}$/.test(value.apiKey)) error('key', '密钥请使用不含空格的 ASCII 字符，最多 256 位', 'local-key');
  if (!valid) { document.querySelector('[aria-invalid="true"]').focus(); return null; } return value;
}
async function saveSettings(event) {
  event.preventDefault(); if (state.busy) return; if (state.sending) { toast('请先停止当前生成，再保存设置'); return; }
  const value = validateSettings(); if (!value) return;
  const button = $('save-settings'); const previous = { ...state.settings }; const wasRunning = state.running;
  button.disabled = true; button.textContent = '正在保存…'; $('save-result').hidden = true; state.busy = true;
  try {
    if (nativeService && typeof bridge.saveSettings !== 'function') throw new Error();
    if (nativeService) { const result = await bridge.saveSettings(value); if (result && result.ok === false) throw new Error(); }
    state.settings = value; state.keyVisible = false;
    if (wasRunning) { state.running = false; updateService(); if (nativeService) { await bridge.stopService(); const result = await bridge.startService(); if (result && result.ok === false) throw new Error(); } else await sleep(650); state.running = true; }
    const stored = storage.set('preferences', { countryCode: value.countryCode, port: value.port, autoStart: value.autoStart });
    if (!stored) toast('设置已应用，本机存储不可用'); else toast(wasRunning ? '设置已保存，服务已重启' + (nativeService ? '' : '（演示）') : '设置已保存');
    $('save-result').textContent = wasRunning ? '设置已应用，' + (nativeService ? '本机' : '演示') + '服务已重新启动。' : '设置已应用，服务保持停止。'; $('save-result').hidden = false;
    $('token-expiry').textContent = '待验证'; addLog((nativeService ? '' : '演示：') + '配置已更新' + (wasRunning ? '，服务已重启' : ''));
  } catch { state.settings = previous; if (nativeService) state.running = false; else state.running = wasRunning; toast('设置未完成，请检查服务后重新保存'); addLog('配置应用失败，请检查服务状态', 'error'); }
  finally { state.busy = false; button.disabled = false; button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>保存设置'; updateService(); }
}

/* ---------- 软件更新 ---------- */

const RELEASES_PAGE_URL = 'https://github.com/BlackTor-tor/raccoon-proxy-desktop/releases/latest';
const updateInfo = { latest: '', downloadUrl: '', variant: 'setup', sha256: '' };
const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
const hasBridge = (fn) => !!(bridge && typeof bridge[fn] === 'function');
const isPortable = () => (updateInfo.variant || state.variant) === 'portable';
function showUpdateFallback(message) {
  const box = $('update-fallback');
  box.replaceChildren(document.createTextNode(message + ' '));
  const link = document.createElement('button');
  link.type = 'button'; link.className = 'text-button';
  link.textContent = '前往 GitHub Releases 手动下载';
  link.title = RELEASES_PAGE_URL;
  link.addEventListener('click', () => { if (hasBridge('openReleases')) bridge.openReleases(); });
  box.appendChild(link);
  box.hidden = false;
}
function setUpdateBusy(busy) { $('update-check').disabled = busy; if (!$('update-download').hidden) $('update-download').disabled = busy; }
async function checkForUpdateUI() {
  $('update-fallback').hidden = true; $('update-progress').hidden = true;
  $('update-download').hidden = true; $('update-install').hidden = true;
  if (!hasBridge('checkUpdate')) {
    $('update-state').textContent = '桌面环境未就绪,无法检查更新';
    showUpdateFallback('检查更新失败:更新服务不可用。');
    return;
  }
  $('update-state').textContent = '正在检查更新…'; setUpdateBusy(true);
  try {
    const r = await bridge.checkUpdate();
    if (!r || r.ok === false) throw new Error();
    $('update-current').textContent = 'v' + r.current;
    updateInfo.latest = r.latest; updateInfo.downloadUrl = r.downloadUrl; updateInfo.variant = r.variant === 'portable' ? 'portable' : 'setup'; updateInfo.sha256 = typeof r.sha256 === 'string' ? r.sha256 : '';
    if (!r.updateAvailable) $('update-state').textContent = `已是最新版本(v${r.current})`;
    else { $('update-state').textContent = `发现新版本 v${r.latest},可下载${isPortable() ? '便携版' : '安装包'}`; $('update-download').hidden = false; }
  } catch {
    $('update-state').textContent = '无法检查更新,请稍后重试';
    showUpdateFallback('检查更新失败:网络不可达或接口受限。');
  } finally { setUpdateBusy(false); }
}
async function downloadUpdateUI() {
  if (!hasBridge('downloadUpdate') || !updateInfo.downloadUrl) return;
  $('update-fallback').hidden = true;
  setUpdateBusy(true);
  const result = await bridge.downloadUpdate({ url: updateInfo.downloadUrl, latest: updateInfo.latest, variant: updateInfo.variant, sha256: updateInfo.sha256 });
  if (!result || result.ok === false) { setUpdateBusy(false); showUpdateFallback('下载未能开始:' + ((result && result.error) || '未知原因')); }
}
function handleUpdateProgress(p) {
  if (!p || !p.status) return;
  const progress = $('update-progress');
  const portable = p.variant === 'portable';
  if (p.status === 'downloading') {
    progress.hidden = false;
    progress.textContent = p.total ? `正在下载 v${updateInfo.latest}${portable ? ' 便携版' : ''}… ${fmtMB(p.received)} / ${fmtMB(p.total)}(${Math.round((p.received / p.total) * 100)}%)` : `正在下载 v${updateInfo.latest}${portable ? ' 便携版' : ''}… ${fmtMB(p.received)}`;
  } else if (p.status === 'ready') {
    setUpdateBusy(false);
    $('update-download').hidden = true;
    progress.hidden = false;
    if (portable) {
      progress.textContent = `便携版已下载完成:${p.file || ''}。退出本应用后运行新文件即可完成升级(可覆盖旧文件)。`;
      $('update-install').textContent = '打开所在文件夹';
    } else {
      progress.textContent = '安装包已下载完成,点击「安装并重启」完成升级。';
      $('update-install').textContent = '安装并重启';
    }
    $('update-install').hidden = false;
    toast(portable ? '新版便携版已就绪' : '新版本已就绪');
  } else if (p.status === 'failed') {
    setUpdateBusy(false);
    progress.hidden = true;
    showUpdateFallback('下载失败(已自动重试 3 次),请检查网络后重试,或手动下载最新版。');
    addLog('更新包下载失败:' + (p.message || ''), 'error');
  }
}
async function installUpdateUI() {
  if (!hasBridge('installUpdate')) return;
  const r = await bridge.installUpdate();
  if (r && r.ok === false) toast(r.error || '安装失败');
  else if (r && r.portable) toast('新版便携版已下载,退出应用后运行新文件即可');
}

/* ---------- 官方积分(签到) ---------- */

let checkinBusy = false;
let pointsFetchedAt = 0;
const fmtNum = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('zh-CN') : '—');

function setCheckinIdle() {
  $('checkin-btn').disabled = false;
  $('checkin-label').textContent = '立即签到';
}
function renderPoints(data) {
  const p = data && data.points;
  if (!p || !Number.isFinite(p.available_points)) return;
  $('points-available').textContent = fmtNum(p.available_points);
  const parts = [];
  if (Number(p.daily_points) > 0) parts.push('今日 ' + fmtNum(p.daily_points));
  if (Number(p.reward_points) > 0) parts.push('奖励 ' + fmtNum(p.reward_points));
  if (Number(p.monthly_points) > 0) parts.push('会员 ' + fmtNum(p.monthly_points));
  if (Number(p.topup_points) > 0) parts.push('充值 ' + fmtNum(p.topup_points));
  $('points-breakdown').textContent = parts.length ? parts.join(' · ') : '账户暂无积分明细';
  const ck = data.checkin || {};
  if (ck.date && ck.date === ck.today) {
    $('checkin-btn').disabled = true;
    $('checkin-label').textContent = '今日已签到';
    $('checkin-state').textContent = ck.lastResult === 'already-granted' ? '官方客户端已领取,账户积分一致' : '服务启动时已自动签到';
  } else {
    setCheckinIdle();
    $('checkin-state').textContent = ck.lastResult && String(ck.lastResult).startsWith('failed') ? '自动签到未完成,可手动重试' : '今日尚未签到';
  }
}
function renderPointsUnavailable() {
  $('points-available').textContent = '—';
  $('points-breakdown').textContent = state.running ? '暂时无法获取积分,稍后自动重试' : '开启服务后自动获取';
  setCheckinIdle();
  $('checkin-state').textContent = '—';
}
function pointsHeaders(extra) {
  const headers = extra ? { ...extra } : {};
  if (state.settings.apiKey) headers.Authorization = 'Bearer ' + state.settings.apiKey;
  return headers;
}
async function refreshPoints(force = false) {
  if (!force && Date.now() - pointsFetchedAt < 60000) return;
  pointsFetchedAt = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${state.settings.port}/api/points`, { headers: pointsHeaders() });
    const data = r.ok ? await r.json() : null;
    if (data && data.ok) renderPoints(data);
    else renderPointsUnavailable();
  } catch { renderPointsUnavailable(); }
}
async function checkinNow() {
  if (checkinBusy || !state.running) { if (!state.running) toast('请先开启服务再签到'); return; }
  checkinBusy = true;
  $('checkin-btn').disabled = true;
  $('checkin-label').textContent = '签到中…';
  try {
    const r = await fetch(`http://127.0.0.1:${state.settings.port}/api/checkin`, { method: 'POST', headers: pointsHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
    const data = r.ok ? await r.json() : null;
    if (!data || data.ok !== true) throw new Error();
    renderPoints(data);
    toast(data.granted ? '签到成功,积分已到账' : '今日已签到过,积分都在账户中');
    addLog(data.granted ? '签到成功' + (data.points ? ',可用 ' + fmtNum(data.points.available_points) : '') : '签到:今日已领取过');
  } catch {
    toast('签到失败,请检查服务状态');
    addLog('签到失败', 'error');
    setCheckinIdle();
  } finally { checkinBusy = false; }
}

/* ---------- 更新提醒弹窗 ---------- */

const updateModalInfo = { latest: '', downloadUrl: '', variant: 'setup', sha256: '' };
function showUpdateModal(info) {
  if (!info || !info.latest) return;
  updateModalInfo.latest = info.latest;
  updateModalInfo.downloadUrl = info.downloadUrl || '';
  updateModalInfo.sha256 = typeof info.sha256 === 'string' ? info.sha256 : '';
  updateModalInfo.variant = info.variant === 'portable' ? 'portable' : info.variant === 'setup' ? 'setup' : state.variant === 'portable' ? 'portable' : 'setup';
  $('update-modal-latest').textContent = 'v' + info.latest;
  $('update-modal-current').textContent = 'v' + (info.current || '');
  $('update-modal-skip').checked = false;
  $('update-modal').hidden = false;
}
function hideUpdateModal() { $('update-modal').hidden = true; }

/* ---------- 历史对话 ---------- */

const HISTORY_CAP = 50;
function persistConversations() { storage.set('conversations', state.conversations); }
function renderHistory() {
  const list = $('history-list'); if (!list) return;
  list.replaceChildren();
  if (!state.conversations.length) {
    const empty = document.createElement('div'); empty.className = 'history-empty';
    empty.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chat"/></svg>';
    const p = document.createElement('p'); p.textContent = '暂无历史对话'; empty.appendChild(p);
    list.appendChild(empty); return;
  }
  for (const c of state.conversations) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'history-item' + (c.id === state.currentId ? ' active' : '');
    item.setAttribute('aria-current', c.id === state.currentId ? 'true' : 'false');
    const title = document.createElement('span'); title.className = 'history-item-title'; title.textContent = c.title; item.appendChild(title);
    const meta = document.createElement('span'); meta.className = 'history-item-meta';
    meta.textContent = `${relTime(c.updatedAt)} · ${c.messages.length} 条 · ${c.model || ''}`; item.appendChild(meta);
    item.title = c.title + '\n' + meta.textContent + '\n点击恢复对话';
    item.addEventListener('click', () => loadConversation(c.id));
    const del = document.createElement('span'); del.className = 'history-item-del'; del.setAttribute('role', 'button'); del.tabIndex = 0;
    del.setAttribute('aria-label', '删除对话：' + c.title);
    del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>';
    const doDelete = () => deleteConversation(c.id);
    del.addEventListener('click', (e) => { e.stopPropagation(); doDelete(); });
    del.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); doDelete(); } });
    item.appendChild(del);
    list.appendChild(item);
  }
}
function saveConversation() {
  if (!state.messages.length) return;
  const first = state.messages.find((m) => m.role === 'user');
  const title = (first ? first.content : '新对话').replace(/\s+/g, ' ').trim().slice(0, 24) || '新对话';
  const now = Date.now();
  const existing = state.conversations.find((c) => c.id === state.currentId);
  const record = {
    id: existing ? existing.id : 'c' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    title, model: $('chat-model').value, updatedAt: now,
    messages: state.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (existing) Object.assign(existing, record);
  else state.conversations.unshift(record);
  state.currentId = record.id;
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.conversations.length > HISTORY_CAP) {
    const dropped = state.conversations.slice(HISTORY_CAP);
    state.conversations = state.conversations.slice(0, HISTORY_CAP);
    if (dropped.some((c) => c.id === state.currentId)) state.currentId = null;
  }
  persistConversations(); renderHistory();
}
function loadConversation(id) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;
  state.currentId = conv.id;
  state.messages = conv.messages.map((m) => ({ role: m.role, content: m.content }));
  document.querySelectorAll('.message').forEach((el) => el.remove()); // 保留 #chat-empty 节点
  $('chat-empty').hidden = true; $('chat-alert').hidden = true;
  for (const m of state.messages) appendMessage(m.role, m.content);
  if (conv.model && [...$('chat-model').options].some((o) => o.value === conv.model)) $('chat-model').value = conv.model;
  renderHistory(); $('chat-input').focus();
}
function deleteConversation(id) {
  const index = state.conversations.findIndex((c) => c.id === id);
  if (index === -1) return;
  const [removed] = state.conversations.splice(index, 1);
  if (state.currentId === id) { state.currentId = null; }
  persistConversations(); renderHistory();
  toast(`已删除「${removed.title}」`, { label: '撤销', onClick: () => {
    state.conversations.splice(Math.min(index, state.conversations.length), 0, removed);
    persistConversations(); renderHistory(); toast('已恢复');
  } });
}
function newConversation() {
  if (state.sending) return;
  state.messages = []; state.currentId = null;
  resetConversation(); renderHistory();
  $('chat-input').focus();
}

/* ---------- 对话 ---------- */

function resetConversation() { document.querySelectorAll('.message').forEach(el => el.remove()); $('chat-empty').hidden = false; $('chat-alert').hidden = true; $('chat-status').textContent = ''; }
function appendMessage(role, text) {
  $('chat-empty').hidden = true;
  const row = document.createElement('div'); row.className = 'message ' + role;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true');
  if (role === 'assistant') avatar.innerHTML = '<svg class="brand-mark"><use href="#raccoon"/></svg>'; else avatar.textContent = '你';
  const content = document.createElement('div'); content.className = 'message-content'; const name = document.createElement('div'); name.className = 'message-name'; name.textContent = role === 'assistant' ? 'RaccoonProxy · ' + $('chat-model').value : '你';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  let thoughtWrap = null, thoughtBody = null;
  if (role === 'assistant') {
    thoughtWrap = document.createElement('details'); thoughtWrap.className = 'thought'; thoughtWrap.hidden = true;
    const summary = document.createElement('summary'); summary.textContent = '思考过程'; thoughtWrap.appendChild(summary);
    thoughtBody = document.createElement('div'); thoughtBody.className = 'thought-body'; thoughtWrap.appendChild(thoughtBody);
    bubble.appendChild(thoughtWrap);
  }
  const answer = document.createElement('div'); answer.className = 'answer'; answer.textContent = text; bubble.appendChild(answer);
  content.append(name, bubble); row.append(avatar, content); $('chat-messages').appendChild(row); scrollChat(true);
  return { row, bubble, content, answer, thoughtWrap, thoughtBody };
}
function scrollChat(force = false) { const el = $('chat-messages'); if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight; }
function setSending(value) { state.sending = value; $('send-label').textContent = value ? '停止' : '发送'; $('send-icon').setAttribute('href', value ? '#i-stop' : '#i-arrow'); $('send-message').setAttribute('aria-label', value ? '停止生成' : '发送消息'); $('chat-model').disabled = value; $('chat-effort').disabled = value; $('system-prompt').disabled = value; $('new-chat').disabled = value; $('history-new').disabled = value; $('chat-messages').setAttribute('aria-busy', String(value)); }
async function consumeSSE(response, onText, signal, onReasoning) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let doneMarker = false;
  function dispatch(frame) { const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim(); if (!data || doneMarker) return; if (data === '[DONE]') { doneMarker = true; return; } let parsed; try { parsed = JSON.parse(data); } catch { throw new Error('invalid-stream'); } if (parsed.error) throw new Error('api-error'); const delta = parsed.choices?.[0]?.delta || {}; if (typeof delta.reasoning_content === 'string' && onReasoning) onReasoning(delta.reasoning_content); if (typeof delta.content === 'string') onText(delta.content); }
  try { while (true) { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); const part = await reader.read(); buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done }); buffer = buffer.replace(/\r\n/g, '\n'); let boundary; while ((boundary = buffer.indexOf('\n\n')) !== -1) { dispatch(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); } if (part.done || doneMarker) break; } if (buffer.trim() && !doneMarker) dispatch(buffer); }
  finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}
async function sendMessage(event) {
  event.preventDefault(); if (state.sending) { state.controller?.abort(); return; }
  const text = $('chat-input').value.trim(); if (!text) { $('chat-input').focus(); return; }
  if (state.busy) { toast('服务正在处理中，请稍后发送'); return; }
  if (!state.running) { $('chat-alert').textContent = '服务已停止，请先在仪表盘开启代理服务。'; $('chat-alert').hidden = false; return; }
  $('chat-alert').hidden = true; appendMessage('user', text); $('chat-input').value = ''; $('chat-input').style.height = '42px';
  const reply = appendMessage('assistant', ''); reply.bubble.classList.add('streaming'); setSending(true); $('chat-status').textContent = '正在等待模型响应';
  const liveStatus = document.createElement('div'); liveStatus.className = 'message-status'; liveStatus.textContent = '等待上游响应…'; reply.content.appendChild(liveStatus);
  let phase = 'waiting';
  const controller = new AbortController(); state.controller = controller; let timedOut = false; let timeout; let raw = ''; let drawn = ''; let reasoning = ''; let finished = false;
  const effort = $('chat-effort').value;
  function armTimeout() { clearTimeout(timeout); timeout = setTimeout(() => { timedOut = true; controller.abort(); }, effort === 'high' ? 240000 : 120000); }
  const painter = setInterval(() => { if (drawn.length < raw.length) { const size = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? raw.length : Math.max(2, Math.ceil((raw.length - drawn.length) / 10)); drawn = raw.slice(0, drawn.length + size); reply.answer.textContent = drawn; scrollChat(); } }, 22);
  const model = $('chat-model').value; const pending = [...state.messages, { role: 'user', content: text }]; const system = $('system-prompt').value.trim();
  addLog(`POST /v1/chat/completions → ${model}${effort ? ' · 思考:' + effort : ''}`); armTimeout(); const started = performance.now();
  try {
    const headers = { 'Content-Type': 'application/json' }; if (state.settings.apiKey) headers.Authorization = 'Bearer ' + state.settings.apiKey;
    const bodyObj = { model, messages: system ? [{ role: 'system', content: system }, ...pending] : pending, stream: true };
    if (effort) bodyObj.reasoning_effort = effort;
    const response = await fetch(baseUrl() + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: controller.signal });
    if (!response.ok) { const error = new Error('http'); error.status = response.status; throw error; }
    if ((response.headers.get('content-type') || '').includes('text/event-stream') && response.body) await consumeSSE(response, chunk => { raw += chunk; armTimeout(); if (phase !== 'answering') { phase = 'answering'; liveStatus.textContent = '生成中…'; } }, controller.signal, chunk => { reasoning += chunk; if (reply.thoughtWrap) { reply.thoughtWrap.hidden = false; reply.thoughtBody.textContent = reasoning; } if (phase === 'waiting') { phase = 'reasoning'; } if (phase === 'reasoning') { liveStatus.textContent = '思考中… ' + reasoning.length + ' 字'; scrollChat(); } });
    else { const result = await response.json(); if (result.error) throw new Error('api-error'); const msg = result.choices?.[0]?.message || {}; raw = msg.content || ''; if (typeof raw !== 'string') throw new Error('invalid-response'); if (typeof msg.reasoning_content === 'string' && msg.reasoning_content && reply.thoughtWrap) { reasoning = msg.reasoning_content; reply.thoughtWrap.hidden = false; reply.thoughtBody.textContent = reasoning; } }
    clearTimeout(timeout); if (!raw.trim()) throw new Error('empty-response');
    while (drawn.length < raw.length && !controller.signal.aborted) await sleep(25);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    state.messages = [...pending, { role: 'assistant', content: raw }]; finished = true;
    const note = document.createElement('div'); note.className = 'message-note'; note.textContent = `响应完成 · ${((performance.now() - started) / 1000).toFixed(1)} 秒`; reply.content.appendChild(note);
    addLog(`200 · ${model} · 响应完成`); $('chat-status').textContent = '模型响应完成';
    saveConversation();
  } catch (error) {
    const interrupted = error.name === 'AbortError' && !timedOut;
    let message = interrupted ? '已停止生成' : timedOut ? '请求超时，请检查本地服务或稍后重试。' : error.status === 401 || error.status === 403 ? '鉴权失败，请检查本地 API Key 和账户权限。' : error.status === 404 ? '未找到接口或模型，请检查本地服务与模型配置。' : error.status === 429 ? '请求过于频繁，请稍后重试。' : error.message === 'empty-response' ? '服务未返回有效内容，请更换模型后重试。' : error.message === 'api-error' ? '本地服务返回错误，请检查账户权限或服务日志。' : error.status ? `请求失败（HTTP ${error.status}），请检查服务日志。` : error.message === 'invalid-stream' || error.message === 'invalid-response' ? '响应格式不正确，请检查本地接口是否兼容。' : '无法连接本地服务，请确认代理进程已启动且允许本地请求。';
    reply.answer.textContent = raw || message;
    if (raw) { const note = document.createElement('div'); note.className = 'message-note'; note.textContent = message; reply.content.appendChild(note); if (interrupted) state.messages = [...pending, { role: 'assistant', content: raw }]; }
    else { if (!interrupted) reply.bubble.classList.add('error'); const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = '重新编辑这条消息'; retry.addEventListener('click', () => { $('chat-input').value = text; $('chat-input').focus(); }); reply.content.appendChild(retry); }
    addLog(message, interrupted ? 'warn' : 'error'); $('chat-status').textContent = message;
    if (raw) saveConversation();
  } finally { clearInterval(painter); clearTimeout(timeout); if (finished) reply.answer.textContent = raw; liveStatus.remove(); reply.bubble.classList.remove('streaming'); setSending(false); state.controller = null; scrollChat(); $('chat-input').focus(); }
}

/* ---------- 事件绑定与启动 ---------- */

document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)));
document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.go)));
document.querySelectorAll('[data-prompt]').forEach(el => el.addEventListener('click', () => { $('chat-input').value = el.dataset.prompt; $('chat-input').focus(); }));
document.querySelectorAll('[data-reveal]').forEach(el => el.addEventListener('click', () => { const input = $(el.dataset.reveal); input.type = input.type === 'password' ? 'text' : 'password'; const label = (input.type === 'password' ? '显示' : '隐藏') + (input.id === 'password' ? '密码' : '本地 API Key'); el.setAttribute('aria-label', label); el.title = label; }));
$('theme-toggle').addEventListener('click', () => setTheme(state.theme === 'light' ? 'dark' : 'light'));
$('service-toggle').addEventListener('click', toggleService);
$('copy-base-url').addEventListener('click', () => copy(baseUrl(), ' Base URL', $('copy-base-url')));
$('copy-api-key').addEventListener('click', () => { if (state.settings.apiKey) copy(state.settings.apiKey, ' API Key', $('copy-api-key')); });
$('reveal-key').addEventListener('click', () => { state.keyVisible = !state.keyVisible; $('reveal-key').setAttribute('aria-label', state.keyVisible ? '隐藏 API Key' : '显示 API Key'); $('reveal-key').title = state.keyVisible ? '隐藏 API Key' : '显示 API Key'; updateService(); });
$('clear-logs').addEventListener('click', () => { $('log-lines').replaceChildren(); const empty = document.createElement('div'); empty.className = 'log-empty'; empty.textContent = '日志已清空,等待新的请求…'; $('log-lines').appendChild(empty); state.logCount = 0; $('log-count').textContent = '0 条'; toast('日志已清空'); });
$('auto-start').addEventListener('click', () => { state.autoStartDraft = !state.autoStartDraft; $('auto-start').setAttribute('aria-checked', String(state.autoStartDraft)); });
$('update-check').addEventListener('click', checkForUpdateUI);
$('update-download').addEventListener('click', downloadUpdateUI);
$('update-install').addEventListener('click', installUpdateUI);
if (hasBridge('onUpdateProgress')) bridge.onUpdateProgress(handleUpdateProgress);
$('checkin-btn').addEventListener('click', checkinNow);
$('update-modal-later').addEventListener('click', () => {
  if ($('update-modal-skip').checked && updateModalInfo.latest && hasBridge('dismissUpdate')) bridge.dismissUpdate({ latest: updateModalInfo.latest });
  hideUpdateModal();
});
$('update-modal-go').addEventListener('click', () => {
  hideUpdateModal();
  navigate('settings');
  if (updateModalInfo.downloadUrl) {
    updateInfo.latest = updateModalInfo.latest;
    updateInfo.downloadUrl = updateModalInfo.downloadUrl;
    updateInfo.variant = updateModalInfo.variant;
    updateInfo.sha256 = updateModalInfo.sha256;
    $('update-state').textContent = `发现新版本 v${updateModalInfo.latest},开始下载${updateModalInfo.variant === 'portable' ? '便携版' : '安装包'}…`;
    downloadUpdateUI();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('update-modal').hidden) hideUpdateModal(); });
if (hasBridge('onUpdateAvailable')) bridge.onUpdateAvailable(showUpdateModal);
$('settings-form').addEventListener('submit', saveSettings);
$('settings-form').addEventListener('input', () => $('save-result').hidden = true);
$('chat-form').addEventListener('submit', sendMessage);
$('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.sending) $('chat-form').requestSubmit(); } });
$('chat-input').addEventListener('input', () => { $('chat-input').style.height = '42px'; $('chat-input').style.height = Math.min($('chat-input').scrollHeight, 140) + 'px'; });
$('new-chat').addEventListener('click', newConversation);
$('history-new').addEventListener('click', newConversation);
$('toast-action').addEventListener('click', hideToast);
window.addEventListener('pagehide', () => state.controller?.abort());

setTheme(state.theme); populateSettings(); updateService(); renderModels(); renderHistory(); navigate(storage.get('page', 'dashboard'));
refreshPoints(true);
if (nativeService) {
  $('service-toggle').disabled = true;
  bridge.getStatus().then(status => { state.running = status.running === true; if (status.variant) state.variant = status.variant === 'portable' ? 'portable' : 'setup'; if (status.settings) Object.assign(state.settings, status.settings); if (!(Number.isInteger(state.settings.port) && state.settings.port >= 1024 && state.settings.port <= 65535)) state.settings.port = 8317; if (status.version) { document.querySelector('.rail-version').textContent = 'v' + status.version; $('update-current').textContent = 'v' + status.version; } $('log-lines').replaceChildren(); state.logCount = 0; if (Array.isArray(status.logs)) status.logs.forEach(entry => addLog(String(entry.line || entry.message || ''), entry.stream === 'err' ? 'error' : 'info')); addLog('已连接本机服务进程'); populateSettings(); updateService(); applyUpstream({ upstream: status.upstream, models: status.models, tokenExpiresAt: status.tokenExpiresAt, defaultModel: status.defaultModel }); refreshPoints(true); }).catch(() => { state.running = false; updateService(); addLog('无法读取本机服务状态', 'error'); });
  if (typeof bridge.onLog === 'function') bridge.onLog(entry => addLog(String(entry.message || ''), entry.level || 'info'));
  if (typeof bridge.onState === 'function') bridge.onState(st => { if (st.state === 'error' && st.error) addLog(st.error, 'error'); if (state.busy) return; const running = st.state === 'running'; if (state.running !== running) { state.running = running; updateService(); addLog(running ? '服务已启动' : '服务已停止'); if (running) refreshPoints(true); } });
  if (typeof bridge.onHealth === 'function') bridge.onHealth(h => { if (h.ok) { applyUpstream(h); refreshPoints(); } });
  $('credentials-note').textContent = '账户凭据交由桌面应用处理；主题、端口与启动偏好保存在本机。';
} else if (state.settings.autoStart) addLog('演示：已按启动偏好开启服务');
