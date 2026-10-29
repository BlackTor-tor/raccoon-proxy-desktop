// updater.js 单元测试:纯 Node 运行(node scripts/update-test.js),内置 mock HTTP 服务器,离线确定性
// 覆盖:版本比较 / 安装包挑选 / 检查更新 / 下载(重定向、瞬时失败重试、连续失败 3 次后兜底报错)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const updater = require('../updater');

let failed = false;
const assert = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
  if (!cond) failed = true;
};

const RELEASE = {
  tag_name: 'v1.5.0',
  assets: [
    { name: 'RaccoonProxy-1.5.0-portable.exe', browser_download_url: 'http://127.0.0.1:0/portable.exe', size: 90 },
    { name: 'RaccoonProxy-Setup-1.5.0.exe.blockmap', browser_download_url: 'http://127.0.0.1:0/blockmap', size: 1 },
    { name: 'RaccoonProxy-Setup-1.5.0.exe', browser_download_url: 'http://127.0.0.1:0/setup.exe', size: 80, digest: 'sha256:' + 'A'.repeat(64) },
    { name: 'latest.yml', browser_download_url: 'http://127.0.0.1:0/latest.yml', size: 1 },
  ],
};

// 未改名的 dist 产物(只有 Setup 带 setup 字样,另一个即便携版)
const RELEASE_UNRENAMED = {
  tag_name: 'v1.6.0',
  assets: [
    { name: 'RaccoonProxy Setup 1.6.0.exe', browser_download_url: 'http://127.0.0.1:0/setup.exe', size: 80 },
    { name: 'RaccoonProxy 1.6.0.exe', browser_download_url: 'http://127.0.0.1:0/portable.exe', size: 90 },
  ],
};

// 计数器在请求开始时自增;failTimes 次 500 后恢复 200
function makeServer({ failTimes = 0, redirect = false } = {}) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/releases/latest' || req.url === '/releases/unrenamed' || req.url === '/releases/setup-only') {
      const release = req.url === '/releases/unrenamed' ? RELEASE_UNRENAMED : req.url === '/releases/setup-only' ? { tag_name: 'v1.5.0', assets: [RELEASE.assets[2]] } : RELEASE;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(release));
    }
    if (redirect && req.url === '/setup.exe') {
      res.writeHead(302, { Location: 'http://127.0.0.1:' + server.address().port + '/real-file' });
      return res.end();
    }
    if (hits <= failTimes && req.url !== '/hits') {
      res.writeHead(500);
      return res.end('boom');
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 11 });
    res.end('hello-patch');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits: () => hits })));
}

(async () => {
  // 1) 版本比较:数字逐段比较,不是字符串比较
  assert('版本比较:新版本大于当前', updater.compareVersions('1.5.0', '1.4.1') === 1);
  assert('版本比较:相同版本返回 0', updater.compareVersions('v1.4.1', '1.4.1') === 0);
  assert('版本比较:逐段数字比较(1.10 > 1.9)', updater.compareVersions('1.10.0', '1.9.9') === 1);
  assert('版本比较:旧版本返回 -1', updater.compareVersions('1.3.9', '1.4.0') === -1);

  // 2) 安装包挑选:只选 NSIS Setup exe,忽略 portable/blockmap/yml
  const asset = updater.pickSetupAsset(RELEASE);
  assert('挑选 NSIS Setup 安装包', !!asset && asset.name === 'RaccoonProxy-Setup-1.5.0.exe', asset && asset.name);
  assert('无 Setup 包时返回 null', updater.pickSetupAsset({ assets: [{ name: 'latest.yml' }] }) === null);

  // 2.5) 便携版挑选:优先 portable 命名,兼容未改名产物,Setup 不会误判
  const portableAsset = updater.pickPortableAsset(RELEASE);
  assert('挑选便携版 exe', !!portableAsset && portableAsset.name === 'RaccoonProxy-1.5.0-portable.exe', portableAsset && portableAsset.name);
  const unrenamed = updater.pickPortableAsset(RELEASE_UNRENAMED);
  assert('未改名产物:排除 Setup 后可识别便携版', !!unrenamed && unrenamed.name === 'RaccoonProxy 1.6.0.exe', unrenamed && unrenamed.name);
  assert('无便携版资产时返回 null', updater.pickPortableAsset({ assets: [{ name: 'RaccoonProxy Setup 1.5.0.exe' }] }) === null);

  // 3) 检查更新:有新版本
  let s = await makeServer();
  const base = 'http://127.0.0.1:' + s.server.address().port;
  const info = await updater.checkForUpdate({ currentVersion: '1.4.1', apiUrl: base + '/releases/latest' });
  assert('检查更新:发现新版本', info.updateAvailable === true && info.latest === '1.5.0', info);
  assert('检查更新:默认(安装版)带上 Setup 包下载地址', info.downloadUrl === RELEASE.assets[2].browser_download_url && info.variant === 'setup', info);
  assert('检查更新:附带 Releases 页面地址', typeof info.pageUrl === 'string' && info.pageUrl.includes('releases'), info.pageUrl);
  const infoPortable = await updater.checkForUpdate({ currentVersion: '1.4.1', apiUrl: base + '/releases/latest', variant: 'portable' });
  assert('检查更新(便携版):下载便携版资产', infoPortable.updateAvailable === true && infoPortable.variant === 'portable' && infoPortable.downloadUrl === RELEASE.assets[0].browser_download_url, infoPortable);
  const infoFallback = await updater.checkForUpdate({ currentVersion: '1.4.1', apiUrl: base + '/releases/setup-only', variant: 'portable' });
  assert('便携版缺资产时回退 Setup 并标注形态', infoFallback.updateAvailable === true && infoFallback.variant === 'setup' && infoFallback.downloadUrl === RELEASE.assets[2].browser_download_url, infoFallback);
  assert('检查更新:携带资产 sha256 摘要(小写)', info.sha256 === 'a'.repeat(64), info.sha256);

  // 3.5) 下载候选:GitHub 地址自动加镜像,非 GitHub 不加速
  const ghAsset = 'https://github.com/BlackTor-tor/raccoon-proxy-desktop/releases/download/v1.5.0/RaccoonProxy-Setup-1.5.0.exe';
  const cands = updater.downloadCandidates(ghAsset);
  assert('下载候选:GitHub 地址 = 直连 + 全部镜像', cands.length === 1 + updater.MIRRORS.length && cands[0] === ghAsset && cands.every((u, i) => i === 0 || u === `${updater.MIRRORS[i - 1]}/${ghAsset}`), cands);
  assert('下载候选:非 GitHub 地址保持单线路', updater.downloadCandidates('http://127.0.0.1:1/x.exe').length === 1);
  const same = await updater.checkForUpdate({ currentVersion: '1.5.0', apiUrl: base + '/releases/latest' });
  assert('检查更新:同版本不提示更新', same.updateAvailable === false, same);
  s.server.close();

  // 4) 下载:跟随重定向,文件落盘,进度回调
  s = await makeServer({ redirect: true });
  const base2 = 'http://127.0.0.1:' + s.server.address().port;
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-')), 'setup.exe');
  let progress = null;
  const dl = await updater.downloadFile({ url: base2 + '/setup.exe', destFile: dest, waitMs: async () => {}, onProgress: (p) => { progress = p; } });
  assert('下载:跟随重定向并写入文件', fs.readFileSync(dest, 'utf8') === 'hello-patch', fs.readFileSync(dest, 'utf8'));
  assert('下载:报告进度与字节数', dl.bytes === 11 && progress && progress.received === 11, { dl, progress });
  s.server.close();

  // 5) 下载:瞬时失败自动重试(失败 2 次后第 3 次成功)
  s = await makeServer({ failTimes: 2 });
  const base3 = 'http://127.0.0.1:' + s.server.address().port;
  const dest2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-')), 'setup.exe');
  const dl2 = await updater.downloadFile({ url: base3 + '/setup.exe', destFile: dest2, waitMs: async () => {} });
  assert('下载:瞬时失败后重试成功', fs.readFileSync(dest2, 'utf8') === 'hello-patch');
  assert('下载:重试后第 3 次请求成功', s.hits() === 3, s.hits());
  s.server.close();

  // 6) 下载:连续失败,重试 3 次后放弃并报错,错误附 Releases 链接
  s = await makeServer({ failTimes: 999 });
  const base4 = 'http://127.0.0.1:' + s.server.address().port;
  let err = null;
  try { await updater.downloadFile({ url: base4 + '/setup.exe', destFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-')), 'setup.exe'), waitMs: async () => {} }); } catch (e) { err = e; }
  assert('下载:重试 3 次(共 4 次请求)后失败', err !== null && s.hits() === 1 + updater.MAX_RETRIES, { hits: s.hits(), msg: err && err.message });
  assert('下载:失败错误携带 Releases 页面链接', !!err && typeof err.pageUrl === 'string' && err.pageUrl.includes('/releases'), err && err.pageUrl);
  assert('下载:失败信息提示手动下载', !!err && err.message.includes('手动下载'), err && err.message);
  s.server.close();

  // 7) 下载:主线路失败自动切换备用线路(测速排序 + 失败兜底)
  const bad = await makeServer({ failTimes: 999 });
  const good = await makeServer();
  const badBase = 'http://127.0.0.1:' + bad.server.address().port;
  const goodBase = 'http://127.0.0.1:' + good.server.address().port;
  const destM = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-')), 'mirror.exe');
  const dlM = await updater.downloadFile({ url: badBase + '/setup.exe', destFile: destM, candidates: [badBase + '/setup.exe', goodBase + '/setup.exe'], waitMs: async () => {} });
  assert('下载:主线路失败自动切换备用线路', fs.readFileSync(destM, 'utf8') === 'hello-patch' && dlM.source === goodBase + '/setup.exe', dlM.source);
  bad.server.close();
  good.server.close();

  // 8) 下载:sha256 摘要校验(通过 / 不匹配删除并报错)
  const hashSrv = await makeServer();
  const baseH = 'http://127.0.0.1:' + hashSrv.server.address().port;
  const expectedHash = crypto.createHash('sha256').update('hello-patch').digest('hex');
  const destH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-')), 'hash-ok.exe');
  await updater.downloadFile({ url: baseH + '/setup.exe', destFile: destH, sha256: expectedHash, probe: false, waitMs: async () => {} });
  assert('下载:sha256 校验通过', fs.readFileSync(destH, 'utf8') === 'hello-patch');
  const destHashBad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpx-')), 'hash-bad.exe');
  let hashErr = null;
  try { await updater.downloadFile({ url: baseH + '/setup.exe', destFile: destHashBad, sha256: 'b'.repeat(64), probe: false, waitMs: async () => {} }); } catch (e) { hashErr = e; }
  assert('下载:摘要不匹配时报错并删除文件', !!hashErr && hashErr.message.includes('完整性') && !fs.existsSync(destHashBad), { msg: hashErr && hashErr.message, exists: fs.existsSync(destHashBad) });
  hashSrv.server.close();

  console.log(failed ? 'UPDATE-TEST FAIL' : 'UPDATE-TEST ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('UPDATE-TEST ERROR', e); process.exit(1); });
