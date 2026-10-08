/* 拣货效率计算统计工具 - Node.js 后端
   - 托管前端静态资源：默认按内容哈希构建到 ../dist 并托管，见 build.js 与 ../CACHE.md
   - CORS：前端与后端不同源时必需
   - BASE_PATH：反向代理子路径（如 nginx 把 https://api.yjmc.xyz/hpe/ 转到本服务）
   - POST /api/upload 上传 xlsx -> 解析并计算 -> 按时间维度覆盖/新增入库 -> 返回数据集
   - POST /api/ums/fetch  带 Cookie 请求实时拣货单接口 -> 解析入库（incremental 时增量并入）
   - POST /api/ums/agent/data 油猴脚本在 ums 页面内取数后回传 -> 同上解析入库（无需后端 Cookie）
   - POST /api/ums/known  脚本增量追平判定：这批拣货单号有多少条已入库
   - GET/POST /api/ums/config 读取/保存接口 Cookie、每页条数、自动获取（间隔轮询当天数据）
   - GET  /api/ums/cookie 读取已保存的 Cookie 原文（仅「Cookie 设置」面板按需回填）
   - GET  /api/latest /api/datasets /api/datasets/:id（均支持 ?date=YYYY-MM-DD 只取某天）
   - GET  /api/settings 读取「拣货分区 -> 前后场分区」映射、忽略分区与数据集里出现过的分区
   - POST /api/settings 保存映射与忽略分区，并用新设置重算历史数据集
   - DELETE /api/datasets/:id
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const CFG = require('./config');
const compute = require('./compute');
const db = require('./db');
const build = require('./build');
const dingCapture = require('./capture');

const app = express();
const PORT = process.env.PORT || 3001;
const WEB_DIR = path.join(__dirname, '..', 'web');
const DIST_DIR = path.join(__dirname, '..', 'dist');
// 例：BASE_PATH=/hpe 时，https://域名/hpe/api/latest 与 /api/latest 均可用
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

/* ---------- 日志 ----------
   统一「[YYYY-MM-DD HH:mm:ss] 内容」前缀，时间取东八区（与门店口径一致），
   输出到 stdout / stderr（nohup 部署时落到 server.log），便于事后对账。
   同时写入环形缓冲 LOG_BUFFER，供页面「日志」弹窗查看（只保留最近 LOG_MAX 条，重启即清空）。 */
const LOG_MAX = 500;
const LOG_BUFFER = [];

function logTime() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
function pushLog(at, level, msg) {
  LOG_BUFFER.push({ at: at, level: level, msg: String(msg) });
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.splice(0, LOG_BUFFER.length - LOG_MAX);
}
function logInfo(msg) {
  const t = logTime();
  pushLog(t, 'info', msg);
  console.log('[' + t + '] ' + msg);
}
function logWarn(msg) {
  const t = logTime();
  pushLog(t, 'warn', msg);
  console.warn('[' + t + '] ' + msg);
}

// 时刻（东八区 HH:mm:ss），用于日志里标注「下次执行时间」等
function clockOf(d) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 19);
}

/* ---------- 静态资源托管方式（详见 ../CACHE.md）
   auto（默认）：启动时构建指纹资源到 ../dist 并托管 dist；构建失败回落源目录
   dist        ：只托管已构建好的 dist（CI / 只读目录场景，需先 npm run build）
   web         ：直接托管前端源目录（改完即见效，未指纹化，靠 ETag 协商缓存）
   off         ：完全不托管前端（前后端分离、由 nginx/1Panel 站点托管时用）
   环境变量 STATIC_DIR / HEMA_WEB_DIR：指定前端目录绝对路径（优先级最高）
   未指定时按候选顺序自动探测含 index.html 的目录，找不到则只提供 API */
const STATIC_MODE = String(process.env.HEMA_STATIC || 'auto').toLowerCase();
const STATIC_OFF = STATIC_MODE === 'off' || STATIC_MODE === 'none' || STATIC_MODE === 'api';

function readManifestMap() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'manifest.json'), 'utf8'));
    return (m && m.files) || {};
  } catch (e) {
    return {};
  }
}

/* 前端目录探测：前后端同仓部署、分离部署、容器挂载等常见位置都试一遍 */
function findWebDir() {
  const tried = [];
  const add = function (p) {
    if (!p) return;
    const abs = path.resolve(p);
    if (tried.indexOf(abs) < 0) tried.push(abs);
  };
  add(process.env.STATIC_DIR);
  add(process.env.HEMA_WEB_DIR);
  add(WEB_DIR);                                        // 同仓：<项目>/web
  add(path.join(__dirname, '..', '..', 'web'));        // 代码在 server/ 子目录
  add(path.join(process.cwd(), 'web'));
  add(path.join(process.cwd(), '..', 'web'));
  add('/web');                                         // 容器内常见挂载点
  add('/app/web');
  for (let i = 0; i < tried.length; i++) {
    if (fs.existsSync(path.join(tried[i], 'index.html'))) return { dir: tried[i], tried: tried };
  }
  return { dir: '', tried: tried };
}

function resolveStatic() {
  if (STATIC_OFF) {
    return { dir: '', fingerprint: false, map: {}, desc: 'HEMA_STATIC=' + STATIC_MODE + '：仅提供 API，前端由外部 Web 服务器托管' };
  }
  const found = findWebDir();
  const webDir = found.dir;
  if (!webDir) {
    logWarn('[静态资源] 未找到前端目录（需含 index.html），已尝试：\n  ' + found.tried.join('\n  '));
    logWarn('[静态资源] 本次仅提供 API。若需本服务托管前端，请设置 STATIC_DIR=<前端目录>；'
      + '若前端已由 nginx/1Panel 站点托管，请设置 HEMA_STATIC=off 消除本提示');
    return { dir: '', fingerprint: false, map: {}, desc: '未找到前端目录：仅提供 API' };
  }
  if (STATIC_MODE === 'web') {
    return { dir: webDir, fingerprint: false, map: {}, desc: 'HEMA_STATIC=web：托管源目录 ' + webDir + '（未指纹化）' };
  }
  if (STATIC_MODE === 'auto') {
    try {
      const r = build.build({ srcDir: webDir });
      return {
        dir: DIST_DIR, fingerprint: true, map: r.map,
        desc: '已构建指纹资源 ' + r.files + ' 个 → ' + r.outDir
      };
    } catch (e) {
      logWarn('[静态资源] 指纹构建失败，回落源目录：' + (e.message || e));
      return { dir: webDir, fingerprint: false, map: {}, desc: '构建失败，回落源目录 ' + webDir + '（未指纹化）' };
    }
  }
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    logWarn('[静态资源] HEMA_STATIC=dist 但 ' + DIST_DIR + ' 不完整，请先 npm run build；本次回落源目录');
    return { dir: webDir, fingerprint: false, map: {}, desc: '缺少 dist，回落源目录 ' + webDir + '（未指纹化）' };
  }
  const map = readManifestMap();
  return { dir: DIST_DIR, fingerprint: true, map: map, desc: 'HEMA_STATIC=dist：托管已构建产物 ' + DIST_DIR };
}

const STATIC = resolveStatic();

// 逻辑路径 → 当前指纹路径（带前导 /），用于「旧指纹回退」
const FP_MAP = {};
Object.keys(STATIC.map).forEach(function (k) { FP_MAP['/' + k] = '/' + STATIC.map[k]; });

// 当前前端构建版本（app.<hash8>.js 的 hash）：前端据此判断自己跑的 JS 是不是旧版本
const BUILD_ID = (function () {
  try {
    const files = fs.readdirSync(path.join(STATIC.dir, 'assets', 'js'));
    for (let i = 0; i < files.length; i++) {
      const m = /^app\.([0-9a-f]{8})\.js$/.exec(files[i]);
      if (m) return m[1];
    }
  } catch (e) { /* 源目录模式等场景没有指纹文件 */ }
  return '';
})();

/* ---------- 静态资源缓存策略（分级）
   - 入口 HTML：no-store，每次访问都回到服务器，保证拿到最新版本 → 同时拿到最新指纹路径
   - 指纹资源（name.<hash8>.ext）：immutable 一年 + 强 ETag（ETag 即内容哈希），命中后零请求
   - 其它未指纹资源：no-cache，可缓存但每次协商，内容未变返回 304
   express.static 的 setHeaders 在 send 写 Cache-Control / ETag 之前调用，
   因此这里设置的值优先生效（send 仅在响应尚无该头时才写入自己的默认值）。 */
function staticHeaders(res, filePath) {
  const rel = path.relative(STATIC.dir, filePath).split(path.sep).join('/');
  if (/\.html?$/i.test(rel)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return;
  }
  const m = /\.([0-9a-f]{8})(\.[^./]+)$/.exec(rel);
  if (STATIC.fingerprint && m) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', '"' + m[1] + '"');
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
}

/* ---------- 路径归一化：容忍反向代理的两种写法与重复斜杠 ---------- */
app.use(function (req, res, next) {
  var raw = req.url || '/';
  var parts = raw.split('?');
  var p = parts[0];
  var qs = parts.length > 1 ? '?' + parts.slice(1).join('?') : '';

  p = p.replace(/\/{2,}/g, '/');                       // //api/ -> /api/
  if (BASE_PATH && (p === BASE_PATH || p.indexOf(BASE_PATH + '/') === 0)) {
    p = p.slice(BASE_PATH.length) || '/';              // 去掉配置的子路径前缀
  }
  var i = p.indexOf('/api/');                          // 兜底：前缀不在开头也能认
  if (i > 0) p = p.slice(i);

  req.url = p + qs;
  next();
});

/* ---------- CORS ---------- */
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-filename');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- API 响应禁止缓存
   express 默认给 json 响应加 ETag：浏览器会带 If-None-Match 协商，内容未变时收到 304（空 body），
   前端 fetch 拿到非 2xx 会当成失败 → 首页角标（获取状态/条数）不更新。
   这里统一 no-store，保证每次轮询都拿到服务端最新状态。 */
app.use(function (req, res, next) {
  if ((req.url || '').indexOf('/api') === 0) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

const router = express.Router();

/* ---------- 分区映射（拣货分区 -> 前后场分区，值即「作业类型」） ---------- */

// 数据库设置优先，未保存过则用配置里的默认值
function currentMap() {
  return db.getSetting(CFG.MAPPING_KEY) || CFG.DEFAULT_FRONT_BACK_MAP;
}

// 「忽略分区」列表（这些分区的明细完全排除出统计）；未保存过则为空
function currentIgnore() {
  const v = db.getSetting(CFG.IGNORE_KEY);
  return Array.isArray(v) ? v.map(z => String(z).trim()).filter(Boolean) : [];
}

// 汇总所有数据集里实际出现过的「拣货分区」（新数据集走原始明细，旧数据集用 payload 里的分区兜底）
function dataZones() {
  const set = {};
  db.rebuildTargets().forEach(t => {
    (t.recs || []).forEach(r => { if (r.zone) set[r.zone] = 1; });
  });
  db.withoutRecs().forEach(x => {
    const ds = db.get(x.id);
    if (!ds) return;
    (ds.byZone || []).forEach(z => { if (z.zone) set[z.zone] = 1; });
  });
  return set;
}

// 设置界面用清单：数据里出现过的分区 + 映射里已配置的分区 + 已忽略的分区（去重、排序）
function zoneRows() {
  const map = currentMap();
  const ignore = currentIgnore();
  const ig = {};
  ignore.forEach(z => { ig[z] = 1; });

  const inData = dataZones();
  const all = {};
  Object.keys(inData).forEach(z => { all[z] = 1; });
  Object.keys(map).forEach(z => { all[z] = 1; });
  ignore.forEach(z => { all[z] = 1; });

  return Object.keys(all).sort().map(z => ({
    zone: z,
    type: map[z] || '',      // 空 = 未映射（数据里会归入「未匹配分区」）
    ignored: !!ig[z],        // 已忽略的分区完全排除出统计
    inData: !!inData[z]
  }));
}

// 用新映射与忽略列表重算全部历史数据集（缺少原始明细的跳过，需重新上传才能重算）
function rebuildAll(map, ignore) {
  const updated = [], failed = [];
  db.rebuildTargets().forEach(t => {
    if (!t.recs || !t.recs.length) return;
    try {
      db.updatePayload(t.id, compute.rebuild(t.recs,
        { sourceFile: t.sourceFile, dropped: t.dropped, otherStore: t.otherStore }, map, ignore));
      updated.push(t.id);
    } catch (e) {
      failed.push({ id: t.id, error: e.message || String(e) });
    }
  });
  return { updated, skipped: db.withoutRecs().map(x => x.id), failed };
}

/* 单日出数：隔天不显示前天，缺省取数据集内最新日期，其他日期由前端下拉手动选择（?date=YYYY-MM-DD）。
   - 响应 meta.dates 仍是完整日期集合（下拉用），meta.date 为本次展示的日期
   - 有原始明细的一律按最新口径重算：库里的 payload 是上传时算好的旧版，
     直接返回会缺后加的字段（统计时间段 / 超时统计 / 分区人均等）
   - 缺原始明细的老数据集、或重算失败：退回原 payload，只补 meta.date */
function withDate(ds, date) {
  if (!ds) return ds;
  const dates = (ds.meta && ds.meta.dates) || [];
  const anchor = dates.indexOf(date) >= 0 ? date : (dates[dates.length - 1] || '');
  const days = anchor ? [anchor] : [];
  if (!days.length) return ds;
  const recs = ds.id == null ? null : db.recsOf(ds.id);
  if (!recs || !recs.length) { ds.meta.date = anchor; return ds; }
  try {
    const out = compute.rebuild(recs,
      { sourceFile: ds.meta.sourceFile, dropped: ds.meta.dropped, otherStore: ds.meta.otherStore,
        dates, bucket: 'hour' },
      currentMap(), currentIgnore(), days);
    out.id = ds.id;
    out.meta.date = anchor;
    return out;
  } catch (e) { ds.meta.date = anchor; return ds; }
}

const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/* 周 / 月视图（?from=&to=）：汇总区间内「所有」数据集的明细后重算
   —— 库内每个数据集通常只含一天（每天各自入库），跨数据集合并才有整周 / 整月的数据。
   - 命中：数据集的日期集合与 [from,to] 有交集
   - 去重：键 = 拣货单号 + 拣货分区（同一单被重复抓取时不重复计数）；list() 按 id 倒序，保留较新的一条
   - unit：'date' = 周视图（时间轴为日期）、'week' = 月视图（时间轴为自然周）
   - meta.range 回传区间实际覆盖的日期；区间内无任何数据集 / 明细时返回 null（由调用方回 404） */
function rangeDataset(from, to, unit) {
  const days = [], allDates = [], merged = [], seen = {};
  let files = 0;
  db.list().forEach(row => {
    const dsDates = String(row.dates == null ? '' : row.dates).split(',').filter(Boolean);
    dsDates.forEach(d => { if (allDates.indexOf(d) < 0) allDates.push(d); });
    const hit = dsDates.filter(d => d >= from && d <= to);
    if (!hit.length) return;
    hit.forEach(d => { if (days.indexOf(d) < 0) days.push(d); });
    const recs = db.recsOf(row.id);
    if (!recs || !recs.length) return;
    files++;
    recs.forEach(r => {
      if (r.date < from || r.date > to) return;
      const no = r.no != null ? String(r.no).trim() : '';
      const key = no ? no + '\u0001' + String(r.zone == null ? '' : r.zone) : '';
      if (key) { if (seen[key]) return; seen[key] = 1; }
      merged.push(r);
    });
  });
  if (!days.length || !merged.length) return null;
  days.sort();
  allDates.sort();
  const out = compute.rebuild(merged, {
    sourceFile: '区间汇总 ' + from + ' ~ ' + to + '（' + files + ' 个数据集）',
    dropped: 0, otherStore: 0,
    dates: allDates,
    bucket: unit === 'week' ? 'week' : 'date'
  }, currentMap(), currentIgnore(), days);
  out.meta.date = days[days.length - 1];
  out.meta.range = { from: days[0], to: days[days.length - 1], dates: days };
  return out;
}

/* 请求是否带区间参数（三个取数接口共用：带 from&to 即视为跨数据集区间汇总）。
   bucket=week 时按自然周分桶（月视图），否则按日期分桶（周视图） */
function rangeQuery(req) {
  const from = req.query.from, to = req.query.to;
  if (!(isYmd(from) && isYmd(to) && to >= from)) return null;
  return { from: from, to: to, bucket: req.query.bucket === 'week' ? 'week' : 'date' };
}

function sendRange(res, from, to, bucket) {
  try {
    const out = rangeDataset(from, to, bucket);
    if (!out) return res.status(404).json({ error: '区间内暂无数据（' + from + ' ~ ' + to + '）' });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
}

router.get('/api/health', (req, res) => {
  res.json({
    ok: true, datasets: db.count(), basePath: BASE_PATH || '/',
    staticMode: STATIC_MODE, staticDesc: STATIC.desc,
    // 已实现的接口能力：油猴脚本启动时自检，用于识别「后端是旧版本」
    features: ['ums.fetch', 'ums.config', 'ums.cookie', 'ums.cookieBackup', 'ums.agentData', 'ums.known', 'ding.push', 'ding.auto']
  });
});

// 服务端日志（最近 limit 条，环形缓冲）：页面「日志」弹窗按需/定时拉取
router.get('/api/logs', (req, res) => {
  const limit = Math.min(LOG_MAX, Math.max(1, Number(req.query.limit) || 200));
  res.json({ total: LOG_BUFFER.length, max: LOG_MAX, lines: LOG_BUFFER.slice(-limit) });
});

router.get('/api/settings', (req, res) => {
  res.json({
    map: currentMap(),
    ignore: currentIgnore(),
    jobTypes: CFG.JOB_TYPES,
    unmatched: CFG.UNMATCHED_TYPE,
    zones: zoneRows()
  });
});

// 保存映射与忽略分区（未提交/值为空的分区视为「不映射」-> 从映射中移除），并按新设置重算历史数据集
router.post('/api/settings', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const input = (req.body && req.body.map) || {};
    const map = {};
    for (const key of Object.keys(input)) {
      const zone = String(key).trim();
      const type = String(input[key] == null ? '' : input[key]).trim();
      if (!zone || !type) continue;
      if (CFG.JOB_TYPES.indexOf(type) < 0) {
        return res.status(400).json({ error: '分区「' + zone + '」的作业类型不合法：' + type });
      }
      map[zone] = type;
    }

    // 忽略分区：命中即完全排除出统计（与其映射无关）
    const ignore = [];
    const inputIgnore = req.body && req.body.ignore;
    if (inputIgnore != null && !Array.isArray(inputIgnore)) {
      return res.status(400).json({ error: '忽略分区列表格式不合法（应为分区名数组）' });
    }
    (inputIgnore || []).forEach(z => {
      const zone = String(z == null ? '' : z).trim();
      if (zone && ignore.indexOf(zone) < 0) ignore.push(zone);
    });

    db.setSetting(CFG.MAPPING_KEY, map);
    db.setSetting(CFG.IGNORE_KEY, ignore);
    const r = rebuildAll(map, ignore);
    logInfo('[设置] 分区映射 ' + Object.keys(map).length + ' 项、忽略分区 ' + ignore.length +
      ' 项已保存；重算 ' + r.updated.length + ' 个数据集' +
      (r.skipped.length ? '，跳过 ' + r.skipped.length + ' 个（缺原始明细）' : '') +
      (r.failed.length ? '，失败 ' + r.failed.length + ' 个' : ''));
    if (r.failed.length) logWarn('[设置] 重算失败：' + JSON.stringify(r.failed).slice(0, 300));
    res.json({ ok: true, map, ignore, updated: r.updated, skipped: r.skipped, failed: r.failed });
  } catch (e) {
    logWarn('[设置] 保存失败：' + (e.message || e));
    res.status(400).json({ error: e.message || String(e) });
  }
});

router.get('/api/datasets', (req, res) => {
  res.json(db.list());
});

router.get('/api/latest', (req, res) => {
  const rq = rangeQuery(req);
  if (rq) return sendRange(res, rq.from, rq.to, rq.bucket);
  const ds = db.latest();
  if (!ds) return res.status(404).json({ error: '暂无数据，请先上传拣货单' });
  res.json(withDate(ds, req.query.date));
});

router.get('/api/datasets/:id', (req, res) => {
  const rq = rangeQuery(req);
  if (rq) return sendRange(res, rq.from, rq.to, rq.bucket);
  const ds = db.get(req.params.id);
  if (!ds) return res.status(404).json({ error: '数据集不存在' });
  try {
    res.json(withDate(ds, req.query.date));
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

/* 周 / 月视图：汇总区间内所有数据集的明细后重算（每个数据集常只含一天）。
   bucket=week 按自然周分桶（月视图），否则按日期分桶（周视图） */
router.get('/api/range', (req, res) => {
  const from = req.query.from, to = req.query.to;
  if (!isYmd(from) || !isYmd(to) || to < from) {
    return res.status(400).json({ error: '需要有效的 from / to（YYYY-MM-DD，且 to ≥ from）' });
  }
  sendRange(res, from, to, req.query.bucket);
});

/* 单日：按日期跨数据集定位数据集（视图页面切回日视图等场景） */
router.get('/api/day', (req, res) => {
  const date = req.query.date;
  if (!isYmd(date)) return res.status(400).json({ error: '需要有效的 date（YYYY-MM-DD）' });
  const rows = db.list().filter(r => String(r.dates == null ? '' : r.dates).split(',').indexOf(date) >= 0);
  const ds = rows.length ? db.get(rows[0].id) : null;
  if (!ds) return res.status(404).json({ error: '该日期暂无数据（' + date + '）' });
  try { res.json(withDate(ds, date)); }
  catch (e) { res.status(400).json({ error: e.message || String(e) }); }
});

// 上传：raw body 传 xlsx 字节，文件名通过 ?name= 或 x-filename 头传入
// 覆盖/新增规则：以文件内「拣货开始时间」的日期集合为时间维度，
// 命中同维度历史记录则整条覆盖，否则新增一条（文件名不再参与匹配）
// opts.merge（实时增量获取）：命中同维度时把新明细并入已有明细后重建，而不是整体替换
// opts.replaceDates：这些日期的旧明细整条替换（整段抓取完整、旧上传数据无单号无法合并时用）
function saveBuilt(built, opts) {
  const dates = built.dataset.meta.dates;
  const hit = db.findByDates(dates);
  const src = built.dataset.meta.sourceFile || '上传文件';
  if (opts && opts.merge) {
    // 增量：优先并入同时间维度的数据集；增量只取到部分日期时并入日期有交集的最新一条
    const target = hit || db.findByOverlap(dates);
    const oldRecs = target ? db.recsOf(target.id) : null;
    if (target && oldRecs && oldRecs.length) {
      const prev = db.get(target.id);
      const m = compute.mergeInto(oldRecs, built, (prev && prev.meta) || {}, currentIgnore(), {
        replaceDates: opts.replaceDates
      });
      if (!m.added && !m.replaced) {
        logInfo('[入库] ' + src + '：无新增/覆盖，跳过写入（数据集 #' + target.id + '）');
        return Object.assign({ id: target.id, mode: 'merge', added: 0, replaced: 0 }, m.dataset);
      }
      db.overwrite(target.id, m.dataset, m.recs);
      logInfo('[入库] ' + src + '：增量并入数据集 #' + target.id +
        '，新增 ' + m.added + ' 条、覆盖 ' + m.replaced + ' 条，有效明细 ' + m.dataset.meta.recordCount + ' 条');
      markDataChanged();   // 有新数据：供定时推送判断「有新数据才推」
      return Object.assign({ id: target.id, mode: 'merge', added: m.added, replaced: m.replaced }, m.dataset);
    }
  }
  // 未命中同维度：新建数据集（或整体替换同维度的数据集）
  const before = hit ? (db.recsOf(hit.id) || []).length : 0;
  const id = hit
    ? db.overwrite(hit.id, built.dataset, built.recs)
    : db.insert(built.dataset, built.recs);
  logInfo('[入库] ' + src + '：' + (hit ? '覆盖数据集 #' + id : '新建数据集 #' + id) +
    '，明细 ' + built.recs.length + ' 条' + (before ? '（替换旧明细 ' + before + ' 条）' : '') +
    '，日期 ' + dates.join('、'));
  markDataChanged();   // 有新数据：供定时推送判断「有新数据才推」
  return Object.assign({
    id: id, mode: hit ? 'overwrite' : 'create',
    added: built.recs.length, replaced: before
  }, built.dataset);
}

router.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  const name = String(req.query.name || req.get('x-filename') || 'upload.xlsx');
  try {
    const buf = req.body;
    if (!buf || !buf.length) {
      logWarn('[上传] ' + name + '：未收到文件内容');
      return res.status(400).json({ error: '未收到文件内容' });
    }
    logInfo('[上传] ' + name + '（' + Math.round(buf.length / 1024) + ' KB）解析中…');
    const built = compute.buildFromBuffer(buf, name, currentMap(), currentIgnore());
    res.json(saveBuilt(built));
  } catch (e) {
    logWarn('[上传] ' + name + ' 失败：' + (e.message || e));
    res.status(400).json({ error: e.message || String(e) });
  }
});

/* ---------- 实时拣货单接口（ums） ----------
   后端带 Cookie 翻页拉取 /api/ums/fetch，解析入库口径与上传完全一致
   分页：index 是页码（0 起，0 为倒序第一页 = 最新），num 是每页条数，
        totalNum 为区间内总条数 -> 总页数 = ceil(totalNum / num)，逐页 index+1 取到取满
   增量：从最新页往回取，遇到「整页拣货单号都已入库」即认为追平，并入已有明细而不整体替换 */

// 同一时刻只允许一个获取任务（手动 / 自动共用）
let umsBusy = false;

/* 取数进度（内存，仅当前任务）：页面弹窗与顶栏据此显示「第 x / N 页」。
   totalPages 由接口每页返回的 totalNum 与 num 直接算出 ceil(totalNum / num)，
   拿到第一页即确定，不靠已取条数累计猜测；任务结束置空 */
let UMS_PROGRESS = null;

function umsProgressInfo() {
  return UMS_PROGRESS;
}

// 接口地址（含固定查询参数）
function umsUrl(startDate, endDate, index, num) {
  const q = new URLSearchParams();
  q.set('pickOperateType', '3');
  Object.keys(CFG.UMS_EXTRA_QUERY).forEach(k => q.set(k, CFG.UMS_EXTRA_QUERY[k]));
  q.set('pickOrderCode', '');
  q.set('externalBatchCode', '');
  q.set('subTaskType', '');
  q.set('deliveryCodes', '');
  q.set('index', String(index));
  q.set('num', String(num));
  q.set('startDate', startDate);
  q.set('endDate', endDate);
  return CFG.UMS_URL + '?' + q.toString();
}

function umsCookie() {
  return String(db.getSetting(CFG.UMS_COOKIE_KEY) || process.env.HEMA_UMS_COOKIE || '').trim();
}

// 备用 Cookie：与主 Cookie 一起随机先后使用；某份鉴权失败（登录态过期）或被风控（限流）时改用另一份
function umsCookieBackup() {
  return String(db.getSetting(CFG.UMS_COOKIE_BACKUP_KEY) || '').trim();
}

/* 本次取数可用的 Cookie 候选（去重、忽略空值），带角色标记 tag：
   primary / backup 传入时优先（页面本次填写的），否则用已保存的主 / 备用。
   返回 [{ cookie, tag }]，执行时由 umsRunFetch 随机打乱先后顺序 */
function umsCookieCandidates(primary, backup) {
  const p = String(primary || '').trim() || umsCookie();
  const b = String(backup || '').trim() || umsCookieBackup();
  const out = [];
  if (p) out.push({ cookie: p, tag: '主' });
  if (b && b !== p) out.push({ cookie: b, tag: '备用' });
  return out;
}

// Fisher-Yates 洗牌：每次取数随机决定先用哪份 Cookie，分摊请求以降低单份被风控的概率
function umsShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// 每页条数（num）：页面可设置，未设置或非法时用默认值
function umsNum() {
  const n = Number(db.getSetting(CFG.UMS_NUM_KEY));
  return CFG.UMS_NUM_CHOICES.indexOf(n) >= 0 ? n : CFG.UMS_PAGE_SIZE;
}

// 自动获取间隔：非法值（空/非数/≤0）按 30 分钟，其余钳到允许区间
function umsClampInterval(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(CFG.UMS_AUTO_MAX_INTERVAL, Math.max(CFG.UMS_AUTO_MIN_INTERVAL, n));
}

// 自动获取设置：开关 + 间隔分钟 + 每日执行时段（均为当天时间点，如 07:00 ~ 22:30）
function umsAutoCfg() {
  const a = db.getSetting(CFG.UMS_AUTO_KEY) || {};
  return {
    enabled: !!a.enabled,
    intervalMin: umsClampInterval(a.intervalMin),
    timeStart: a.timeStart || '',   // 空 = 不限，格式 HH:MM，如 '07:00'
    timeEnd: a.timeEnd || ''        // 空 = 不限，格式 HH:MM，如 '22:30'
  };
}

// 检查当前时间是否在配置的执行时段内（东八区）；未设时段 = 全天
function umsInTimeWindow(cfg) {
  if (!cfg.timeStart && !cfg.timeEnd) return true;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sh, sm] = (cfg.timeStart || '00:00').split(':').map(Number);
  const [eh, em] = (cfg.timeEnd || '23:59').split(':').map(Number);
  return cur >= (sh * 60 + sm) && cur <= (eh * 60 + em);
}

/* 时段边界到点：在设置的「开始时间 / 结束时间」各额外强制取数一次（不受间隔排期限制）。
   返回 '' | 'start' | 'end'。用 umsAutoState.edge 记录当天已执行的边界，同一时刻只触发一次；
   到点后的 UMS_EDGE_WINDOW_MIN 分钟内允许补执行 —— 首次因冷却 / 任务占用被跳过时不会漏掉 */
function umsEdgeHit(cfg, st) {
  if (!cfg.timeStart && !cfg.timeEnd) return '';      // 未设时段 = 全天，无边界
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  const day = now.toISOString().slice(0, 10);
  const hit = function (hhmm, kind) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const at = h * 60 + m;
    if (!(cur >= at && cur < at + CFG.UMS_EDGE_WINDOW_MIN)) return '';
    return st.edge === day + ':' + kind ? '' : kind;
  };
  return hit(cfg.timeStart, 'start') || hit(cfg.timeEnd, 'end');
}

// 最近一次自动获取结果（供页面展示）；failures/nextMin 为连续失败次数与退避后的下次间隔，
// nextAt 为排期好的下次执行时间（页面据此在临近触发前显示倒计时），
// cfgInterval 为排期时使用的「设置里的间隔」，用来判断用户改过间隔后是否需要重新排期，
// edge 记录当天已执行的「时段边界额外取数」（形如 '2026-09-30:end'），避免同一时刻重复触发
function umsAutoState() {
  const s = db.getSetting(CFG.UMS_AUTO_STATE_KEY) || {};
  return {
    at: s.at || null, ok: s.ok == null ? null : !!s.ok,
    error: s.error || '', records: s.records || 0, added: s.added || 0,
    failures: s.failures || 0, nextMin: s.nextMin || 0,
    nextAt: s.nextAt || null, cfgInterval: s.cfgInterval || 0,
    edge: s.edge || ''
  };
}

// 当天日期：接口数据与门店都按东八区计时
function umsToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/* 取数条件：页面「开始日期 / 结束日期」保存到服务端，手动与自动获取共用同一区间。
   · 单日区间视为「跟随当天」：日期已过（如昨天设的当天）时顺延到今天，
     避免浏览器没开着（自动获取只在服务端跑）时一直抓旧日期；
   · 多日区间视为用户明确指定的区间，原样使用；
   · 未设置或非法时回退当天 */
function umsRangeCfg() {
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  const r = db.getSetting(CFG.UMS_RANGE_KEY) || {};
  const start = ok.test(r.startDate) ? r.startDate : '';
  let end = ok.test(r.endDate) ? r.endDate : '';
  const today = umsToday();
  if (!start) return { startDate: today, endDate: today };
  if (!end || end < start) end = start;
  if (start === end && end < today) return { startDate: today, endDate: today };   // 单日顺延
  return { startDate: start, endDate: end };
}

/* ---------- 防风控：取数冷却（手动 / 自动 / 脚本共用同一窗口） ----------
   每次「尝试取数」（不论成功失败）都记一次时间，两次取数间隔不得小于
   CFG.UMS_FETCH_COOLDOWN_SEC 秒，避免连续点按或自动与手动叠加触发接口风控 */

// 记录一次取数尝试
function umsMarkTry() {
  db.setSetting(CFG.UMS_LAST_TRY_KEY, new Date().toISOString());
}

// 冷却状态：waitSec > 0 表示还在冷却中，禁止再次取数
function umsCooldownInfo() {
  const sec = CFG.UMS_FETCH_COOLDOWN_SEC;
  const at = db.getSetting(CFG.UMS_LAST_TRY_KEY) || '';
  const t = at ? Date.parse(at) : 0;
  return {
    sec: sec,
    at: at || null,
    waitSec: t ? Math.max(0, Math.ceil((t + sec * 1000 - Date.now()) / 1000)) : 0
  };
}

// 页面用配置（Cookie 只回布尔，不回原文）
function umsConfigPayload() {
  return {
    cookieSet: !!umsCookie(),
    cookieBackupSet: !!umsCookieBackup(),
    build: BUILD_ID,
    num: umsNum(),
    numChoices: CFG.UMS_NUM_CHOICES,
    range: umsRangeCfg(),
    auto: Object.assign(umsAutoCfg(), umsAutoState()),
    agent: db.getSetting(CFG.UMS_AGENT_STATE_KEY) || null,
    lastFetch: db.getSetting(CFG.UMS_LAST_KEY) || null,
    progress: umsProgressInfo(),
    cooldown: umsCooldownInfo(),
    // 最近一次手动获取结果的轻量摘要（完整结果由 /api/ums/result 领取，避免轮询反复传大对象）
    manual: UMS_MANUAL ? { at: UMS_MANUAL.at, ok: UMS_MANUAL.ok, range: UMS_MANUAL.range } : null
  };
}

// 防风控：随机停顿指定毫秒区间（翻页间隔用，避免连续快速请求被 UMS 判定为异常流量）
function umsSleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* Cookie 失效（登录态过期）时的统一指引：手动跑一次油猴脚本即会重新读取并保存 Cookie。
   放在错误信息开头，页面弹窗与自动获取失败提示都能直接看到。 */
const UMS_COOKIE_HINT = 'Cookie 已失效（登录态过期）：请打开盒马工作台页面，点右下角插件面板里的'
  + '「立即同步」手动同步一次，脚本会重新读取并保存 Cookie';

// 鉴权类错误（登录态失效）：打上 umsAuth 标记，取数时据此改用备用 Cookie 重试
function umsAuthError(msg) {
  const e = new Error(msg);
  e.umsAuth = true;
  return e;
}

// 风控类错误（限流）：打上 umsThrottle 标记，取数时据此改用备用 Cookie 重试。
// 风控按 IP / 请求频次判定，但换一份 Cookie 有时能命中不同的限流维度，故也回退试一次
function umsThrottleError(msg) {
  const e = new Error(msg);
  e.umsThrottle = true;
  return e;
}

// 逐页拉取直到取满 totalNum；incremental 时遇到「整页单号都已入库」提前结束
// 返回 { info: { list, totalNum }, pages, totalPages, reached, complete }
//   reached  ：增量模式下提前追平（本次只拿到新增部分）
//   complete ：跑完了整个区间（拿到全部明细）
async function umsFetchAll(startDate, endDate, cookie, opts) {
  const o = opts || {};
  const size = o.size || CFG.UMS_PAGE_SIZE;
  const known = o.incremental ? db.knownPickNos() : null;
  const list = [];
  let index = 0, total = 0, pages = 0, totalPages = 0, reached = false, complete = false;
  umsMarkTry();                                     // 记录本次取数尝试，开始与其他取数共用冷却窗口
  for (;;) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CFG.UMS_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(umsUrl(startDate, endDate, index, size), {
        headers: { Cookie: cookie, Accept: 'application/json, text/plain, */*' },
        signal: ac.signal
      });
    } catch (e) {
      throw new Error('请求接口失败（' + (e.name === 'AbortError' ? '超时' : (e.message || e)) + '）');
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      // 401 / 403：登录态问题，直接给出手动同步一次的指引
      if (resp.status === 401 || resp.status === 403) {
        throw umsAuthError(UMS_COOKIE_HINT + '（接口返回 HTTP ' + resp.status + '）');
      }
      // 429：请求过于频繁被限流，标记为风控类，可改用备用 Cookie 重试
      if (resp.status === 429) {
        throw umsThrottleError('接口被限流（HTTP 429）：请求过于频繁，本次未取到数据，稍后会自动重试');
      }
      throw new Error('接口返回 HTTP ' + resp.status);
    }
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // UMS 出错时返回的是 HTML 页面，转成简短可读的原因（页面上会直接展示）
      const snippet = text.replace(/<[^>]*>/g, ' ').replace(/[\s\u00a0]+/g, ' ').trim().slice(0, 80);
      if (/被挤爆|人太多/.test(text)) {
        throw umsThrottleError('接口被限流：UMS 返回「亲~人太多，被挤爆了！」（请求过于频繁），本次未取到数据，稍后会自动重试');
      }
      if (/登录|login|passport|sso/i.test(text)) {
        // 登录页整页都是 HTML/CSS 噪声，不回片段，只给「手动同步一次」的指引
        throw umsAuthError(UMS_COOKIE_HINT);
      }
      throw umsAuthError('接口未返回 JSON，可能是 Cookie 失效：' + UMS_COOKIE_HINT + (snippet ? '（' + snippet + '）' : ''));
    }
    if (json.code !== 200 || !json.info) {
      throw new Error('接口返回异常：' + JSON.stringify(json).slice(0, 200));
    }
    const got = json.info.list || [];
    list.push.apply(list, got);
    total = Number(json.info.totalNum) || list.length;
    totalPages = Math.max(1, Math.ceil(total / size));
    pages++;
    if (o.onProgress) o.onProgress({ pages, totalPages, got: list.length, total });
    if (known && got.length && got.every(it => known.has(String(it.code)))) { reached = true; break; }
    index++;                                        // index 是页码（index=0 为倒序第一页），逐页 +1
    if (!got.length || list.length >= total) { complete = true; break; }
    if (pages >= CFG.UMS_MAX_PAGES) break;
    // 防风控：翻页之间随机停顿 300~900ms，避免高频连续请求触发限流
    await umsSleep(CFG.UMS_PAGE_GAP_MIN_MS +
      Math.round(Math.random() * (CFG.UMS_PAGE_GAP_MAX_MS - CFG.UMS_PAGE_GAP_MIN_MS)));
  }
  return { info: { list: list, totalNum: total }, pages: pages, totalPages: totalPages, reached: reached, complete: complete };
}

// 最近一次获取结果（首页角标显示 状态 + 距上次获取的时长）
function umsRemember(state) {
  const last = Object.assign({ at: new Date().toISOString() }, state);
  db.setSetting(CFG.UMS_LAST_KEY, last);
  return last;
}

/* 一次完整获取：翻页拉取 -> 解析 -> 入库（merge=incremental），手动与自动获取共用
   整段抓取完整（complete）时把抓取日期范围内的旧明细整条替换：
   手动上传的当天数据没有单号、无法按单号合并，覆盖掉才不会与新抓的同一单重复计数 */
async function umsRunFetchOnce(startDate, endDate, incremental, cookie, tag) {
  const size = umsNum();
  UMS_PROGRESS = {
    active: true, pages: 0, totalPages: 0, got: 0, total: 0,
    startDate: startDate, endDate: endDate, startedAt: Date.now()
  };
  let r;
  try {
    r = await umsFetchAll(startDate, endDate, cookie, {
      size: size, incremental: incremental,
      onProgress: function (p) {
        UMS_PROGRESS.pages = p.pages;
        UMS_PROGRESS.totalPages = p.totalPages;   // = ceil(totalNum / num)
        UMS_PROGRESS.got = p.got;
        UMS_PROGRESS.total = p.total;
      }
    });
  } finally {
    UMS_PROGRESS = null;                          // 任务结束（含失败）：进度置空
  }
  const label = '实时接口 ' + startDate + ' ~ ' + endDate + (incremental && !r.complete ? '（增量）' : '');
  const built = compute.buildFromUms(r.info, { sourceFile: label }, currentMap(), currentIgnore());
  const out = saveBuilt(built, {
    merge: incremental,
    replaceDates: r.complete ? built.dataset.meta.dates : null
  });
  const last = umsRemember({
    label, mode: out.mode, added: out.added || 0, replaced: out.replaced || 0,
    records: out.meta.recordCount, id: out.id
  });
  return Object.assign(out, { pages: r.pages, totalPages: r.totalPages, reached: r.reached, last: last, cookieTag: tag || '主' });
}

/* 取数：把候选 Cookie（主 / 备用）随机排序后依次尝试 —— 每次随机先用主或备用，
   摊薄单份 Cookie 的请求频次；鉴权失效（登录态过期）或遇到风控（限流）时改用下一份重试；
   超时 / 网络错误 / 其它 HTTP 错误直接抛出（换 Cookie 也解决不了，重试只会徒增请求） */
async function umsRunFetch(startDate, endDate, incremental, candidates) {
  const list = umsShuffle((Array.isArray(candidates) ? candidates : [candidates])
    .map(function (c) { return (c && typeof c === 'object') ? c : { cookie: c, tag: '主' }; })
    .filter(function (c) { return !!(c && c.cookie); }));
  if (!list.length) throw new Error('未配置接口 Cookie，无法获取（请在弹窗中粘贴一次 Cookie 后重试）');
  if (list.length > 1) logInfo('[取数] 本次随机先用 ' + list[0].tag + ' Cookie');
  let lastErr;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const tag = it.tag || (i === 0 ? '主' : '备用');
    try {
      const out = await umsRunFetchOnce(startDate, endDate, incremental, it.cookie, tag);
      if (i > 0) logInfo('[取数] ' + tag + ' Cookie 取数成功（已回退）');
      out.cookieFallback = i > 0;          // 首个 Cookie 未成功、已改用后续 Cookie
      return out;
    } catch (e) {
      lastErr = e;
      const retryable = e.umsAuth || e.umsThrottle;
      if (!retryable || i === list.length - 1) throw e;   // 不可回退 / 已无更多候选：抛出
      logWarn('[取数] ' + tag + ' Cookie ' + (e.umsAuth ? '鉴权失败' : '被风控') + '，改用下一份 Cookie 重试');
    }
  }
  throw lastErr;
}

/* 后台跑一次手动获取，结果写入 UMS_MANUAL 供页面领取。
   为什么不在 HTTP 请求里 await 结果：全量取数页数多、耗时长，长连接挂着等结果时
   容易被中间层（nginx / 网关 / 网络）掐断，出现「前端报 Failed to fetch，但后端其实已成功入库」。
   改为「启动即返回 + 页面轮询进度」后，连接只是短请求，不受取数耗时影响 */
let UMS_MANUAL = null;   // { at, ok:true, range, out } | { at, ok:false, range, error }
async function umsRunManualJob(startDate, endDate, incremental, cookies, range) {
  const t0 = Date.now();
  umsBusy = true;                                   // 同步置忙，防止启动返回后紧接着又来一次
  try {
    const out = await umsRunFetch(startDate, endDate, incremental, cookies);
    logInfo('[取数] 手动获取完成：' + out.pages + '/' + out.totalPages + ' 页，明细 ' + out.meta.recordCount +
      ' 条，新增 ' + (out.added || 0) + ' 条、覆盖 ' + (out.replaced || 0) + ' 条，数据集 #' + out.id +
      '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    UMS_MANUAL = { at: new Date().toISOString(), ok: true, range: range, out: out };
  } catch (e) {
    logWarn('[取数] 手动获取 ' + range + ' 失败（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）：' + (e.message || e));
    UMS_MANUAL = { at: new Date().toISOString(), ok: false, range: range, error: String(e.message || e) };
  } finally {
    umsBusy = false;
  }
}

/* ---------- 油猴脚本同步（userscript/hema-pick-sync.user.js） ----------
   UMS 登录态是 HttpOnly Cookie，脚本读不到，所以换思路：
   脚本在 ums.hemaos.com 页面内用当前登录态「同源」请求接口（浏览器自动带 Cookie），
   把逐页结果回传到 /api/ums/agent/data 入库 —— 后端不需要任何 Cookie */

// 脚本回传数据入库：pages 为逐页响应数组；complete=整段抓取完整 -> 覆盖该日期范围的旧明细
router.post('/api/ums/agent/data', express.json({ limit: '100mb' }), (req, res) => {
  const body = req.body || {};
  const startDate = String(body.startDate || '').trim();
  const endDate = String(body.endDate || startDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  }
  if (!Array.isArray(body.pages) || !body.pages.length) {
    return res.status(400).json({ error: 'pages 应为逐页响应数组' });
  }
  if (umsBusy) {
    logWarn('[取数] 脚本同步被拒绝：已有获取任务正在进行');
    return res.status(409).json({ error: '已有获取任务正在进行，请稍后再试' });
  }
  umsBusy = true;
  const range = startDate + ' ~ ' + endDate;
  const t0 = Date.now();
  try {
    umsMarkTry();                                   // 脚本同步同样占用冷却窗口
    const complete = !!body.complete;
    logInfo('[取数] 脚本同步 ' + range + ' 开始：' + body.pages.length + ' 页，complete=' + complete +
      '，reached=' + !!body.reached);
    const label = '浏览器脚本 ' + range + (complete ? '' : '（增量）');
    const built = compute.buildFromUms(body.pages, { sourceFile: label }, currentMap(), currentIgnore());
    const out = saveBuilt(built, {
      merge: true,
      replaceDates: complete ? built.dataset.meta.dates : null
    });
    const last = umsRemember({
      label, mode: out.mode, added: out.added || 0, replaced: out.replaced || 0,
      records: out.meta.recordCount, id: out.id
    });
    db.setSetting(CFG.UMS_AGENT_STATE_KEY, {
      at: last.at, ok: true, error: '', range: range,
      complete: complete, reached: !!body.reached,
      added: out.added || 0, replaced: out.replaced || 0, records: out.meta.recordCount
    });
    res.json(Object.assign(out, { pages: body.pages.length, last: last }));
    logInfo('[取数] 脚本同步完成：新增 ' + (out.added || 0) + ' 条、覆盖 ' + (out.replaced || 0) +
      ' 条，数据集 #' + out.id + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  } catch (e) {
    db.setSetting(CFG.UMS_AGENT_STATE_KEY, {
      at: new Date().toISOString(), ok: false, error: String(e.message || e).slice(0, 200),
      range: range, added: 0, replaced: 0, records: 0
    });
    logWarn('[取数] 脚本同步 ' + range + ' 失败：' + (e.message || e));
    res.status(400).json({ error: e.message || String(e) });
  } finally {
    umsBusy = false;
  }
});

// 脚本增量追平判定：这批拣货单号里有多少条已入库
router.post('/api/ums/known', express.json({ limit: '1mb' }), (req, res) => {
  const codes = (req.body && req.body.codes) || [];
  if (!Array.isArray(codes)) return res.status(400).json({ error: 'codes 应为数组' });
  const known = db.knownPickNos();
  let n = 0;
  codes.forEach(c => { if (known.has(String(c))) n++; });
  res.json({ known: n, total: codes.length });
});

/* 手动获取：需要 Cookie（页面里保存或环境变量 HEMA_UMS_COOKIE）。
   只「启动」任务并立即返回（202）：实际取数在后台跑，前端轮询 /api/ums/config 看进度、
   轮询 /api/ums/result 领取结果 —— 全量取数耗时长，避免长连接被中间层掐断导致误报失败 */
router.post('/api/ums/fetch', express.json({ limit: '1mb' }), (req, res) => {
  const body = req.body || {};
  const startDate = String(body.startDate || '').trim();
  const endDate = String(body.endDate || startDate).trim();
  const incremental = !!body.incremental;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  }
  const cookies = umsCookieCandidates(String(body.cookie || '').trim(), String(body.cookieBackup || '').trim());
  if (!cookies.length) {
    logWarn('[取数] 未配置 Cookie，无法手动获取');
    return res.status(400).json({ error: '未配置接口 Cookie，无法获取（请在弹窗中粘贴一次 Cookie 后重试）' });
  }
  if (umsBusy) {
    logWarn('[取数] 手动获取被拒绝：已有任务正在进行');
    return res.status(409).json({ error: '已有获取任务正在进行，请稍后再试' });
  }
  // 冷却：距上次取数（含自动获取 / 脚本同步）不足冷却时长时拒绝，避免触发接口风控
  const cd = umsCooldownInfo();
  if (cd.waitSec > 0) {
    logWarn('[取数] 冷却中，拒绝手动获取（剩 ' + cd.waitSec + ' 秒）');
    return res.status(429).json({
      error: '冷却中：为避免触发接口风控，请 ' + cd.waitSec + ' 秒后再试（自动获取同样计入冷却）',
      waitSec: cd.waitSec
    });
  }
  const range = startDate + ' ~ ' + endDate;
  logInfo('[取数] 手动获取 ' + range + (incremental ? '（增量）' : '（全量）') + ' 开始');
  UMS_MANUAL = null;                                // 清掉上一次结果，供本次完成后领取
  umsRunManualJob(startDate, endDate, incremental, cookies, range);   // 不 await：后台跑
  res.status(202).json({ started: true, range: range, progress: umsProgressInfo() });
});

/* 领取最近一次手动获取结果：页面启动任务后轮询到这里取完整结果（含入库后的数据集） */
router.get('/api/ums/result', (req, res) => {
  res.json(UMS_MANUAL || { ok: null });
});

/* ---------- 自动获取：服务端按间隔轮询，每次取「页面取数条件」的日期区间增量并入 ----------
   与手动获取共用 umsRunFetch；上一轮未跑完（umsBusy）时跳过本轮；
   未配置 Cookie 时直接跳过（页面里会提示）；每次尝试都记 umsAutoState.at。
   防风控：间隔加随机抖动，连续失败按指数退避（上限 UMS_BACKOFF_MAX_MIN 分钟）。
   排期固定写入 umsAutoState.nextAt —— 服务端据此判断是否到点，页面据此显示倒计时 */

// 防风控：间隔抖动系数（±CFG.UMS_INTERVAL_JITTER），避免固定时刻规律打点
function umsJitter() {
  return 1 + (Math.random() * 2 - 1) * CFG.UMS_INTERVAL_JITTER;
}

// 本次应等待的间隔（分钟）：连续失败时按指数退避
function umsAutoWaitMin(auto, st) {
  const fails = st.failures || 0;
  return fails > 0
    ? Math.min(CFG.UMS_BACKOFF_MAX_MIN, auto.intervalMin * Math.pow(2, fails))
    : auto.intervalMin;
}

// 下次执行时间（ms）：优先用已排期的时间；配置间隔变了（或从未排期）则按当前间隔重算
function umsAutoNextAt(auto, st) {
  const t = st.nextAt ? Date.parse(st.nextAt) : 0;
  if (t && st.cfgInterval === auto.intervalMin) return t;
  const last = st.at ? Date.parse(st.at) : 0;
  return last ? last + umsAutoWaitMin(auto, st) * 60000 : Date.now();   // 从未跑过：立即执行
}

async function umsAutoTick() {
  if (umsBusy) return;
  const auto = umsAutoCfg();
  if (!auto.enabled) return;
  const cookies = umsCookieCandidates();
  if (!cookies.length) return;
  const st = umsAutoState();
  const edge = umsEdgeHit(auto, st);      // 时段「开始 / 结束」时刻：额外强制取数一次
  if (!edge) {
    // 不在执行时段内：跳过（不更新 at，到点后自然会触发）
    if (!umsInTimeWindow(auto)) return;
    if (Date.now() < umsAutoNextAt(auto, st)) return;   // 未到排期时间
  }
  // 与手动获取共用冷却窗口：距上次取数（含手动 / 脚本）不足冷却时长时跳过本轮
  if (umsCooldownInfo().waitSec > 0) return;

  const fails = st.failures || 0;
  const edgeKey = edge ? umsToday() + ':' + edge : (st.edge || '');
  const badge = edge ? '（时段' + (edge === 'start' ? '开始' : '结束') + '额外获取）' : '';
  const range = umsRangeCfg();
  const day = range.startDate + (range.endDate === range.startDate ? '' : ' ~ ' + range.endDate);
  // 单日区间被顺延到当天：写回设置，让页面看到的取数条件与实际执行的保持一致
  const stored = db.getSetting(CFG.UMS_RANGE_KEY) || {};
  if (stored.startDate !== range.startDate || stored.endDate !== range.endDate) {
    db.setSetting(CFG.UMS_RANGE_KEY, { startDate: range.startDate, endDate: range.endDate });
    logInfo('[取数条件] 单日区间顺延到当天 → ' + day);
  }
  const t0 = Date.now();
  umsBusy = true;
  try {
    const out = await umsRunFetch(range.startDate, range.endDate, true, cookies);
    const at = new Date();
    const nextAt = new Date(at.getTime() + auto.intervalMin * 60000 * umsJitter());
    db.setSetting(CFG.UMS_AUTO_STATE_KEY, {
      at: at.toISOString(), ok: true, error: '',
      records: out.meta.recordCount, added: out.added || 0,
      failures: 0, nextMin: auto.intervalMin, cfgInterval: auto.intervalMin,
      nextAt: nextAt.toISOString(), edge: edgeKey
    });
    logInfo('[自动获取] ' + day + badge + ' 完成：明细 ' + out.meta.recordCount + ' 条，新增 ' + (out.added || 0) +
      ' 条、覆盖 ' + (out.replaced || 0) + ' 条，数据集 #' + out.id +
      '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，下次 ' + clockOf(nextAt));
  } catch (e) {
    const nf = fails + 1;
    const nextMin = Math.min(CFG.UMS_BACKOFF_MAX_MIN, auto.intervalMin * Math.pow(2, nf));
    const at = new Date();
    const nextAt = new Date(at.getTime() + nextMin * 60000 * umsJitter());
    db.setSetting(CFG.UMS_AUTO_STATE_KEY, {
      at: at.toISOString(), ok: false,
      error: String(e.message || e).slice(0, 160), records: 0, added: 0,
      failures: nf, nextMin: nextMin, cfgInterval: auto.intervalMin,
      nextAt: nextAt.toISOString(), edge: edgeKey
    });
    logWarn('[自动获取] ' + day + badge + ' 失败（连续 ' + nf + ' 次，' + nextMin + ' 分钟后重试，' +
      '下次 ' + clockOf(nextAt) + '）：' + (e.message || e));
  } finally {
    umsBusy = false;
  }
}

setInterval(umsAutoTick, 5 * 1000);   // 5 秒一检查，保证「每 N 分钟」到点后尽快执行

// 读取接口配置：Cookie 状态（不回原文）、每页条数、自动获取设置与最近执行结果
router.get('/api/ums/config', (req, res) => {
  res.json(umsConfigPayload());
});

// 读取已保存的 Cookie 原文：仅点击「Cookie 设置」时按需拉取回填输入框，不放进轮询接口
router.get('/api/ums/cookie', (req, res) => {
  res.json({ cookie: umsCookie(), backup: umsCookieBackup() });
});

// 保存设置：Cookie（传空字符串清除）/ 备用 Cookie / 每页条数 / 自动获取开关与间隔
router.post('/api/ums/config', express.json({ limit: '32kb' }), (req, res) => {
  const body = req.body || {};
  if (typeof body.cookie === 'string') {
    const v = body.cookie.trim();
    if (body.force) {
      // 页面「保存到服务端 / 清除」：显式写入主 Cookie（空字符串 = 清除）
      db.setSetting(CFG.UMS_COOKIE_KEY, v);
      // 只记长度，不把 Cookie 原文写进日志
      logInfo('[设置] 接口 Cookie ' + (v ? '已保存（' + v.length + ' 字符）' : '已清除'));
    } else if (!v) {
      // 脚本推送的空值：忽略（脚本读不到 Cookie 时不会推送，这里兜底）
    } else if (v === umsCookie() || v === umsCookieBackup()) {
      // 脚本推送：与已存的主 / 备用 Cookie 相同 → 跳过，不重复写库、不刷日志
      logInfo('[设置] 脚本推送的 Cookie 与已存相同，已跳过');
    } else if (!umsCookie()) {
      // 脚本推送且主 Cookie 尚未设置：首次以脚本推来的这份作为主 Cookie
      db.setSetting(CFG.UMS_COOKIE_KEY, v);
      logInfo('[设置] 脚本推送的 Cookie 已作为主 Cookie 保存（' + v.length + ' 字符）');
    } else {
      // 脚本推送：与主 Cookie 不同 → 写入备用槽，不覆盖主 Cookie（主失效时自动回退到它）
      db.setSetting(CFG.UMS_COOKIE_BACKUP_KEY, v);
      logInfo('[设置] 脚本推送的 Cookie 与主不同，已写入备用 Cookie（' + v.length + ' 字符）');
    }
  }
  if (typeof body.cookieBackup === 'string') {
    const v = body.cookieBackup.trim();
    db.setSetting(CFG.UMS_COOKIE_BACKUP_KEY, v);
    logInfo('[设置] 备用 Cookie ' + (v ? '已保存（' + v.length + ' 字符）' : '已清除'));
  }
  if (body.num != null && CFG.UMS_NUM_CHOICES.indexOf(Number(body.num)) >= 0) {
    db.setSetting(CFG.UMS_NUM_KEY, Number(body.num));
    logInfo('[设置] 每页条数 → ' + Number(body.num));
  }
  if (body.range && typeof body.range === 'object') {
    const ok = /^\d{4}-\d{2}-\d{2}$/;
    const s = ok.test(body.range.startDate) ? body.range.startDate : '';
    let e = ok.test(body.range.endDate) ? body.range.endDate : '';
    if (s) {
      if (!e || e < s) e = s;
      // 与当前值相同就不再写库/记日志：页面每次加载都会把「默认当天」同步过来，避免刷屏
      const cur = db.getSetting(CFG.UMS_RANGE_KEY) || {};
      if (cur.startDate !== s || cur.endDate !== e) {
        db.setSetting(CFG.UMS_RANGE_KEY, { startDate: s, endDate: e });
        logInfo('[设置] 取数条件 → ' + s + (e === s ? '' : ' ~ ' + e));
      }
    }
  }
  if (body.auto && typeof body.auto === 'object') {
    function clampTime(v) {
      v = String(v || '').trim();
      return /^\d{1,2}:\d{2}$/.test(v) ? v : '';
    }
    db.setSetting(CFG.UMS_AUTO_KEY, {
      enabled: !!body.auto.enabled,
      intervalMin: umsClampInterval(body.auto.intervalMin),
      timeStart: clampTime(body.auto.timeStart),
      timeEnd: clampTime(body.auto.timeEnd)
    });
    const a = umsAutoCfg();
    logInfo('[设置] 自动获取 ' + (a.enabled ? '开启' : '关闭') + '，间隔 ' + a.intervalMin +
      ' 分钟，时段 ' + (a.timeStart || '不限') + ' ~ ' + (a.timeEnd || '不限'));
  }
  res.json(umsConfigPayload());
});

router.delete('/api/datasets/:id', (req, res) => {
  const removed = db.remove(req.params.id);
  logInfo('[数据集] 删除 #' + req.params.id + '，移除 ' + removed + ' 条');
  res.json({ removed: removed });
});

/* ---------- 钉钉群机器人推送（效率透视图截图发到群） ----------
   自定义机器人 Webhook 不支持「图片」消息类型（只支持 text / markdown / link / 卡片），
   图片无法直接上传，只能用 markdown 语法嵌入一个「公网可访问的图片 URL」，由钉钉客户端拉取显示。
   因此这里把前端截好的 PNG 落到 data/ding（公开只读路由 /api/ding/img/<file> 提供），
   拼出公网 URL 后用 markdown 消息发给群机器人。 */
const DING_DIR = process.env.HEMA_DING_DIR
  ? path.resolve(process.env.HEMA_DING_DIR)
  : path.join(__dirname, 'data', 'ding');
fs.mkdirSync(DING_DIR, { recursive: true });

/* 图片对外 URL 的路径前缀（拼在「公网地址」之后）：
   默认走本服务的只读路由 <BASE_PATH>/api/ding/img；
   若把图片目录挂到 nginx 站点目录、由 nginx 直接静态托管，可设 HEMA_DING_URL_PREFIX=/ding */
const DING_URL_PREFIX = (function () {
  const v = process.env.HEMA_DING_URL_PREFIX;
  if (v != null && String(v).trim() !== '') {
    return '/' + String(v).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  }
  return BASE_PATH + '/api/ding/img';
})();

function dingWebhook() { return String(db.getSetting(CFG.DING_WEBHOOK_KEY) || '').trim(); }
function dingSecret() { return String(db.getSetting(CFG.DING_SECRET_KEY) || '').trim(); }
function dingPublicBase() { return String(db.getSetting(CFG.DING_PUBLIC_BASE_KEY) || '').trim().replace(/\/+$/, ''); }

// 掩码展示：Webhook / 密钥含 access_token 与签名密钥，不回明文给前端
function dingMask(s) {
  s = String(s || '');
  if (!s) return '';
  return s.length <= 16 ? s.slice(0, 4) + '****' : s.slice(0, 8) + '……' + s.slice(-4);
}

function dingConfigPayload() {
  const wh = dingWebhook(), sec = dingSecret();
  return {
    webhookSet: !!wh, webhookMask: dingMask(wh),
    secretSet: !!sec, secretMask: dingMask(sec),
    publicBase: dingPublicBase(),
    pageUrl: String(db.getSetting(CFG.DING_PAGE_URL_KEY) || '').trim(),   // 已保存的原始值（可空）
    pageUrlEffective: dingPageUrl(),                                       // 实际会用的地址（留空时为推断值）
    auto: Object.assign(dingAutoCfg(), { state: dingAutoState() }),
    // 定时推送依赖无头浏览器：未安装 puppeteer 时前端给出提示
    captureOk: dingCapture.available(),
    captureError: dingCapture.unavailableReason()
  };
}

/* ---------- 定时推送：看板地址与排期（跟随「自动获取拣货单」） ---------- */

// 无头浏览器打开的看板地址；留空 = 按本机端口 / 子路径推断（服务端自访问）
function dingPageUrl() {
  const v = String(db.getSetting(CFG.DING_PAGE_URL_KEY) || '').trim();
  return v || ('http://127.0.0.1:' + PORT + BASE_PATH + '/');
}

// 数据变更打点：入库发生新增/覆盖时写入当前时间（自动获取 / 手动 / 脚本同步 / 上传共用）
function markDataChanged() {
  db.setSetting(CFG.DING_DATA_AT_KEY, new Date().toISOString());
}

// 最近一次数据变更的时间戳（无则空串），与「上次成功推送时记录的时间戳」比较即可判断是否有新数据
function dingHasNewData() {
  const data = String(db.getSetting(CFG.DING_DATA_AT_KEY) || '');
  const pushed = String(db.getSetting(CFG.DING_PUSHED_AT_KEY) || '');
  return !!data && data > pushed;
}

// 定时推送设置：开关来自钉钉配置；时段与间隔跟随「自动获取拣货单」（umsAutoCfg），不再单独配置
function dingAutoCfg() {
  const a = db.getSetting(CFG.DING_AUTO_KEY) || {};
  const u = umsAutoCfg();
  return {
    enabled: !!a.enabled,
    intervalMin: u.intervalMin,
    timeStart: u.timeStart,
    timeEnd: u.timeEnd
  };
}

// 当前是否在配置的执行时段内（东八区）；未设时段 = 全天
function dingInWindow(cfg) {
  if (!cfg.timeStart && !cfg.timeEnd) return true;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sh, sm] = (cfg.timeStart || '00:00').split(':').map(Number);
  const [eh, em] = (cfg.timeEnd || '23:59').split(':').map(Number);
  return cur >= (sh * 60 + sm) && cur <= (eh * 60 + em);
}

function dingAutoState() {
  const s = db.getSetting(CFG.DING_AUTO_STATE_KEY) || {};
  return { at: s.at || null, ok: s.ok == null ? null : !!s.ok, error: s.error || '', reason: s.reason || '', count: s.count || 0 };
}

// 推送时图片要用的公网基址：优先设置里的固定域名，否则取看板地址的来源（仅供本机 / 内网自测）
function dingPushBase() {
  const b = dingPublicBase();
  if (b) return b;
  try { return new URL(dingPageUrl()).origin; } catch (e) { return ''; }
}

/* 加签（机器人安全设置选「加签」时必填）：
   sign = Base64(HmacSHA256(timestamp + "\n" + secret))，作为查询参数拼到 Webhook 上 */
function dingSignUrl(url, secret) {
  if (!secret) return url;
  const ts = String(Date.now());
  const sign = crypto.createHmac('sha256', secret).update(ts + '\n' + secret).digest('base64');
  return url + (url.indexOf('?') >= 0 ? '&' : '?') +
    'timestamp=' + ts + '&sign=' + encodeURIComponent(sign);
}

// 钉钉配置读取（Webhook / 密钥只回掩码，不回明文）
router.get('/api/ding/config', (req, res) => {
  res.json(dingConfigPayload());
});

// 保存钉钉配置：Webhook / 加签密钥 / 公网地址 / 定时推送（传空字符串 = 清除）
router.post('/api/ding/config', express.json({ limit: '16kb' }), (req, res) => {
  const b = req.body || {};
  if (typeof b.webhook === 'string') {
    const v = b.webhook.trim();
    db.setSetting(CFG.DING_WEBHOOK_KEY, v);
    logInfo('[钉钉] Webhook ' + (v ? '已保存' : '已清除'));
  }
  if (typeof b.secret === 'string') {
    const v = b.secret.trim();
    db.setSetting(CFG.DING_SECRET_KEY, v);
    logInfo('[钉钉] 加签密钥 ' + (v ? '已保存（' + v.length + ' 字符）' : '已清除'));
  }
  if (typeof b.publicBase === 'string') {
    const v = b.publicBase.trim().replace(/\/+$/, '');
    db.setSetting(CFG.DING_PUBLIC_BASE_KEY, v);
    logInfo('[钉钉] 公网地址 ' + (v || '（已清除，按请求 Host 推断）'));
  }
  if (typeof b.pageUrl === 'string') {
    const v = b.pageUrl.trim();
    db.setSetting(CFG.DING_PAGE_URL_KEY, v);
    logInfo('[钉钉] 定时推送看板地址 ' + (v || '（已清除，用本机默认）'));
  }
  if (b.auto && typeof b.auto === 'object') {
    db.setSetting(CFG.DING_AUTO_KEY, { enabled: !!b.auto.enabled });
    const a = dingAutoCfg();
    logInfo('[钉钉] 定时推送 ' + (a.enabled ? '开启' : '关闭') +
      '（时段 / 间隔跟随自动获取：每 ' + a.intervalMin + ' 分钟，时段 ' +
      (a.timeStart || '不限') + ' ~ ' + (a.timeEnd || '不限') + '）');
  }
  res.json(dingConfigPayload());
});

/* 图片落盘：data URL → data/ding/<md5-16>.<ext>（同图不重复写）；返回 { file, bytes } */
function dingSaveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('图片数据格式不合法（应为 data:image/png;base64,…）');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片数据为空');
  if (buf.length > 30 * 1024 * 1024) throw new Error('图片过大（超过 30MB）');
  const ext = m[1].toLowerCase() === 'png' ? 'png' : 'jpg';
  const file = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  const fp = path.join(DING_DIR, file);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
  return { file: file, bytes: buf.length, path: fp };
}

// 效率数值：保留 1 位小数，缺失 / 非数 → '-'
function dingFmtNum(v) {
  return (v == null || v === '' || isNaN(Number(v))) ? '-' : Number(v).toFixed(1);
}

/* 组装 markdown：结构化（效率透视表：统计时间段 + 每块「图片 + 效率 / 平均值 / 中位数」） */
function dingBuildBlocksText(blocks, period, base) {
  const parts = [], urls = [];
  let bytes = 0;
  const p = String(period || '').trim();
  if (p) parts.push('#### 统计时间段：\n \n#### ' + p);
  blocks.forEach(function (bk, i) {
    const name = String(bk.name || '').trim() || '分块';
    const saved = dingSaveImage(bk.image);
    bytes += saved.bytes;
    const url = base + DING_URL_PREFIX + '/' + saved.file;
    urls.push(url);
    logInfo('[钉钉] 图片 ' + (i + 1) + '/' + blocks.length + '「' + name + '」落盘 ' + saved.path +
      '（' + (saved.bytes / 1024).toFixed(0) + 'KB）→ URL ' + url);
    parts.push('#### ' + name + ':\n' +
      '![' + name + '](' + url + ')\n' +
      '#### 效率:' + dingFmtNum(bk.eff) + ' \n 平均值:' + dingFmtNum(bk.avg) + ' 中位数:' + dingFmtNum(bk.median));
  });
  return { text: parts.join('\n\n'), urls: urls, bytes: bytes };
}

// 单图（测试推送 / 兜底）
function dingBuildSingleText(image, title, base) {
  const saved = dingSaveImage(image);
  const url = base + DING_URL_PREFIX + '/' + saved.file;
  logInfo('[钉钉] 图片 1/1「' + title + '」落盘 ' + saved.path +
    '（' + (saved.bytes / 1024).toFixed(0) + 'KB）→ URL ' + url);
  return { text: '#### ' + title + '\n\n![' + title + '](' + url + ')', urls: [url], bytes: saved.bytes };
}

// 发送 markdown 到群（按需加签）；返回 { ok, error? }
async function dingPostMarkdown(webhook, title, text) {
  const sendUrl = dingSignUrl(webhook, dingSecret());
  const r = await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title: title, text: text } })
  });
  const j = await r.json().catch(function () { return null; });
  if (!j || j.errcode !== 0) {
    return { ok: false, error: (j && (j.errmsg || ('errcode ' + j.errcode))) || ('HTTP ' + r.status) };
  }
  return { ok: true };
}

/* 推送：接收前端截图（data:image/png;base64,...）→ 落盘 → 发 markdown 到群。两种入参：
   · 结构化（效率透视表）：{ title?, period?, blocks: [{ name, image, eff, avg, median }] }
   · 单图（测试推送 / 兜底）：{ image, title? }。
   图片走公网 URL 由钉钉客户端拉取，故必须配置可被公网访问的地址（或按本次请求 Host 推断）。 */
router.post('/api/ding/push', express.json({ limit: '48mb' }), async (req, res) => {
  try {
    const webhook = dingWebhook();
    if (!webhook) {
      return res.status(400).json({ error: '未配置钉钉机器人 Webhook，请先在「钉钉推送」设置中填写并保存' });
    }
    const b = req.body || {};
    // 公网地址：优先用设置里的固定域名，否则按本次请求的 Host / 协议推断
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const base = dingPublicBase() || (proto + '://' + req.headers.host);
    const title = String(b.title || '效率透视表').slice(0, 60);
    const structured = Array.isArray(b.blocks) && b.blocks.length > 0;
    const out = structured ? dingBuildBlocksText(b.blocks, b.period, base)
      : dingBuildSingleText(b.image, title, base);
    const r = await dingPostMarkdown(webhook, title, out.text);
    if (!r.ok) {
      logWarn('[钉钉] 推送失败：' + r.error);
      return res.status(502).json({ error: '钉钉推送失败：' + r.error });
    }
    const n = structured ? (b.blocks.length + ' 块') : '1 张图';
    logInfo('[钉钉] 已推送「' + title + '」（' + n + '，共 ' + (out.bytes / 1024).toFixed(0) + 'KB）到群');
    res.json({ ok: true, urls: out.urls, bytes: out.bytes });
  } catch (e) {
    logWarn('[钉钉] 推送异常：' + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* ---------- 定时推送：服务端无头浏览器截图后自动发到群 ----------
   看板图只能在浏览器里出，故定时任务用 puppeteer 打开看板（默认本机地址）、
   在页面内调 HEMA.dingPayload() 取回三块图与统计，再走与手动推送相同的 markdown 链路。 */

let dingAutoRunning = false;
let dingAutoLastAt = 0;   // 本轮已触发的执行时间戳（内存；重启后从状态记录里恢复）

// 上次执行时间（毫秒）：内存里的在途触发优先，其次取状态记录（手动触发也会写状态）
function dingLastRunMs() {
  const s = dingAutoState();
  const m = s.at ? (Date.parse(s.at) || 0) : 0;
  return Math.max(dingAutoLastAt, m);
}

// 每 30 秒检查一次：在时段内、距上次执行已满一个间隔，且期间有新数据（新增/覆盖）才推一次
function dingAutoTick() {
  const cfg = dingAutoCfg();
  if (!cfg.enabled) return;
  if (!dingInWindow(cfg)) return;
  if (Date.now() - dingLastRunMs() < cfg.intervalMin * 60 * 1000) return;
  // 只在有新数据时推：自上次成功推送后没有新增/覆盖就跳过（不推进 lastRun，等有数据再推）
  if (!dingHasNewData()) return;
  dingAutoLastAt = Date.now();
  dingRunAuto('定时（每 ' + cfg.intervalMin + ' 分钟）');
}
setInterval(dingAutoTick, 30 * 1000);

// 执行一次「无头截图 + 推送」；reason 仅用于日志与状态展示
async function dingRunAuto(reason) {
  if (dingAutoRunning) { logWarn('[钉钉] 定时推送：上一次仍在进行，跳过本次（' + reason + '）'); return; }
  const webhook = dingWebhook();
  if (!webhook) { logWarn('[钉钉] 定时推送：未配置 Webhook，跳过（' + reason + '）'); return; }
  dingAutoRunning = true;
  const t0 = Date.now();
  try {
    const pageUrl = dingPageUrl();
    logInfo('[钉钉] 定时推送开始（' + reason + '）：无头浏览器打开看板 ' + pageUrl + ' 截图…');
    const payload = await dingCapture.capturePivot(pageUrl, {
      log: function (m) { logInfo('[钉钉] ' + m); }
    });
    const base = dingPushBase();
    if (!base) throw new Error('未配置公网地址，钉钉无法访问图片链接');
    const out = dingBuildBlocksText(payload.blocks || [], payload.period, base);
    const r = await dingPostMarkdown(webhook, '效率透视表', out.text);
    if (!r.ok) throw new Error(r.error);
    const n = (payload.blocks || []).length;
    logInfo('[钉钉] 定时推送完成（' + reason + '）：' + n + ' 块，共 ' + (out.bytes / 1024).toFixed(0) +
      'KB，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    db.setSetting(CFG.DING_AUTO_STATE_KEY, {
      at: new Date().toISOString(), ok: true, error: '', reason: reason, count: n
    });
    // 记录本次推送对应的数据版本：此后没有新增/覆盖就不再推送
    db.setSetting(CFG.DING_PUSHED_AT_KEY, String(db.getSetting(CFG.DING_DATA_AT_KEY) || ''));
  } catch (e) {
    logWarn('[钉钉] 定时推送失败（' + reason + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）：' + (e.message || e));
    db.setSetting(CFG.DING_AUTO_STATE_KEY, {
      at: new Date().toISOString(), ok: false, error: String(e.message || e), reason: reason, count: 0
    });
  } finally {
    dingAutoRunning = false;
  }
}

// 立即执行一次定时推送（测试用）：后台跑，结果看 /api/ding/config 的 auto.state
router.post('/api/ding/auto/run', (req, res) => {
  if (dingAutoRunning) return res.status(409).json({ error: '已有定时推送在执行中，请稍候' });
  if (!dingWebhook()) return res.status(400).json({ error: '未配置钉钉机器人 Webhook' });
  if (!dingCapture.available()) return res.status(400).json({ error: dingCapture.unavailableReason() });
  dingRunAuto('手动触发');
  res.status(202).json({ started: true });
});

// 已推送图片的公开只读访问（供钉钉客户端拉取）；文件名限定为「16 位十六进制 + 扩展名」
router.get('/api/ding/img/:file', (req, res) => {
  const file = path.basename(String(req.params.file || ''));
  if (!/^[0-9a-f]{16}\.(png|jpg)$/.test(file)) return res.status(404).json({ error: 'not found' });
  const fp = path.join(DING_DIR, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(file.slice(-3) === 'png' ? 'image/png' : 'image/jpeg');
  fs.createReadStream(fp).pipe(res);
});

/* 旧指纹回退：资源内容变化后文件名会变，仍停留在旧页面的标签页可能请求上一版文件名。
   这里按「逻辑名」改写成当前指纹名，避免 404 白屏；新页面永远引用最新文件名。 */
router.use(function (req, res, next) {
  if (STATIC.fingerprint) {
    const m = /^(.*)\.([0-9a-f]{8})(\.[^./]+)$/.exec(req.path);
    if (m) {
      const cur = FP_MAP[m[1] + m[3]];
      if (cur && cur !== req.path) {
        const cut = req.url.indexOf('?');
        req.url = cur + (cut >= 0 ? req.url.slice(cut) : '');
      }
    }
  }
  next();
});

// 前端静态资源（未配置前端目录时跳过，只提供 API）
if (STATIC.dir) {
  router.use(express.static(STATIC.dir, {
    index: 'index.html',
    etag: true,
    lastModified: true,
    setHeaders: staticHeaders
  }));
}

// 路径已在归一化中间件里处理，此处只需挂到根
app.use(router);

// 未匹配路径：给出自解释提示（常见于反向代理子路径与 BASE_PATH 不一致）
app.use(function (req, res) {
  res.status(404).json({
    error: '路径未匹配：' + req.method + ' ' + req.originalUrl,
    hint: BASE_PATH
      ? '当前 BASE_PATH=' + BASE_PATH + '；请确认 nginx 转发时是否已剥掉该前缀（proxy_pass 末尾带 / 会剥掉）'
      : '当前未设置 BASE_PATH。若通过子路径访问（如 /hpe/api/...），请用 「BASE_PATH=前缀」 启动本服务；'
        + '或在 nginx 把 proxy_pass 改成 http://127.0.0.1:端口/（末尾加斜杠）',
    availableApi: ['/api/health', '/api/logs', '/api/datasets', '/api/latest', '/api/datasets/:id', '/api/range', '/api/day', '/api/upload',
      '/api/ums/fetch', '/api/ums/result', '/api/ums/config', '/api/ums/cookie', '/api/ums/agent/data', '/api/ums/known', '/api/settings',
      '/api/ding/config', '/api/ding/push', '/api/ding/img/:file', '/api/ding/auto/run']
      .map(function (p) { return (BASE_PATH || '') + p; })
  });
});

// 直接运行时才启动监听（被 require 时只导出 app，便于测试）
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    logInfo('服务已启动： http://localhost:' + PORT +
      (BASE_PATH ? '  （子路径 ' + BASE_PATH + '）' : '') + '  静态目录 ' + (STATIC.dir || '（未托管，仅 API）'));
    logInfo('静态资源：' + STATIC.desc);
    logInfo('可通过本地 IP 或域名访问');
    logInfo('[钉钉] 图片输出目录 ' + DING_DIR + '（可写：' + (function () {
      try { fs.accessSync(DING_DIR, fs.constants.W_OK); return '是'; } catch (e) { return '否 - ' + (e.message || e); }
    })() + '），URL 前缀 ' + DING_URL_PREFIX + '，公网地址 ' + (dingPublicBase() || '（未配置，按请求 Host 推断）'));
    logInfo('历史数据集数量：' + db.count());
    const auto = umsAutoCfg();
    logInfo('自动获取：' + (auto.enabled ? '已开启（每 ' + auto.intervalMin + ' 分钟，时段 ' +
      (auto.timeStart || '不限') + ' ~ ' + (auto.timeEnd || '不限') + '）' : '未开启') +
      '，接口 Cookie：' + (umsCookie() ? '已保存' : '未保存') +
      '，备用 Cookie：' + (umsCookieBackup() ? '已保存' : '未保存'));
  });
}

module.exports = app;
