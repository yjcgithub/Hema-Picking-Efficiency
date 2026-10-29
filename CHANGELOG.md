# 更新日志

本文件记录本项目的功能变更。结构参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 2026-10-30

### 变更

- **拣货时长改为「并行订单只计一次」（与盒马系统口径一致）**：合流按单时同一人同时进行多单，各单「开始 → 完成」区间重叠。原实现逐单累加，重叠时段被重复计入 → 时长虚高、效率偏低；现 `compute.js` 新增 `dedupOverlap`，在 `buildDataset` 入口按「人 × 日期」把当日订单区间排序，逐单扣除已被占用的时段，剩余部分作为该单的独占时长（行数不变）。明细时间精确到秒时不做容差，只存到分钟时把「重叠 ≤ 30 秒」视为取整噪声（`OVERLAP_TOLERANCE_SEC`）。实测 2026-10-29 数据：总时长 158.15h → 142.72h、总效率 89.09 → 98.72；系统导出 143.01h / 98.52。总时长差 0.2%，85 人逐人比值由 1.3~1.8 收敛到 0.97~1.02（中位 0.998），仅 2 人超 2%（「拣打一体」16 行的归属差异）。
- **口径升级自动重算历史**：新增设置 `computeVersion`（当前 `4`）。服务启动时若版本不一致，按**各数据集自身的映射快照**全量重算 payload（`rebuildFromSnapshots`，不改分区映射）并回写版本号，日志输出重算数量。
- **并行订单时长改按秒级精确计算**：起止时间带秒时，明细额外保存 `t0s`（当日 00:00 起的秒数），去重时按秒级区间精确扣除重叠、不再需要取整容差；导出被截断到分钟（秒恒为 0）的明细仍回落到分钟级 + 30 秒容差。旧数据集的明细没有 `t0s`，重新导入 / 重新抓取后自动按秒级计算。
- **接口复用已算好的结果**：`payload.meta` 记录 `computeVersion`，`/api/latest`、`/api/datasets/:id` 在「版本一致 + 数据集只含一天」时直接返回库里的 payload，不再每次请求用明细重算（实测 110ms → 8ms，190KB 响应不变）。

## 2026-10-12

### 变更

- **自绘图片向网页样式靠齐**：`server/render.js` 的分块改为按 `style.css` 的「效率透视分块」样式绘制 —— 标题行（▼ 折叠箭头 + 分块色点 + 作业类型 + 规模小字 + 「平均 / 中位数」图例色点）、表格圆角外框（`border-radius:10px` + 裁剪）、表头浅灰底（`#f8fafc` / 字号 13 / `#475569`）、首列吸左分隔线、`小计` 行浅灰底加粗、**平均值 / 中位数最接近的行加浅蓝 `#93c5fd` / 浅紫 `#d8b4fe` 边框**并在「总计」列右上角浮出小标注（对应 `.stat-badge`）、折线图行改为 **平滑曲线 + 10% 面积填充 + 橙色虚线达标线（含「达标线 N」标注）+ 时间轴刻度**（对应 ECharts `smooth/areaStyle/markLine`）、表格下方补回口径说明 `.note`。配色改用页面 CSS 变量（`--txt/--muted/--line-mid` 等），并新增按文本宽度估算的画布宽度/折行，使表格像页面一样铺满卡片宽度。
- 字体族改为按前端 `body` 的顺序给出备选列表（`Noto Sans SC, PingFang SC, Microsoft YaHei, Hiragino Sans GB, WenQuanYi Micro Hei, sans-serif`），提升容器内命中中文字体的概率。
- **定时推送改用「服务端自绘图片」，移除无头浏览器**：原来用 `puppeteer` 打开看板截图，小服务器上启动慢（实测启动一次要 70+ 秒）、吃内存。现改为服务端直接拿最新数据集的 `personByHour` 数据拼 **SVG**、用 **`@resvg/resvg-js`** 光栅化成 PNG（纯 CPU，无需 Chromium）。
- **移除 `puppeteer` 依赖与 `server/capture.js`**，并去掉「看板地址」设置项（`dingPageUrl`）、`/api/ding/config` 的 `pageUrl`/`pageUrlEffective`/`captureOk`/`captureError` 字段、前端 `HEMA.dingPayload`、`HEMA._current` 与 `HEMA_DING_SCALE`（无头截图专用）等连带逻辑；`/api/ding/config` 改为返回 `renderOk` / `renderError`。
- **新增依赖 `@resvg/resvg-js`**（含预编译二进制，`npm install` 即用）。
- 新增环境变量：`HEMA_SVG_FONT_FILE` / `HEMA_SVG_FONT_DIR`（自绘用字体文件 / 目录）、`HEMA_SVG_FONT`（默认字体名）、`HEMA_SVG_SCALE`（出图倍率，默认 2）。容器内缺中文字体时装系统字体包（如 `fonts-wqy-microhei`）即可。

### 修复

- 自动推送在「当天还没数据」时不再报「看板无数据」：改为判断最新数据集是否有透视数据，无数据集才跳过。
- **自绘字体健壮性**：`HEMA_SVG_FONT_FILE` / `HEMA_SVG_FONT_DIR` 只传真实存在的路径（避免 resvg 因路径不存在报错）；字体路径按系统分隔符拆分（Linux 为 `:`，此前文档误写为 `;`）。新增启动日志 `[钉钉] 自绘字体 …`，打印默认字体名、来源以及**指定路径是否存在**（容器重启常把运行时装的字体清掉，便于自查）。README / `.env` 补充说明：容器重启会丢失 `apt` 装的字体，建议把字体放进挂载卷并用 `HEMA_SVG_FONT_FILE` 指向。
- **自绘折线图的达标线消失**：y 量程此前只按数据收紧，当达标值（如后场 260）高于数据最大值时，橙色虚线落到量程外被裁掉。改为把达标线一并纳入量程，保证始终可见。

## 2026-10-11

### 新增

- **推送消息关键值着色**：钉钉 markdown 里的关键值用 `<font color="#RRGGBB">…</font>` 着色（统计时间段=蓝、效率=绿、平均值=橙、中位数=紫），提升群消息可读性。

### 变更

- **Cookie 鉴权失效即删除并提示**：取数时若某份 Cookie 返回鉴权失效（登录态过期，HTTP 401/403 或接口非 JSON），直接**删除该份已保存的 Cookie**（主 / 备用对应槽位），不再留着反复撞接口；同时写一条状态（`UMS_COOKIE_AUTH_KEY`）经 `/api/ums/config` 的 `cookieAuth` 下发，页面弹一次提示引导重新同步。仅当本次失败的正是「已保存」的那份才删除；页面临时粘贴、未保存的 Cookie 不受影响。

### 修复

- **自动获取在网格点分钟内被反复触发**：轮询每 5 秒一次、而网格点按「分钟」命中，原判断「落在网格点即执行」导致同一分钟内每 5 秒各触发一次（日志里 16:06 连续跑了 10 多次）。改为在 `umsAutoState` 记录已执行的网格点 `slot`（东八区「日期:分钟数」），同一网格点只执行一次；执行后回写 `nextAt` 时排除当前网格点（`futureOnly`），日志显示为真正的下次时刻（如 17:06）而非「刚才那一刻」。
- **自动推送分块顺序 / 图文错位**：页面按固定顺序（前场 / 后场 / 一体化）渲染分块，而服务端 `personByHour.groups` 按效率降序，`capture.js` 原按下标逐块截图 → 出现「后场 / 一体化 / 前场」的错序，且标签与截图不是同一块。改为按 DOM 实际顺序取块，用各块标题 `data-toggle`（作业类型）反查对应数据，顺序与名称 / 数值 / 截图一致。
- **推送图片显示为裂图（PNG 损坏）**：`puppeteer` v24 的 `screenshot()` 默认返回 `Uint8Array` 而非 `Buffer`，原代码 `buf.toString('base64')` 对 `Uint8Array` 会退化为逗号分隔的数字串，落盘后字节非法 → 浏览器显示裂图。改为先 `Buffer.from(buf)` 再转 base64。
- **`npm test` 卡住不退出**：`umsAutoTick` 的 `setInterval` 未 `unref`，被 `require` 的测试进程（含 `static.test.js` 里 `execFileSync` 起的子进程）会一直挂着。改为 `.unref()`（生产由 HTTP 服务保活，不受影响）。
- **无头截图注入字体时报错**：`evaluateOnNewDocument` 在 `document_start` 执行，此时 `document.head` 可能为 `null`，`document.head.appendChild(...)` 抛「Cannot read properties of null (reading 'appendChild')」。改为兜底 `document.head || document.documentElement`。
- 诊断信息增强：页面 console 错误补上其资源 URL（`Failed to load resource … 404` 正文不带地址），便于定位是哪个静态资源 404。

### 测试

- 新增 `server/test/ums-cookie.test.js`：用**本机 mock 接口**（`HEMA_UMS_URL` 指向本地随机端口，不联网）+ 独立临时库，验证「Cookie 鉴权失效 → 删除已存的那份并记录 `cookieAuth`」「主 / 备用都失效 → 两份都删」「临时粘贴未保存的 Cookie 失效 → 不动已存 Cookie」三条路径。

## 2026-10-10

### 新增

- **钉钉群推送（效率透视图截图发群）**：因自定义机器人 Webhook 不支持图片消息，改为把截图存到服务端、以 markdown 图片链接发到群。
  - 设置弹窗（顶栏「钉钉推送」）：Webhook、加签密钥（`SEC` 开头）、公网地址。
  - 效率透视表卡片菜单「上传到钉钉群」：按范围菜单选中的分块逐块截图 + 效率 / 平均值 / 中位数，手动推送。
- **自动推送（服务端无头浏览器截图）**：用 `puppeteer` 在服务端打开看板页、调用页面内 `HEMA.dingPayload()` 取回分块图与统计后发群，无需浏览器常开。
  - `server/capture.js`（新增）：无头浏览器截图模块，`puppeteer` 为可选依赖。
  - 设置弹窗「定时推送」：启用开关、看板地址、立即执行一次。
- **图片落盘**：截图按内容哈希命名写入服务端；默认 `server/data/ding/`，由只读路由 `/api/ding/img/<file>` 对外提供。
- 环境变量 **`HEMA_DING_DIR`**：图片落盘目录（可指向 nginx 站点目录，交给 nginx 静态托管）。
- 环境变量 **`HEMA_DING_URL_PREFIX`**：图片对外 URL 路径前缀（交给 nginx 托管时设为 `/ding`）。
- 环境变量 **`HEMA_DING_SCALE`**：截图降采样倍率（默认 1）。
- 配置项 `DING_PUSH_DELAY_MIN`（取数成功后延迟推送的分钟数，默认 1）、`DING_PUSH_MAX_RETRY`（推送失败重试次数，默认 2）。
- 配置项 `UMS_MANUAL_LOCK_SEC`（自动获取点前后拒绝手动获取的秒数，默认 60）；`/api/ums/config` 新增 `manualLockSec` 字段。

### 变更

- **自动推送触发方式**：由「按时段 + 间隔定时」改为**「自动获取成功后延迟 1 分钟」触发**；多次触发合并为一次；失败自动重试（默认 2 次）。仅 **自动获取** 触发，手动获取、脚本同步、上传 xlsx 均不触发（手动推可用「立即执行一次」）。
- **自动获取排期不再受手动 / 脚本取数影响**：移除自动获取侧的取数冷却判断，到点即执行。
- **自动获取点前后错峰**：距离下次自动获取（`auto.nextAt`）前后 60 秒内，`/api/ums/fetch` 拒绝手动获取（返回 429），前端在发起前也会提前提示。
- **图片 URL 基址**：手动推送此前按请求 Host 推断（接口域名）导致图片链接错误，改为以设置里的「公网地址」为准。
- 无头浏览器截图：`protocolTimeout` 放宽至 300s、像素密度 1、倍率由 `HEMA_DING_SCALE` 控制（明显提速）。
- 启动日志与每次落盘日志打印图片输出目录、可写状态、URL 前缀、公网地址、以及每张图的「本地绝对路径 → 对外 URL」。

### 修复

- **无头浏览器时区**：容器时区为 UTC 时，北京时间 00:00–08:00 页面会把「今天」判成前一天、导致推错日期；改为强制页面时区 `Asia/Shanghai`。
- **截图超时**：页面内 html2canvas 较慢导致 `Runtime.evaluate timed out`，放宽 CDP 超时并降采样；失败时附带页面诊断（页面报错 / 失败请求 / 接口响应）。
- 提示浮层 `.notice` 被其它弹窗遮挡：提高 `z-index`。

### 文档

- README 增补「钉钉群推送」「自动推送」章节、相关 API 与环境变量说明。

> 部署提醒：前端由 nginx 站点托管时，改动后需把新的 `dist/` 覆盖到站点目录；服务端改动需重启容器。容器需自备 Chromium 运行库（`libnspr4`/`libnss3` 等）与中文字体。
