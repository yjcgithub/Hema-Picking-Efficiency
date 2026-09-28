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
    console.warn('[静态资源] 未找到前端目录（需含 index.html），已尝试：\n  ' + found.tried.join('\n  '));
    console.warn('[静态资源] 本次仅提供 API。若需本服务托管前端，请设置 STATIC_DIR=<前端目录>；'
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
      console.warn('[静态资源] 指纹构建失败，回落源目录：' + (e.message || e));
      return { dir: webDir, fingerprint: false, map: {}, desc: '构建失败，回落源目录 ' + webDir + '（未指纹化）' };
    }
  }
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.warn('[静态资源] HEMA_STATIC=dist 但 ' + DIST_DIR + ' 不完整，请先 npm run build；本次回落源目录');
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
    res.json({ ok: true, map, ignore, updated: r.updated, skipped: r.skipped, failed: r.failed });
  } catch (e) {
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
        return Object.assign({ id: target.id, mode: 'merge', added: 0, replaced: 0 }, m.dataset);
      }
      db.overwrite(target.id, m.dataset, m.recs);
      return Object.assign({ id: target.id, mode: 'merge', added: m.added, replaced: m.replaced }, m.dataset);
    }
  }
  // 未命中同维度：新建数据集（或整体替换同维度的数据集）
  const before = hit ? (db.recsOf(hit.id) || []).length : 0;
  const id = hit
    ? db.overwrite(hit.id, built.dataset, built.recs)
    : db.insert(built.dataset, built.recs);
  return Object.assign({
    id: id, mode: hit ? 'overwrite' : 'create',
    added: built.recs.length, replaced: before
  }, built.dataset);
}

router.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  try {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: '未收到文件内容' });
    const name = String(req.query.name || req.get('x-filename') || 'upload.xlsx');
    const built = compute.buildFromBuffer(buf, name, currentMap(), currentIgnore());
    res.json(saveBuilt(built));
  } catch (e) {
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

// 自动获取设置：开关 + 间隔分钟
function umsAutoCfg() {
  const a = db.getSetting(CFG.UMS_AUTO_KEY) || {};
  return { enabled: !!a.enabled, intervalMin: umsClampInterval(a.intervalMin) };
}

// 最近一次自动获取结果（供页面展示）
function umsAutoState() {
  const s = db.getSetting(CFG.UMS_AUTO_STATE_KEY) || {};
  return {
    at: s.at || null, ok: s.ok == null ? null : !!s.ok,
    error: s.error || '', records: s.records || 0, added: s.added || 0
  };
}

// 当天日期：接口数据与门店都按东八区计时
function umsToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 页面用配置（Cookie 只回布尔，不回原文）
function umsConfigPayload() {
  return {
    cookieSet: !!umsCookie(),
    build: BUILD_ID,
    num: umsNum(),
    numChoices: CFG.UMS_NUM_CHOICES,
    auto: Object.assign(umsAutoCfg(), umsAutoState()),
    agent: db.getSetting(CFG.UMS_AGENT_STATE_KEY) || null,
    lastFetch: db.getSetting(CFG.UMS_LAST_KEY) || null
  };
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
    if (!resp.ok) throw new Error('接口返回 HTTP ' + resp.status);
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
        throw new Error('登录已失效：接口返回的是登录页而非数据，请在「实时获取」弹窗里更新 Cookie' + (snippet ? '（' + snippet + '）' : ''));
      }
      throw new Error('接口未返回 JSON（多为登录已失效，请更新 Cookie）' + (snippet ? '：' + snippet : ''));
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
  const r = await umsFetchAll(startDate, endDate, cookie, { size: umsNum(), incremental: incremental });
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
  if (umsBusy) return res.status(409).json({ error: '已有获取任务正在进行，请稍后再试' });
  umsBusy = true;
  const range = startDate + ' ~ ' + endDate;
  try {
    const complete = !!body.complete;
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
  } catch (e) {
    db.setSetting(CFG.UMS_AGENT_STATE_KEY, {
      at: new Date().toISOString(), ok: false, error: String(e.message || e).slice(0, 200),
      range: range, added: 0, replaced: 0, records: 0
    });
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
    return res.status(400).json({ error: '未配置接口 Cookie，无法获取（请在弹窗中粘贴一次 Cookie 后重试）' });
  }
  if (umsBusy) return res.status(409).json({ error: '已有获取任务正在进行，请稍后再试' });
  umsBusy = true;
  try {
    res.json(await umsRunFetch(startDate, endDate, incremental, cookie));
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  } finally {
    umsBusy = false;
  }
});

/* ---------- 自动获取：服务端按固定间隔轮询，每次取「当天」数据增量并入 ----------
   与手动获取共用 umsRunFetch；上一轮未跑完（umsBusy）时跳过本轮；
   未配置 Cookie 时直接跳过（页面里会提示）；每次尝试都记 umsAutoState.at，
   失败的间隔内不重试，避免刷接口 */

async function umsAutoTick() {
  if (umsBusy) return;
  const auto = umsAutoCfg();
  if (!auto.enabled) return;
  const cookie = umsCookie();
  if (!cookie) return;
  const st = umsAutoState();
  const last = st.at ? Date.parse(st.at) : 0;
  if (last && Date.now() - last < auto.intervalMin * 60000) return;

  const day = umsToday();
  umsBusy = true;
  try {
    const out = await umsRunFetch(day, day, true, cookie);
    db.setSetting(CFG.UMS_AUTO_STATE_KEY, {
      at: new Date().toISOString(), ok: true, error: '',
      records: out.meta.recordCount, added: out.added || 0
    });
    console.log('[自动获取] ' + day + '：明细 ' + out.meta.recordCount + ' 条，本次新增 ' + (out.added || 0) + ' 条');
  } catch (e) {
    db.setSetting(CFG.UMS_AUTO_STATE_KEY, {
      at: new Date().toISOString(), ok: false,
      error: String(e.message || e).slice(0, 160), records: 0, added: 0
    });
    console.warn('[自动获取] ' + day + ' 失败：' + (e.message || e));
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
  if (typeof body.cookie === 'string') db.setSetting(CFG.UMS_COOKIE_KEY, body.cookie.trim());
  if (body.num != null && CFG.UMS_NUM_CHOICES.indexOf(Number(body.num)) >= 0) {
    db.setSetting(CFG.UMS_NUM_KEY, Number(body.num));
  }
  if (body.auto && typeof body.auto === 'object') {
    db.setSetting(CFG.UMS_AUTO_KEY, {
      enabled: !!body.auto.enabled,
      intervalMin: umsClampInterval(body.auto.intervalMin)
    });
  }
  res.json(umsConfigPayload());
});

router.delete('/api/datasets/:id', (req, res) => {
  res.json({ removed: db.remove(req.params.id) });
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
    availableApi: ['/api/health', '/api/datasets', '/api/latest', '/api/datasets/:id', '/api/upload',
      '/api/ums/fetch', '/api/ums/config', '/api/ums/cookie', '/api/ums/agent/data', '/api/ums/known', '/api/settings']
      .map(function (p) { return (BASE_PATH || '') + p; })
  });
});

// 直接运行时才启动监听（被 require 时只导出 app，便于测试）
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('服务已启动： http://localhost:' + PORT +
      (BASE_PATH ? '  （子路径 ' + BASE_PATH + '）' : '') + '  静态目录 ' + (STATIC.dir || '（未托管，仅 API）'));
    console.log('静态资源：' + STATIC.desc);
    console.log('可通过本地 IP 或域名访问');
    console.log('历史数据集数量：' + db.count());
  });
}

module.exports = app;
