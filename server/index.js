/* 拣货效率计算统计工具 - Node.js 后端
   - 托管前端静态文件（../web）
   - CORS：前端与后端不同源时必需
   - BASE_PATH：反向代理子路径（如 nginx 把 https://api.yjmc.xyz/hpe/ 转到本服务）
   - POST /api/upload 上传 xlsx -> 解析并计算 -> 按时间维度覆盖/新增入库 -> 返回数据集
   - GET  /api/latest /api/datasets /api/datasets/:id（均支持 ?date=YYYY-MM-DD 只取某天）
   - GET  /api/settings 读取「拣货分区 -> 前后场分区」映射、忽略分区与数据集里出现过的分区
   - POST /api/settings 保存映射与忽略分区，并用新设置重算历史数据集
   - DELETE /api/datasets/:id
*/
const path = require('path');
const express = require('express');

const CFG = require('./config');
const compute = require('./compute');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const WEB_DIR = path.join(__dirname, '..', 'web');
// 例：BASE_PATH=/hpe 时，https://域名/hpe/api/latest 与 /api/latest 均可用
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

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
  res.json({ ok: true, datasets: db.count(), basePath: BASE_PATH || '/' });
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
router.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  try {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: '未收到文件内容' });
    const name = String(req.query.name || req.get('x-filename') || 'upload.xlsx');
    const built = compute.buildFromBuffer(buf, name, currentMap(), currentIgnore());

    const hit = db.findByDates(built.dataset.meta.dates);
    const id = hit
      ? db.overwrite(hit.id, built.dataset, built.recs)
      : db.insert(built.dataset, built.recs);
    res.json(Object.assign({ id, mode: hit ? 'overwrite' : 'create' }, built.dataset));
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

router.delete('/api/datasets/:id', (req, res) => {
  res.json({ removed: db.remove(req.params.id) });
});

// 前端静态文件
router.use(express.static(WEB_DIR));

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
    availableApi: ['/api/health', '/api/datasets', '/api/latest', '/api/datasets/:id', '/api/upload', '/api/settings']
      .map(function (p) { return (BASE_PATH || '') + p; })
  });
});

// 直接运行时才启动监听（被 require 时只导出 app，便于测试）
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('服务已启动： http://localhost:' + PORT +
      (BASE_PATH ? '  （子路径 ' + BASE_PATH + '）' : '') + '  静态目录 ' + WEB_DIR);
    console.log('可通过本地 IP 或域名访问');
    console.log('历史数据集数量：' + db.count());
  });
}

module.exports = app;
