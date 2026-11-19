// vision 开关端到端自检:mock https 上游 + 真实 fork server.js,验证 XHX_VISION 语义与主进程 env 注入
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');

const PORT = 8399;
let sawImageUrl = null; // 最近一次上游 chat 请求里是否含 image_url

// ---- mock 上游:拦截 https.request,任何 host 都落到本地处理器 ----
const realRequest = https.request;
https.request = function (opts, cb) {
  const fake = new (require('stream').Writable)({
    write(chunk, enc, next) { body += chunk; next(); },
  });
  let body = '';
  const res = new (require('stream').Readable)({ read() {} });
  res.statusCode = 200;
  res.headers = { 'content-type': 'application/json' };
  fake.end = function (chunk) {
    if (chunk) body += chunk;
    if (String(opts.path || '').includes('/chat/completions')) {
      try { sawImageUrl = JSON.stringify(JSON.parse(body).messages || []).includes('"image_url"'); } catch { sawImageUrl = false; }
      res.push(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    } else {
      res.push(JSON.stringify({ ok: true, access_token: 't', expires_in: 86400 }));
    }
    res.push(null);
    process.nextTick(() => { if (cb) cb(res); fake.emit('finish'); });
    return fake;
  };
  fake.on = function (ev, fn) { if (ev === 'error') return fake; return require('stream').Writable.prototype.on.call(fake, ev, fn); };
  fake.setTimeout = () => fake;
  return fake;
};

const assert = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${JSON.stringify(detail)}`); if (!ok) process.exitCode = 1; };
const post = (payload) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end(JSON.stringify(payload));
});
const imgMsg = { model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 子进程入口:先装 mock 再加载 server.js
const bootstrap = path.join(os.tmpdir(), `raccoon-vision-boot-${Date.now()}.js`);
fs.writeFileSync(bootstrap, `
const https = require('https');
const { Writable, Readable } = require('stream');
https.request = function (opts, cb) {
  let body = '';
  const fake = new Writable({ write(c, e, n) { body += c; n(); } });
  const res = new Readable({ read() {} });
  res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
  const realEnd = fake.end.bind(fake);
  fake.end = function (chunk) {
    if (chunk) body += chunk;
    if (String(opts.path || '').includes('/chat/completions')) {
      let saw = false;
      try { saw = JSON.stringify(JSON.parse(body).messages || []).includes('image_url'); } catch {}
      console.log('UPSTREAM_SAW_IMAGE_URL=' + saw);
      res.push(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'm1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    } else {
      res.push(JSON.stringify({ ok: true, access_token: 't', expires_in: 86400, data: { access_token: 't', expires_in: 86400 } }));
    }
    res.push(null);
    process.nextTick(() => { if (cb) cb(res); });
    return realEnd();
  };
  fake.setTimeout = () => fake;
  return fake;
};
require(${JSON.stringify(path.join(__dirname, '..', 'proxy', 'server.js'))});
`);

async function runOnce(visionEnv) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'raccoon-vision-ud-'));
  fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: 'a1', name: 'test', token: 't', tokenExp: Date.now() + 86400000, deviceId: 'd1', createdAt: new Date().toISOString(), enabled: true, authVia: 'qr' }] }));
  const child = fork(bootstrap, [], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', XHX_VISION: visionEnv, XHX_ACCOUNTS_FILE: path.join(userData, 'accounts.json'), PROXY_API_KEY: '', XHX_TOKEN_FILE: path.join(userData, 'token.cache'), XHX_USAGE_FILE: path.join(userData, 'usage.json'), XHX_CHECKIN_FILE: path.join(userData, 'checkin.json'), XHX_DEVICE_FILE: path.join(userData, 'device.json') },
    silent: true,
  });
  let saw = null;
  child.stdout.on('data', (d) => { const m = String(d).match(/UPSTREAM_SAW_IMAGE_URL=(true|false)/); if (m) saw = m[1] === 'true'; });
  child.stderr.on('data', () => {});
  await sleep(1500);
  let result = null;
  try { result = await post(imgMsg); } catch (e) { result = { error: String(e) }; }
  await sleep(400);
  child.kill();
  await sleep(300);
  return { result, saw };
}

(async () => {
  const on = await runOnce('1');
  assert('XHX_VISION=1:image_url 原样转发上游', on.result && on.result.status === 200 && on.saw === true, on);
  const off = await runOnce('');
  assert('XHX_VISION 空:图片降级为占位文字', off.result && off.result.status === 200 && off.saw === false, off);
  fs.unlinkSync(bootstrap);
  console.log(process.exitCode ? 'VISION-TEST FAIL' : 'VISION-TEST ALL PASS');
})();