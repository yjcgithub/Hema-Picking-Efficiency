/* 存储层：SQLite（使用 Node 内置 node:sqlite，免原生编译依赖） */
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
`);

function insert(dataset) {
  const info = db.prepare(
    `INSERT INTO datasets (source_file, dates, record_count, dropped, eff, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dataset.meta.sourceFile,
    dataset.meta.dates.join(','),
    dataset.meta.recordCount,
    dataset.meta.dropped,
    dataset.totals.eff,
    JSON.stringify(dataset),
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

module.exports = { insert, list, get, latest, remove, count };
