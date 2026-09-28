# 静态资源缓存方案（内容哈希指纹 + 分级 HTTP 缓存）

目标：**服务器上的 HTML / CSS / JS / 图片被修改后，用户无需手动清缓存，刷新即得最新版本**；同时，未修改的资源必须继续命中浏览器缓存，不产生多余网络请求。

---

## 1. 现状梳理与根因

### 1.1 改造前的部署架构

```
浏览器 ──GET /hpe/────────────────────────────► nginx（反向代理，可选）
       ──GET /hpe/assets/js/app.js────────────►  Node/Express
                                                 └─ express.static(server/../web)
                                                    实时读盘返回文件
```

- 前端为纯静态资源，**没有构建步骤**：`web/` 目录就是线上目录，Express 实时读盘托管。
- 资源引用全部是固定 URL：`web/index.html` 里写死 `assets/css/style.css`、`assets/js/app.js`、`assets/js/charts.js`、`assets/js/config.js`。
- 第三方库（ECharts、html2canvas）走 CDN 外链，URL 自带版本号（`echarts@5.5.1`），本身不受影响。

### 1.2 原有缓存策略

| 项 | 改造前 | 后果 |
|----|--------|------|
| `Cache-Control` | 未显式设置，`express.static` 默认 `public, max-age=0` | 允许缓存，但每次都要回源协商 |
| `ETag` | `express.static` 默认弱 ETag（`W/"size-mtime"`，基于文件大小 + 修改时间） | 仅能做到协商缓存 |
| CDN / nginx `proxy_cache` | 未配置 | 若后续接入，URL 不变 → 缓存永不失效 |
| HTML 入口 | 与其它资源同策略 | HTML 本身也可能被缓存，导致引用不到新资源 |

### 1.3 核心问题（根因）

**浏览器的缓存键是 URL，不是文件内容。**

1. 资源 URL 恒定 → 只要浏览器内存/磁盘缓存、中间 CDN 或 nginx `proxy_cache` 命中旧副本，用户就一直看到旧版本，直到缓存过期或手动清除。
2. `max-age=0` 的协商缓存在「强刷新（Ctrl+F5）」下可绕过，但**普通刷新 + 中间层缓存**并不受用户控制，运维侧无法保证「改完立刻生效」。
3. HTML 若被缓存，即使资源指纹变了，用户拿到的仍是引用了旧指纹的旧 HTML。

因此仅靠 ETag / `max-age=0` 不能解决问题，必须让**资源 URL 随内容变化**，并让**入口 HTML 永远回源**。

---

## 2. 方案总览

### 2.1 三层策略

| 资源类型 | 文件名示例 | `Cache-Control` | ETag | 效果 |
|---------|-----------|-----------------|------|------|
| 入口 HTML | `index.html`（文件名不变） | `no-store, no-cache, must-revalidate, max-age=0` + `Pragma: no-cache` + `Expires: 0` | 弱 ETag（不影响） | 每次访问 100% 回源，永远是最新版本，且引用的资源路径永远是最新指纹 |
| 指纹资源 | `app.c9005a48.js`、`style.a801a99f.css`、`logo.3f2a1b7c.png` | `public, max-age=31536000, immutable` | 强 ETag = 内容哈希（`"c9005a48"`） | 内容未变 → 一年内零请求；内容一变 → 文件名变、URL 变 → 必然重新下载 |
| 其它未指纹资源 | `manifest.json` 等 | `no-cache` | 弱 ETag | 可缓存，但每次协商，未变返回 304 |

### 2.2 数据流

```
        ┌──────────────────────────────────────────────┐
        │  web/  源码（人工编辑，文件名恒定，可读性好）  │
        └───────────────────┬──────────────────────────┘
                            │  npm run build（或启动时自动构建）
                            ▼
        ┌──────────────────────────────────────────────┐
        │  dist/ 产物                                   │
        │    index.html        引用已改写为指纹路径      │
        │    assets/js/app.<hash8>.js                   │
        │    assets/css/style.<hash8>.css（内部 url() 也已改写）
        │    manifest.json     原始路径 → 指纹路径       │
        └───────────────────┬──────────────────────────┘
                            │  express.static(dist) + 分级 Cache-Control
                            ▼
   浏览器：GET /hpe/  ────────────► 200 index.html（no-store，每次回源）
           GET /…/app.c9005a48.js ► 强缓存一年；文件内容改了 → 变成 app.7f3e1d02.js
```

### 2.3 关键设计点

- **哈希 = sha256 前 8 位十六进制**，插在最后一个扩展名前：`app.js → app.c9005a48.js`（`app.min.js → app.min.<hash8>.js` 也正确处理）。
- **哈希只由内容决定**：内容不变则哈希不变 → 发布多次也命中缓存；只在真正修改时失效。
- **HTML 文件名不变**（不参与指纹），靠 `no-store` 保证回源，避免用户收藏的 URL 404。
- **旧指纹回退**：资源改名后，仍停留在旧页面的标签页会去请求上一版文件名，服务端按「逻辑名」改写为当前指纹名，避免 404 白屏。
- **兜底开关**：`HEMA_STATIC=web` 可退回「直接托管源目录」的旧模式，未指纹化也能跑。

---

## 3. 构建流程改造

新增 [server/build.js](file:///h:/Hema-Picking-Efficiency/Hema-Picking-Efficiency/server/build.js)，用 Node 内置 `crypto` / `fs` 完成构建，**不引入任何新依赖**。

### 3.1 三轮构建顺序

| 轮次 | 处理对象 | 动作 | 理由 |
|------|---------|------|------|
| 1 | 叶子资源（图片 / 字体 / JS / 其它） | 按原始内容算哈希并改名 | 内容不含引用，直接哈希 |
| 2 | CSS | 先把内部 `url(...)` 指向指纹资源，**再**对改写后的内容算哈希 | 否则 CSS 里的图片改名后 CSS 指纹不会变，导致指向不存在的旧图片 |
| 3 | HTML | 只改写引用，**文件名不变** | 入口靠 HTTP 头禁缓存，不需要改名 |

### 3.2 产物结构

```
dist/
├── index.html                      # 引用已改写为指纹路径
├── manifest.json                   # { entry, generatedAt, hashLength, files: { 原始路径: 指纹路径 } }
└── assets/
    ├── css/style.<hash8>.css
    └── js/{app,charts,config}.<hash8>.js
```

`dist/` 全量重建（`fs.rmSync` 后重写），保证产物与 `web/` 严格一致，不会残留上一版文件。`dist/` 已加入 `.gitignore`，不入版本库。

### 3.3 引用改写规则

- 只改写 HTML 中的 `href` / `src` / `poster` / `data-src` 属性，以及 CSS 中的 `url(...)`。
- **不改写**：`http:` / `https:` / `data:` / `mailto:` 等协议链接、协议相对地址（`//cdn...`）、页内锚点（`#top`）、纯查串（`?x=1`）、越出 `web/` 的路径。
- 保留原有写法与查串：绝对路径 `/assets/x.png` 仍为绝对路径；`app.js?v=1` 改写成 `app.<hash8>.js?v=1`。
- 相对引用改写后仍为相对引用（CSS 里的 `../img/logo.png` → `../img/logo.<hash8>.png`）。

### 3.4 运行时命令

```bash
cd server

npm run build     # 手动构建：node build.js，打印 原始路径 -> 指纹路径 全量清单
npm start         # 默认 HEMA_STATIC=auto，启动时自动构建后再托管 dist/
```

---

## 4. 服务端缓存头实现

实现位置：[server/index.js](file:///h:/Hema-Picking-Efficiency/Hema-Picking-Efficiency/server/index.js)（静态托管段）

### 4.1 分级响应头

```js
function staticHeaders(res, filePath) {
  const rel = path.relative(STATIC.dir, filePath).split(path.sep).join('/');

  // 入口 HTML：绝对不缓存，保证每次拿到最新 HTML（进而拿到最新指纹路径）
  if (/\.html?$/i.test(rel)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return;
  }

  // 指纹资源：文件名中的 hash8 即内容哈希，可安全长期强缓存
  const m = /\.([0-9a-f]{8})(\.[^./]+)$/.exec(rel);
  if (STATIC.fingerprint && m) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', '"' + m[1] + '"');   // 强 ETag = 内容哈希
    return;
  }

  // 其它（manifest.json 等）：协商缓存，不落强缓存
  res.setHeader('Cache-Control', 'no-cache');
}
```

> 时序说明：`express.static` 的 `setHeaders` 回调在底层 `send` 写入默认 `Cache-Control` / `ETag` **之前**执行，而 `send` 只在响应尚无该头时才补默认值，因此这里设置的值一定生效。

### 4.2 旧指纹回退

资源内容变化后文件名会变。用户停留在旧页面的标签页（或旧 HTML 的 Service Worker / CDN 边缘副本）会请求**上一版文件名**，服务端按逻辑名改写，返回当前版本，避免 404：

```js
router.use(function (req, res, next) {
  if (STATIC.fingerprint) {
    const m = /^(.*)\.([0-9a-f]{8})(\.[^./]+)$/.exec(req.path);
    if (m) {
      const cur = FP_MAP[m[1] + m[3]];            // /assets/js/app.js -> /assets/js/app.c9005a48.js
      if (cur && cur !== req.path) {
        const cut = req.url.indexOf('?');
        req.url = cur + (cut >= 0 ? req.url.slice(cut) : '');
      }
    }
  }
  next();
});

router.use(express.static(STATIC.dir, {
  index: 'index.html', etag: true, lastModified: true, setHeaders: staticHeaders
}));
```

### 4.3 运行模式（`HEMA_STATIC`）

| 值 | 行为 | 适用场景 |
|----|------|---------|
| `auto`（默认） | 启动时调用 `build.build()` 构建到 `dist/` 并托管；构建失败自动回落源目录 | 单机部署、内网，最省心：改完 `web/` 重启服务即生效 |
| `dist` | 只托管已构建好的 `dist/`（缺失则回落源目录并告警） | CI 构建 + 只读目录部署；需先 `npm run build` |
| `web` | 直接托管源目录，未指纹化，仅靠 `no-cache` + ETag 协商 | 临时排障 / 老环境兜底 |
| `off` | 完全不托管前端，只提供 API（等价写法 `none` / `api`） | 前后端分离：前端由 nginx / 1Panel 站点托管 |

### 4.4 前后端分离部署（前端目录不在仓库里）

前端目录与后端不在同一路径时，用环境变量指定：

| 变量 | 说明 |
|------|------|
| `STATIC_DIR` | 前端目录绝对路径，如 `/1Panel/1panel/www/sites/xl/index`（优先级最高） |
| `HEMA_WEB_DIR` | 同上，别名 |

未显式指定时，服务端会按候选顺序自动探测含 `index.html` 的目录（`<项目>/web`、`<项目>/../web`、`<cwd>/web`、`/web`、`/app/web`），全部落空则**转为仅提供 API** 并打印尝试过的路径。

```bash
# 方式一：后端托管前端（auto 模式下会把该目录构建到 dist/ 再托管）
STATIC_DIR=/1Panel/1panel/www/sites/xl/index npm start

# 方式二：前端交给 1Panel 站点托管，后端只管 API（推荐，CORS 已默认放开）
HEMA_STATIC=off npm start
```

> 方式二下前端由 nginx 直接返回，本服务不参与前端资源的构建与缓存策略；指纹化收益需在前端仓库单独构建。

启动日志会打印当前模式，`GET /api/health` 也会返回 `staticMode` 与 `staticDesc`，便于线上确认到底跑在哪种模式：

```json
{ "ok": true, "datasets": 3, "basePath": "/hpe",
  "staticMode": "auto", "staticDesc": "已构建指纹资源 5 个 → …/dist" }
```

---

## 5. 服务器 / 反向代理配置示例

服务端返回的头是「源站策略」，反向代理与 CDN 必须**透传、不得改写或缓存 HTML**，否则前面的设计会被架空。

### 5.1 Nginx

```nginx
# 前端静态资源与页面（Node 直出）
location /hpe/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 入口 HTML：禁止在 nginx 层缓存，确保每次回源
    proxy_cache_bypass $http_upgrade;
    proxy_no_cache     $http_upgrade;

    # 关闭 nginx 对上游 Cache-Control 的改写
    proxy_hide_header X-Powered-By;
    expires off;                     # 关键：不要用 expires 覆盖上游头
    add_header Cache-Control "" always;  # 需要时再显式透传，见下方说明
}

# 如果必须用 nginx 做静态文件缓存，请只缓存指纹资源（文件名含 8 位哈希）
location ~ ^/hpe/.+\.[0-9a-f]{8}\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico)$ {
    proxy_pass http://127.0.0.1:3001;
    proxy_cache            static_cache;
    proxy_cache_valid      200 365d;
    proxy_cache_key        $scheme$request_method$host$request_uri;   # URL 含哈希，无需担心失效
    proxy_cache_use_stale  error timeout updating;
    proxy_ignore_headers   Cache-Control Expires Set-Cookie;
    add_header X-Cache-Status $upstream_cache_status;                 # 便于验证命中
}

proxy_cache_path /var/cache/nginx/static levels=1:2 keys_zone=static_cache:64m inactive=365d max_size=2g;

# 入口 HTML 一律不缓存
location = /hpe/            { proxy_pass http://127.0.0.1:3001; proxy_cache off; expires off; }
location = /hpe/index.html  { proxy_pass http://127.0.0.1:3001; proxy_cache off; expires off; }

# 压缩（对 JS/CSS 收益大）
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;
gzip_min_length 1k;
```

> `add_header` 的坑：一旦某 `location` 内出现 `add_header`，父级 `add_header` 会被整体丢弃。若要用 nginx 加头，请在该 `location` 内补全所有需要的头，或改在 `server` 块统一处理。

若前端由 nginx 直接读 `dist/` 目录（不经 Node），则等效配置：

```nginx
root /srv/hema/dist;

location /hpe/ {
    try_files $uri $uri/ /hpe/index.html;
}

# 指纹资源：一年强缓存
location ~ \.[0-9a-f]{8}\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico)$ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    etag on;
}

# 入口 HTML：禁缓存
location ~* \.html?$ {
    add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;
    add_header Pragma "no-cache" always;
    expires off;
    etag off;
}
```

### 5.2 Apache（httpd）

```apache
<VirtualHost *:443>
    ServerName api.yjmc.xyz

    # 反向代理到 Node（需 mod_proxy / mod_proxy_http / mod_headers / mod_expires）
    ProxyPreserveHost On
    ProxyPass        /hpe/ http://127.0.0.1:3001/hpe/
    ProxyPassReverse /hpe/ http://127.0.0.1:3001/hpe/

    # 透传上游缓存头，不在 Apache 层改写
    Header always unset X-Powered-By

    # 仅对指纹资源追加（若上游已给，会重复；因此只在 nginx/Node 未接管时使用）
    <LocationMatch "\.html?$">
        Header always set Cache-Control "no-store, no-cache, must-revalidate, max-age=0"
        Header always set Pragma "no-cache"
        Header always unset ETag
        Header always set Expires "0"
    </LocationMatch>
</VirtualHost>
```

若 Apache 直接读 `dist/`：

```apache
<Directory "/srv/hema/dist">
    Options -Indexes +FollowSymLinks
    AllowOverride None
    Require all granted

    <FilesMatch "\.html?$">
        Header set Cache-Control "no-store, no-cache, must-revalidate, max-age=0"
        Header set Pragma "no-cache"
        Header unset ETag
        Header set Expires "0"
    </FilesMatch>

    <FilesMatch "\.[0-9a-f]{8}\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico)$">
        Header set Cache-Control "public, max-age=31536000, immutable"
        FileETag MTime Size
    </FilesMatch>

    # 全站压缩
    AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml
</Directory>
```

### 5.3 CDN / 云存储（若前端托管在对象存储 + CDN）

1. 上传时**不要**对 HTML 设置「缓存 30 天」，HTML 必须配置为「不缓存 / 遵循源站」。
2. 指纹资源可设「缓存一年、忽略源站头」。
3. 配置刷新规则时**只需刷新 `index.html`**（以及任何未指纹的入口文件），指纹资源无需刷新 —— 这正是本方案最大的收益。
4. 若使用了 SPA 的 `try_files` 兜底，注意别让 404 兜底把不存在的指纹文件也返回 `index.html`，否则资源加载会静默出错。

---

## 6. 验证方法

### 6.1 自动化用例（每次改动都跑）

```powershell
cd server
npm test
```

[server/test/static.test.js](file:///h:/Hema-Picking-Efficiency/Hema-Picking-Efficiency/server/test/static.test.js) 共 8 个用例，覆盖：

| 层面 | 用例 | 断言要点 |
|------|------|---------|
| 构建 | 资源名插入内容哈希 | `app.js → app.<hash8>.js`、`index.html` 与 `manifest.json` 就位、指纹文件内容与源一致 |
| 构建 | HTML / CSS 引用改写 | `<link>` / `<script>` / `<img>` 已指向指纹路径；`?v=1` 保留；CDN 外链与 `#top` 锚点原样；CSS 内 `url()` 指向指纹图片 |
| 构建 | 内容不变哈希不变 | 原样重建两次 `map` 完全一致（缓存可复用）；只改 `app.js` 时仅它换名，CSS/图片指纹不变，入口引用同步更新 |
| 服务 | 入口 HTML 无缓存 | `no-store` / `no-cache` / `Pragma: no-cache`；HTML 中**只见指纹路径**，不含原始逻辑路径 |
| 服务 | 指纹资源强缓存 + 强 ETag | `public, max-age=31536000, immutable`；ETag 为 `"<hash8>"` 且与文件名哈希一致；`If-None-Match` 命中返回 304 空体；不匹配返回 200 全量 |
| 服务 | 旧指纹回退 | 把哈希换成 `.00000000.js` 仍返回 200，内容与当前版本一致 |
| 服务 | 未指纹资源协商 | `manifest.json` 为 `no-cache` |
| 服务 | `HEMA_STATIC=web` 兜底 | HTML 仍 `no-store`，JS 为 `no-cache` 且带 ETag |

> 用例说明：Node 的 `fetch`（undici）会自动附加 `cache-control: no-cache`，按 HTTP 语义服务端**应当**忽略条件请求返回 200，因此协商缓存断言改用 `node:http` 发起。

### 6.2 命令行验证（curl）

```powershell
# 1) 入口 HTML 必须 no-store
curl -sI http://127.0.0.1:3001/hpe/ | Select-String 'Cache-Control|Pragma|Expires'

# 2) 指纹资源必须 immutable + 强 ETag，且哈希与文件名一致
curl -sI http://127.0.0.1:3001/hpe/assets/js/app.c9005a48.js | Select-String 'Cache-Control|ETag'

# 3) 协商缓存：命中返回 304
curl -sI -H 'If-None-Match: "c9005a48"' http://127.0.0.1:3001/hpe/assets/js/app.c9005a48.js | Select-String 'HTTP/|ETag'

# 4) 旧指纹回退：应 200 而非 404
curl -sI http://127.0.0.1:3001/hpe/assets/js/app.00000000.js | Select-String 'HTTP/'

# 5) 确认当前运行模式
curl -s http://127.0.0.1:3001/hpe/api/health
```

### 6.3 浏览器实测（Chrome / Firefox / Edge）

统一前置：访问 `http://localhost:3001/hpe/`，按 `F12` 打开 DevTools → **Network** 面板，勾选 **Disable cache 关闭**（即正常使用缓存），再刷新一次让资源入缓存。建议同时勾选「Preserve log」。

**测试 A：修改文件后无需清缓存即生效**

1. 修改 `web/assets/js/app.js`（例如 `console.log('v2')`）。
2. 重启服务（`HEMA_STATIC=auto` 时构建发生在启动阶段）。
3. 在**已缓存**的页面上**普通刷新（F5 / Ctrl+R）**，**不要**用 Ctrl+F5。
4. 预期结果（三个浏览器一致）：
   - `index.html` 请求状态为 `200`（非 `304` / 非 `(from disk cache)`）；
   - `app.<新hash8>.js` 首次加载为 `200`，响应头 `Cache-Control: public, max-age=31536000, immutable`；
   - 旧的 `app.<旧hash8>.js` 在后续刷新中不再出现在请求列表里；
   - 页面行为已是新版本（Console 可见 `v2`）。
5. 再次普通刷新：`index.html` 仍为 `200`（no-store），`app.<新hash8>.js` 变为 `(from disk cache)` 或 `304`，**不重新下载**。

Chrome / Edge 额外检查：
- Network 面板 Size 列显示 `(from disk cache)`；Status 列若显示 `304`，说明命中了协商缓存。
- 右键资源 → **Copy → Copy as cURL**，可复核请求头中**没有**发送 `If-None-Match`（强缓存生效时不发请求）。

Firefox 额外检查：
- 地址栏 `about:cache` 可看到磁盘缓存条目；
- Network 面板 Details 中确认 `Cache-Control: immutable` 被识别（Size 列显示 `cached`）。

**测试 B：未修改资源缓存命中，不产生多余请求**

1. 连续普通刷新 3 次页面。
2. 预期：`app.<hash8>.js`、`style.<hash8>.css` 自第二次起不再有网络传输（`from cache` / `304`），**只有 `index.html` 和 `/api/*` 请求真正回源**。
3. 若发现每次刷新都重新下载全部资源：检查是否被 DevTools 的「Disable cache」勾选、是否用了 `Ctrl+F5`、或 nginx 是否用 `expires` 覆盖了上游 `Cache-Control`。

**测试 C：跨标签页 / 灰度场景**

1. 打开标签页 A，加载页面（记为旧指纹 v1）。
2. 修改 `app.js` 并重启服务（指纹变为 v2），**不刷新 A**。
3. 在标签页 A 中再次触发加载某个 v1 文件（例如切到 Network 面板后重新请求 `app.<v1>.js`）：应返回 `200` 且内容为 v2（旧指纹回退生效），页面不会 404 白屏。

**测试 D：图片 / CSS 联动**

1. 替换 `web/assets/img/` 下某张图片，或修改 CSS。
2. 刷新页面：新图片/新样式立即生效，且其 URL 已变为新哈希。

### 6.4 验收清单

- [ ] `npm test` 全绿（8/8）。
- [ ] `GET /hpe/` 响应头含 `no-store`，且响应体中的资源引用全部带 8 位哈希。
- [ ] 指纹资源响应头含 `immutable`，ETag 与文件名哈希一致。
- [ ] 修改 JS 后普通刷新即生效（Chrome / Firefox / Edge 各验证一次）。
- [ ] 连续刷新时未修改资源无网络传输。
- [ ] 旧指纹 URL 返回 200（回退生效，非 404）。
- [ ] nginx / Apache 未用 `expires` 或 `add_header` 覆盖上游 `Cache-Control`。

---

## 7. 故障排查

| 现象 | 可能原因 | 排查与处理 |
|------|---------|-----------|
| 改了 JS，刷新页面仍是旧版本 | HTML 被缓存 | `curl -sI /hpe/` 看是否有 `no-store`；若被 nginx 加了 `expires 30d`，去掉该指令；CDN 侧把 HTML 设为不缓存 |
| 资源 404（`net::ERR_ABORTED` 或空白页） | 直接部署了 `web/` 目录却带着已改写的 HTML；或 `dist/` 不完整 | 确认 `dist/` 与当前 `web/` 同一版本；`HEMA_STATIC=dist` 时先 `npm run build`；查看启动日志与 `/api/health` 的 `staticDesc` |
| 页面引用 `app.c9005a48.js` 却请求了 `app.<旧hash>.js` | 浏览器/代理缓存了旧 HTML | 属预期（旧指纹回退会兜住），但应确认 HTML 头为 no-store；必要时单独 `curl /hpe/` 确认 HTML 内容里的路径 |
| 资源被无限次重新下载 | 上游 `Cache-Control` 被代理覆盖为 `no-cache`/`max-age=0`；或文件名未指纹化（跑在 `HEMA_STATIC=web`） | `curl -sI` 看实际响应头；检查 nginx `expires`、`proxy_ignore_headers`、CDN 缓存规则；确认 `/api/health` 的 `staticMode` 不是 `web` |
| `ETag` 与文件名哈希不一致 | 上游头被覆盖，或 `send` 的默认弱 ETag 生效 | 检查 `staticHeaders` 是否被执行；nginx 未设置 `etag off` |
| 构建后样式里的图片 404 | CSS 的 `url()` 指向了不存在路径 | 检查 CSS 中 `url(...)` 的相对路径是否越出 `web/`（越界引用不会被改写，保持原样）；确认图片确实存在于 `web/` 下 |
| `HEMA_STATIC=auto` 启动变慢 | 每次启动都全量重建 `dist/` | 属预期；若资源很多、启动敏感，可改为 `HEMA_STATIC=dist` 并在发布流程中单独执行 `npm run build` |
| 构建报「源目录不存在」 | `web/` 路径不对或未部署 | 确认仓库根下有 `web/`；`build.js` 默认 `SRC_DIR = <repo>/web` |
| 修改 `web/` 后没重启服务就刷新 | `auto` 模式下构建只在启动时发生 | 重启服务，或先执行 `npm run build` 再刷新；纯排障可临时用 `HEMA_STATIC=web` |
| 灰度/回滚需求 | 需要快速退回旧版本 | 保留上一版 `dist/` 副本即可（指纹文件名不同，可共存）；或 `git checkout` 源码后重启构建 |

### 回滚方式

1. **优先回滚源码**：`git checkout` 回退 `web/` 下的文件 → 重启服务（`auto` 会重建 `dist/`）。
2. **仅回滚静态产物**：把上一版 `dist/` 备份目录换回 `dist/`，用 `HEMA_STATIC=dist` 启动（避免被 `auto` 覆盖重建）。
3. **完全退回旧机制**：`HEMA_STATIC=web` 启动 —— 未指纹化，仅靠 `no-cache` + ETag 协商，行为与改造前一致。

---

## 8. 日常发布流程

```powershell
# 修改前端源码
#   web/index.html、web/assets/css/style.css、web/assets/js/*.js、web/assets/img/*

# 本地验证
cd server
npm test

# 方式一（推荐，改动最少）：直接重启服务
npm start                     # HEMA_STATIC=auto，启动时自动重建 dist/

# 方式二（CI / 只读目录）：显式构建 + 只托管产物
npm run build
$env:HEMA_STATIC='dist'; npm start
```

发布后自查一次：

```powershell
curl -sI http://127.0.0.1:3001/hpe/ | Select-String 'Cache-Control'
curl -s  http://127.0.0.1:3001/hpe/api/health
```
