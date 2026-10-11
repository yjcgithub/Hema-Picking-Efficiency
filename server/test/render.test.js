/* 本地测试：服务端自绘「效率透视表」SVG → PNG
 *
 * 只吃不联网：直接用构造的数据集 payload 调 renderPivot，校验产出的 PNG 合法、顺序正确。
 *
 * 运行：cd server && npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const render = require('../render');

function group(type, total, avg, median, names) {
  const hourly = [total, total - 10, null];
  return {
    type: type, rows: 1000, hours: 5, total: total, hourly: hourly,
    persons: names.map((p, i) => ({ person: p, data: [total - i * 5, total - 10, null], total: total - i * 5 })),
    stat: { avg: avg, median: median, avgPerson: names[0], medianPerson: names[names.length - 1] }
  };
}

const DATASET = {
  meta: {
    bucket: 'hour',
    period: { dateStart: '2026-10-11', dateEnd: '2026-10-11', start: '07:01', end: '22:34', crossDay: false }
  },
  personByHour: {
    hours: [7, 8, 9],
    // 故意按效率降序给（与 personByHour.groups 的实际顺序一致），验证会被排成 前场/后场/一体化
    groups: [
      group('后场合流', 209.6, 209.6, 219.5, ['张三', '李四']),
      group('一体化', 164.4, 164.4, 170.3, ['王五']),
      group('前场合流', 74.9, 74.9, 75.8, ['赵六', '钱七', '孙八'])
    ]
  }
};

function pngOf(dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  assert.ok(m, '图片应为 data:image/png;base64,…');
  return Buffer.from(m[1], 'base64');
}

test('自绘：产出三块 PNG，顺序为 前场 / 后场 / 一体化', () => {
  const out = render.renderPivot(DATASET);
  assert.equal(out.period, '2026-10-11 07:01 – 22:34', '统计时间段应与页面一致');
  assert.deepEqual(out.blocks.map(b => b.name), ['前场', '后场', '一体化']);
  out.blocks.forEach(b => {
    const png = pngOf(b.image);
    assert.deepEqual(Array.from(png.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47], '应为合法 PNG 头');
    assert.ok(png.length > 1000, 'PNG 不应为空');
  });
  // 数值随块一起产出（供钉钉文案使用）
  const front = out.blocks[0];
  assert.equal(front.eff, 74.9);
  assert.equal(front.avg, 74.9);
  assert.equal(front.median, 75.8);
});

test('自绘：无透视数据时给出可读报错（不抛底层异常）', () => {
  assert.throws(() => render.renderPivot({ meta: {}, personByHour: { hours: [], groups: [] } }),
    /没有透视数据/);
});
