'use strict';
// 更新服务:检查/下载 GitHub Releases 最新 NSIS 安装包。纯 Node、零依赖,传输函数可注入以便离线测试。
const https = require('https');
const http = require('http');
const fs = require('fs');

const REPO = 'BlackTor-tor/raccoon-proxy-desktop';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const MAX_RETRIES = 3; // 首次失败后再试 3 次,共 4 次请求

function transport(url, options, cb) {
  const mod = url.startsWith('https:') ? https : http;
  return mod.get(url, { headers: { 'User-Agent': 'RaccoonProxy-Desktop' }, ...options }, cb);
}

// 逐段数字比较,避免 '1.10.0' < '1.9.0' 的字符串陷阱;容忍 v 前缀与缺段
function compareVersions(a, b) {
  const norm = (v) => String(v).trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 只挑 NSIS 安装包(文件名含 Setup 的 .exe),忽略 portable/blockmap/yml
function pickSetupAsset(release) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  return assets.find((a) => /\.exe$/i.test(a.name || '') && /setup/i.test(a.name || '')) || null;
}

// 便携版:优先文件名含 portable 的 .exe;兼容未改名的 dist 产物(排除 Setup/卸载器后剩下的 exe)
function pickPortableAsset(release) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  const exes = assets.filter((a) => /\.exe$/i.test(a.name || ''));
  return (
    exes.find((a) => /portable/i.test(a.name)) ||
    exes.find((a) => !/setup|uninstall/i.test(a.name)) ||
    null
  );
}

const ASSET_PICKERS = { setup: pickSetupAsset, portable: pickPortableAsset };

function readJson(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('重定向次数过多'));
  return new Promise((resolve, reject) => {
    transport(url, {}, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(readJson(new URL(res.headers.location, url).href, depth + 1));
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('响应不是有效 JSON')); }
      });
    }).on('error', reject);
  });
}

async function checkForUpdate({ currentVersion, apiUrl, variant } = {}) {
  const url = apiUrl || `https://api.github.com/repos/${REPO}/releases/latest`;
  const release = await readJson(url);
  const latest = String(release.tag_name || '').trim().replace(/^v/i, '');
  const want = variant === 'portable' ? 'portable' : 'setup';
  const pick = ASSET_PICKERS[want];
  const primary = pick(release);
  const other = want === 'portable' ? pickSetupAsset(release) : pickPortableAsset(release);
  const asset = primary || other; // 对应形态缺失时回退另一种,避免完全无法更新
  return {
    updateAvailable: !!asset && compareVersions(latest, currentVersion) > 0,
    current: currentVersion,
    latest,
    variant: primary ? want : want === 'setup' ? 'portable' : 'setup',
    downloadUrl: asset ? asset.browser_download_url : null,
    size: asset ? Number(asset.size) || 0 : 0,
    pageUrl: RELEASES_PAGE,
  };
}

function fetchOnce(url, destFile, onProgress, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('重定向次数过多'));
  return new Promise((resolve, reject) => {
    transport(url, {}, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchOnce(new URL(res.headers.location, url).href, destFile, onProgress, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const out = fs.createWriteStream(destFile);
      res.on('data', (c) => { received += c.length; if (onProgress) onProgress({ received, total }); });
      res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', () => resolve({ bytes: received, total: total || received }));
      res.pipe(out);
    }).on('error', reject);
  });
}

// 失败自动重试 MAX_RETRIES 次;仍失败则抛错并携带 Releases 页面链接供兜底提示
async function downloadFile({ url, destFile, onProgress, waitMs } = {}) {
  const sleep = waitMs || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    try {
      return { ...(await fetchOnce(url, destFile, onProgress)), attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
    }
  }
  const err = new Error(`下载失败(已自动重试 ${MAX_RETRIES} 次):${lastErr ? lastErr.message : '未知错误'},请手动下载`);
  err.pageUrl = RELEASES_PAGE;
  throw err;
}

module.exports = { REPO, RELEASES_PAGE, MAX_RETRIES, compareVersions, pickSetupAsset, pickPortableAsset, checkForUpdate, downloadFile };
