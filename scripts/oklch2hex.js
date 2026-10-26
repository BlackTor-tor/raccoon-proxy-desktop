const { app, BrowserWindow } = require('electron');
const colors = process.argv.slice(2);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<body></body>');
  const out = await win.webContents.executeJavaScript(`(${JSON.stringify(colors)}).map(c => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    return c + ' ' + hex;
  })`);
  console.log(out.join('\n'));
  app.exit(0);
});
