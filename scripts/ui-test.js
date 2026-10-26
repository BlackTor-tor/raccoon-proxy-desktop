// 历史对话 + 导航回归测试:内置 mock 网关(8318),不依赖真实上游,完全确定性
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');

// ---- mock 网关:SSE 流式回 "收到" ----
const upstream = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, token_exp: '2026-11-25T00:00:00Z', upstream: { state: 'ok', modelCount: 7 }, models: ['m1', 'm2'], default_model: 'm1' }));
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  const frame = (s) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
  res.write(frame(''));
  setTimeout(() => res.write(frame('收到')), 150);
  setTimeout(() => { res.write(frame('!')); res.write('data: [DONE]\n\n'); res.end(); }, 400);
});

app.whenReady().then(async () => {
  await new Promise((resolve) => upstream.listen(8318, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 指向 mock 网关并清空历史,再重载生效
  await win.webContents.executeJavaScript(`localStorage.removeItem('raccoonproxy.conversations'); localStorage.setItem('raccoonproxy.preferences', JSON.stringify({ port: 8318 }))`).catch(() => {});
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  let failed = false;
  const assert = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
    if (!cond) failed = true;
  };
  const run = (js) => win.webContents.executeJavaScript(js);

  await run(`new Promise(r => setTimeout(r, 1500))`);

  // 0) 导航回归:hidden 页面必须真正隐藏(回归:v1.3.0 丢过 [hidden] 规则)
  const navBefore = await run(`(async () => {
    const disp = id => getComputedStyle(document.getElementById(id)).display;
    document.querySelector('[data-page="settings"]').click();
    await new Promise(r => setTimeout(r, 250));
    const afterSettings = { dashboard: disp('page-dashboard'), settings: disp('page-settings') };
    document.querySelector('[data-page="dashboard"]').click();
    await new Promise(r => setTimeout(r, 250));
    const afterDashboard = { dashboard: disp('page-dashboard'), settings: disp('page-settings') };
    return { afterSettings, afterDashboard, bodyRatio: +(document.body.scrollHeight / window.innerHeight).toFixed(2) };
  })()`);
  assert('导航切换:点击设置后仅设置页可见', navBefore.afterSettings.dashboard === 'none' && navBefore.afterSettings.settings !== 'none', navBefore.afterSettings);
  assert('导航切换:点击仪表盘后仅仪表盘可见', navBefore.afterDashboard.dashboard !== 'none' && navBefore.afterDashboard.settings === 'none', navBefore.afterDashboard);
  assert('页面不叠放(无双滚动条根因)', navBefore.bodyRatio <= 1.05, navBefore.bodyRatio);

  // 1) 切到对话调试页(真实用户路径),发送消息(mock 网关秒回)
  await run(`(async () => { document.querySelector('[data-page="playground"]').click(); await new Promise(r => setTimeout(r, 300)); })()`);
  const afterSend = await run(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('chat-input').value = '只回复两个字:收到';
    document.getElementById('chat-form').requestSubmit();
    for (let i = 0; i < 40; i++) { await sleep(500); if (document.querySelector('.message-note') || document.querySelector('.message .text-button')) break; }
    return {
      messages: document.querySelectorAll('.message').length,
      historyItems: document.querySelectorAll('.history-item').length,
      stored: JSON.parse(localStorage.getItem('raccoonproxy.conversations') || '[]').length,
      bubble: (document.querySelectorAll('.message .bubble')[1] || {}).textContent || '',
      title: (document.querySelector('.history-item-title') || {}).textContent || '',
    };
  })()`);
  assert('发送后产生对话与历史记录', afterSend.messages >= 2 && afterSend.historyItems === 1 && afterSend.stored === 1, afterSend);
  assert('助手有真实回复', afterSend.bubble.trim().length > 0, afterSend.bubble.slice(0, 40));
  assert('历史标题取自首条消息', afterSend.title.includes('收到') || afterSend.title.length > 0, afterSend.title);

  // 2) 新对话:消息清空,历史保留
  const afterNew = await run(`(async () => {
    document.getElementById('new-chat').click();
    await new Promise(r => setTimeout(r, 300));
    return { messages: document.querySelectorAll('.message').length, history: document.querySelectorAll('.history-item').length, empty: !document.getElementById('chat-empty').hidden };
  })()`);
  assert('新对话清空消息且保留历史', afterNew.messages === 0 && afterNew.history === 1 && afterNew.empty === true, afterNew);

  // 3) 点击历史恢复对话
  const afterLoad = await run(`(async () => {
    document.querySelector('.history-item').click();
    await new Promise(r => setTimeout(r, 300));
    return { messages: document.querySelectorAll('.message').length, active: document.querySelectorAll('.history-item.active').length };
  })()`);
  assert('恢复历史对话', afterLoad.messages === 2 && afterLoad.active === 1, afterLoad);

  // 4) 删除 + 撤销
  const afterDelete = await run(`(async () => {
    document.querySelector('.history-item-del').click();
    await new Promise(r => setTimeout(r, 300));
    return { history: document.querySelectorAll('.history-item').length, toastVisible: document.getElementById('toast').classList.contains('visible') };
  })()`);
  assert('删除后历史清空且 toast 提示', afterDelete.history === 0 && afterDelete.toastVisible === true, afterDelete);
  const afterUndo = await run(`(async () => {
    document.getElementById('toast-action').click();
    await new Promise(r => setTimeout(r, 300));
    return { history: document.querySelectorAll('.history-item').length };
  })()`);
  assert('撤销恢复历史', afterUndo.history === 1, afterUndo);

  // 5) 重载页面后历史持久化
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await run(`new Promise(r => setTimeout(r, 1200))`);
  const afterReload = await run(`({ history: document.querySelectorAll('.history-item').length })`);
  assert('重载后历史仍在', afterReload.history === 1, afterReload);

  console.log(failed ? 'UI-TEST FAIL' : 'UI-TEST ALL PASS');
  upstream.close();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('UI-TEST ERROR', e); app.exit(1); });
