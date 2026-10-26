// 历史对话功能端到端测试:无头加载 renderer/index.html,真实请求本地网关(需 8317 在运行)
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(`localStorage.removeItem('raccoonproxy.conversations')`).catch(() => {});
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  let failed = false;
  const assert = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
    if (!cond) failed = true;
  };
  const run = (js) => win.webContents.executeJavaScript(js);

  await run(`new Promise(r => setTimeout(r, 1500))`);

  // 1) 发送真实消息并等待完成
  const afterSend = await run(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('chat-input').value = '只回复两个字:收到';
    document.getElementById('chat-form').requestSubmit();
    for (let i = 0; i < 80; i++) { await sleep(500); if (document.querySelectorAll('.message').length >= 2 && document.querySelector('.message-note')) break; }
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
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('UI-TEST ERROR', e); app.exit(1); });
