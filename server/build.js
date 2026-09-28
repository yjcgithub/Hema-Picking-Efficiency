/* 静态资源指纹构建：web/ → dist/
 *
 * 为什么需要它
 *   浏览器对 CSS / JS / 图片的缓存以「URL」为键：URL 不变，缓存就不会失效。
 *   只靠 ETag 协商缓存时，一旦中间层（CDN、nginx proxy_cache）或浏览器内存缓存
 *   直接命中旧副本，用户就会一直看到旧页面，直到手动清缓存。
 *   把「内容哈希」写进文件名后：
 *     - 内容变了 → 文件名变 → URL 变 → 必然重新下载
 *     - 内容没变 → 文件名不变 → 命中一年期强缓存，零网络请求
 *
 * 产物（整目录重建，与 web/ 严格一致）
 *   dist/<原相对路径的扩展名前插入 hash8>   指纹资源，如 assets/js/app.1a2b3c4d.js
 *   dist/index.html                          入口文件（内部引用已改写为指纹路径，文件名不变）
 *   dist/manifest.json                       原始路径 → 指纹路径（服务端旧指纹回退用）
 *
 * 用法
 *   node build.js                    手动构建
 *   npm run build
 *   require('./build').build()       服务端启动时自动构建（HEMA_STATIC=auto，默认）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'web');
const OUT_DIR = path.join(ROOT, 'dist');
const HASH_LEN = 8;

const HTML_EXT = ['.html', '.htm'];
// HTML 中会被改写的引用属性（不含 async/defer 等无值属性）
const ATTR_RE = /\b(href|src|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// CSS 中的 url(...)
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;

function walk(dir, base, out) {
  base = base || dir;
  out = out || [];
  fs.readdirSync(dir).forEach(function (name) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  });
  return out;
}

function isHtml(rel) { return HTML_EXT.indexOf(path.posix.extname(rel).toLowerCase()) >= 0; }
function isCss(rel) { return path.posix.extname(rel).toLowerCase() === '.css'; }

function hash8(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, HASH_LEN);
}

/* app.js → app.<hash8>.js；哈希插在最后一个扩展名前，app.min.js 也能正确处理 */
function fingerprinted(rel, hash) {
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const stem = path.posix.basename(rel, ext);
  const name = stem + '.' + hash + ext;
  return dir === '.' ? name : dir + '/' + name;
}

/* 把「引用值」解析成相对 web/ 的规范路径；外部链接 / 锚点 / 查串返回 null */
function resolveRef(ref, fromRel) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return null;
  // http: https: data: mailto: 等协议链接，以及协议相对地址 //cdn/...
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.indexOf('//') === 0) return null;
  if (s.charAt(0) === '#' || s.charAt(0) === '?') return null;
  const cut = s.search(/[?#]/);
  const clean = cut >= 0 ? s.slice(0, cut) : s;
  if (!clean) return null;
  const fromDir = path.posix.dirname(fromRel);
  const abs = clean.charAt(0) === '/'
    ? path.posix.normalize(clean).slice(1)
    : path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, clean));
  if (!abs || abs.indexOf('..') === 0) return null;   // 越出 web/ 目录，交给原样
  return abs;
}

/* 引用值 → 指纹引用值；无需改写时返回 null（调用方保持原样） */
function hashRef(ref, fromRel, map) {
  const logical = resolveRef(ref, fromRel);
  if (!logical || !map[logical]) return null;
  const raw = String(ref).trim();
  const cut = raw.search(/[?#]/);
  const suffix = cut >= 0 ? raw.slice(cut) : '';
  const to = map[logical];
  if (raw.charAt(0) === '/') return '/' + to + suffix;      // 保持绝对路径写法
  const fromDir = path.posix.dirname(fromRel);
  const rel = fromDir === '.' ? to : path.posix.relative(fromDir, to);
  return rel + suffix;
}

function rewriteHtml(html, fromRel, map) {
  return html.replace(ATTR_RE, function (whole, attr, dq, sq) {
    const ref = dq != null ? dq : sq;
    const next = hashRef(ref, fromRel, map);
    if (next == null) return whole;
    const quote = dq != null ? '"' : "'";
    return attr + '=' + quote + next + quote;
  });
}

function rewriteCss(css, fromRel, map) {
  return css.replace(CSS_URL_RE, function (whole, dq, sq, raw) {
    const ref = dq != null ? dq : (sq != null ? sq : raw);
    const next = hashRef(ref, fromRel, map);
    if (next == null) return whole;
    const quote = dq != null ? '"' : (sq != null ? "'" : '');
    return 'url(' + quote + next + quote + ')';
  });
}

/* 构建：返回 { srcDir, outDir, entry, map, files } */
function build(options) {
  const opts = options || {};
  const srcDir = path.resolve(opts.srcDir || SRC_DIR);
  const outDir = path.resolve(opts.outDir || OUT_DIR);
  if (!fs.existsSync(srcDir)) throw new Error('源目录不存在：' + srcDir);

  const rels = walk(srcDir);
  const map = {};       // 原始相对路径 → 指纹后相对路径
  const outputs = {};   // 指纹后相对路径 → 待写内容

  // 第一轮：叶子资源（图片 / 字体 / JS / 其它非 HTML 非 CSS）直接按内容算哈希
  rels.filter(function (r) { return !isHtml(r) && !isCss(r); }).forEach(function (r) {
    const buf = fs.readFileSync(path.join(srcDir, r));
    const to = fingerprinted(r, hash8(buf));
    map[r] = to;
    outputs[to] = buf;
  });

  // 第二轮：CSS —— 先把内部 url() 指向指纹资源，再对改写后的内容算哈希
  rels.filter(isCss).forEach(function (r) {
    const buf = Buffer.from(rewriteCss(fs.readFileSync(path.join(srcDir, r), 'utf8'), r, map), 'utf8');
    const to = fingerprinted(r, hash8(buf));
    map[r] = to;
    outputs[to] = buf;
  });

  // 第三轮：HTML 入口 —— 改写引用后原样输出（文件名不变，靠 HTTP 头禁止缓存）
  const htmls = rels.filter(isHtml);
  htmls.forEach(function (r) {
    outputs[r] = Buffer.from(rewriteHtml(fs.readFileSync(path.join(srcDir, r), 'utf8'), r, map), 'utf8');
  });

  fs.rmSync(outDir, { recursive: true, force: true });
  Object.keys(outputs).forEach(function (r) {
    const abs = path.join(outDir, r);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, outputs[r]);
  });

  const entry = htmls.indexOf('index.html') >= 0 ? 'index.html' : (htmls[0] || '');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    hashLength: HASH_LEN,
    entry: entry,
    files: map
  }, null, 2) + '\n');

  return { srcDir: srcDir, outDir: outDir, entry: entry, map: map, files: Object.keys(outputs).length };
}

module.exports = { build: build, fingerprinted: fingerprinted, hash8: hash8, SRC_DIR: SRC_DIR, OUT_DIR: OUT_DIR };

if (require.main === module) {
  try {
    const r = build();
    console.log('静态资源指纹构建完成 → ' + r.outDir);
    console.log('入口：' + r.entry + '，产物 ' + r.files + ' 个文件：');
    Object.keys(r.map).forEach(function (k) { console.log('  ' + k + '  ->  ' + r.map[k]); });
  } catch (e) {
    console.error('构建失败：' + (e.message || e));
    process.exit(1);
  }
}
