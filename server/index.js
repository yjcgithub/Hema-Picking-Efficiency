/* 门店拣货效率监控看板 - Node.js 后端
   - 托管前端静态文件（../web）
   - CORS：前端与后端不同源时必需
   - BASE_PATH：反向代理子路径（如 nginx 把 https://api.yjmc.xyz/hpe/ 转到本服务）
   - POST /api/upload 上传 xlsx -> 解析并计算 -> 存入 SQLite -> 返回数据集
   - GET  /api/latest /api/datasets /api/datasets/:id
   - DELETE /api/datasets/:id
*/
const fs = require('fs');
const path = require('path');
const express = require('express');

const compute = require('./compute');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const WEB_DIR = path.join(__dirname, '..', 'web');
const SEED_FILE = path.join(__dirname, '..', 'export-1785428943043.xlsx');
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

router.get('/api/health', (req, res) => {
  res.json({ ok: true, datasets: db.count(), basePath: BASE_PATH || '/' });
});

router.get('/api/datasets', (req, res) => {
  res.json(db.list());
});

router.get('/api/latest', (req, res) => {
  const ds = db.latest();
  if (!ds) return res.status(404).json({ error: '暂无数据，请先上传拣货单' });
  res.json(ds);
});

router.get('/api/datasets/:id', (req, res) => {
  const ds = db.get(req.params.id);
  if (!ds) return res.status(404).json({ error: '数据集不存在' });
  res.json(ds);
});

// 上传：raw body 传 xlsx 字节，文件名通过 ?name= 或 x-filename 头传入
router.post('/api/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
  try {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: '未收到文件内容' });
    const name = String(req.query.name || req.get('x-filename') || 'upload.xlsx');
    const ds = compute.buildFromBuffer(buf, name);
    const id = db.insert(ds);
    res.json(Object.assign({ id }, ds));
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
    availableApi: ['/api/health', '/api/datasets', '/api/latest', '/api/datasets/:id', '/api/upload']
      .map(function (p) { return (BASE_PATH || '') + p; })
  });
});

// 首次启动：若库为空且有示例导出文件，则初始化一条
if (db.count() === 0 && fs.existsSync(SEED_FILE)) {
  try {
    const ds = compute.buildFromBuffer(fs.readFileSync(SEED_FILE), path.basename(SEED_FILE));
    db.insert(ds);
    console.log('已用示例文件初始化数据集：' + path.basename(SEED_FILE) +
      '（有效明细 ' + ds.meta.recordCount + ' 条，综合效率 ' + ds.totals.eff + ' 行/h）');
  } catch (e) {
    console.warn('示例数据初始化失败：' + e.message);
  }
}

app.listen(PORT, () => {
  console.log('服务已启动： http://localhost:' + PORT +
    (BASE_PATH ? '  （子路径 ' + BASE_PATH + '）' : '') + '  静态目录 ' + WEB_DIR);
  console.log('历史数据集数量：' + db.count());
});
