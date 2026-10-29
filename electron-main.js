const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');
const { checkForUpdate, downloadFile, RELEASES_PAGE } = require('./updater');

// 渲染进程桥接契约(window.raccoonProxy):
//   getStatus() -> {running, port, tokenExpiresAt, settings, version}
//   startService()/stopService() -> {ok, error?}
//   saveSettings(value) -> {ok}   value={countryCode, phone, password, port, apiKey, autoStart}
//   checkUpdate() -> {ok, updateAvailable, current, latest, downloadUrl, pageUrl}
//   downloadUpdate({url, latest}) -> {ok, started}   进度经 onUpdateProgress 推送
//   installUpdate() -> {ok} / openReleases() -> {ok}
//   dismissUpdate({latest}) -> {ok}  记住「不再提醒这个版本」
//   onUpdateAvailable(cb) cb({latest, current})  后台发现新版本时推送(渲染层弹窗)
//   onLog(cb) cb({message, level}) / onState(cb) cb({state, error}) / onHealth(cb) cb({ok, tokenExpiresAt})
const DEFAULTS = {
  phone: '',
  password: '',
  countryCode: '+86',
  port: 8317,
  apiKey: '',
  autoStart: true,
  skipVersion: '', // 用户勾选「不再提醒」的版本号,只对该版本静默
};

let win = null;
let tray = null;
let child = null;
let quitting = false;
let state = 'stopped'; // stopped | starting | running | error
let lastError = '';
let logBuf = [];
let settings = null;
let healthTimer = null;
let lastTokenExp = null;
let lastUpstream = null;
let lastModels = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function persistSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
}

function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

function appendLog(line, stream = 'out') {
  const entry = { t: new Date().toISOString(), line: String(line), stream };
  logBuf.push(entry);
  if (logBuf.length > 300) logBuf.shift();
  send('proxy:log', entry);
}

function setState(s, err = '') {
  state = s;
  lastError = err;
  send('proxy:state', { state, error: err });
  updateTray();
}

function iconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function startProxy() {
  if (child) return { ok: true };
  if (!settings.phone || !settings.password) {
    const msg = '账号未配置:请先在「设置」页填写手机号与密码';
    setState('error', msg);
    appendLog(msg, 'err');
    return { ok: false, error: msg };
  }
  setState('starting');
  const env = {
    ...process.env,
    PORT: String(settings.port),
    HOST: '127.0.0.1',
    XHX_PHONE: settings.phone,
    XHX_PASSWORD: settings.password,
    XHX_NATION_CODE: settings.countryCode || '+86',
    PROXY_API_KEY: settings.apiKey || '',
    XHX_TOKEN_FILE: path.join(app.getPath('userData'), 'token.cache'),
    XHX_CHECKIN_FILE: path.join(app.getPath('userData'), 'checkin.json'),
  };
  try {
    child = fork(path.join(__dirname, 'proxy', 'server.js'), [], { env, silent: true });
  } catch (e) {
    child = null;
    setState('error', `服务进程启动失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
  child.stdout.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => appendLog(l, 'out')));
  child.stderr.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => appendLog(l, 'err')));
  child.on('exit', (code, signal) => {
    child = null;
    stopHealthPoll();
    lastTokenExp = null;
    lastUpstream = null;
    lastModels = null;
    const graceful = code === 0 || signal === 'SIGTERM';
    setState(
      graceful ? 'stopped' : 'error',
      graceful ? '' : `服务进程退出 (code=${code}${signal ? ` signal=${signal}` : ''})`
    );
  });
  startHealthPoll();
  return { ok: true };
}

function stopProxy() {
  return new Promise((resolve) => {
    if (!child) {
      if (state !== 'stopped') setState('stopped');
      return resolve();
    }
    const c = child;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    c.once('exit', done);
    try {
      c.kill();
    } catch {}
    setTimeout(done, 3000);
  });
}

function healthCheck() {
  const opts = {
    host: '127.0.0.1',
    port: Number(settings.port),
    path: '/health',
    timeout: 4000,
    headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
  };
  const req = http.get(opts, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      if (res.statusCode !== 200) {
        send('proxy:health', { ok: false });
        return;
      }
      try {
        const json = JSON.parse(body);
        lastTokenExp = json.token_exp || lastTokenExp;
        lastUpstream = json.upstream || lastUpstream;
        lastModels = json.models || lastModels;
        if (state === 'starting') setState('running');
        send('proxy:health', { ok: true, tokenExpiresAt: lastTokenExp, upstream: json.upstream, models: json.models, defaultModel: json.default_model });
      } catch {
        send('proxy:health', { ok: false });
      }
    });
  });
  req.on('error', () => send('proxy:health', { ok: false }));
  req.on('timeout', () => {
    req.destroy();
    send('proxy:health', { ok: false });
  });
}

function startHealthPoll() {
  stopHealthPoll();
  let settling = true; // 启动期密轮询,确认就绪后转慢轮询
  const tick = () => {
    if (!child) return;
    healthCheck();
    if (settling && state === 'running') settling = false;
    healthTimer = setTimeout(tick, settling ? 1500 : 12000);
  };
  tick();
}

function stopHealthPoll() {
  if (healthTimer) {
    clearTimeout(healthTimer);
    healthTimer = null;
  }
}

function updateTray() {
  if (!tray) return;
  const label = state === 'running' ? '运行中' : state === 'starting' ? '启动中…' : state === 'error' ? '异常' : '已停止';
  tray.setToolTip(`RaccoonProxy — ${label} (127.0.0.1:${settings ? settings.port : 8317})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开面板', click: showWindow },
      { type: 'separator' },
      { label: '开启服务', enabled: !child, click: () => startProxy() },
      { label: '停止服务', enabled: !!child, click: () => stopProxy() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    title: 'RaccoonProxy',
    autoHideMenuBar: true,
    backgroundColor: '#f7f8fa',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // 供端到端自检:RACCOON_SHOT=<前缀> 时启动 6 秒后连拍三页(重试直到拿到非空帧)
  if (process.env.RACCOON_SHOT) {
    setTimeout(async () => {
      const prefix = process.env.RACCOON_SHOT;
      const shot = async (name) => {
        for (let i = 0; i < 10; i++) {
          try {
            const png = (await win.webContents.capturePage()).toPNG();
            if (png.length > 8000) { fs.writeFileSync(prefix + name, png); console.log(`[shot] ${name} ${png.length}`); return; }
          } catch {}
          await new Promise((r) => setTimeout(r, 300));
        }
        console.log(`[shot] FAILED ${name}`);
      };
      const go = async (page) => { try { await win.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click(); new Promise(r=>setTimeout(r,500))`); } catch {} await new Promise((r) => setTimeout(r, 700)); };
      await go('dashboard'); await shot('dashboard.png');
      await go('settings'); await shot('settings.png');
      await go('playground'); await shot('playground.png');
    }, 6000);
  }
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    settings = loadSettings();
    createWindow();
    tray = new Tray(nativeImage.createFromPath(iconPath()));
    tray.on('click', showWindow);
    updateTray();
    if (settings.autoStart) startProxy();
    scheduleUpdateChecks();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopHealthPoll();
    stopProxy();
  });

  // 常驻托盘,关窗不退出
}

ipcMain.handle('app:status', () => ({
  running: state === 'running',
  state,
  error: lastError,
  port: settings.port,
  tokenExpiresAt: lastTokenExp,
  upstream: lastUpstream,
  models: lastModels,
  version: app.getVersion(),
  logs: logBuf,
}));

ipcMain.handle('service:start', () => startProxy());
ipcMain.handle('service:stop', async () => {
  await stopProxy();
  return { ok: true };
});

// 只负责持久化;是否重启服务由渲染端按运行状态编排(stop -> save -> start)
// skipVersion 不是表单字段,原地保留,避免保存设置时把「不再提醒」抹掉
ipcMain.handle('settings:save', (_e, v) => {
  settings = {
    countryCode: /^\+\d{1,4}$/.test(String(v.countryCode || '').trim()) ? String(v.countryCode).trim() : '+86',
    phone: String(v.phone ?? '').trim(),
    password: String(v.password ?? ''),
    port: Math.min(65535, Math.max(1024, Math.floor(Number(v.port)) || 8317)),
    apiKey: String(v.apiKey ?? '').trim(),
    autoStart: v.autoStart === true,
    skipVersion: typeof settings.skipVersion === 'string' ? settings.skipVersion : '',
  };
  persistSettings();
  updateTray();
  return { ok: true };
});

// ---- 软件更新:检查 / 下载(主进程网络,渲染进程无外网权限) / 安装 / 打开 Releases ----
let updateDownloading = false;
let updateFile = null;

ipcMain.handle('update:check', async () => {
  try {
    const info = await checkForUpdate({ currentVersion: app.getVersion() });
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), pageUrl: RELEASES_PAGE };
  }
});

ipcMain.handle('update:download', (_e, payload) => {
  const url = payload && typeof payload.url === 'string' ? payload.url : '';
  const latest = payload && typeof payload.latest === 'string' ? payload.latest.replace(/[^\w.-]/g, '') : '';
  if (!/^https:\/\//i.test(url)) return { ok: false, error: '下载地址无效' };
  if (updateDownloading) return { ok: false, error: '已有下载任务进行中' };
  updateDownloading = true;
  updateFile = null;
  const destFile = path.join(app.getPath('temp'), `RaccoonProxy-Setup-${latest || 'latest'}.exe`);
  send('update:progress', { status: 'downloading', received: 0, total: 0 });
  downloadFile({ url, destFile, onProgress: (p) => send('update:progress', { status: 'downloading', ...p }) })
    .then(() => {
      updateFile = destFile;
      send('update:progress', { status: 'ready', file: destFile, latest });
    })
    .catch((e) => {
      send('update:progress', { status: 'failed', message: String((e && e.message) || e), pageUrl: RELEASES_PAGE });
    })
    .finally(() => {
      updateDownloading = false;
    });
  return { ok: true, started: true };
});

ipcMain.handle('update:install', async () => {
  if (!updateFile || !fs.existsSync(updateFile)) return { ok: false, error: '未找到已下载的安装包,请先下载更新' };
  const err = await shell.openPath(updateFile);
  if (err) return { ok: false, error: err };
  setTimeout(() => app.quit(), 500); // 让安装器接管,退出本应用
  return { ok: true };
});

ipcMain.handle('update:open-page', async () => {
  await shell.openExternal(RELEASES_PAGE);
  return { ok: true };
});

// 「不再提醒这个版本」:记住版本号,后续后台检查对该版本静默(手动检查不受影响)
ipcMain.handle('update:dismiss', (_e, payload) => {
  const ver = String((payload && payload.latest) || '').replace(/[^\w.-]/g, '');
  if (ver) {
    settings.skipVersion = ver;
    persistSettings();
  }
  return { ok: true };
});

// ---- 后台自动检查更新:启动后 8 秒一次,之后每 4 小时;命中未静默的新版本即推给渲染层弹窗 ----
const UPDATE_CHECK_DELAY_MS = 8000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
let updateCheckTimer = null;

async function autoCheckUpdate() {
  try {
    const info = await checkForUpdate({ currentVersion: app.getVersion() });
    if (info.updateAvailable && info.latest && info.latest !== settings.skipVersion) {
      send('update:available', { latest: info.latest, current: app.getVersion(), downloadUrl: info.downloadUrl });
    }
  } catch {
    // 后台静默检查失败不打扰用户,设置页手动检查仍可用
  }
}

function scheduleUpdateChecks() {
  clearTimeout(updateCheckTimer);
  updateCheckTimer = setTimeout(() => {
    autoCheckUpdate();
    setInterval(autoCheckUpdate, UPDATE_CHECK_INTERVAL_MS);
  }, UPDATE_CHECK_DELAY_MS);
}
