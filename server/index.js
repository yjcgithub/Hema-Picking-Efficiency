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
const express = require('express');

const CFG = require('./config');
const compute = require('./compute');
const db = require('./db');
const build = require('./build');

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

/* 出数范围：隔天不显示前天，默认只取数据集内最新日期，其他日期由前端日期下拉手动选择。
   - 响应 meta.dates 仍是完整日期集合（下拉用），meta.date 为本次实际展示的日期
   - 有原始明细的一律按最新口径重算：库里的 payload 是上传时算好的旧版，
     直接返回会缺后加的字段（统计时间段 / 超时统计 / 分区人均等）
   - 缺原始明细的老数据集、或重算失败：退回原 payload，只补 meta.date */
function withDate(ds, date) {
  if (!ds) return ds;
  const dates = (ds.meta && ds.meta.dates) || [];
  const pick = dates.indexOf(date) >= 0 ? date : (dates[dates.length - 1] || '');
  if (!pick) return ds;
  const recs = ds.id == null ? null : db.recsOf(ds.id);
  if (!recs || !recs.length) {
    ds.meta.date = pick;
    return ds;
  }
  try {
    const out = compute.rebuild(recs,
      { sourceFile: ds.meta.sourceFile, dropped: ds.meta.dropped, otherStore: ds.meta.otherStore, dates },
      currentMap(), currentIgnore(), pick);
    out.id = ds.id;
    out.meta.date = pick;
    return out;
  } catch (e) {
    ds.meta.date = pick;
    return ds;
  }
}

router.get('/api/health', (req, res) => {
  res.json({
    ok: true, datasets: db.count(), basePath: BASE_PATH || '/',
    staticMode: STATIC_MODE, staticDesc: STATIC.desc,
    // 已实现的接口能力：油猴脚本启动时自检，用于识别「后端是旧版本」
    features: ['ums.fetch', 'ums.config', 'ums.cookie', 'ums.agentData', 'ums.known']
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
  const ds = db.latest();
  if (!ds) return res.status(404).json({ error: '暂无数据，请先上传拣货单' });
  res.json(withDate(ds, req.query.date));
});

router.get('/api/datasets/:id', (req, res) => {
  const ds = db.get(req.params.id);
  if (!ds) return res.status(404).json({ error: '数据集不存在' });
  try {
    res.json(withDate(ds, req.query.date));
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
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

// 最近一次自动获取结果（供页面展示）；failures/nextMin 为连续失败次数与退避后的下次间隔，
// nextAt 为排期好的下次执行时间（页面据此在临近触发前显示倒计时），
// cfgInterval 为排期时使用的「设置里的间隔」，用来判断用户改过间隔后是否需要重新排期
function umsAutoState() {
  const s = db.getSetting(CFG.UMS_AUTO_STATE_KEY) || {};
  return {
    at: s.at || null, ok: s.ok == null ? null : !!s.ok,
    error: s.error || '', records: s.records || 0, added: s.added || 0,
    failures: s.failures || 0, nextMin: s.nextMin || 0,
    nextAt: s.nextAt || null, cfgInterval: s.cfgInterval || 0
  };
}

// 当天日期：接口数据与门店都按东八区计时
function umsToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 取数条件：页面「开始日期 / 结束日期」保存到服务端，手动与自动获取共用同一区间；
// 未设置或非法时回退「当天」
function umsRangeCfg() {
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  const r = db.getSetting(CFG.UMS_RANGE_KEY) || {};
  const start = ok.test(r.startDate) ? r.startDate : '';
  let end = ok.test(r.endDate) ? r.endDate : '';
  if (!start) return { startDate: umsToday(), endDate: umsToday() };
  if (!end || end < start) end = start;
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
    build: BUILD_ID,
    num: umsNum(),
    numChoices: CFG.UMS_NUM_CHOICES,
    range: umsRangeCfg(),
    auto: Object.assign(umsAutoCfg(), umsAutoState()),
    agent: db.getSetting(CFG.UMS_AGENT_STATE_KEY) || null,
    lastFetch: db.getSetting(CFG.UMS_LAST_KEY) || null,
    progress: umsProgressInfo(),
    cooldown: umsCooldownInfo()
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
        throw new Error(UMS_COOKIE_HINT + '（接口返回 HTTP ' + resp.status + '）');
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
        throw new Error('接口被限流：UMS 返回「亲~人太多，被挤爆了！」（请求过于频繁），本次未取到数据，稍后会自动重试');
      }
      if (/登录|login|passport|sso/i.test(text)) {
        // 登录页整页都是 HTML/CSS 噪声，不回片段，只给「手动同步一次」的指引
        throw new Error(UMS_COOKIE_HINT);
      }
      throw new Error('接口未返回 JSON，可能是 Cookie 失效：' + UMS_COOKIE_HINT + (snippet ? '（' + snippet + '）' : ''));
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
async function umsRunFetch(startDate, endDate, incremental, cookie) {
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
  return Object.assign(out, { pages: r.pages, totalPages: r.totalPages, reached: r.reached, last: last });
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

// 手动获取：需要 Cookie（页面里保存或环境变量 HEMA_UMS_COOKIE）
router.post('/api/ums/fetch', express.json({ limit: '1mb' }), async (req, res) => {
  const body = req.body || {};
  const startDate = String(body.startDate || '').trim();
  const endDate = String(body.endDate || startDate).trim();
  const incremental = !!body.incremental;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  }
  const cookie = String(body.cookie || '').trim() || umsCookie();
  if (!cookie) {
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
  const t0 = Date.now();
  logInfo('[取数] 手动获取 ' + range + (incremental ? '（增量）' : '（全量）') + ' 开始');
  umsBusy = true;
  try {
    const out = await umsRunFetch(startDate, endDate, incremental, cookie);
    logInfo('[取数] 手动获取完成：' + out.pages + '/' + out.totalPages + ' 页，明细 ' + out.meta.recordCount +
      ' 条，新增 ' + (out.added || 0) + ' 条、覆盖 ' + (out.replaced || 0) + ' 条，数据集 #' + out.id +
      '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    res.json(out);
  } catch (e) {
    logWarn('[取数] 手动获取 ' + range + ' 失败（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's）：' + (e.message || e));
    res.status(400).json({ error: e.message || String(e) });
  } finally {
    umsBusy = false;
  }
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
  const cookie = umsCookie();
  if (!cookie) return;
  // 不在执行时段内：跳过（不更新 at，到点后自然会触发）
  if (!umsInTimeWindow(auto)) return;
  const st = umsAutoState();
  const fails = st.failures || 0;
  if (Date.now() < umsAutoNextAt(auto, st)) return;   // 未到排期时间
  // 与手动获取共用冷却窗口：距上次取数（含手动 / 脚本）不足冷却时长时跳过本轮
  if (umsCooldownInfo().waitSec > 0) return;

  const range = umsRangeCfg();
  const day = range.startDate + (range.endDate === range.startDate ? '' : ' ~ ' + range.endDate);
  const t0 = Date.now();
  umsBusy = true;
  try {
    const out = await umsRunFetch(range.startDate, range.endDate, true, cookie);
    const at = new Date();
    const nextAt = new Date(at.getTime() + auto.intervalMin * 60000 * umsJitter());
    db.setSetting(CFG.UMS_AUTO_STATE_KEY, {
      at: at.toISOString(), ok: true, error: '',
      records: out.meta.recordCount, added: out.added || 0,
      failures: 0, nextMin: auto.intervalMin, cfgInterval: auto.intervalMin,
      nextAt: nextAt.toISOString()
    });
    logInfo('[自动获取] ' + day + ' 完成：明细 ' + out.meta.recordCount + ' 条，新增 ' + (out.added || 0) +
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
      nextAt: nextAt.toISOString()
    });
    logWarn('[自动获取] ' + day + ' 失败（连续 ' + nf + ' 次，' + nextMin + ' 分钟后重试，' +
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
  res.json({ cookie: umsCookie() });
});

// 保存设置：Cookie（传空字符串清除）/ 每页条数 / 自动获取开关与间隔
router.post('/api/ums/config', express.json({ limit: '32kb' }), (req, res) => {
  const body = req.body || {};
  if (typeof body.cookie === 'string') {
    const v = body.cookie.trim();
    db.setSetting(CFG.UMS_COOKIE_KEY, v);
    // 只记长度，不把 Cookie 原文写进日志
    logInfo('[设置] 接口 Cookie ' + (v ? '已保存（' + v.length + ' 字符）' : '已清除'));
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
      db.setSetting(CFG.UMS_RANGE_KEY, { startDate: s, endDate: e });
      logInfo('[设置] 取数条件 → ' + s + (e === s ? '' : ' ~ ' + e));
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
    availableApi: ['/api/health', '/api/logs', '/api/datasets', '/api/latest', '/api/datasets/:id', '/api/upload',
      '/api/ums/fetch', '/api/ums/config', '/api/ums/cookie', '/api/ums/agent/data', '/api/ums/known', '/api/settings']
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
    logInfo('历史数据集数量：' + db.count());
    const auto = umsAutoCfg();
    logInfo('自动获取：' + (auto.enabled ? '已开启（每 ' + auto.intervalMin + ' 分钟，时段 ' +
      (auto.timeStart || '不限') + ' ~ ' + (auto.timeEnd || '不限') + '）' : '未开启') +
      '，接口 Cookie：' + (umsCookie() ? '已保存' : '未保存'));
  });
}

module.exports = app;
