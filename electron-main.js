const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

// 渲染进程桥接契约(window.raccoonProxy):
//   getStatus() -> {running, port, tokenExpiresAt, settings, version}
//   startService()/stopService() -> {ok, error?}
//   saveSettings(value) -> {ok}   value={countryCode, phone, password, port, apiKey, autoStart}
//   onLog(cb) cb({message, level}) / onState(cb) cb({state, error}) / onHealth(cb) cb({ok, tokenExpiresAt})
const DEFAULTS = {
  phone: '',
  password: '',
  countryCode: '+86',
  port: 8317,
  apiKey: '',
  autoStart: true,
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
        if (state === 'starting') setState('running');
        send('proxy:health', { ok: true, tokenExpiresAt: lastTokenExp });
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
  // 供端到端自检:RACCOON_SHOT=路径 时启动 4 秒后截图
  if (process.env.RACCOON_SHOT) {
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.RACCOON_SHOT, img.toPNG());
        console.log(`[shot] ${process.env.RACCOON_SHOT}`);
      } catch (e) {
        console.error('[shot] failed', e.message);
      }
    }, 4000);
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
  settings,
  version: app.getVersion(),
  logs: logBuf,
}));

ipcMain.handle('service:start', () => startProxy());
ipcMain.handle('service:stop', async () => {
  await stopProxy();
  return { ok: true };
});

// 只负责持久化;是否重启服务由渲染端按运行状态编排(stop -> save -> start)
ipcMain.handle('settings:save', (_e, v) => {
  settings = {
    countryCode: /^\+\d{1,4}$/.test(String(v.countryCode || '').trim()) ? String(v.countryCode).trim() : '+86',
    phone: String(v.phone ?? '').trim(),
    password: String(v.password ?? ''),
    port: Math.min(65535, Math.max(1024, Math.floor(Number(v.port)) || 8317)),
    apiKey: String(v.apiKey ?? '').trim(),
    autoStart: v.autoStart === true,
  };
  persistSettings();
  updateTray();
  return { ok: true };
});
