'use strict';
// 更新服务:检查/下载 GitHub Releases 最新产物。纯 Node、零依赖,传输函数可注入以便离线测试。
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const REPO = 'BlackTor-tor/raccoon-proxy-desktop';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const MAX_RETRIES = 3; // 首轮失败后再试 3 轮,共 4 轮
// GitHub 直连在部分网络下很慢,按「直连 + 镜像」并行测速选最快;下载后用 GitHub 摘要校验完整性
const MIRRORS = ['https://gh-proxy.com', 'https://ghfast.top'];

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
    // GitHub 对上传资产计算的 sha256(格式 "sha256:..."),用于镜像下载后校验
    sha256: asset && asset.digest ? String(asset.digest).replace(/^sha256:/i, '').toLowerCase() : null,
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

// 镜像候选:github.com 资产默认加 MIRRORS 前缀;非 GitHub 地址保持单候选
function downloadCandidates(url, mirrors) {
  const list = [url];
  const isGitHub = /^https:\/\/github\.com\//i.test(url);
  if (isGitHub || (Array.isArray(mirrors) && mirrors.length)) {
    for (const m of (Array.isArray(mirrors) && mirrors.length ? mirrors : MIRRORS)) {
      const base = String(m || '').replace(/\/+$/, '');
      if (base) list.push(`${base}/${url}`);
    }
  }
  return [...new Set(list)];
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// 用 Range 取前 256KB 测速(不支持 Range 的镜像读到阈值即断开)
function speedProbe(url, { bytes = 256 * 1024, timeoutMs = 6000, depth = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    if (depth > 5) return done({ ok: false, speed: 0 });
    const req = transport(url, { headers: { Range: `bytes=0-${bytes - 1}` } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return speedProbe(new URL(res.headers.location, url).href, { bytes, timeoutMs, depth: depth + 1 }).then(done);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return done({ ok: false, speed: 0 });
      }
      const started = Date.now();
      let received = 0;
      const finish = () => done({ ok: received > 0, speed: received / Math.max((Date.now() - started) / 1000, 0.001) });
      const timer = setTimeout(() => { res.destroy(); finish(); }, timeoutMs);
      res.on('data', (c) => { received += c.length; if (received >= bytes) { clearTimeout(timer); res.destroy(); finish(); } });
      res.on('end', () => { clearTimeout(timer); finish(); });
      res.on('error', () => { clearTimeout(timer); finish(); });
    });
    req.on('error', () => done({ ok: false, speed: 0 }));
  });
}

// 并行测速,按速度降序;测不出速度的排最后(仍会作为下载兜底尝试)
async function orderBySpeed(candidates, probe) {
  if (!probe || candidates.length < 2) return candidates;
  const speeds = await Promise.all(candidates.map((u) => speedProbe(u)));
  const ranked = candidates.map((u, i) => ({ u, s: speeds[i].ok ? speeds[i].speed : 0 }));
  const fast = ranked.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.u);
  const slow = ranked.filter((x) => x.s <= 0).map((x) => x.u);
  return [...fast, ...slow];
}

// 失败自动重试 MAX_RETRIES 轮;每轮按测速顺序尝试候选(直连/镜像);给了 sha256 则校验后才算成功
async function downloadFile({ url, destFile, onProgress, waitMs, sha256, mirrors, candidates, probe = true } = {}) {
  const sleep = waitMs || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const list = Array.isArray(candidates) && candidates.length ? candidates : downloadCandidates(url, mirrors);
  const ordered = await orderBySpeed(list, probe);
  const expected = sha256 ? String(sha256).replace(/^sha256:/i, '').toLowerCase() : null;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    for (const candidate of ordered) {
      try {
        const result = await fetchOnce(candidate, destFile, onProgress);
        if (expected) {
          const actual = await sha256File(destFile);
          if (actual !== expected) {
            try { fs.unlinkSync(destFile); } catch {}
            throw new Error('文件完整性校验失败(与官方摘要不一致),已删除');
          }
        }
        return { ...result, attempts: attempt + 1, source: candidate };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  const err = new Error(`下载失败(已自动重试 ${MAX_RETRIES} 轮):${lastErr ? lastErr.message : '未知错误'},请手动下载`);
  err.pageUrl = RELEASES_PAGE;
  throw err;
}

module.exports = { REPO, RELEASES_PAGE, MAX_RETRIES, MIRRORS, compareVersions, pickSetupAsset, pickPortableAsset, checkForUpdate, downloadCandidates, sha256File, speedProbe, downloadFile };
