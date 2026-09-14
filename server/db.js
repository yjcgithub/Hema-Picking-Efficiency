/* 存储层：SQLite（使用 Node 内置 node:sqlite，免原生编译依赖）
   - datasets：数据集（payload 为整份计算结果的 JSON；recs 为原始明细，用于改映射后重算）
   - settings：键值设置（如「拣货分区 -> 前后场分区」映射）
*/
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'hema.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS datasets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file  TEXT,
    dates        TEXT,
    record_count INTEGER,
    dropped      INTEGER,
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

// 旧库补列：recs 为解析后的原始明细（早期版本未保存），保存映射后重算依赖它
if (!db.prepare('PRAGMA table_info(datasets)').all().some(c => c.name === 'recs')) {
  db.exec('ALTER TABLE datasets ADD COLUMN recs TEXT');
}

function insert(dataset, recs) {
  const info = db.prepare(
    `INSERT INTO datasets (source_file, dates, record_count, dropped, eff, payload, recs, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dataset.meta.sourceFile,
    dataset.meta.dates.join(','),
    dataset.meta.recordCount,
    dataset.meta.dropped,
    dataset.totals.eff,
    JSON.stringify(dataset),
    recs && recs.length ? JSON.stringify(recs) : null,
    new Date().toISOString()
  );
  return Number(info.lastInsertRowid);
}

// 列表（不含 payload，避免过大）
function list() {
  return db.prepare(
    `SELECT id, source_file AS sourceFile, dates, record_count AS recordCount,
            dropped, eff, created_at AS createdAt
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

// 重算所需的全部数据：原始明细 + meta 里 recs 之外的字段
function rebuildTargets() {
  return db.prepare('SELECT id, source_file AS sourceFile, dropped, recs FROM datasets ORDER BY id').all()
    .map(r => ({
      id: r.id, sourceFile: r.sourceFile, dropped: r.dropped,
      recs: r.recs ? JSON.parse(r.recs) : null
    }));
}

// 缺少原始明细的数据集（上传时补存后可重算）
function withoutRecs() {
  return db.prepare('SELECT id, source_file AS sourceFile, dropped FROM datasets WHERE recs IS NULL ORDER BY id').all();
}

function saveRecs(id, recs) {
  db.prepare('UPDATE datasets SET recs = ? WHERE id = ?').run(recs && recs.length ? JSON.stringify(recs) : null, id);
}

function updatePayload(id, dataset) {
  db.prepare('UPDATE datasets SET payload = ?, eff = ?, record_count = ?, dropped = ?, dates = ? WHERE id = ?')
    .run(JSON.stringify(dataset), dataset.totals.eff, dataset.meta.recordCount, dataset.meta.dropped,
      dataset.meta.dates.join(','), id);
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
  insert, list, get, latest, remove, count,
  rebuildTargets, withoutRecs, saveRecs, updatePayload,
  getSetting, setSetting
};
