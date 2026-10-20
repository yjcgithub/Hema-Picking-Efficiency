/* 本地测试：Cookie 鉴权失效 → 删除已存的那份 Cookie 并记录提示状态
 *
 * 全程使用本机 mock 的 UMS 接口（HEMA_UMS_URL 指向本地随机端口），不访问任何外网接口。
 * 用独立的临时库（HEMA_DB_PATH），不触碰 server/data 下的真实数据。
 *
 * 运行：cd server && npm test
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 必须在 require('../index' | '../db' | '../config') 之前设置：
// 走本地假接口 + 临时库 + 关掉静态托管（避免测试里再跑一次前端构建）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hema-ums-'));
process.env.HEMA_DB_PATH = path.join(TMP, 'test.db');
process.env.HEMA_STATIC = 'off';
process.env.HEMA_PUSHPLUS_TOKEN = '';   // 关闭 Cookie 失效的 PushPlus 提醒，测试不访问外网
// 真实 UMS 地址在 before 里用本地 mock 的端口覆盖（require('../index') 之前设置）

// ---- 本地假 UMS 接口：Cookie 里带 BAD → 401（模拟登录态过期）；否则 200 空列表 ----
const mock = http.createServer((req, res) => {
  const cookie = String(req.headers['cookie'] || '');
  if (/BAD/.test(cookie)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 401, msg: '登录态失效' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 200, info: { list: [], totalNum: 0 } }));
});

let app, db, CFG;
let srv, mockSrv, base;

before(async () => {
  await new Promise(r => { mockSrv = mock.listen(0, '127.0.0.1', r); });
  process.env.HEMA_UMS_URL = 'http://127.0.0.1:' + mockSrv.address().port;
  app = require('../index');
  db = require('../db');
  CFG = require('../config');
  await new Promise(r => { srv = app.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); }); });
});

after(async () => {
  await new Promise(r => srv.close(r));
  await new Promise(r => mockSrv.close(r));
});

function post(url, body) {
  return fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => r.json().then(j => ({ status: r.status, body: j })));
}
function get(url) { return fetch(base + url, { cache: 'no-store' }).then(r => r.json()); }

// 等待后台手动取数完成（/api/ums/result 的 ok 由 null 变为布尔）
async function waitResult(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const r = await get('/api/ums/result');
    if (r && r.ok !== null && r.ok !== undefined) return r;
    if (Date.now() - t0 > (timeoutMs || 10000)) throw new Error('等待取数结果超时');
    await new Promise(res => setTimeout(res, 100));
  }
}

// 手动取数：清掉冷却 → 发起 → 等结果（mock 让带 BAD 的 Cookie 返回 401）
async function manualFetch(cookie, backup) {
  db.setSetting(CFG.UMS_LAST_TRY_KEY, '');                 // 清冷却，避免 429
  const r = await post('/api/ums/fetch', {
    startDate: '2026-01-01', endDate: '2026-01-01', incremental: false,
    cookie: cookie || '', cookieBackup: backup || ''
  });
  assert.equal(r.status, 202, '应启动后台任务，实际：' + JSON.stringify(r));
  return waitResult();
}

test('鉴权失效：删除已存的主 Cookie，并记录 cookieAuth 供页面提示', async () => {
  db.setSetting(CFG.UMS_COOKIE_AUTH_KEY, null);
  await post('/api/ums/config', { cookie: 'BAD_MAIN', force: true, cookieBackup: '' });
  assert.deepEqual((await get('/api/ums/cookie')).cookie, 'BAD_MAIN', '前置：主 Cookie 已保存');

  const out = await manualFetch();                          // 用已存的主 Cookie（BAD_MAIN）
  assert.equal(out.ok, false, '鉴权失效应取数失败');

  const cfg = await get('/api/ums/config');
  assert.equal(cfg.cookieSet, false, '失效的主 Cookie 应已被删除');
  assert.ok(cfg.cookieAuth && cfg.cookieAuth.tag === '主', '应记录 cookieAuth（主）');
  assert.equal((await get('/api/ums/cookie')).cookie, '', '库里的主 Cookie 应被清空');
});

test('鉴权失效：主 / 备用都失效 → 两份都被删除', async () => {
  db.setSetting(CFG.UMS_COOKIE_AUTH_KEY, null);
  await post('/api/ums/config', { cookie: 'BAD_MAIN', force: true, cookieBackup: 'BAD_BACK' });

  const out = await manualFetch();
  assert.equal(out.ok, false);

  const cfg = await get('/api/ums/config');
  assert.equal(cfg.cookieSet, false, '主 Cookie 应被删除');
  assert.equal(cfg.cookieBackupSet, false, '备用 Cookie 应被删除');
  assert.ok(cfg.cookieAuth && cfg.cookieAuth.tag, '应记录 cookieAuth');
});

test('鉴权失效：临时粘贴（未保存）的 Cookie → 不动已保存的 Cookie', async () => {
  db.setSetting(CFG.UMS_COOKIE_AUTH_KEY, null);
  await post('/api/ums/config', { cookie: 'GOOD_MAIN', force: true, cookieBackup: '' });

  // 只把坏 Cookie 作为本次请求的临时 Cookie 传入，不落库
  const out = await manualFetch('BAD_TMP', '');
  assert.equal(out.ok, false);

  const cfg = await get('/api/ums/config');
  assert.equal(cfg.cookieSet, true, '未保存的临时 Cookie 失效，不应删除已存的主 Cookie');
  assert.equal(cfg.cookieAuth, null, '未删除任何已存 Cookie，不应记录 cookieAuth');
  assert.equal((await get('/api/ums/cookie')).cookie, 'GOOD_MAIN', '已存的主 Cookie 应原样保留');
});
