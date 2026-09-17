/* 拣货单上传（时间维度覆盖 / 新增）测试
   覆盖场景：
   1. 时间维度无匹配 -> 新增
   2. 时间维度匹配   -> 覆盖更新，完全替换原拣货单数据
   3. 同时间维度多条历史记录 -> 仅覆盖最新一条，其余保持不动
   4. 多日期文件按日期集合整体匹配时间维度
   5. 缺少时间字段列 / 整列无有效时间 -> 终止上传并提示
   6. 时间字段格式非法 -> 终止上传并提示
   7. 兼容原有格式：空时间单元格的行仍按丢弃处理
   8. 覆盖后数据仍可供其他模块（分区设置重算）使用
   9. 忽略分区：命中分区的明细完全排除出统计，条数单独记为「已忽略」，保存后自动重算
  10. 忽略分区按分区判定：拣打一体的被忽略分区不进入「一体化」统计
  11. 上传时忽略未命中的分区 -> 取消忽略后重算可恢复
  12. 忽略分区列表格式非法 / 全部分区被忽略时的异常处理
  13. 门店鉴别：只导入拣货单号以门店编码（20005）开头的明细，其它门店明细单独计数
  14. 门店鉴别：文件内没有本门店明细时终止上传并提示
  运行：npm test（node --test）
*/
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 必须在 require 业务模块之前指定独立测试库，避免污染 server/data/hema.db
const DB_FILE = path.join(os.tmpdir(), 'hema-upload-test-' + process.pid + '-' + Date.now() + '.db');
process.env.HEMA_DB_PATH = DB_FILE;

const app = require('../index');
const db = require('../db');

const HEADER = ['拣货单号', '拣货人', '拣货开始时间', '拣货完成时间', '拣货行数', '拣货分区', '拣货单类型'];

// 门店编码（拣货单号前缀）：导入时按此做门店鉴别，非本门店明细会被过滤
const STORE = '20005';

let server, base;

before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm'].forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) { /* 忽略 */ } });
});

// 每个用例前清空数据集，保证用例相互独立
beforeEach(async () => {
  const list = await getJson('/api/datasets');
  for (const d of list) await fetch(base + '/api/datasets/' + d.id, { method: 'DELETE' });
});

/* ---------- 测试辅助 ---------- */

function rec(no, person, start, end, rows, zone, type) {
  return [STORE + no, person, start, end, rows, zone || 'AH 水产*A', type || '普通'];
}

function xlsxBuf(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'data');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function upload(buf, name) {
  const r = await fetch(base + '/api/upload?name=' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf
  });
  return { status: r.status, body: await r.json() };
}

function getJson(p) {
  return fetch(base + p).then(r => r.json());
}

/* ---------- 用例 ---------- */

test('时间维度无匹配记录时执行新增', async () => {
  const r = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-07-30 08:00:00', '2026-07-30 08:30:00', 60)
  ]), '拣货单-0730.xlsx');

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.mode, 'create');
  assert.deepStrictEqual(r.body.meta.dates, ['2026-07-30']);

  const list = await getJson('/api/datasets');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, r.body.id);
});

test('存在同时间维度记录时覆盖更新并完全替换原数据', async () => {
  const first = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-07-30 08:00:00', '2026-07-30 09:00:00', 60),
    rec('PK002', '李四', '2026-07-30 09:00:00', '2026-07-30 10:00:00', 100)
  ]), '第一次导出.xlsx');
  assert.strictEqual(first.body.mode, 'create');
  const id = first.body.id;

  const before = await getJson('/api/datasets/' + id);
  assert.strictEqual(before.meta.recordCount, 2);
  assert.strictEqual(before.totals.rows, 160);
  assert.strictEqual(before.totals.eff, 80);

  // 文件名不同、数据完全不同，但时间维度（2026-07-30）一致 -> 覆盖
  const second = await upload(xlsxBuf([
    HEADER,
    rec('PK101', '王五', '2026-07-30 10:00:00', '2026-07-30 11:00:00', 30)
  ]), '重新导出的文件.xlsx');

  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.mode, 'overwrite');
  assert.strictEqual(second.body.id, id);                      // 覆盖同一条记录，而非新增

  const list = await getJson('/api/datasets');
  assert.strictEqual(list.length, 1);                          // 数据集总数不变

  const after = await getJson('/api/datasets/' + id);
  assert.strictEqual(after.meta.sourceFile, '重新导出的文件.xlsx');
  assert.strictEqual(after.meta.recordCount, 1);
  assert.strictEqual(after.totals.rows, 30);
  assert.strictEqual(after.totals.eff, 30);                    // 效率等派生数据同步替换
  assert.deepStrictEqual(after.byPerson.map(p => p.name), ['王五']);  // 原「张三/李四」数据被完全替换
});

test('同时间维度存在多条历史记录时，仅覆盖最新一条，其余保持不动', async () => {
  // 模拟旧规则遗留：同一时间维度积累了多条记录
  const legacy = n => ({
    meta: { sourceFile: '历史重复-' + n + '.xlsx', dates: ['2026-07-30'], recordCount: 0, dropped: 0 },
    totals: { eff: 0 }
  });
  const old1 = db.insert(legacy(1), []);
  const old2 = db.insert(legacy(2), []);

  const r = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-07-30 08:00:00', '2026-07-30 09:00:00', 60)
  ]), '新上传.xlsx');

  assert.strictEqual(r.body.mode, 'overwrite');
  assert.strictEqual(r.body.id, old2);                       // 覆盖最新一条

  const list = await getJson('/api/datasets');
  assert.deepStrictEqual(list.map(x => x.id), [old2, old1]); // 旧重复记录不删除
  assert.strictEqual(list[1].sourceFile, '历史重复-1.xlsx');
  assert.strictEqual(list[0].recordCount, 1);
});

test('多日期文件按日期集合整体匹配时间维度', async () => {
  const twoDays = xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-07-30 08:00:00', '2026-07-30 09:00:00', 60),
    rec('PK002', '李四', '2026-07-31 08:00:00', '2026-07-31 09:00:00', 80)
  ]);

  const a = await upload(twoDays, '两天.xlsx');
  assert.strictEqual(a.body.mode, 'create');
  assert.deepStrictEqual(a.body.meta.dates, ['2026-07-30', '2026-07-31']);

  const b = await upload(twoDays, '两天-重传.xlsx');
  assert.strictEqual(b.body.mode, 'overwrite');
  assert.strictEqual(b.body.id, a.body.id);

  // 只包含其中一天 -> 时间维度不同 -> 新增
  const c = await upload(xlsxBuf([
    HEADER,
    rec('PK003', '王五', '2026-07-30 10:00:00', '2026-07-30 11:00:00', 40)
  ]), '一天.xlsx');
  assert.strictEqual(c.body.mode, 'create');
  assert.notStrictEqual(c.body.id, a.body.id);

  assert.strictEqual((await getJson('/api/datasets')).length, 2);
});

test('缺少时间字段列时终止上传并给出明确提示', async () => {
  const header = HEADER.filter(h => h !== '拣货开始时间');
  const r = await upload(xlsxBuf([
    header,
    ['PK001', '张三', '2026-07-30 09:00:00', 60, 'AH 水产*A', '普通']
  ]), '缺少时间列.xlsx');

  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /缺少时间字段.*拣货开始时间/);
  assert.strictEqual((await getJson('/api/datasets')).length, 0);   // 未写入任何记录
});

test('时间字段格式非法时终止上传并给出明确提示', async () => {
  const cases = ['2026年07月30日 08点00分', '2026-07-30', 'not-a-time'];

  for (const bad of cases) {
    const r = await upload(xlsxBuf([
      HEADER,
      rec('PK001', '张三', bad, '2026-07-30 09:00:00', 60)
    ]), '时间格式非法.xlsx');

    assert.strictEqual(r.status, 400, '非法时间「' + bad + '」应被拒绝');
    assert.match(r.body.error, /时间字段格式非法/);
    assert.strictEqual((await getJson('/api/datasets')).length, 0);
  }
});

test('时间列整列为空时终止上传并提示缺少有效时间字段', async () => {
  const r = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', null, null, 60)
  ]), '无有效时间.xlsx');

  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /缺少有效时间字段/);
  assert.strictEqual((await getJson('/api/datasets')).length, 0);
});

test('兼容原有格式：空时间单元格的行仍按丢弃处理，不影响上传', async () => {
  const r = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-07-30 08:00:00', '2026-07-30 09:00:00', 60),
    rec('PK002', '李四', null, null, 20)
  ]), '含空时间行.xlsx');

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.meta.recordCount, 1);
  assert.strictEqual(r.body.meta.dropped, 1);
});

test('覆盖后拣货单数据仍可供其他模块（分区设置重算）使用', async () => {
  const first = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-07-30 08:00:00', '2026-07-30 09:00:00', 60)
  ]), 'v1.xlsx');
  const id = first.body.id;

  const overwritten = await upload(xlsxBuf([
    HEADER,
    rec('PK101', '王五', '2026-07-30 08:00:00', '2026-07-30 09:00:00', 120)
  ]), 'v2.xlsx');
  assert.strictEqual(overwritten.body.mode, 'overwrite');

  const res = await fetch(base + '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map: { 'AH 水产*A': '前场合流' } })
  });
  const j = await res.json();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(j.updated, [id]);          // 覆盖后的记录仍保存在 recs，可参与重算

  const ds = await getJson('/api/datasets/' + id);
  assert.strictEqual(ds.totals.rows, 120);
  assert.deepStrictEqual(ds.byJobType.map(x => x.name), ['前场合流']);
});

/* ---------- 忽略分区（用例 10 ~ 13） ---------- */

const ZONE_A = 'ZZ 忽略测试前场*A';      // 测试专用分区名，避免与真实导出文件里的分区重合
const ZONE_B = 'YY 忽略测试后场*P';

async function setSettings(body) {
  const r = await fetch(base + '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

// 两个分区、两天之外的同一天数据：ZONE_A 60 行/1h，ZONE_B 100 行/1h
function twoZonesBuf() {
  return xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-08-01 08:00:00', '2026-08-01 09:00:00', 60, ZONE_A),
    rec('PK002', '李四', '2026-08-01 09:00:00', '2026-08-01 10:00:00', 100, ZONE_B)
  ]);
}

const MAP_AB = { [ZONE_A]: '前场合流', [ZONE_B]: '后场合流' };

test('忽略分区：命中分区的明细完全排除出统计，条数单独记为「已忽略」，保存后自动重算', async () => {
  await setSettings({ map: MAP_AB, ignore: [] });          // 基线：两个分区都参与统计
  const up = await upload(twoZonesBuf(), '忽略前.xlsx');
  const id = up.body.id;
  assert.strictEqual(up.body.meta.ignored, 0);
  assert.strictEqual(up.body.totals.rows, 160);

  const s = await setSettings({ map: MAP_AB, ignore: [ZONE_B] });
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(s.body.ignore, [ZONE_B]);
  assert.deepStrictEqual(s.body.updated, [id]);            // 保存后自动重算历史数据集

  const ds = await getJson('/api/datasets/' + id);
  assert.strictEqual(ds.meta.recordCount, 1);              // ZONE_B 的明细完全排除
  assert.strictEqual(ds.meta.ignored, 1);                  // 单独统计为「已忽略」，与「丢弃」区分
  assert.strictEqual(ds.meta.dropped, 0);                  // 不计入丢弃
  assert.strictEqual(ds.totals.rows, 60);                  // 行数、人数、图表口径均不含被忽略分区
  assert.strictEqual(ds.totals.persons, 1);
  assert.deepStrictEqual(ds.meta.dates, ['2026-08-01']);   // 时间维度不受忽略影响
  assert.deepStrictEqual(ds.byJobType.map(x => x.name), ['前场合流']);
  assert.deepStrictEqual(ds.byZone.map(z => z.zone), [ZONE_A]);

  const list = await getJson('/api/datasets');
  assert.strictEqual(list[0].ignored, 1);                  // 数据管理列表同步展示

  const cfg = await getJson('/api/settings');
  assert.strictEqual(cfg.zones.filter(z => z.zone === ZONE_B)[0].ignored, true);
  assert.strictEqual(cfg.zones.filter(z => z.zone === ZONE_A)[0].ignored, false);
});

test('忽略分区按分区判定：拣打一体的被忽略分区不进入「一体化」统计', async () => {
  await setSettings({ map: MAP_AB, ignore: [] });
  const up = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-08-02 08:00:00', '2026-08-02 09:00:00', 50, ZONE_A, '拣打一体'),
    rec('PK002', '李四', '2026-08-02 09:00:00', '2026-08-02 10:00:00', 70, ZONE_B, '普通')
  ]), '一体化忽略.xlsx');
  const id = up.body.id;
  assert.deepStrictEqual(up.body.byJobType.map(x => x.name).sort(), ['一体化', '后场合流']);

  await setSettings({ map: MAP_AB, ignore: [ZONE_A] });
  const ds = await getJson('/api/datasets/' + id);
  assert.strictEqual(ds.meta.ignored, 1);
  assert.strictEqual(ds.totals.rows, 70);
  assert.deepStrictEqual(ds.byJobType.map(x => x.name), ['后场合流']);   // 一体化那笔随分区被忽略
});

test('取消忽略后重算可恢复被排除的明细', async () => {
  await setSettings({ map: MAP_AB, ignore: [ZONE_A] });
  const up = await upload(twoZonesBuf(), '忽略上传.xlsx');   // 上传时即按当前忽略设置统计
  assert.strictEqual(up.body.meta.recordCount, 1);
  assert.strictEqual(up.body.meta.ignored, 1);
  assert.strictEqual(up.body.meta.dates.length, 1);          // 时间维度仍取文件完整日期集合

  await setSettings({ map: MAP_AB, ignore: [] });
  const ds = await getJson('/api/datasets/' + up.body.id);
  assert.strictEqual(ds.meta.recordCount, 2);
  assert.strictEqual(ds.meta.ignored, 0);
  assert.strictEqual(ds.totals.rows, 160);
});

test('忽略分区异常处理：列表格式非法、全部分区被忽略', async () => {
  // 格式非法：直接拒绝，不写入设置
  const bad = await setSettings({ map: MAP_AB, ignore: ZONE_A });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /忽略分区/);

  // 上传：全部明细的分区都被忽略 -> 终止上传并提示
  await setSettings({ map: MAP_AB, ignore: [ZONE_A, ZONE_B] });
  const up = await upload(twoZonesBuf(), '全忽略.xlsx');
  assert.strictEqual(up.status, 400);
  assert.match(up.body.error, /忽略分区/);
  assert.strictEqual((await getJson('/api/datasets')).length, 0);

  // 重算：已有数据集在全部忽略后重算失败，被明确报出且原数据保持不变
  await setSettings({ map: MAP_AB, ignore: [] });
  const ok = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-08-03 08:00:00', '2026-08-03 09:00:00', 60, ZONE_A)
  ]), '仅一个分区.xlsx');

  const s = await setSettings({ map: MAP_AB, ignore: [ZONE_A] });
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(s.body.updated, []);
  assert.deepStrictEqual(s.body.failed.map(f => f.id), [ok.body.id]);

  const ds = await getJson('/api/datasets/' + ok.body.id);
  assert.strictEqual(ds.meta.recordCount, 1);                // 重算失败不破坏原数据
  assert.strictEqual(ds.meta.ignored, 0);
});

/* ---------- 门店鉴别（用例 13 ~ 14） ---------- */

test('门店鉴别：只导入拣货单号以门店编码开头的明细，其它门店明细单独计数', async () => {
  await setSettings({ map: MAP_AB, ignore: [] });
  const r = await upload(xlsxBuf([
    HEADER,
    rec('PK001', '张三', '2026-08-05 08:00:00', '2026-08-05 09:00:00', 60),
    ['20006' + 'PK002', '李四', '2026-08-05 09:00:00', '2026-08-05 10:00:00', 100, 'AH 水产*A', '普通']
  ]), '两个门店.xlsx');

  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.meta.recordCount, 1);            // 其它门店的明细不进入统计
  assert.strictEqual(r.body.meta.otherStore, 1);             // 单独计数为「非本门店」
  assert.strictEqual(r.body.meta.dropped, 0);                // 不计入「丢弃」
  assert.strictEqual(r.body.totals.rows, 60);
  assert.deepStrictEqual(r.body.byPerson.map(p => p.name), ['张三']);

  const list = await getJson('/api/datasets');
  assert.strictEqual(list[0].otherStore, 1);                 // 数据管理列表同步展示
});

test('门店鉴别：文件内没有本门店明细时终止上传并提示', async () => {
  const r = await upload(xlsxBuf([
    HEADER,
    ['20006PK001', '张三', '2026-08-06 08:00:00', '2026-08-06 09:00:00', 60]
  ]), '其它门店.xlsx');

  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /20005/);
  assert.strictEqual((await getJson('/api/datasets')).length, 0);   // 未写入任何记录
});
