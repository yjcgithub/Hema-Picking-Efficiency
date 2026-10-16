# 拣货效率计算统计工具 — 项目架构文档

> 本文档描述系统的整体分层、模块职责、数据流、接口与关键机制，供开发/维护/二次开发参考。
> 业务口径与使用说明见 [README.md](./README.md)。

---

## 1. 项目概述

从盒马门店「门店视角：拣货单」的拣货明细（xlsx 导出 / 实时接口 / 油猴脚本回传）出发，按**作业类型 / 拣货分区 / 人员 / 时段**计算效率指标，并以看板形式呈现；同时支持把「人员 × 小时」效率透视表**服务端自绘成图片**、定时推送到钉钉群（见 [7.10](#710-钉钉定时推送)）。

五条核心设计原则：

- **口径唯一**：所有统计口径只在服务端 `compute.js` 实现，前端不做任何计算，仅渲染服务端返回的结果，避免前后端各写一套导致口径漂移。
- **多来源同一口径**：xlsx 上传、服务端带 Cookie 取数、油猴脚本回传三条路径最终都汇入 `buildFromMatrix`，门店筛选 / 丢弃计数 / 时间维度完全一致。
- **零构建前端**：前端为纯静态 HTML/CSS/JS（原生 JS），无打包步骤；发布时仅由 `build.js` 做内容哈希指纹。
- **原始明细留库**：入库时同时保存原始明细 `recs`，使「分区设置」变更后能重算全部历史数据集，无需重新上传。
- **推送不依赖浏览器**：定时推送的透视表图片由服务端自绘 SVG → PNG（`render.js` + `@resvg/resvg-js`），无需无头浏览器常开，小服务器也能跑。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            浏览器（web/）                                      │
│  index.html ── assets/js/config.js （API 地址 / 配色）                        │
│             ── assets/js/charts.js （ECharts 封装：图 / 表渲染）               │
│             ── assets/js/app.js    （视图逻辑：拉数 / 渲染 / 交互 / 实时获取）   │
│                     │ fetch(API_BASE + /api/...)                             │
└─────────────────────┼────────────────────────────────────────────────────────┘
                      │ HTTP（JSON / xlsx 原始字节）
┌─────────────────────▼────────────────────────────────────────────────────────┐
│                       服务端（server/，Express）                              │
│                                                                              │
│  ① HTTP 层  index.js   路由 / CORS / 路径归一化 / 静态托管 / UMS 取数 / 自动获取 │
│      │                  / 钉钉定时推送（编排 + 出网）                          │
│      ▼                                                                       │
│  ② 计算层  compute.js  xlsx 与 UMS 解析 + 全部统计口径（唯一口径实现）           │
│      │                                                                       │
│      ▼                                                                       │
│  ③ 存储层  db.js       node:sqlite（datasets / settings）                     │
│                                                                              │
│    自绘层  render.js   人员×小时 透视表 SVG → PNG（@resvg/resvg-js，无浏览器）  │
│    配置层  config.js   作业类型字典、默认前后场映射、必需列、门店编码、UMS/防风控/钉钉常量│
│    构建层  build.js    web/ → dist/ 内容哈希指纹构建                           │
└──────────────────────────────────────────────────────────────────────────────┘
         ▲                                  ▲
         │ POST /api/ums/agent/data         │ GET  ums.hemaos.com（带登录态 Cookie）
         │ （逐页取数结果回传）               │
┌────────┴──────────────────────────────────┴──────────────────────────────────┐
│  浏览器（油猴脚本，userscript/）                                                │
│  UMS / portalpro 页面内用登录态「同源」请求拣货单接口，逐页回传后端               │
└──────────────────────────────────────────────────────────────────────────────┘
```

**分层依赖方向**：`index.js → compute.js → config.js`、`index.js → db.js`、`index.js → build.js`、`index.js → render.js`。
`compute.js` 不依赖 `db.js`（映射与忽略列表由调用方传入），保持计算层可独立测试；`render.js` 只吃数据集 `payload`，不碰库。

---

## 3. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 运行环境 | Node.js ≥ 22.5.0 | 依赖内置 `node:sqlite`，免原生编译 |
| HTTP | Express 4 | 路由、`express.static`、`express.raw`（上传）/`express.json`（设置与 UMS） |
| 解析 | SheetJS `xlsx` | 读取工作表 `data`（缺失则取第一个）为矩阵 |
| 存储 | `node:sqlite`（`DatabaseSync`） | 单文件库 `server/data/hema.db` |
| 出网取数 | 全局 `fetch` + `AbortController` | 服务端带 Cookie 逐页请求 UMS 接口（超时可控） |
| 前端 | 原生 HTML / CSS / JS | 无框架、无打包；`HEMA` 全局命名空间 + IIFE |
| 图表 | ECharts 5.5.1（CDN） | 所有图表渲染 |
| 导出 | html2canvas 1.4.1（CDN） | 卡片「导出为图片 / 复制为图片」（仅前端页面用，推送不再依赖它） |
| 出图（推送） | `@resvg/resvg-js` | 服务端自绘透视表 SVG → PNG（纯 CPU、无浏览器；替代原 puppeteer 截图） |
| 推送 | 全局 `fetch` + `HmacSHA256` 加签 | 钉钉群机器人 Webhook：markdown 带图 + 单独一条 text @全员 |
| 构建 | `crypto.createHash('sha256')` | `build.js` 生成内容哈希指纹，无打包器 |
| 测试 | Node 内置测试运行器 | `node --test` |

---

## 4. 目录结构

```
Hema-Picking-Efficiency/
├── server/                        # npm 工程根（所有 npm 命令在此执行）
│   ├── index.js                   # ① HTTP 层：路由、CORS、路径归一化、UMS 取数与自动获取、钉钉推送、静态托管
│   ├── compute.js                 # ② 计算层：xlsx / UMS 解析 + 全部统计口径 + 增量合并
│   ├── db.js                      # ③ 存储层：SQLite（datasets / settings）
│   ├── render.js                  # 自绘层：人员×小时 透视表 SVG → PNG（@resvg/resvg-js）
│   ├── config.js                  # 配置层：口径参数、UMS 接口、防风控与钉钉常量
│   ├── build.js                   # 构建层：web/ → dist/ 内容哈希指纹
│   ├── package.json               # 依赖与脚本（start / build / test）
│   ├── .env                       # PORT / BASE_PATH / 自绘字体与倍率（npm start 自动加载）
│   ├── data/hema.db               # SQLite 库文件（运行时生成）
│   ├── data/ding/                 # 推送图片目录（默认；可用 HEMA_DING_DIR 指到 nginx 站点目录）
│   └── test/                      # node --test 用例（共 14 个）
│       ├── static.test.js         # 静态资源缓存方案（8）
│       ├── ums-cookie.test.js     # Cookie 鉴权失效自动删除（3）
│       ├── render.test.js         # 服务端自绘 PNG（2）
│       └── ding-render.test.js    # 定时推送全链路：自绘 → 落盘 → markdown 发群（1，全程离线）
├── web/                           # 前端静态资源（由 Express 托管）
│   ├── index.html                 # 页面结构（顶栏 + 10 张卡片 + 5 个弹窗 + 门禁遮罩）
│   └── assets/
│       ├── css/style.css
│       └── js/
│           ├── config.js          # API_BASE（按访问来源自动选择）、配色、单位
│           ├── charts.js          # ECharts 封装：图表渲染 / 自适应 / 双口径
│           └── app.js             # 视图逻辑：拉数、渲染、交互、上传、实时获取、钉钉推送、日志、门禁
├── userscript/                    # 油猴脚本（二选一安装）
│   ├── hema-pick-sync.user.js     # 纯同步脚本
│   └── 选中文本生成条码…CODE-128.js # 条码脚本 + 内置「拣货效率同步」面板
├── ARCHITECTURE.md                # 本文档
├── README.md                      # 使用与业务口径说明
├── CHANGELOG.md                   # 变更记录
└── .gitignore
```

---

## 5. 分层设计

### 5.1 HTTP 层 — [server/index.js](./server/index.js)

职责：协议处理、编排与出网取数，不含业务计算（UMS 明细解析也下沉到 `compute.js`）。

**中间件注册顺序**（顺序即语义，勿随意调整）

| 顺序 | 中间件 | 作用 |
|------|--------|------|
| 1 | 路径归一化 | 压缩重复斜杠 `//`、剥离 `BASE_PATH` 前缀、兜底截取 `/api/` 之后的部分 → `/hpe/api/...` 与 `/api/...` 均可用 |
| 2 | CORS | `ALLOW_ORIGIN`（默认 `*`），允许 `GET/POST/DELETE/OPTIONS`，预检直接 `204` |
| 3 | API 禁缓存 | `/api*` 统一 `no-store`，规避 express 默认 ETag 造成的 304 空响应（会导致前端轮询解析失败、角标不刷新） |
| 4 | 业务路由 | `express.Router()` 上的全部接口 |
| 5 | 旧指纹回退 | 按「逻辑名」把旧版资源请求改写到当前指纹路径，避免旧标签页 404 白屏 |
| 6 | `express.static` | 托管前端目录（`HEMA_STATIC=off` 时跳过） |
| 7 | 自解释 404 | 返回 `{ error, hint, availableApi }`，专门提示反代子路径与 `BASE_PATH` 不一致 |

**静态资源解析**（启动时执行一次，结果存入 `STATIC`）

```
resolveStatic()
  ├─ HEMA_STATIC=off/none/api → 不托管，仅 API
  ├─ findWebDir()             → STATIC_DIR / HEMA_WEB_DIR / web / ../web / cwd/web / /web / /app/web 依次探测
  ├─ HEMA_STATIC=web          → 直接托管源目录（未指纹化）
  ├─ HEMA_STATIC=auto（默认） → build.build({srcDir}) 构建到 dist/ 后托管；失败回落源目录
  └─ HEMA_STATIC=dist         → 托管已有 dist/；缺 index.html 时回落源目录
```

派生值：

- `FP_MAP`：逻辑路径 → 当前指纹路径，用于旧指纹回退。
- `BUILD_ID`：从 `dist/assets/js/app.<hash8>.js` 提取的 8 位哈希，经 `/api/ums/config` 下发给前端；前端与自身 `script` 标签里的哈希比对，不一致时角标提示「有新版本 · 点击刷新」。
- `staticHeaders(res, filePath)`：入口 HTML `no-store`；指纹资源 `immutable` 一年 + 强 ETag（ETag 即内容哈希）；其余 `no-cache`。

**UMS 取数模块**（同一文件内的独立段落）

| 函数 | 职责 |
|------|------|
| `umsUrl(startDate, endDate, index, num)` | 拼接口地址：固定参数 + `UMS_EXTRA_QUERY` + `index/num/startDate/endDate` |
| `umsCookie()` / `umsCookieBackup()` / `umsCookieCandidates(p, b)` | Cookie 读取：设置表优先、回退环境变量 `HEMA_UMS_COOKIE`；主 / 备用两份，`umsCookieCandidates` 用 `umsShuffle` 随机排序后依次尝试（摊薄单份 Cookie 的请求频次） |
| `umsDropAuthCookie(tag, cookie)` | 鉴权失效（登录态过期）时删除对应 Cookie 并记 `umsCookieAuth`（供页面提示重新同步），**直改库里已存的槽位，不动环境变量来源** |
| `umsNum()` / `umsClampInterval(v)` | 每页条数与自动间隔的取值钳制 |
| `umsAutoCfg()` | 自动获取设置：`{ enabled, intervalMin, timeStart, timeEnd }` |
| `umsRangeCfg()` | 取数条件：页面「开始/结束日期」持久化的日期区间，非法/未设回退当天；**单日区间已过期时顺延为当天**（服务端不依赖浏览器），多日区间原样使用（手动与自动共用） |
| `umsInTimeWindow(cfg)` | 按东八区判断是否在执行时段内（当天时间点，支持留空 = 全天） |
| `umsEdgeHit(cfg, st)` | 时段边界到点：返回 `'' / 'start' / 'end'`，用于在「开始 / 结束时刻」各额外强制取数一次（同一时刻只触发一次，见 `umsAutoState.edge`） |
| `umsEdgeNextMs(auto, st)` | 下一次「时段边界」时刻（ms，今天未执行且未过点）；用于让页面倒计时把边界取数也算进去 |
| `umsAutoState()` | 最近一次自动执行结果 + `failures` / `nextMin` / `nextAt` / `cfgInterval` / `edge` / `slot` |
| `umsAutoNextAt(auto, st, futureOnly)` | 排期：**网格基准是整点**（0 点起每 `intervalMin` 一个点），触发时刻 = 网格点 + 1 分钟，即恒为 `hh:(kN+1)`；时段只作范围过滤。`futureOnly` 排除当前点（执行后回写用） |
| `umsNextAtWithEdge(auto, st, futureOnly)` | 页面「下次取数」显示 / 排期用：取「下一个网格点」与「未执行的时段边界」中更早的一个（边界也是真实执行，必须进倒计时） |
| `umsSlotKey(auto)` | 当前分钟是否落在网格点上（返回东八区「日期:分钟数」），配合 `umsAutoState.slot` 做同分钟去重（轮询 5 秒、网格按分钟命中） |
| `umsMarkTry()` / `umsCooldownInfo()` | 取数冷却：记录尝试时间、返回剩余等待秒数 |
| `umsSleep(ms)` | 翻页之间的随机停顿 |
| `umsFetchAll(...)` | 逐页拉取：超时 `AbortController` → HTML 错误转可读文案 → 增量追平提前结束 → 翻页停顿；每页回调 `onProgress({ pages, totalPages, got, total })`（`totalPages = ceil(totalNum / num)`） |
| `umsRunFetchOnce(...)` / `umsRunFetch(..., src)` | 一次完整获取：翻页 → `compute.buildFromUms` → `saveBuilt`（`src` = `manual / auto / script`，用于给日志打来源角标） |
| `umsRunManualJob(...)` | 后台跑一次**手动**获取，结果写入内存 `UMS_MANUAL` 供页面轮询领取（见 [6.2](#62-实时获取三条路径同一入库口径)） |
| `umsRemember(state)` / `umsProgressInfo()` | 写「最近一次取数结果」/ 读内存取数进度（供 `umsConfigPayload().progress`） |
| `umsAutoTick()` | 自动获取定时任务（`setInterval` 5 秒检查一次排期） |

自动获取的排期（`umsAutoTick`，每 5 秒一轮）：

```
if (umsBusy) return                                 # 已有任务在跑：本轮跳过
if (!auto.enabled) return
if (!cookies.length) return                         # 未配置 Cookie
st = umsAutoState()
edge = umsEdgeHit(auto, st)                         # 时段开始 / 结束时刻（到点后 UMS_EDGE_WINDOW_MIN 分钟内有效）
if (!edge) {                                        # 边界取数不吃时段与排期
  if (!umsInTimeWindow(auto)) return                # 不在执行时段
  slot = umsSlotKey(auto)                           # 当前分钟是否落在网格点上
  if (slot && slot === st.slot) return              # 同一网格点只执行一次（防 5 秒轮询重复触发）
  if (Date.now() < umsAutoNextAt(auto, st)) return  # 未到排期时间
}
# 自动获取不看「取数冷却」：排期只由 nextAt 决定，不受手动 / 脚本取数影响
成功 → failures=0，nextAt = umsNextAtWithEdge(auto, st, true)，slot = 本次网格点，edge = 当天:边界
失败 → failures=1，同上（不累积退避；固定网格本身已足够分散请求），slot / edge 同上
```

> 排期**不含抖动、也不做指数退避**：触发时刻只由「整点网格 + 每 `intervalMin` 一分钟」决定，不受上次执行耗时影响、永不漂移；服务端判断与前端倒计时用的是同一个 `nextAt`。

**其它编排函数**：`currentMap()` / `currentIgnore()`（设置优先、回退默认值）、`dataZones()` / `zoneRows()`（分区清单）、`rebuildAll()`（设置变更后重算）、`withDate()`（出数范围，见 [7.3](#73-按日重算-withdate)）、`saveBuilt()`（上传与取数共用的入库决策，见 [7.1](#71-时间维度覆盖--新增)）。

**日志**：`logInfo(msg, src)` / `logWarn(msg, src)` 统一输出 `[YYYY-MM-DD HH:mm:ss] 内容`（东八区时间，`clockOf()` 用于标注「下次执行时间」）。日志只打在**关键动作**上，不打请求级日志（前端每 5 秒轮询一次配置，全量请求日志会淹没有用信息）：

| 分类 | 位置 | 内容 |
|------|------|------|
| 启动 | `app.listen` 回调 | 端口 / 子路径 / 静态目录 / 数据集数量 / 自动获取与 Cookie 状态 / 自绘字体来源 |
| `[上传]` | `/api/upload` | 文件名与大小（开始）、失败原因 |
| `[入库]` | `saveBuilt` | 新建 / 覆盖 / 增量并入的数据集 id 与新增、覆盖、有效明细条数（上传与取数共用） |
| `[取数]` | `/api/ums/fetch`、`/api/ums/agent/data`、`umsRunFetch` | 开始（区间 / 页数 / 增量或全量）、Cookie 选择与回退、鉴权失效删除、完成（页数、明细、新增、覆盖、数据集 id、耗时）、失败；被 409 / 429 拒绝的请求 |
| `[自动获取]` | `umsAutoTick` | 完成（明细、新增、覆盖、耗时、下次执行时刻）、失败（连续次数、下次执行时刻） |
| `[取数条件]` | `umsAutoTick` | 单日区间被顺延到当天时写回设置 |
| `[钉钉]` | 钉钉各接口与 `dingRunAuto` | 配置变更、图片落盘与 URL、定时推送开始 / 完成 / 失败、@全体成员发送失败 |
| `[设置]` | `/api/settings`、`/api/ums/config`、`/api/ding/config` | 映射与忽略项数、重算结果；Cookie（只记字符数，**不记原文**）、每页条数、自动获取开关与时段、钉钉开关与 @全体成员 |
| `[数据集]` | `DELETE /api/datasets/:id` | 删除的数据集 id 与移除条数 |
| `[静态资源]` | `resolveStatic` | 未找到前端目录 / 构建失败 / 缺 `dist` 等回落原因 |

第 2 个参数 `src`（`manual` / `auto` / `script`）只给**取数链路**的日志打来源：随日志一起进缓冲区、由 `GET /api/logs` 下发，页面「日志」弹窗据此在行首渲染彩色角标（手动=蓝 / 自动=绿 / 脚本=灰）；其余日志 `src` 为空、不显示角标。

日志同时写入内存环形缓冲（`LOG_MAX = 500` 条，写满丢弃最旧的），由 `GET /api/logs?limit=N` 提供给顶栏「日志」弹窗：默认 3 秒自动刷新、可切 100 / 200 / 500 行、`warn` 行标红、自动滚到最新一行。缓冲随进程重启清空（历史日志看 `server.log`）。

### 5.2 计算层 — [server/compute.js](./server/compute.js)

职责：**唯一口径实现**。xlsx / UMS 解析、明细清洗、全部统计聚合、增量合并。

对外导出：`buildFromBuffer`、`buildFromMatrix`、`buildFromUms`、`buildDataset`、`mergeInto`、`rebuild`、`jobType`、`zoneCode`。

**解析入口**

| 函数 | 说明 |
|------|------|
| `buildFromBuffer(buf, sourceFile, map, ignore)` | 解析 xlsx Buffer → `{ dataset, recs }`。`recs` 为**未过滤**原始明细（含被忽略分区），供改设置后重算 |
| `buildFromMatrix(matrix, meta, map)` | 校验必需列与时间列，逐行解析为 `recs`，统计 `dropped` / `otherStore`；`meta.ums` 为真时给每条明细打 `ums: true` 来源标记 |
| `buildFromUms(payload, meta, map, ignore)` | 实时接口解析：`umsItems()` 摊平多页并按 `id/code` 去重 → `umsRow()` 拼成与 xlsx 一致的表头矩阵 → 复用 `buildFromMatrix` |
| `mergeInto(oldRecs, built, prevMeta, ignore, opts)` | 增量合并（见 [7.2](#72-增量合并-mergeinto)） |
| `validateStartTime(matrix, col)` | 时间列校验：整列无可解析值 → 报错；非空单元格解析失败 → 报错并带行号；空单元格按「丢弃」 |
| `rebuild(recs, meta, map, ignore, date)` | 用新映射/忽略列表重算；`date` 非空时仅重算该日明细，但保留原完整日期集合 |

**`recs` 单条明细结构**（存储与增量合并的最小单元）

```
date      拣货开始日期 YYYY-MM-DD      hour/slot  整点小时 / 半小时刻度
t0m/t1m   当日 00:00 起的分钟数（工作时间图用）  hours      拣货时长(h)
jobType   作业类型（改映射后重算）       zone/orderType/code  分区原文 / 单类型 / 分区编码
no        拣货单号（增量合并去重的键）    person     拣货人
rows      拣货行数                     timeout/duty  是否超时 / 超时判责
ums       来源标记：仅实时接口/脚本来源的明细才有，用于「增量追平」判定
```

**统计工具**（纯函数，无副作用）

| 函数 | 用途 |
|------|------|
| `jobType(part, orderType, map)` | 作业类型判定：`拣打一体 → 一体化`，否则查映射，未命中 → `未匹配分区` |
| `splitIgnored(recs, ignore)` | 按**分区**排除忽略明细，返回 `{ recs, ignored }` |
| `dateSetOf(recs)` | 时间维度：全部明细的日期集合（**不受忽略分区影响**） |
| `isStoreOf(no)` | 门店鉴别：单号前缀是否为 `STORE_CODE` |
| `eff(h, t)` / `sum(rs)` | 效率 = Σ行数 ÷ Σ时长(h)（时长 0 返回 `null`） |
| `binAgg` / `quantile` / `stdOf` / `numsOf` | 分档、分位数、标准差等分布统计 |
| `unweightedFromGroups(groups, n)` | 「人均」口径序列：各人效率的算术平均 |
| `stabilityList(groups)` | 稳定性榜：取每人记录最多的作业类型算变异系数（cv） |
| `paretoTop(desc, total, frac)` | 行数集中度（帕累托） |

**构建函数**

| 函数 | 产出 |
|------|------|
| `buildDataset(recs, meta)` | 单份数据集的完整结果对象（见下） |
| `buildTimeline(recs)` | 人员工作时间图：按「人 × 日期」合并区间为作业段，输出在岗率、最大空档等 |
| `groupStat(persons)` | 组内平均/中位数效率及最接近的人员（透视表标注） |
| `buildStats(recs, groups, byPerson, H)` | 人员效率分布、分档、稳定性、箱线图、行数统计与集中度 |
| `buildBoxplot(groups)` | 箱线图数据（整体 + 各作业类型，样本 < 2 人的组不画） |

**`buildDataset` 返回结构**（前端渲染的数据契约）

```
meta           { sourceFile, dates[], date, hours[], period, recordCount, dropped, ignored, otherStore }
totals         { rows, hours, eff, persons, jobTypes }
byJobType[]    { name, rows, hours, eff }              // 作业类型汇总
byPerson[]     { name, rows, hours, eff }              // 人员汇总
byHour[]       { hour, rows, hours, eff }              // 整点小时汇总
byZone[]       { type, zone, code, rows, hours, eff, avg, share }  // 作业类型 × 分区明细
jobTypeByHour  { hours, series[], total[], unweighted }  // 作业类型 × 小时图（含双口径）
zoneByHour     { hours, series[] }                     // 分区 × 小时效率
bySlot[]       { slot, rows, hours, eff }              // 半小时刻度汇总
jobTypeBySlot  { slots, series[], total[], groups, unweighted }
personByHour   { hours, rows[], groups[] }             // 人员透视（分块 + 小计 + stat）
stats          { personMean, personDist, effBins, stability, boxplot, rowsStat, rowsTop, rowsBins }
timeline       { mergeGap, rows[] }                    // 人员工作时间图（段 + 行级指标）
timeout        { total, hours, duties[], types[], byPerson[], hourly[], series[], typeSeries[] } | null
```

### 5.3 存储层 — [server/db.js](./server/db.js)

职责：SQLite 读写。库文件 `server/data/hema.db`，可用 `HEMA_DB_PATH` 覆盖（测试用临时库）。启动时建表并为旧库补列 `recs` / `ignored` / `other_store`。

导出函数分组：

- **数据集 CRUD**：`insert`、`overwrite`、`list`（不含 `payload`）、`get`、`latest`、`remove`、`count`
- **时间维度匹配**：`findByDates(dates)`（`timeKey` 规范化后比较，同维度多条取最新）、`findByOverlap(dates)`（增量只取到部分日期时并入日期有交集的最新一条）
- **重算支持**：`rebuildTargets()`（`recs` + meta 字段，并固化旧格式 `sub → orderType` 迁移）、`withoutRecs()`、`recsOf(id)`、`saveRecs`、`updatePayload`
- **增量追平**：`knownPickNos()`（返回已入库拣货单号 `Set`，只统计 `rec.ums && rec.no`；模块内 `knownCache` 缓存，任意写操作置空，避免翻页时反复解析全部明细）
- **键值设置**：`getSetting` / `setSetting`（JSON 序列化，`ON CONFLICT` upsert）

### 5.4 配置层 — [server/config.js](./server/config.js)

| 分组 | 常量 |
|------|------|
| 口径 | `UNIT`、`JOB_TYPES`、`UNMATCHED_TYPE`、`DEFAULT_FRONT_BACK_MAP`（8 项）、`INTEGRATED_ORDER_TYPE`、`TIME_COLUMN`、`QTY_COLUMN` / `QTY_FIELD` |
| 超时 | `TIMEOUT_COLUMN`、`TIMEOUT_YES`、`TIMEOUT_DUTY_COLUMN`、`TIMEOUT_NO_DUTY`、`UMS_DUTY_MAP`（接口英文编码 → 中文判责） |
| 上传 | `STORE_CODE`、`REQUIRED_COLUMNS` |
| 设置键名 | `MAPPING_KEY`、`IGNORE_KEY` |
| UMS 接口 | `UMS_URL`、`UMS_PAGE_SIZE`、`UMS_NUM_CHOICES`、`UMS_EXTRA_QUERY`、`UMS_TIMEOUT_MS`、`UMS_MAX_PAGES` |
| 自动获取 | `UMS_AUTO_MIN_INTERVAL`、`UMS_AUTO_MAX_INTERVAL`、`UMS_EDGE_WINDOW_MIN`、`UMS_MANUAL_LOCK_SEC`（120）、`UMS_AUTO_KEY`、`UMS_AUTO_STATE_KEY`、`UMS_AGENT_STATE_KEY` |
| 防风控 | `UMS_PAGE_GAP_MIN_MS` / `UMS_PAGE_GAP_MAX_MS`（300 / 900）、`UMS_FETCH_COOLDOWN_SEC`（60）；`UMS_INTERVAL_JITTER`（0.15）/ `UMS_BACKOFF_MAX_MIN`（60）为**历史遗留，当前未使用**（排期已改为固定网格、不再抖动 / 退避） |
| 设置表键名 | `UMS_COOKIE_KEY`、`UMS_COOKIE_BACKUP_KEY`（备用 Cookie）、`UMS_COOKIE_AUTH_KEY`（最近一次鉴权失效被删记录）、`UMS_LAST_KEY`、`UMS_LAST_TRY_KEY`、`UMS_NUM_KEY`、`UMS_RANGE_KEY` |
| 钉钉推送 | `DING_WEBHOOK_KEY`、`DING_SECRET_KEY`（加签）、`DING_PUBLIC_BASE_KEY`（图片公网地址）、`DING_AUTO_KEY`、`DING_AUTO_STATE_KEY`、`DING_AT_ALL_KEY`（@全体成员，未设=开）、`DING_PUSH_DELAY_MIN`（1）、`DING_PUSH_MAX_RETRY`（2） |

映射的实际取值存于设置表，此处仅为**首次运行**的默认值。

### 5.5 构建层 — [server/build.js](./server/build.js)

`build({ srcDir, outDir })` 三轮扫描，整目录重建：

1. **叶子资源**（图片/字体/JS）→ 按内容 `sha256` 前 8 位插入文件名；
2. **CSS** → 先把内部 `url()` 改写为指纹路径，再对改写后内容算哈希；
3. **HTML** → 改写 `href/src/poster/data-src` 引用后**原样输出**（文件名不变，靠 HTTP 头禁缓存）。

产出 `dist/`（指纹资源 + `index.html` + `manifest.json`），返回 `{ srcDir, outDir, entry, map, files }`。外链、锚点、`data:`、协议相对地址、越出 `web/` 的引用一律不改写。

### 5.6 前端 — web/

`web/assets/js/`（按引入顺序）：

- **config.js**：[web/assets/js/config.js](./web/assets/js/config.js) 定义 `window.HEMA_CONFIG`（`UNIT` / `COLORS` / `API_BASE`）。`API_BASE` 按 `location.hostname` 自动选择：`localhost`/`127.0.0.1` → 本机 `:3001`；IP → 固定 IP 后端；域名 → `https://api.yjmc.xyz/hpe/api`。
- **charts.js**：[web/assets/js/charts.js](./web/assets/js/charts.js) 导出 `HEMA.charts.render(data)` / `HEMA.charts.resize()` / `HEMA.charts.setWeighted(v)`。内部以 `instances` 缓存并复用 ECharts 实例，`cache` 保存最近数据以便切换双口径时无需重新拉数；监听 `resize` 自适应。
- **app.js**：[web/assets/js/app.js](./web/assets/js/app.js) 视图逻辑主体，`(function(window){ ... })(window)` IIFE，挂 `HEMA` 命名空间。

**app.js 模块划分**（按文件中的 `/* ---------- */` 段落）

| 段落 | 关键函数 | 职责 |
|------|---------|------|
| 基础工具 | `readJson` / `esc` / `fmt` / `notice` | 请求、转义、格式化、顶部提示 |
| KPI | `renderKpis` / `kpiCard` / `personMean` | 顶部 KPI 卡与次级规模指标 |
| 表格排序 | `sortState` / `theadHtml` / `bindSort` | 所有表格表头点击升/降序（空值恒末尾） |
| 人员透视 | `renderPivotBlocks` / `heatColor` / `collapsedSet` | 按作业类型分 3 块的 人员×小时 透视，可折叠并记忆 |
| 明细表 | `renderZoneTable` / `renderPersonTable` | 拣货分区效率、人员效率明细 |
| 超时 | `renderTimeoutPerson` / 超时 × 分区 | 超时卡片的两种细分视角 |
| 分布与行数 | `renderDist` / `renderRowsStat` | 效率分布箱线图、分档、稳定性榜、行数 TOP/分档/集中度 |
| 工作时间 | `renderTimeline` / `clockOf` | 人员工作时间图与班次明细表 |
| 顶栏品牌 | `renderPeriod` / `renderSource` / `renderDates` | 统计时间段、来源/有效明细、日期下拉 |
| 总渲染 | `render(d)` / `clearView(errMsg, latestMeta)` | 渲染全部卡片 / 清空视图 |
| 历史数据集 | `selHtml` / `syncHistory` / `renderHistoryMenu` / `refetch` / `loadHistory` / `pickHistory` | 顶栏与门禁同款自定义下拉 |
| 上传 | `upload(file)` | POST xlsx 原始字节 |
| **实时获取** | `umsRun` / `umsManualPaint` / `umsChipPaint` / `umsAutoPaint` / `umsAutoCountdown` / `umsLoadCfg` / `umsSaveCfg` / `umsSaveRange` / `umsDateSync` / `umsLoadCookie` / `umsAfterImport` / `umsApplyServerFetch` | 顶栏角标与「手动获取」按钮、取数弹窗、自动获取设置、取数日期（默认当天，跨 0 点自动翻新）、冷却与倒计时（自动获取前 2 分钟 + 钉钉推送倒计时）、后台新数据自动刷新视图 |
| **钉钉推送** | `dingOpen` / `dingLoadCfg` / `dingPaint` / `dingSave` / `dingTest` / `dingAutoRun` | 钉钉设置弹窗：Webhook / 加签 / 公网地址、定时推送开关与 @全体成员开关、测试推送、「立即执行一次」并轮询结果 |
| 日志查看 | `logsLoad` / `openLogs` / `closeLogs` | 服务端环形缓冲日志弹窗：来源角标、`warn` 标红、自动刷新 |
| 数据管理 | `renderDmTable` / `loadDataMgr` / `deleteDatasets` / `clearDatasets` / `switchDataset` / `askConfirm` | 弹窗内查看/切换/删除/清空 + 页内二次确认 |
| 分区设置 | `renderZoneCfg` / `loadZoneCfg` / `zcAdd` / `saveZoneCfg` | 维护映射与忽略分区，保存并重算 |
| 门禁 | `todayStr` / `syncGate` / `playGateOut` / `playDashIn` | 「今日暂无数据」遮罩与入场动画 |
| 卡片工具 | `injectCardTools` / `captureCard` / `exportPng` / `copyPng` / `runCapture` | html2canvas 导出/复制图片（透视卡可按分类选范围） |
| 启动 | 底部末尾 | 拉数据集 → 判定含今天的数据集 → `refetch` 或 `clearView` + 遮罩 |

前端轮询约定：角标与手动获取按钮每 1 秒重绘（倒计时走动），每 5 秒 `umsLoadCfg()` 拉一次 `/api/ums/config` 同步后台状态（自动获取结果、冷却剩余、钉钉推送时刻、构建版本）；**取数进行中改为每秒轮询**，据 `progress`（`pages` / `totalPages`）在弹窗与顶栏显示「第 x / N 页」（`totalPages` 来自接口 `totalNum ÷ num`，拿到第一页即确定）。

### 5.7 自绘层 — [server/render.js](./server/render.js)

职责：把数据集 `payload` 里的 `personByHour`（人员 × 小时透视）**自绘成 PNG**，供钉钉推送。**不依赖浏览器**（原方案用 puppeteer 截图：小服务器上启动慢、吃内存，已整体替换）。

- 入口 `renderPivot(dataset, opts)`：按 `PIVOT_ORDER`（前场 / 后场 / 一体化）逐块拼 SVG → `@resvg/resvg-js` 光栅化为 PNG；返回 `{ period, blocks: [{ name, image(dataURL), eff, avg, median, bytes }] }`。
- 视觉与前端对齐：分块标识色、热力色阶 `HEAT_STOPS`、达标线 `TARGETS`（后场 260 行/h）、圆角表格 + `clipPath` 裁剪、平滑折线（Catmull-Rom → 三次贝塞尔）+ 面积 + 达标虚线、平均值 / 中位数所在行的浅蓝 / 浅紫边框与白底角标（角标最后绘制、压在边框之上，对应页面 `.stat-badge` 的 `z-index`）、底部口径说明。
- `blockSvg()` 只用字符串拼 SVG；Node 侧量不到文本宽度，`textW()` 按「全角 1em / 数字 0.56em / 其它 0.6em」估宽，`wrapText()` 逐字折行；折线 `smoothPath()` 用 Catmull-Rom 转贝塞尔，逼近 ECharts `smooth: true`。
- 字体：默认加载系统字体；容器缺中文字体时用 `HEMA_SVG_FONT_FILE` / `HEMA_SVG_FONT_DIR` / `HEMA_SVG_FONT` 兜底（见 [10](#10-环境变量与部署)）。`fontInfo()` 在启动日志里打印字体来源与「指定路径是否存在」，便于排查容器重建后字体丢失。
- 依赖不可用时 `available()` 为 `false`、`unavailableReason()` 给出可读原因，钉钉推送会跳过并提示（配置接口下发 `renderOk` / `renderError`）。
- 出图倍率 `HEMA_SVG_SCALE`（默认 2），越大越清晰、越占内存。

---

## 6. 数据流

### 6.1 上传（写入）

```
用户选 xlsx → upload(file)
  → POST /api/upload?name=xxx.xlsx   （raw body，上限 100MB）
    → compute.buildFromBuffer(buf, name, currentMap(), currentIgnore())
        ├─ XLSX.read → 取工作表 data（缺失取第一个）→ sheet_to_json 矩阵
        ├─ buildFromMatrix：校验列 → 逐行解析 → recs[] + dropped + otherStore
        ├─ splitIgnored(recs, ignore)：排除忽略分区，记 ignored
        └─ buildDataset(kept, meta)：算全部口径 → dataset
    → saveBuilt(built)
        ├─ db.findByDates(dataset.meta.dates) 命中 → db.overwrite(id, …)（保留原 id）
        └─ 未命中 → db.insert(dataset, recs)
  → 响应 { id, mode: 'create'|'overwrite', ...dataset }
→ 前端 refetch(id) → render(dataset)
```

### 6.2 实时获取（三条路径，同一入库口径）

```
路径 A：服务端带 Cookie（手动）
  POST /api/ums/fetch { startDate, endDate, incremental }
    → 互斥（umsBusy 409）→ 手动锁（自动获取点前 / 成功后 UMS_MANUAL_LOCK_SEC 内 429）
    → 冷却检查（429）→ 立即 202 返回 { started }
    → 后台 umsRunManualJob → umsRunFetch(..., 'manual')
    → 前端轮询 /api/ums/config 看 progress，完成后轮询 /api/ums/result 领结果

路径 B：服务端带 Cookie（自动）
  setInterval(umsAutoTick, 5s) → umsRunFetch(..., 'auto')（见 6.3）

路径 C：油猴脚本（同源取数，后端无需 Cookie）
  UMS 页面内 fetch/GM_xmlhttpRequest 逐页取数
    → POST /api/ums/known { codes }        （判定是否已追平，可选）
    → POST /api/ums/agent/data { pages }   → buildFromUms → saveBuilt（同 A/B）
    → POST /api/ums/config { cookie }      （顺带把读到的 Cookie 存到服务端，供 A/B 使用）

三条路径内部都是：
  umsRunFetch：主 / 备用 Cookie 随机排序 → 逐个尝试（鉴权失效 / 风控自动回退）
    → umsFetchAll：逐页 umsUrl(index) fetch → 去重 → 增量追平提前结束 → 翻页停顿
    → compute.buildFromUms(pages, meta, map, ignore)
    → saveBuilt(built, { merge: incremental, replaceDates: complete ? dates : null, src })
```

三条路径最终都调用 `saveBuilt`，因此**覆盖 / 增量合并规则完全一致**；只有日志来源角标（`src`）不同。

> 手动获取为什么改成「启动即返回 + 轮询领结果」：全量取数页数多、耗时长，长连接挂着等结果容易被中间层掐断，出现「前端报 Failed to fetch，但后端其实已成功入库」。

### 6.3 自动获取排期

```
setInterval(umsAutoTick, 5s)
  → 互斥（umsBusy）→ 读配置与状态
  → 边界判断（umsEdgeHit：时段开始 / 结束时刻额外取一次）
  → 时段判断 → 网格点去重（umsSlotKey vs umsAutoState.slot）→ 排期判断（now >= umsAutoNextAt）
  → umsRangeCfg() 取页面「取数条件」的日期区间（未设置则当天）
  → umsRunFetch(开始日期, 结束日期, incremental = true, 'auto')
  → 写回 umsAutoState：{ at, ok, error, records, added, failures, nextMin, nextAt, cfgInterval, edge, slot }
  → afterFetchSuccess：本次有新增 / 覆盖 → 延迟 DING_PUSH_DELAY_MIN 分钟自动推送（见 7.10）
```

排期网格 = **整点起每 `intervalMin` 分钟一个点，触发时刻再 +1 分钟**（恒为 `hh:(kN+1)`），与「时段开始」的分钟无关，时段只作范围过滤。`nextAt` 取「下一个网格点」与「未执行的时段边界」中更早的一个 —— 这样服务端判断与前端倒计时用的是同一个时间点，边界取数也会先走完倒计时。

`edge` 记录当天已执行的时段边界（`当天:start` / `当天:end`）：边界这一跳**不吃时段与间隔排期**（结束时刻正好在时段外），但仍受 `umsBusy` 约束；到点后 `UMS_EDGE_WINDOW_MIN` 分钟内允许补执行一次。`slot` 记录最近执行的常规网格点（东八区「日期:分钟数」），保证同一分钟只执行一次（轮询 5 秒、网格按分钟命中）。

自动获取**不看取数冷却**（排期只由 `nextAt` 决定，不受手动 / 脚本取数影响）；反过来，手动获取在「自动获取点前」或「自动获取成功后」`UMS_MANUAL_LOCK_SEC`（120 秒）内会被拒绝（尾段从**成功时刻**起算）。

### 6.4 读取（展示）

```
启动 → GET /api/datasets（列表，按 id 倒序）
  ├─ 命中「日期集合含今天」的数据集 → refetch(id) → GET /api/datasets/:id → render
  └─ 未命中 → loadHistory(null, list) + clearView('', 最新一条的 meta) → syncGate 显示遮罩

切换数据集 / 切日期 → GET /api/datasets/:id?date=YYYY-MM-DD
  服务端 withDate()：按 date 过滤后用 recs 重算再返回
前端 render(d)：
  ├─ charts.render(d)       → 全部 ECharts 图
  ├─ renderKpis / renderPivotBlocks / renderZoneTable / renderPersonTable ...
  └─ syncGate(d)            → 依 meta.dates 是否含今天决定遮罩显隐
```

### 6.5 设置变更（重算）

```
分区设置弹窗 → saveZoneCfg()
  → POST /api/settings { map, ignore }
     → 校验（作业类型必须在 JOB_TYPES 内，ignore 必须为数组）
     → db.setSetting(MAPPING_KEY / IGNORE_KEY, ...)
     → rebuildAll(map, ignore)
         → 逐条 db.rebuildTargets() → compute.rebuild(recs, meta, map, ignore)
         → db.updatePayload(id, dataset)
     → 响应 { ok, updated[], skipped[], failed[] }
  → 前端刷新当前数据集
```

---

## 7. 关键机制

### 7.1 时间维度：覆盖 / 新增

时间维度 = 明细的「拣货开始时间」日期集合，规范化（去重 + 排序 + 逗号拼接）后作为数据集标识。`saveBuilt` 的决策顺序：

1. `opts.merge` 为真（实时增量）→ 先按同维度命中，否则按**日期有交集**的最新一条作为并入目标；并入后若无任何新增/替换则直接返回，不写库；
2. 否则：命中同维度 → `db.overwrite`（**保留原 id**，前端选中态与引用不变）；未命中 → `db.insert` 新增。

> 之所以用「全部明细」的日期集合而非过滤后的，是为了避免某天明细全被忽略时维度变化，导致重传同一文件被判为新数据集而重复入库。

### 7.2 增量合并 `mergeInto`

```
键 = 拣货单号 + 拣货分区（同一单跨分区会导出为多行，单号单独作键会误合并）
```

- `opts.replaceDates`（整段抓取完整时的日期集合）：这些日期的**旧明细整条替换**并计入 `replaced` —— 手动上传的旧数据没有单号，无法按键合并，留着会与新抓到的同一单重复计数；
- 其余旧明细按键去重保留，新明细按键覆盖同键旧行或追加，追加计入 `added`；
- 旧明细被整条替换后，`meta.sourceFile` 改为本次实时接口来源；
- `dropped` / `otherStore` 在合并时按「旧 + 新」累加。

### 7.3 按日重算 `withDate`

展示范围默认只取数据集内**最新一天**（隔天不显示前天），其余日期由顶栏日期下拉手动选择：

- `meta.dates` 始终是**完整**日期集合（下拉用），`meta.date` 为本次实际展示日期；
- 有原始明细的数据集一律按**最新口径重算后再返回**（库里 `payload` 是上传时算好的旧版，直接返回会缺后加字段）；
- 缺原始明细的旧数据集或重算失败时，退回原 `payload`，仅补 `meta.date`。

### 7.4 门禁遮罩（今日暂无数据）

`syncGate(d, errMsg)` 依 `d.meta.dates` 是否含**今天**决定遮罩显隐：

- 启动时若没有任何含今天的数据集 → 显示遮罩（`clearView` 清空 DOM/图表，不后台渲染最近一天数据）；
- `gateDismissed`：本次访问是否已手动关闭——用户**主动导入**或**手动选择**历史数据集后置位，`syncGate` 直接隐藏；
- `introPending`：是否播放「导入成功」入场动画（仅当遮罩原本可见 **且** 新数据含今天）。

### 7.5 双效率口径

| 口径 | 计算 | 默认 |
|------|------|------|
| 按工时加权 | Σ拣货行数 ÷ Σ拣货时长(h) | ✅ |
| 人均 | 各人效率的算术平均（忽略该时段无记录的人） | |

顶栏 `weightedToggle` 切换，`HEMA.charts.setWeighted(v)` 统一切换所有**聚合**效率（KPI 卡、透视分块含小计/整体、细分与人员表合计行、两张趋势图）。**人员级**数字（各人自身效率、效率分布卡、稳定性榜、工作时间图）不受开关影响。

### 7.6 明细的四种归宿

| 状态 | 判定 | 处理 |
|------|------|------|
| 有效 | 默认 | 参与全部统计 |
| 已忽略 | 拣货分区在「忽略分区」列表 | 完全排除出统计，仅记 `meta.ignored`，明细仍存库 |
| 丢弃 | 缺拣货人、缺时间或时长非正 | 记 `meta.dropped` |
| 其它门店 | 拣货单号前缀不是 `STORE_CODE=20005` | 整行排除，记 `meta.otherStore` |

> 忽略判定按**分区**进行，先于作业类型判定，因此「拣打一体」的被忽略分区不会混入「一体化」；取消忽略后重算即可恢复。

### 7.7 工作时间图合并规则

每笔拣货按真实起止时间 `[t0m, t1m]`（当日 00:00 起的分钟数）取区间；上一笔结束到下一笔开始间隔 ≤ `TIMELINE_MERGE_GAP = 2` 分钟视为连续作业并合并（重叠亦接续）。色块宽度 = 真实段长；在岗率 = Σ段长 ÷ (末段结束 − 首段开始)。

### 7.8 防风控

| 措施 | 实现位置 | 行为 |
|------|---------|------|
| 翻页停顿 | `umsFetchAll` | 每页之间随机 `UMS_PAGE_GAP_MIN_MS ~ UMS_PAGE_GAP_MAX_MS`（300~900ms） |
| 固定网格排期 | `umsAutoNextAt` | 触发时刻固定为「整点 + 每 `intervalMin` + 1 分钟」，不随上次执行时刻漂移、也不加抖动（原 `UMS_INTERVAL_JITTER` / 退避已废用） |
| 主 / 备用 Cookie 轮换 | `umsRunFetch` | 每次随机决定先用哪份；鉴权失效自动删除该份，风控则改用下一份重试（成功记「已回退」） |
| 取数冷却 | `umsMarkTry()` / `umsCooldownInfo()` | 手动、自动、脚本同步**共用**同一窗口：距上次**尝试**不足 `UMS_FETCH_COOLDOWN_SEC`（60 秒）则拒绝（手动接口返回 429） |
| 手动错峰锁 | `/api/ums/fetch` | 自动获取点前 / 成功后的 `UMS_MANUAL_LOCK_SEC`（120 秒）内拒绝手动获取，避免同一时刻两次取数 |

`umsMarkTry()` 的调用点：`umsFetchAll`（覆盖手动 + 自动）与 `/api/ums/agent/data`（脚本同步）。因此「自动刚跑过」时前端的「手动获取」按钮会同步进入冷却并显示 `冷却 N 秒`。

> **自动获取本身不受冷却约束**（排期只由 `nextAt` 决定），冷却与错峰锁主要约束手动 / 脚本两条路径。

### 7.9 缓存分层与版本提示

| 资源 | 响应头 | 效果 |
|------|--------|------|
| `index.html` | `no-store` | 每次回源，永远拿到最新 HTML 与最新指纹路径 |
| `name.<hash8>.ext` | `public, max-age=31536000, immutable` + 强 ETag | 内容没变零请求；一变文件名即变 |
| 其它（`manifest.json`） | `no-cache` | 可缓存但每次协商 |
| `/api*` | `no-store` | 规避 express 默认 ETag 的 304 空响应 |

`HEMA_STATIC=web`（源目录）下即使没有指纹文件，`staticHeaders` 也会退回协商缓存，保证「改完即生效」。
后端 `BUILD_ID` 与前端脚本文件名哈希不一致时，顶栏角标显示「有新版本 · 点击刷新」，避免旧 JS 配新数据造成显示不符。

### 7.10 钉钉定时推送

目标：**不用浏览器常开**，把「人员 × 小时」效率透视表定时发到钉钉群。

```
自动获取成功（有新增 / 覆盖）
  → afterFetchSuccess：setDingPushTimer(fn, DING_PUSH_DELAY_MIN × 60s)   # 多次取数只保留最后一次排期
  → dingRunAuto(reason)：
       dingRender.renderPivot(db.latest())            # 自绘 3 块 PNG（见 5.7）
       → 逐块落盘 + 拼 markdown（@全体成员 + 统计时间段 + 每块「图片 + 效率 / 平均值 / 中位数」）
       → （开关开时）先发一条 text 消息 @全体成员
       → dingPostMarkdown 发带图 markdown
  → 失败自动重试 DING_PUSH_MAX_RETRY（2）次，每次再等 DING_PUSH_DELAY_MIN 分钟
```

**图片与 URL**

- 落盘目录 `HEMA_DING_DIR`（默认 `server/data/ding`）；文件名 = 东八区 `YYYYMMDD-HHmmss` + 类型后缀（前场 `A` / 后场 `P` / 一体化不加），例：`20261014-063345_A.png`。时间精确到秒（避免同一分钟内两次推送撞名），同名**直接覆盖**。
- 对外 URL = `公网地址 + HEMA_DING_URL_PREFIX + /<文件名>`。前缀默认走本服务只读路由 `<BASE_PATH>/api/ding/img`（响应头 `immutable` 一年）；把目录挂到 nginx 站点目录时设 `HEMA_DING_URL_PREFIX=/xxx`，由 nginx 直接静态托管（便于接 CDN）。域名由「公网地址」决定。
- 钉钉自定义机器人**不支持图片消息**，只能给 markdown 嵌一个公网可访问的图片 URL，由钉钉客户端去拉 —— 所以公网地址必须配置正确。

**@全体成员（重要）**

- 钉钉自定义机器人的 **markdown 消息不支持标准 `at` 元数据**：写在 markdown 里的 `@全体成员` 只会被当纯文本渲染、**不产生提醒**。
- 因此 @ 必须**单独发一条 `text` 消息**（`at: { isAtAll: true }`），markdown 正文里仍保留 `@全体成员` 文案；可用页面「钉钉推送 → 定时推送 → @全体成员」开关（`dingAtAll`，默认开）关闭。@ 那条发送失败只记日志，不影响正文推送。
- 若钉钉群开启了「仅群主和群管理员可@所有人」，机器人 @全员会不生效 / 被拒，需在群设置里关掉。

**接口**：`GET /api/ding/config` 下发 `webhookSet / webhookMask / secretSet / secretMask / publicBase / atAll / auto{ enabled, delayMin, maxRetry, state } / renderOk / renderError`；`POST /api/ding/config` 保存（Webhook / 密钥传空串 = 清除，留空 = 不修改；`atAll` 为布尔）。已排期的推送时刻 `dingPushAt` 经 `/api/ums/config` 下发给顶栏，用于「N 秒后推送」倒计时。

---

## 8. API 接口

均以 `/api` 为前缀（配置 `BASE_PATH` 时前面拼接子路径）。

**数据集与设置**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查：数据集数量、`basePath`、静态托管方式与 `features`（接口能力自检） |
| GET | `/api/logs?limit=N` | 服务端最近日志（内存环形缓冲，最多 500 条）：`{ total, max, lines[{ at, level, msg, src }] }`（`src` = `manual / auto / script`，取数链路才有） |
| POST | `/api/upload?name=文件名.xlsx` | 上传拣货单（raw body，≤100MB；文件名也可用 `x-filename` 头）。返回 `{ id, mode, added, replaced, ...dataset }` |
| GET | `/api/datasets` | 数据集列表（不含 `payload`） |
| GET | `/api/latest?date=YYYY-MM-DD` | 最新数据集完整结果（无数据 404） |
| GET | `/api/datasets/:id?date=YYYY-MM-DD` | 指定数据集完整结果 |
| GET | `/api/range?from&to&bucket` | 周 / 月视图：汇总区间内所有数据集的明细后重算；`bucket=week` 按自然周分桶（月视图），否则按日期分桶（周视图） |
| GET | `/api/day?date=YYYY-MM-DD` | 单日视图：跨数据集按日期定位并返回该日结果 |
| DELETE | `/api/datasets/:id` | 删除数据集，返回 `{ removed }` |
| GET | `/api/settings` | 读取 `map` / `ignore` / `jobTypes` / `unmatched` / `zones` |
| POST | `/api/settings` | 保存映射与忽略列表并重算全部历史数据集，返回 `{ ok, map, ignore, updated, skipped, failed }` |

**实时获取（UMS）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ums/config` | 页面全量状态：`cookieSet` / `cookieBackupSet` / `build` / `num` / `numChoices` / `range` / `auto`（含 `nextAt` / `slot` / `edge`）/ `agent` / `lastFetch` / `progress` / `cooldown` / `cookieAuth` / `manualLockSec` / `dingPushAt` / `manual` |
| GET | `/api/ums/cookie` | 已保存的 Cookie 原文（仅在展开「Cookie 设置」时调用） |
| POST | `/api/ums/config` | 保存 Cookie（主 / 备用）/ 每页条数 / 取数条件（日期区间）/ 自动获取设置，返回最新配置 |
| POST | `/api/ums/fetch` | **启动**一次手动取数并立即 202 返回（后台跑）；冷却 429、任务进行中 409、自动获取错峰锁 429 |
| GET | `/api/ums/result` | 领取最近一次手动取数结果（前端轮询，任务完成后取完整结果） |
| POST | `/api/ums/agent/data` | 脚本回传逐页结果入库 |
| POST | `/api/ums/known` | 判定这批单号已入库多少条 → `{ known, total }` |

**钉钉推送**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ding/config` | `webhookSet` / `webhookMask` / `secretSet` / `secretMask` / `publicBase` / `atAll` / `auto{ enabled, delayMin, maxRetry, state }` / `renderOk` / `renderError` |
| POST | `/api/ding/config` | 保存 Webhook / 加签密钥 / 公网地址 / 定时推送开关 / @全体成员开关，返回最新配置 |
| POST | `/api/ding/push` | 手动推送：接收前端截好的图（结构化 `{ title, period, blocks[{ name, image, eff, avg, median }] }` 或单图 `{ image, title }`）→ 落盘 → 发 markdown 到群 |
| POST | `/api/ding/auto/run` | 「立即执行一次」：后台自绘最新数据集并推送（已有推送在跑时 409） |
| GET | `/api/ding/img/:file` | 图片公开只读：文件名限 `时间戳[_后缀].(png\|jpg)`，响应头 `immutable` 一年（供钉钉客户端与 CDN 拉取） |

错误响应统一为 `{ error: string }`；404 兜底额外带 `hint` 与 `availableApi`。`POST /api/settings` 的 `map` 值非法或 `ignore` 非数组均返回 400。

---

## 9. 数据模型

### datasets（数据集）

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | INTEGER PK AUTOINCREMENT | 数据集 id |
| `source_file` | TEXT | 源文件名 / 「实时接口 …」「浏览器脚本 …」 |
| `dates` | TEXT | 时间维度（逗号拼接的日期集合） |
| `record_count` | INTEGER | 有效明细条数 |
| `dropped` | INTEGER | 丢弃条数 |
| `ignored` | INTEGER | 已忽略条数（旧库后补列） |
| `other_store` | INTEGER | 其它门店条数（旧库后补列） |
| `eff` | REAL | 综合效率（列表展示用） |
| `payload` | TEXT NOT NULL | 整份计算结果的 JSON |
| `recs` | TEXT | 原始明细 JSON，用于改设置后重算与增量合并（旧库后补列） |
| `created_at` | TEXT NOT NULL | ISO 时间；索引 `idx_datasets_created(created_at DESC)` |

### settings（键值设置）

| 列 | 类型 | 说明 |
|----|------|------|
| `key` | TEXT PK | 键名 |
| `value` | TEXT NOT NULL | JSON 序列化值 |
| `updated_at` | TEXT NOT NULL | ISO 时间 |

现用键名：

| 键 | 内容 |
|----|------|
| `frontBackMap` | 拣货分区 → 前后场分区（作业类型） |
| `ignoreZones` | 忽略分区列表 |
| `umsCookie` / `umsCookieBackup` | 实时接口主 Cookie / 备用 Cookie（页面或脚本同步写入，鉴权失效时自动删除对应槽位） |
| `umsCookieAuth` | 最近一次「Cookie 鉴权失效被删除」的记录 `{ at, tag }`，供页面提示重新同步 |
| `umsNum` | 每页条数（50 / 100 / 200） |
| `umsRange` | 取数条件 `{ startDate, endDate }`（页面「开始/结束日期」，手动与自动共用的日期区间） |
| `umsAuto` | 自动获取设置 `{ enabled, intervalMin, timeStart, timeEnd }` |
| `umsAutoState` | 最近一次自动执行结果 + `failures` / `nextMin` / `nextAt` / `cfgInterval` / `edge`（当天已执行的时段边界）/ `slot`（最近执行的网格点，防重复触发） |
| `umsAgentState` | 油猴脚本最近一次同步结果 |
| `umsLastFetch` | 最近一次取数结果（角标展示） |
| `umsLastTryAt` | 最近一次取数**尝试**时间（冷却窗口起点） |
| `dingWebhook` / `dingSecret` | 钉钉机器人 Webhook / 加签密钥 |
| `dingPublicBase` | 图片对外公网地址（如 `https://zh.yjmc.xyz`），留空则按请求 Host 推断 |
| `dingAuto` | 定时推送开关 `{ enabled }`（触发时机 = 取数成功后延迟，不按间隔） |
| `dingAutoState` | 最近一次自动推送结果 `{ at, ok, error, reason, count }` |
| `dingAtAll` | 推送正文是否 @全体成员（未设置 = 开） |

---

## 10. 环境变量与部署

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3001` | 监听端口 |
| `BASE_PATH` | 空 | 反向代理子路径前缀（如 `/hpe`） |
| `ALLOW_ORIGIN` | `*` | CORS 允许来源 |
| `HEMA_DB_PATH` | `server/data/hema.db` | SQLite 路径（测试用独立库） |
| `HEMA_STATIC` | `auto` | 静态托管方式：`auto` / `dist` / `web` / `off` |
| `STATIC_DIR` / `HEMA_WEB_DIR` | 空 | 指定前端目录绝对路径（优先级最高） |
| `HEMA_UMS_URL` | 盒马实时接口地址 | 覆盖接口地址（本地/联调指向假接口） |
| `HEMA_UMS_COOKIE` | 空 | 未在页面保存 Cookie 时的兜底（设置表优先） |
| `HEMA_DING_DIR` | `server/data/ding` | 推送图片落盘目录（可指向 nginx 站点目录，见下） |
| `HEMA_DING_URL_PREFIX` | `<BASE_PATH>/api/ding/img` | 图片 URL 的**路径前缀**；由 nginx 静态托管时设为站点内的目录名（如 `/hpe_ding`）。域名由页面「公网地址」决定 |
| `HEMA_SVG_FONT` | `Noto Sans SC` | 自绘默认字体名 |
| `HEMA_SVG_FONT_FILE` / `HEMA_SVG_FONT_DIR` | 空 | 自绘中文字体文件 / 目录（多个用系统路径分隔符；容器缺字体时用） |
| `HEMA_SVG_SCALE` | `2` | 自绘出图倍率 |

由 `npm start`（`node --env-file-if-exists=.env index.js`）加载，命令行同名变量优先。

```bash
cd server
npm install --omit=dev
nohup npm start > server.log 2>&1 &
```

nginx 子路径反代两种写法均受支持（服务端已做路径归一化）：

```nginx
location /hpe/ {
    proxy_pass http://127.0.0.1:3001;      # 不剥前缀
    # proxy_pass http://127.0.0.1:3001/;  # 剥掉前缀
}
```

> 部署到新环境时需调整 [web/assets/js/config.js](./web/assets/js/config.js) 中硬编码的 `API_BASE` 域名 / IP，以及油猴脚本面板里的「后端地址」。

**把推送图片交给 nginx / CDN**（可选，省掉应用层的图片转发）

```nginx
location ^~ /hpe_ding/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    access_log off;
}
```

三处要保持一致：`HEMA_DING_DIR`（落盘目录）、`HEMA_DING_URL_PREFIX`（URL 路径）、页面「公网地址」（域名）。例：`HEMA_DING_DIR=/1Panel/1panel/www/sites/xxx/index/hpe_ding` + `HEMA_DING_URL_PREFIX=/hpe_ding` + 公网地址 `https://zh.yjmc.xyz` → `https://zh.yjmc.xyz/hpe_ding/20261014-063345_A.png`。

- 图片名是「时间戳 + 类型后缀」，每次推送都是**新 URL**，天然适合 CDN 强缓存（无需 cache-busting）；
- 不做内容去重：同一内容重推（如失败重试）会各写一份，必要时自行加「只留最近 N 天」的清理；
- CDN / nginx 侧要**关掉防盗链**（Referer 白名单），否则钉钉客户端拉不到图。

**容器部署的字体坑**：1Panel 重建容器会丢掉运行时 `apt` 装的字体。建议把字体文件放进挂载卷（如 `<CODE_DIR>/fonts/`），用 `HEMA_SVG_FONT_FILE` 指向容器内路径；启动日志的「自绘字体」一行会打印字体来源与「指定路径是否存在」，可据此自查。

---

## 11. 测试

`npm test` → `node --test`（用例在 `server/test/`），共 **14** 个用例，分四组：

**静态资源缓存 — `static.test.js`（8）**

构建（3）

1. 资源名插入内容哈希，入口与 manifest 就位
2. 改写 HTML 引用与 CSS `url()`，外链 / 锚点不受影响
3. 内容未变则哈希不变（缓存可复用），内容一变哈希即变

服务（5）

4. 入口 HTML 无缓存，始终回源取最新版本
5. 指纹资源长缓存 + 强 ETag，命中协商返回 304
6. 停止使用旧指纹的页面请求旧文件名，自动回退到当前版本
7. 未指纹资源（`manifest.json`）用 `no-cache` 协商，不落强缓存
8. `HEMA_STATIC=web` 时退回协商缓存（未指纹化兜底）

**Cookie 鉴权失效 — `ums-cookie.test.js`（3）**：本机 mock UMS 接口（Cookie 含 `BAD` → 401）

9. 失效的主 Cookie 被删除，并记录 `cookieAuth` 供页面提示
10. 主 / 备用都失效 → 两份都被删除
11. 临时粘贴（未保存）的 Cookie 失效 → 不动已保存的 Cookie

**服务端自绘 — `render.test.js`（2）**：直接喂构造的数据集 payload

12. 产出三块 PNG 且顺序为 前场 / 后场 / 一体化，数值随块产出
13. 无透视数据时给出可读报错（不抛底层异常）

**定时推送全链路 — `ding-render.test.js`（1）**：Webhook 指向本机 mock、图片落临时目录、库用临时文件，**全程离线**

14. 自绘 → 落盘 3 张 PNG → 发 markdown 到群，markdown 里带公网图片链接

---

## 12. 二次开发指引

- **新增统计指标**：在 `compute.js` 的 `buildDataset` / `buildStats` 中计算并加入返回结构 → 在 `charts.js` 增图表渲染 → 在 `app.js` 对应 `render*` 函数中调用 → 如需卡片则在 `index.html` 加 DOM 容器。
- **新增口径参数**：加在 `server/config.js`；若可在界面调整则加进 `settings` 表（参考 `MAPPING_KEY` / `IGNORE_KEY` 的用法）。
- **调整实时取数行为**：分页与入库在 `index.js` 的 `umsFetchAll` / `umsRunFetch` / `saveBuilt`；明细解析与合并键在 `compute.js` 的 `buildFromUms` / `mergeInto`；接口字段映射在 `umsRow` + `UMS_COLUMNS` + `UMS_DUTY_MAP`。
- **调整自动获取排期**：改 `index.js` 的 `umsAutoNextAt`（网格基准 = 整点、触发 = 网格点 +1 分钟）与 `umsEdgeNextMs` / `umsNextAtWithEdge`（边界取数怎么并入倒计时）。
- **调整防风控强度**：只改 `config.js` 的 `UMS_PAGE_GAP_*` / `UMS_FETCH_COOLDOWN_SEC` / `UMS_MANUAL_LOCK_SEC` 即可（`UMS_INTERVAL_JITTER` / `UMS_BACKOFF_MAX_MIN` 已废用）。
- **调整推送出图样式**：改 `render.js`（配色 / 热力色阶 / 达标线 / 字号 / 折线），它只吃数据集 `payload`，可离线用 `render.test.js` 的方式验证。
- **调整推送文案 / @全体成员**：文案在 `index.js` 的 `dingBuildBlocksText` / `dingBuildSingleText`，@ 在 `dingPostAtAll`（**markdown 不支持 at，必须走 text**）。
- **修改日期的取数范围**：改 `server/index.js` 的 `withDate`。
- **切换数据来源/展示日期**：前端统一走 `refetch(id)` / `loadHistory`，不要在 `render` 之外直接改 DOM。
- **注意事项**：
  - 改 `server/*.js` 必须**重启服务**；改前端刷新页面即可（`HEMA_STATIC=auto` 时需重启以重建 `dist/`）。
  - `compute.js` 不应 `require('./db')`，映射与忽略列表始终由调用方传入，保持计算层可独立测试。
  - `render.js` 同样不应 `require('./db')`（只吃 `payload`），这样自绘能用纯数据离线测试。
  - 入库时必须同时保存 `recs`，否则该数据集此后无法重算，也无法参与增量合并。
  - 新增接口时同步更新 `/api/health` 的 `features` 与 404 的 `availableApi`，油猴脚本依赖前者做版本自检。
