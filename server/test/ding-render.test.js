/* 本地测试：定时推送全链路（服务端自绘 → 落盘 → markdown 发群）
 *
 * 全程不联网：钉钉 Webhook 指向本机 mock，图片落到临时目录，库用临时文件。
 * 校验：自动推送能就绪、返回 ok、mock 收到的 markdown 里带公网图片链接。
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hema-ding-'));
process.env.HEMA_DB_PATH = path.join(TMP, 'test.db');
process.env.HEMA_DING_DIR = path.join(TMP, 'ding');
process.env.HEMA_STATIC = 'off';

let app, db, CFG;
let appSrv, mockSrv, base, mockBase;
let received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try { received.push(JSON.parse(body)); } catch (e) { received.push({ raw: body }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
});

function seedDataset() {
  const group = (type, total, names) => ({
    type: type, rows: 1000, hours: 5, total: total, hourly: [total, total - 10, null],
    persons: names.map((p, i) => ({ person: p, data: [total - i * 5, total - 10, null], total: total - i * 5 })),
    stat: { avg: total, median: total, avgPerson: names[0], medianPerson: names[names.length - 1] }
  });
  const ds = {
    meta: {
      sourceFile: '实时接口', dates: ['2026-10-12'], recordCount: 3000, dropped: 0, ignored: 0, otherStore: 0,
      bucket: 'hour',
      period: { dateStart: '2026-10-12', dateEnd: '2026-10-12', start: '07:01', end: '22:34', crossDay: false }
    },
    totals: { eff: 120, rows: 3000, hours: 25 },
    personByHour: {
      hours: [7, 8, 9],
      groups: [group('后场合流', 209.6, ['张三']), group('一体化', 164.4, ['李四']), group('前场合流', 74.9, ['王五'])]
    }
  };
  return db.insert(ds, []);
}

before(async () => {
  await new Promise(r => { mockSrv = mock.listen(0, '127.0.0.1', r); });
  mockBase = 'http://127.0.0.1:' + mockSrv.address().port;
  app = require('../index');
  db = require('../db');
  CFG = require('../config');
  await new Promise(r => { appSrv = app.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + appSrv.address().port; r(); }); });
});

after(async () => {
  await new Promise(r => appSrv.close(r));
  await new Promise(r => mockSrv.close(r));
});

function post(url, body) {
  return fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => r.json().then(j => ({ status: r.status, body: j })));
}
function get(url) { return fetch(base + url, { cache: 'no-store' }).then(r => r.json()); }

async function waitAuto(prevAt, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const j = await get('/api/ding/config');
    const st = (j.auto && j.auto.state) || {};
    if (st.at && st.at !== prevAt) return st;
    if (Date.now() - t0 > (timeoutMs || 15000)) throw new Error('等待自动推送结果超时');
    await new Promise(r => setTimeout(r, 150));
  }
}

test('定时推送：服务端自绘并发群（全程离线）', async () => {
  seedDataset();
  const cfg = await post('/api/ding/config', {
    webhook: mockBase + '/robot/send', publicBase: 'http://img.test', auto: { enabled: false }
  });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.renderOk, true, '自绘依赖应可用');

  const prevAt = ((await get('/api/ding/config')).auto.state || {}).at || null;
  const r = await post('/api/ding/auto/run', {});
  assert.equal(r.status, 202, '应立即返回 202');

  const st = await waitAuto(prevAt);
  assert.equal(st.ok, true, '自动推送应成功：' + st.error);
  assert.equal(st.count, 3, '应推送三块');

  const msg = received[received.length - 1];
  assert.equal(msg.msgtype, 'markdown');
  const text = msg.markdown.text;
  assert.ok(text.indexOf('统计时间段') >= 0);
  assert.ok(text.indexOf('http://img.test/') >= 0, 'markdown 里应带公网图片链接：' + text.slice(0, 200));
  // 三块图确实落盘了
  const files = fs.readdirSync(process.env.HEMA_DING_DIR).filter(f => /\.png$/.test(f));
  assert.equal(files.length, 3);
});
