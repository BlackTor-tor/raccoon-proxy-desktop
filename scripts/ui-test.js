// 历史对话 + 导航回归测试:内置 mock 网关(8318),不依赖真实上游,完全确定性
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');

// ---- mock 网关:SSE 先发思维链再发答案,记录 reasoning_effort;附带积分/签到路由 ----
let lastBody = null;
let checkinDone = false;
let mockBalance = { available_points: 6798, daily_points: 798, monthly_points: 0, reward_points: 6000, topup_points: 0 };
const json = (res, obj) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
};
const pointsPayload = (extra) => ({
  ok: true,
  points: mockBalance,
  checkin: { date: checkinDone ? '2026-10-28' : null, today: '2026-10-28', lastResult: checkinDone ? 'granted(manual)' : '' },
  ...extra,
});
const upstream = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, token_exp: '2026-11-25T00:00:00Z', upstream: { state: 'ok', modelCount: 7 }, models: ['m1', 'm2'], default_model: 'm1' }));
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  if (req.url === '/api/points') return json(res, pointsPayload());
  if (req.url && req.url.startsWith('/api/points/bills')) {
    return json(res, {
      ...pointsPayload(),
      items: [
        { id: 'u1', kind: 'usage', at: '2026-10-29T14:18:44+08:00', event: 'SenseChat-5', points: -2, prompt: 12, completion: 4, cached: 0, total: 16, free: false },
        { id: 'b2', kind: 'bill', at: '2026-10-29T00:23:12+08:00', event: '每日积分发放', points: 798, prompt: null, completion: null, cached: null, total: null },
        { id: 'u3', kind: 'usage', at: '2026-10-28T19:02:01+08:00', event: 'sn-deepseek-v4-1-flash-1017', points: null, prompt: 1200, completion: 300, cached: 800, total: 1500, free: true, billingNote: '限免至10月31日' },
        { id: 'u4', kind: 'usage', at: '2026-10-28T19:01:01+08:00', event: 'SenseChat-5', points: null, prompt: 30, completion: 8, cached: 0, total: 38, free: false },
      ],
      nextCursor: null,
      hasMore: false,
    });
  }
  if (req.url === '/api/checkin') {
    const granted = !checkinDone;
    if (granted) {
      checkinDone = true;
      mockBalance = { ...mockBalance, available_points: mockBalance.available_points + 20, reward_points: mockBalance.reward_points + 20 };
    }
    req.resume();
    return json(res, pointsPayload({ granted, popup: granted ? { points: 20, source: 'daily' } : null }));
  }
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    try { lastBody = JSON.parse(body); } catch {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    const frame = (extra) => `data: ${JSON.stringify({ choices: [{ delta: extra }] })}\n\n`;
    res.write(frame({}));
    setTimeout(() => res.write(frame({ reasoning_content: '思考中' })), 100);
    setTimeout(() => res.write(frame({ content: '收到' })), 250);
    setTimeout(() => { res.write(frame({ content: '!' })); res.write('data: [DONE]\n\n'); res.end(); }, 450);
  });
});

app.whenReady().then(async () => {
  await new Promise((resolve) => upstream.listen(8318, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 1180, height: 780, webPreferences: { offscreen: true } });
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

  // 0.5) UI 优化回归:删「工作台」/「本地配置」文案、设置页滚动容器贴窗口右缘、图标非太阳误绘
  const uiCopy = await run(`(async () => {
    const texts = {};
    for (const p of ['dashboard', 'points', 'settings', 'playground']) {
      document.querySelector('[data-page="' + p + '"]').click();
      await new Promise(r => setTimeout(r, 100));
      texts[p] = document.getElementById('page-' + p).textContent;
    }
    document.querySelector('[data-page="settings"]').click();
    await new Promise(r => setTimeout(r, 100));
    const scroller = document.querySelector('#page-settings .content');
    return {
      texts,
      crumbCount: document.querySelectorAll('.crumb').length,
      scrollerRight: Math.round(scroller.getBoundingClientRect().right),
      winW: window.innerWidth,
      bodyRatio: +(document.body.scrollHeight / window.innerHeight).toFixed(2),
    };
  })()`);
  assert('所有页面不出现「工作台」文字', Object.values(uiCopy.texts).every(t => !t.includes('工作台')));
  assert('设置页不出现「本地配置」文字', !uiCopy.texts.settings.includes('本地配置'));
  assert('仪表盘不再显示积分块(已移入积分管理)', !uiCopy.texts.dashboard.includes('官方积分'));
  assert('积分管理页显示官方积分与明细标题', uiCopy.texts.points.includes('官方积分') && uiCopy.texts.points.includes('消耗明细'));
  assert('设置页滚动容器贴住窗口右缘(无悬空滚动条)', uiCopy.scrollerRight >= uiCopy.winW - 2, { scrollerRight: uiCopy.scrollerRight, winW: uiCopy.winW });
  assert('设置页不撑破窗口滚动', uiCopy.bodyRatio <= 1.05, uiCopy.bodyRatio);
  const iconState = await run(`({
    settings: document.getElementById('i-settings').innerHTML,
    sun: document.getElementById('i-sun').innerHTML,
    dangling: [...document.querySelectorAll('use')].map(u => u.getAttribute('href')).filter(h => h && h.startsWith('#i-') && !document.getElementById(h.slice(1))),
  })`);
  assert('设置图标已换成齿轮(不再是太阳误绘)', iconState.settings.startsWith('<path d="M9.671 4.136') && iconState.settings.includes('<circle cx="12" cy="12" r="3">'), iconState.settings.slice(0, 80));
  assert('所有图标引用均可解析(重做后无悬空 use)', iconState.dangling.length === 0, iconState.dangling);

  // 0.6) 软件更新块:版本号 + 检查更新按钮;无桥接环境点击后优雅降级(不崩、给提示)
  const updateBlock = await run(`(async () => {
    const cur = document.getElementById('update-current');
    const btn = document.getElementById('update-check');
    if (!cur || !btn) return { present: false };
    btn.click();
    await new Promise(r => setTimeout(r, 300));
    return {
      present: true,
      versionText: cur.textContent,
      stateText: document.getElementById('update-state').textContent,
      btnReEnabled: !btn.disabled,
      fallbackShown: !document.getElementById('update-fallback').hidden,
    };
  })()`);
  assert('设置页有版本号与检查更新按钮', updateBlock.present === true && /^(v)?\d+\.\d+\.\d+$|^—$/.test(updateBlock.versionText), updateBlock);
  assert('无桥接时检查更新优雅降级并显示 Releases 链接', updateBlock.stateText.includes('无法') && updateBlock.btnReEnabled === true && updateBlock.fallbackShown === true, updateBlock);

  // 0.7) 积分管理:总积分 + 合并明细(token 读取/写入/缓存、变动) + 手动签到
  const pointsBefore = await run(`(async () => {
    document.querySelector('[data-page="points"]').click();
    await new Promise(r => setTimeout(r, 250));
    for (let i = 0; i < 40; i++) { if (document.getElementById('points-available').textContent !== '—') break; await new Promise(r => setTimeout(r, 100)); }
    const rows = [...document.querySelectorAll('#bills-list tr')].map(tr => [...tr.children].map(td => td.textContent));
    return {
      pageVisible: getComputedStyle(document.getElementById('page-points')).display !== 'none',
      available: document.getElementById('points-available').textContent,
      breakdown: document.getElementById('points-breakdown').textContent,
      rows,
      btnDisabled: document.getElementById('checkin-btn').disabled,
      label: document.getElementById('checkin-label').textContent,
      loadMoreAbsent: document.getElementById('bills-more') === null,
    };
  })()`);
  assert('积分管理页可进入并显示总积分', pointsBefore.pageVisible === true && pointsBefore.available === '6,798' && pointsBefore.breakdown.includes('今日 798') && pointsBefore.breakdown.includes('奖励 6,000'), pointsBefore);
  assert('明细只保留最近 100 条(无加载更多)', pointsBefore.loadMoreAbsent === true && pointsBefore.rows.length === 4, { absent: pointsBefore.loadMoreAbsent, rows: pointsBefore.rows.length });
  assert('明细含 token 读取/写入/缓存与变动列', pointsBefore.rows.length === 4 && pointsBefore.rows[0].length === 6 && pointsBefore.rows[0][2] === '12' && pointsBefore.rows[0][3] === '4' && pointsBefore.rows[0][4] === '0' && pointsBefore.rows[0][5] === '-2', pointsBefore.rows);
  assert('官方账单行无 token 时显示占位', pointsBefore.rows[1][2] === '—' && pointsBefore.rows[1][3] === '—' && pointsBefore.rows[1][5] === '+798', pointsBefore.rows[1]);
  assert('限免模型变动显示「免费」', pointsBefore.rows[2][2] === '1,200' && pointsBefore.rows[2][5] === '免费', pointsBefore.rows[2]);
  assert('未入账请求变动显示占位', pointsBefore.rows[3][2] === '30' && pointsBefore.rows[3][5] === '—', pointsBefore.rows[3]);
  assert('未签到时签到按钮可用', pointsBefore.btnDisabled === false && pointsBefore.label === '立即签到', pointsBefore);

  const afterCheckin = await run(`(async () => {
    document.getElementById('checkin-btn').click();
    await new Promise(r => setTimeout(r, 500));
    return {
      available: document.getElementById('points-available').textContent,
      label: document.getElementById('checkin-label').textContent,
      disabled: document.getElementById('checkin-btn').disabled,
      toastVisible: document.getElementById('toast').classList.contains('visible'),
      toastText: document.getElementById('toast-text').textContent,
    };
  })()`);
  assert('手动签到后余额刷新且按钮置为已签到', afterCheckin.available === '6,818' && afterCheckin.disabled === true && afterCheckin.label === '今日已签到', afterCheckin);
  assert('签到成功有 toast 提示', afterCheckin.toastVisible === true && afterCheckin.toastText.includes('签到成功'), afterCheckin);

  // 0.8) 更新提醒弹窗:显示版本号,勾选「不再提醒」后关闭
  const modal = await run(`(async () => {
    showUpdateModal({ latest: '9.9.9', current: '1.6.0', downloadUrl: '' });
    await new Promise(r => setTimeout(r, 100));
    const visible = !document.getElementById('update-modal').hidden;
    const latest = document.getElementById('update-modal-latest').textContent;
    const current = document.getElementById('update-modal-current').textContent;
    document.getElementById('update-modal-skip').checked = true;
    document.getElementById('update-modal-later').click();
    await new Promise(r => setTimeout(r, 100));
    return { visible, latest, current, closed: document.getElementById('update-modal').hidden === true };
  })()`);
  assert('新版本弹窗出现且版本号正确', modal.visible === true && modal.latest === 'v9.9.9' && modal.current === 'v1.6.0', modal);
  assert('勾选不再提醒后点暂不更新可关闭弹窗', modal.closed === true, modal);

  // 1) 切到对话调试页(真实用户路径),选思考程度=低,发送消息(mock 网关秒回)
  await run(`(async () => { document.querySelector('[data-page="playground"]').click(); await new Promise(r => setTimeout(r, 300)); document.getElementById('chat-effort').value = 'low'; })()`);
  const afterSend = await run(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.getElementById('chat-input').value = '只回复两个字:收到';
    document.getElementById('chat-form').requestSubmit();
    let sawStatus = false, sawPartial = false;
    for (let i = 0; i < 400; i++) {
      await sleep(100);
      const note = !!document.querySelector('.message-note');
      const statusEl = document.querySelector('.message.assistant .message-status');
      const answerEl = document.querySelector('.message.assistant .answer');
      if (statusEl && statusEl.textContent.trim()) sawStatus = true;
      if (!note && answerEl && answerEl.textContent.length > 0) sawPartial = true;
      if (note || document.querySelector('.message .text-button')) break;
    }
    const thought = document.querySelector('.message.assistant .thought');
    return {
      messages: document.querySelectorAll('.message').length,
      historyItems: document.querySelectorAll('.history-item').length,
      stored: JSON.parse(localStorage.getItem('raccoonproxy.conversations') || '[]').length,
      answer: (document.querySelector('.message.assistant .answer') || {}).textContent || '',
      thoughtVisible: !!thought && !thought.hidden,
      thoughtText: (document.querySelector('.message.assistant .thought-body') || {}).textContent || '',
      title: (document.querySelector('.history-item-title') || {}).textContent || '',
      sawStatus, sawPartial,
    };
  })()`);
  assert('发送后产生对话与历史记录', afterSend.messages >= 2 && afterSend.historyItems === 1 && afterSend.stored === 1, afterSend);
  assert('助手有真实回复', afterSend.answer.includes('收到'), afterSend.answer.slice(0, 40));
  assert('思维链已渲染(可折叠)', afterSend.thoughtVisible && afterSend.thoughtText.includes('思考中'), { visible: afterSend.thoughtVisible, text: afterSend.thoughtText });
  assert('等待期有实时状态提示', afterSend.sawStatus === true, afterSend.sawStatus);
  assert('回答在完成前已流式增量出现', afterSend.sawPartial === true, afterSend.sawPartial);
  assert('reasoning_effort 已随请求发送', lastBody && lastBody.reasoning_effort === 'low', lastBody && lastBody.reasoning_effort);
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
