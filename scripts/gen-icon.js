// 从 assets/logo.svg 生成 512x512 的 assets/icon.png(应用图标 / 打包图标)
const sharp = require('sharp');
const path = require('path');

(async () => {
  const src = path.join(__dirname, '..', 'assets', 'logo-icon.svg');
  const out = path.join(__dirname, '..', 'assets', 'icon.png');
  await sharp(src, { density: 384 }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(out);
  console.log('icon written:', out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
