const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const demos = [
  ['direction-a-quiet-studio.html', 'direction-a.png'],
  ['direction-b-console.html', 'direction-b.png'],
  ['direction-c-paper-ledger.html', 'direction-c.png'],
];
app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'design-demos');
  const win = new BrowserWindow({ show: false, width: 1280, height: 832, webPreferences: { offscreen: true } });
  for (const [src, out] of demos) {
    try {
      await win.loadFile(path.join(outDir, src));
      await new Promise((r) => setTimeout(r, 1200));
      let png = Buffer.alloc(0);
      for (let i = 0; i < 8 && png.length < 8000; i++) {
        win.webContents.invalidate();
        await new Promise((r) => setTimeout(r, 350));
        png = (await win.webContents.capturePage()).toPNG();
      }
      fs.writeFileSync(path.join(outDir, out), png);
      console.log('OK', out, png.length);
    } catch (e) {
      console.log('ERR', src, e.message);
    }
  }
  app.exit(0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
