/* 由 export 导出文件生成网站的内置示例数据 web/assets/js/data.js
   直接复用服务端 compute（口径唯一，避免前后端各写一套统计），
   映射取自数据库设置，缺省用 config 的默认值。
   用法：node web/tools/gen_data.js [导出文件.xlsx]
*/
const fs = require('fs');
const path = require('path');
const CFG = require('../../server/config');
const compute = require('../../server/compute');
const db = require('../../server/db');

const ROOT = path.resolve(__dirname, '../..');
const EXPORT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'export-1785428943043.xlsx');
const OUT = path.join(ROOT, 'web', 'assets', 'js', 'data.js');

const map = db.getSetting(CFG.MAPPING_KEY) || CFG.DEFAULT_FRONT_BACK_MAP;
const ds = compute.buildFromBuffer(fs.readFileSync(EXPORT), path.basename(EXPORT), map).dataset;

fs.writeFileSync(OUT,
  '/* 由 tools/gen_data.js 生成，勿手改 */\n' +
  'window.HEMA_DATA = ' + JSON.stringify(ds) + ';\n', 'utf8');

console.log('已生成:', OUT);
console.log('记录:', ds.meta.recordCount, '| 丢弃:', ds.meta.dropped,
  '| 人:', ds.totals.persons, '| 作业类型:', ds.byJobType.map(t => t.name + '(' + t.rows + ')').join(' '));
console.log('小时:', ds.meta.hours.join(','), '| 日期:', ds.meta.dates.join(','));
