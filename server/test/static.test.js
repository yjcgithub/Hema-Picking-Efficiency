/* 静态资源缓存方案验证
 *
 * 覆盖两条链路：
 *  1) 构建层 build.js：内容哈希命名、引用改写、内容未变则哈希不变（缓存可复用）
 *  2) 服务层 index.js：分级 Cache-Control / 强 ETag、304 协商、旧指纹回退
 *
 * 运行：cd server && npm test
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const build = require('../build');

const SERVER_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(SERVER_DIR, '..', 'dist');

/* ---------- 构建层：用临时 fixture 目录，不触碰真实 web/ ---------- */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hema-static-'));
  const src = path.join(root, 'web');
  const out = path.join(root, 'dist');
  return { root: root, src: src, out: out };
}

function put(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function sample(f) {
  put(f.src, 'assets/img/logo.png', Buffer.from('PNG-BYTES'));
  put(f.src, 'assets/css/style.css', 'body{background:url("../img/logo.png")}\n.a{color:red}');
  put(f.src, 'assets/js/app.js', 'console.log(1);\n');
  put(f.src, 'index.html', [
    '<!DOCTYPE html>',
    '<html><head>',
    '<link rel="stylesheet" href="assets/css/style.css">',
    '<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>',
    '</head><body>',
    '<img src="assets/img/logo.png">',
    '<a href="#top">锚点</a>',
    '<a href="assets/js/app.js?v=1">带查串</a>',
    '<script src="assets/js/app.js"></script>',
    '</body></html>'
  ].join('\n'));
}

function readOut(f, rel) {
  return fs.readFileSync(path.join(f.out, rel), 'utf8');
}

test('构建：资源名插入内容哈希，入口与 manifest 就位', () => {
  const f = fixture();
  sample(f);
  const r = build.build({ srcDir: f.src, outDir: f.out });

  assert.match(r.map['assets/js/app.js'], /^assets\/js\/app\.[0-9a-f]{8}\.js$/);
  assert.match(r.map['assets/css/style.css'], /^assets\/css\/style\.[0-9a-f]{8}\.css$/);
  assert.match(r.map['assets/img/logo.png'], /^assets\/img\/logo\.[0-9a-f]{8}\.png$/);

  // 入口文件名保持 index.html（无缓存由 HTTP 头保证，不靠改名）
  assert.ok(fs.existsSync(path.join(f.out, 'index.html')));
  const manifest = JSON.parse(readOut(f, 'manifest.json'));
  assert.equal(manifest.entry, 'index.html');
  assert.deepEqual(manifest.files, r.map);
  // 指纹文件确实落盘，且内容与源一致
  assert.equal(readOut(f, r.map['assets/js/app.js']), 'console.log(1);\n');
});

test('构建：改写 HTML 引用与 CSS url()，外链 / 锚点不受影响', () => {
  const f = fixture();
  sample(f);
  const r = build.build({ srcDir: f.src, outDir: f.out });
  const html = readOut(f, 'index.html');

  assert.ok(html.indexOf('href="' + r.map['assets/css/style.css'] + '"') >= 0);
  assert.ok(html.indexOf('src="' + r.map['assets/img/logo.png'] + '"') >= 0);
  assert.ok(html.indexOf('src="' + r.map['assets/js/app.js'] + '"') >= 0);
  // 带查串的引用：保留 ?v=1
  assert.ok(html.indexOf('href="' + r.map['assets/js/app.js'] + '?v=1"') >= 0);
  // CDN 与页内锚点保持原样
  assert.ok(html.indexOf('https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js') >= 0);
  assert.ok(html.indexOf('href="#top"') >= 0);
  // CSS 内的图片引用被改写为同目录相对路径
  assert.match(readOut(f, r.map['assets/css/style.css']), /url\("\.\.\/img\/logo\.[0-9a-f]{8}\.png"\)/);
});

test('构建：内容未变则哈希不变（缓存可复用），内容一变哈希即变', () => {
  const f = fixture();
  sample(f);
  const first = build.build({ srcDir: f.src, outDir: f.out });

  // 原样重建一次：所有指纹应完全一致 → 浏览器继续命中强缓存，不产生请求
  const second = build.build({ srcDir: f.src, outDir: f.out });
  assert.deepEqual(second.map, first.map);

  // 只改 app.js：仅它换名，样式与图片的指纹不变
  put(f.src, 'assets/js/app.js', 'console.log(2);\n');
  const third = build.build({ srcDir: f.src, outDir: f.out });
  assert.notEqual(third.map['assets/js/app.js'], first.map['assets/js/app.js']);
  assert.equal(third.map['assets/css/style.css'], first.map['assets/css/style.css']);
  assert.equal(third.map['assets/img/logo.png'], first.map['assets/img/logo.png']);
  // 入口里的引用同步指向新哈希
  assert.ok(readOut(f, 'index.html').indexOf(third.map['assets/js/app.js']) >= 0);
});

/* ---------- 服务层：用真实 dist 起服务，验证真实 HTTP 响应头 ---------- */

const app = require('../index');
let srv, base;

before(() => new Promise((resolve) => {
  srv = app.listen(0, '127.0.0.1', () => {
    base = 'http://127.0.0.1:' + srv.address().port;
    resolve();
  });
}));

after(() => new Promise((resolve) => srv.close(resolve)));

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'manifest.json'), 'utf8')).files;
}

// 注意：Node 的 fetch（undici）会自动带上 cache-control: no-cache，
// 按 HTTP 语义服务端应当忽略条件请求直接回 200，故协商缓存用例改用原生 http。
function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, { headers: headers || {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
    });
    req.on('error', reject);
  });
}

test('服务：入口 HTML 无缓存，始终回源取最新版本', async () => {
  const res = await fetch(base + '/', { headers: { 'Cache-Control': 'max-age=600' } });
  assert.equal(res.status, 200);
  const cc = res.headers.get('cache-control');
  assert.ok(/no-store/.test(cc), 'HTML 必须 no-store，实际：' + cc);
  assert.ok(/no-cache/.test(cc));
  assert.equal(res.headers.get('pragma'), 'no-cache');

  const html = await res.text();
  // HTML 引用的是指纹路径，且不是源目录里的原始路径
  const files = manifest();
  Object.keys(files).forEach((logical) => {
    assert.ok(html.indexOf(files[logical]) >= 0, '入口未引用指纹资源：' + files[logical]);
    assert.ok(html.indexOf('"' + logical + '"') < 0, '入口仍引用未指纹路径：' + logical);
  });
});

test('服务：指纹资源长缓存 + 强 ETag，命中协商返回 304', async () => {
  const hashed = manifest()['assets/js/app.js'];
  const url = base + '/' + hashed;

  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = res.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{8}"$/, 'ETag 应为内容哈希，实际：' + etag);
  // ETag 必须与文件名中的哈希一致
  assert.equal(etag, '"' + /\.([0-9a-f]{8})\.js$/.exec(hashed)[1] + '"');

  const again = await rawGet(url, { 'If-None-Match': etag });
  assert.equal(again.status, 304, 'ETag 命中应返回 304');
  assert.equal(again.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(again.body, '');

  // 未修改的指纹资源在强缓存有效期内，浏览器根本不会发请求；
  // 真发请求时（如强制刷新）也因 ETag 命中而只收 304 空响应
  const mismatch = await rawGet(url, { 'If-None-Match': '"deadbeef"' });
  assert.equal(mismatch.status, 200, 'ETag 不匹配须回 200 全量内容');
  assert.ok(mismatch.body.length > 0);
});

test('服务：停止使用旧指纹的页面请求旧文件名，自动回退到当前版本', async () => {
  const hashed = manifest()['assets/js/app.js'];
  const stale = hashed.replace(/\.([0-9a-f]{8})\.js$/, '.00000000.js');
  assert.notEqual(stale, hashed);

  const res = await fetch(base + '/' + stale);
  assert.equal(res.status, 200, '旧指纹不应 404');
  const current = await fetch(base + '/' + hashed);
  assert.equal(await res.text(), await current.text());
});

test('服务：未指纹资源（manifest.json）用 no-cache 协商，不落强缓存', async () => {
  const res = await fetch(base + '/manifest.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('服务：HEMA_STATIC=web 时退回协商缓存（未指纹化兜底）', () => {
  const script = [
    'const app = require("./index");',
    'const s = app.listen(0, "127.0.0.1", async () => {',
    '  const b = "http://127.0.0.1:" + s.address().port;',
    '  const html = await fetch(b + "/");',
    '  const js = await fetch(b + "/assets/js/app.js");',
    '  console.log(JSON.stringify({',
    '    htmlCC: html.headers.get("cache-control"),',
    '    jsCC: js.headers.get("cache-control"),',
    '    jsStatus: js.status,',
    '    jsEtag: js.headers.get("etag")',
    '  }));',
    '  s.close();',
    '});'
  ].join('\n');

  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, { HEMA_STATIC: 'web', PORT: '0' }),
    encoding: 'utf8'
  });
  const r = JSON.parse(out.trim().split('\n').pop());

  assert.ok(/no-store/.test(r.htmlCC), 'web 模式下 HTML 仍须 no-store：' + r.htmlCC);
  assert.equal(r.jsCC, 'no-cache', 'web 模式下 JS 走协商缓存');
  assert.equal(r.jsStatus, 200);
  assert.ok(r.jsEtag, 'web 模式下仍有 ETag 可协商');
});
