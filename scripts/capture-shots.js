// 视觉验收截图:offscreen 渲染三页 + 设置页更新块交互态
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', '.shots');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 780, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1500));
  const shot = async (name) => {
    for (let i = 0; i < 10; i++) {
      const png = (await win.webContents.capturePage()).toPNG();
      if (png.length > 8000) { fs.writeFileSync(path.join(OUT, name), png); console.log('[shot]', name, png.length); return; }
      await new Promise(r => setTimeout(r, 300));
    }
    console.log('[shot] FAILED', name);
  };
  const go = async (page) => { await win.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click(); new Promise(r=>setTimeout(r,300))`); await new Promise(r => setTimeout(r, 500)); };
  await go('dashboard'); await shot('dashboard.png');
  await go('settings'); await shot('settings.png');
  await win.webContents.executeJavaScript(`document.getElementById('update-check').click(); new Promise(r=>setTimeout(r,300))`);
  await new Promise(r => setTimeout(r, 400));
  await shot('settings-update-fallback.png');
  await go('playground'); await shot('playground.png');
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
