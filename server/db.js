/* 存储层：SQLite（使用 Node 内置 node:sqlite，免原生编译依赖）
   - datasets：数据集（payload 为整份计算结果的 JSON；recs 为原始明细，用于改映射后重算）
   - settings：键值设置（如「拣货分区 -> 前后场分区」映射）
   库文件可用环境变量 HEMA_DB_PATH 覆盖（测试用独立库）
*/
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.HEMA_DB_PATH || path.join(DATA_DIR, 'hema.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS datasets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file  TEXT,
    dates        TEXT,
    record_count INTEGER,
    dropped      INTEGER,
    ignored      INTEGER,
    eff          REAL,
    payload      TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_datasets_created ON datasets(created_at DESC);
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// 旧库补列：recs 为解析后的原始明细（早期版本未保存），保存映射后重算依赖它；
// ignored 为被「忽略分区」排除出统计的明细条数
[['recs', 'TEXT'], ['ignored', 'INTEGER']].forEach(function (c) {
  if (!db.prepare('PRAGMA table_info(datasets)').all().some(x => x.name === c[0])) {
    db.exec('ALTER TABLE datasets ADD COLUMN ' + c[0] + ' ' + c[1]);
  }
});

function insert(dataset, recs) {
  const info = db.prepare(
    `INSERT INTO datasets (source_file, dates, record_count, dropped, ignored, eff, payload, recs, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dataset.meta.sourceFile,
    dataset.meta.dates.join(','),
    dataset.meta.recordCount,
    dataset.meta.dropped,
    dataset.meta.ignored || 0,
    dataset.totals.eff,
    JSON.stringify(dataset),
    recs && recs.length ? JSON.stringify(recs) : null,
    new Date().toISOString()
  );
  return Number(info.lastInsertRowid);
}

/* ---------- 时间维度匹配（覆盖 / 新增） ----------
   时间维度 = 拣货单内「拣货开始时间」的日期集合（去重、排序后拼接，即 datasets.dates 的规范形式）。
   命中同维度历史记录 -> 整条覆盖；未命中 -> 新增。 */

function timeKey(dates) {
  const out = [];
  (dates || []).forEach(d => {
    const s = String(d == null ? '' : d).trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  });
  return out.sort().join(',');
}

// 按时间维度检索历史拣货单；同维度存在多条时取最新一条（兼容历史遗留的重复数据）
function findByDates(dates) {
  const key = timeKey(dates);
  if (!key) return null;
  const rows = db.prepare('SELECT id, source_file AS sourceFile, dates FROM datasets ORDER BY id DESC').all();
  for (const r of rows) {
    if (timeKey(String(r.dates == null ? '' : r.dates).split(',')) === key) return r;
  }
  return null;
}

// 覆盖更新：用新上传的数据完全替换该拣货单的全部字段（保留原 id，历史引用与前端选中态不变）
function overwrite(id, dataset, recs) {
  db.prepare(
    `UPDATE datasets SET source_file = ?, dates = ?, record_count = ?, dropped = ?, ignored = ?,
            eff = ?, payload = ?, recs = ?, created_at = ? WHERE id = ?`
  ).run(
    dataset.meta.sourceFile,
    dataset.meta.dates.join(','),
    dataset.meta.recordCount,
    dataset.meta.dropped,
    dataset.meta.ignored || 0,
    dataset.totals.eff,
    JSON.stringify(dataset),
    recs && recs.length ? JSON.stringify(recs) : null,
    new Date().toISOString(),
    id
  );
  return id;
}

// 列表（不含 payload，避免过大）
function list() {
  return db.prepare(
    `SELECT id, source_file AS sourceFile, dates, record_count AS recordCount,
            dropped, ignored, eff, created_at AS createdAt
       FROM datasets ORDER BY id DESC`
  ).all();
}

function withId(row) {
  if (!row) return null;
  const ds = JSON.parse(row.payload);
  ds.id = row.id;
  return ds;
}

function get(id) {
  return withId(db.prepare('SELECT id, payload FROM datasets WHERE id = ?').get(id));
}

function latest() {
  return withId(db.prepare('SELECT id, payload FROM datasets ORDER BY id DESC LIMIT 1').get());
}

function remove(id) {
  return db.prepare('DELETE FROM datasets WHERE id = ?').run(id).changes;
}

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM datasets').get().n;
}

/* ---------- 原始明细（重算用） ---------- */

// 口径变更迁移：早期明细把「任务子类型」存在 sub 键下（一体化值为「拆零拣打一体」），
// 现按「拣货单类型」判定（一体化值为「拣打一体」），读取时补齐并在库中固化
function migrateRecs(recs) {
  let changed = false;
  for (const r of recs) {
    if (r.orderType == null && r.sub != null) {
      r.orderType = r.sub === '拆零拣打一体' ? '拣打一体' : r.sub;
      delete r.sub;
      changed = true;
    }
  }
  return changed;
}

// 重算所需的全部数据：原始明细 + meta 里 recs 之外的字段
function rebuildTargets() {
  return db.prepare('SELECT id, source_file AS sourceFile, dropped, recs FROM datasets ORDER BY id').all()
    .map(r => {
      if (!r.recs) return { id: r.id, sourceFile: r.sourceFile, dropped: r.dropped, recs: null };
      const recs = JSON.parse(r.recs);
      if (migrateRecs(recs)) db.prepare('UPDATE datasets SET recs = ? WHERE id = ?').run(JSON.stringify(recs), r.id);
      return { id: r.id, sourceFile: r.sourceFile, dropped: r.dropped, recs };
    });
}

// 缺少原始明细的数据集（上传时补存后可重算）
function withoutRecs() {
  return db.prepare('SELECT id, source_file AS sourceFile, dropped FROM datasets WHERE recs IS NULL ORDER BY id').all();
}

function saveRecs(id, recs) {
  db.prepare('UPDATE datasets SET recs = ? WHERE id = ?').run(recs && recs.length ? JSON.stringify(recs) : null, id);
}

function updatePayload(id, dataset) {
  db.prepare(
    `UPDATE datasets SET payload = ?, eff = ?, record_count = ?, dropped = ?, ignored = ?, dates = ? WHERE id = ?`
  ).run(JSON.stringify(dataset), dataset.totals.eff, dataset.meta.recordCount, dataset.meta.dropped,
    dataset.meta.ignored || 0, dataset.meta.dates.join(','), id);
}

/* ---------- 键值设置 ---------- */

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

module.exports = {
  insert, findByDates, overwrite, list, get, latest, remove, count,
  rebuildTargets, withoutRecs, saveRecs, updatePayload,
  getSetting, setSetting
};
