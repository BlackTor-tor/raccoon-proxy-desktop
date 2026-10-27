const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', '.shots');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 780, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 1500));
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-page="settings"]').click();
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('.update-block').scrollIntoView({ block: 'start' });
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('update-check').click();
    await new Promise(r => setTimeout(r, 300));
  })()`);
  await new Promise(r => setTimeout(r, 400));
  const png = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(OUT, 'settings-update-fallback.png'), png);
  console.log('[shot] settings-update-fallback.png', png.length);
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
