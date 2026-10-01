# 拣货效率计算统计工具 — 项目架构文档

> 本文档描述系统的整体分层、模块职责、数据流、接口与关键机制，供开发/维护/二次开发参考。
> 业务口径与使用说明见 [README.md](./README.md)。

---

## 1. 项目概述

从盒马门店「门店视角：拣货单」的拣货明细（xlsx 导出 / 实时接口 / 油猴脚本回传）出发，按**作业类型 / 拣货分区 / 人员 / 时段**计算效率指标，并以看板形式呈现。

四条核心设计原则：

- **口径唯一**：所有统计口径只在服务端 `compute.js` 实现，前端不做任何计算，仅渲染服务端返回的结果，避免前后端各写一套导致口径漂移。
- **多来源同一口径**：xlsx 上传、服务端带 Cookie 取数、油猴脚本回传三条路径最终都汇入 `buildFromMatrix`，门店筛选 / 丢弃计数 / 时间维度完全一致。
- **零构建前端**：前端为纯静态 HTML/CSS/JS（原生 JS），无打包步骤；发布时仅由 `build.js` 做内容哈希指纹。
- **原始明细留库**：入库时同时保存原始明细 `recs`，使「分区设置」变更后能重算全部历史数据集，无需重新上传。

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
│      │                                                                       │
│      ▼                                                                       │
│  ② 计算层  compute.js  xlsx 与 UMS 解析 + 全部统计口径（唯一口径实现）           │
│      │                                                                       │
│      ▼                                                                       │
│  ③ 存储层  db.js       node:sqlite（datasets / settings）                     │
│                                                                              │
│    配置层  config.js   作业类型字典、默认前后场映射、必需列、门店编码、UMS 与防风控常量│
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

**分层依赖方向**：`index.js → compute.js → config.js`、`index.js → db.js`、`index.js → build.js`。
`compute.js` 不依赖 `db.js`（映射与忽略列表由调用方传入），保持计算层可独立测试。

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
| 导出 | html2canvas 1.4.1（CDN） | 卡片「导出为图片 / 复制为图片」 |
| 构建 | `crypto.createHash('sha256')` | `build.js` 生成内容哈希指纹，无打包器 |
| 测试 | Node 内置测试运行器 | `node --test` |

---

## 4. 目录结构

```
Hema-Picking-Efficiency/
├── server/                        # npm 工程根（所有 npm 命令在此执行）
│   ├── index.js                   # ① HTTP 层：路由、CORS、路径归一化、UMS 取数与自动获取、静态托管
│   ├── compute.js                 # ② 计算层：xlsx / UMS 解析 + 全部统计口径 + 增量合并
│   ├── db.js                      # ③ 存储层：SQLite（datasets / settings）
│   ├── config.js                  # 配置层：口径参数、UMS 接口与防风控常量
│   ├── build.js                   # 构建层：web/ → dist/ 内容哈希指纹
│   ├── package.json               # 依赖与脚本（start / build / test）
│   ├── .env                       # PORT / BASE_PATH
│   ├── data/hema.db               # SQLite 库文件（运行时生成）
│   └── test/static.test.js        # 静态资源缓存方案测试（8 个用例）
├── web/                           # 前端静态资源（由 Express 托管）
│   ├── index.html                 # 页面结构（顶栏 + 9 张卡片 + 3 个弹窗 + 门禁遮罩）
│   └── assets/
│       ├── css/style.css
│       └── js/
│           ├── config.js          # API_BASE（按访问来源自动选择）、配色、单位
│           ├── charts.js          # ECharts 封装：图表渲染 / 自适应 / 双口径
│           └── app.js             # 视图逻辑：拉数、渲染、交互、上传、实时获取、门禁
├── userscript/                    # 油猴脚本（二选一安装）
│   ├── hema-pick-sync.user.js     # 纯同步脚本
│   └── 选中文本生成条码…CODE-128.js # 条码脚本 + 内置「拣货效率同步」面板
├── ARCHITECTURE.md                # 本文档
├── CACHE.md                       # 静态资源缓存方案
├── README.md                      # 使用与业务口径说明
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
| `umsCookie()` | 读取 Cookie：设置表优先，回退环境变量 `HEMA_UMS_COOKIE` |
| `umsNum()` / `umsClampInterval(v)` | 每页条数与自动间隔的取值钳制 |
| `umsAutoCfg()` | 自动获取设置：`{ enabled, intervalMin, timeStart, timeEnd }` |
| `umsRangeCfg()` | 取数条件：页面「开始/结束日期」持久化的日期区间，非法/未设回退当天；**单日区间已过期时顺延为当天**（服务端不依赖浏览器），多日区间原样使用（手动与自动共用） |
| `umsInTimeWindow(cfg)` | 按东八区判断是否在执行时段内（当天时间点，支持留空 = 全天） |
| `umsEdgeHit(cfg, st)` | 时段边界到点：返回 `'' / 'start' / 'end'`，用于在「开始 / 结束时刻」各额外强制取数一次（同一时刻只触发一次，见 `umsAutoState.edge`） |
| `umsAutoState()` | 最近一次自动执行结果 + `failures` / `nextMin` / `nextAt` / `cfgInterval` / `edge` |
| `umsJitter()` / `umsAutoWaitMin()` / `umsAutoNextAt()` | 防风控：抖动系数、退避后的等待间隔、排期好的下次执行时间 |
| `umsMarkTry()` / `umsCooldownInfo()` | 取数冷却：记录尝试时间、返回剩余等待秒数 |
| `umsSleep(ms)` | 翻页之间的随机停顿 |
| `umsFetchAll(...)` | 逐页拉取：超时 `AbortController` → HTML 错误转可读文案 → 增量追平提前结束 → 翻页停顿；每页回调 `onProgress({ pages, totalPages, got, total })`（`totalPages = ceil(totalNum / num)`） |
| `umsRunFetch(...)` | 一次完整获取：翻页 → `compute.buildFromUms` → `saveBuilt`（手动与自动共用）；期间把进度写入内存 `UMS_PROGRESS`，供 `umsConfigPayload().progress` 读取 |
| `umsAutoTick()` | 自动获取定时任务（`setInterval` 5 秒检查一次排期） |

自动获取的排期与退避（`umsAutoTick`）：

```
if (!enabled || !cookie) return
edge = umsEdgeHit(auto, st)                        # 时段开始 / 结束时刻（到点后 UMS_EDGE_WINDOW_MIN 分钟内有效）
if (!edge) {                                       # 边界取数不吃时段与排期
  if (不在执行时段) return
  if (now < umsAutoNextAt(auto, st)) return        # 未到排期时间
}
if (umsCooldownInfo().waitSec > 0) return          # 与手动/脚本共用冷却窗口
成功 → failures=0，nextAt = now + intervalMin × jitter()，edge = 当天:边界
失败 → failures+1，nextAt = now + min(BACKOFF_MAX, intervalMin × 2^failures) × jitter()，edge = 当天:边界
```

**其它编排函数**：`currentMap()` / `currentIgnore()`（设置优先、回退默认值）、`dataZones()` / `zoneRows()`（分区清单）、`rebuildAll()`（设置变更后重算）、`withDate()`（出数范围，见 [7.3](#73-按日重算-withdate)）、`saveBuilt()`（上传与取数共用的入库决策，见 [7.1](#71-时间维度覆盖--新增)）。

**日志**：`logInfo()` / `logWarn()` 统一输出 `[YYYY-MM-DD HH:mm:ss] 内容`（东八区时间，`clockOf()` 用于标注「下次执行时间」）。日志只打在**关键动作**上，不打请求级日志（前端每 5 秒轮询一次配置，全量请求日志会淹没有用信息）：

| 分类 | 位置 | 内容 |
|------|------|------|
| 启动 | `app.listen` 回调 | 端口 / 子路径 / 静态目录 / 数据集数量 / 自动获取与 Cookie 状态 |
| `[上传]` | `/api/upload` | 文件名与大小（开始）、失败原因 |
| `[入库]` | `saveBuilt` | 新建 / 覆盖 / 增量并入的数据集 id 与新增、覆盖、有效明细条数（上传与取数共用） |
| `[取数]` | `/api/ums/fetch`、`/api/ums/agent/data` | 开始（区间 / 页数 / 增量或全量）、完成（页数、明细、新增、覆盖、数据集 id、耗时）、失败；被 409 / 429 拒绝的请求 |
| `[自动获取]` | `umsAutoTick` | 完成（明细、新增、覆盖、耗时、下次执行时刻）、失败（连续次数、退避分钟数、下次执行时刻） |
| `[设置]` | `/api/settings`、`/api/ums/config` | 映射与忽略项数、重算结果；Cookie（只记字符数，**不记原文**）、每页条数、自动获取开关与时段 |
| `[数据集]` | `DELETE /api/datasets/:id` | 删除的数据集 id 与移除条数 |
| `[静态资源]` | `resolveStatic` | 未找到前端目录 / 构建失败 / 缺 `dist` 等回落原因 |

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
| 口径 | `UNIT`、`JOB_TYPES`、`UNMATCHED_TYPE`、`DEFAULT_FRONT_BACK_MAP`（8 项）、`INTEGRATED_ORDER_TYPE`、`TIME_COLUMN` |
| 超时 | `TIMEOUT_COLUMN`、`TIMEOUT_YES`、`TIMEOUT_DUTY_COLUMN`、`TIMEOUT_NO_DUTY`、`UMS_DUTY_MAP`（接口英文编码 → 中文判责） |
| 上传 | `STORE_CODE`、`REQUIRED_COLUMNS` |
| 设置键名 | `MAPPING_KEY`、`IGNORE_KEY` |
| UMS 接口 | `UMS_URL`、`UMS_PAGE_SIZE`、`UMS_NUM_CHOICES`、`UMS_EXTRA_QUERY`、`UMS_TIMEOUT_MS`、`UMS_MAX_PAGES` |
| 自动获取 | `UMS_AUTO_MIN_INTERVAL`、`UMS_AUTO_MAX_INTERVAL`、`UMS_EDGE_WINDOW_MIN`、`UMS_AUTO_KEY`、`UMS_AUTO_STATE_KEY`、`UMS_AGENT_STATE_KEY` |
| 防风控 | `UMS_PAGE_GAP_MIN_MS` / `UMS_PAGE_GAP_MAX_MS`（300 / 900）、`UMS_INTERVAL_JITTER`（0.15）、`UMS_BACKOFF_MAX_MIN`（60）、`UMS_FETCH_COOLDOWN_SEC`（60） |
| 设置表键名 | `UMS_COOKIE_KEY`、`UMS_LAST_KEY`、`UMS_LAST_TRY_KEY`、`UMS_NUM_KEY`、`UMS_RANGE_KEY` |

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
| **实时获取** | `umsRun` / `umsManualPaint` / `umsChipPaint` / `umsAutoPaint` / `umsLoadCfg` / `umsSaveCfg` / `umsSaveRange` / `umsDateSync` / `umsLoadCookie` / `umsAfterImport` / `umsApplyServerFetch` | 顶栏角标与「手动获取」按钮、取数弹窗、自动获取设置、取数日期（默认当天，跨 0 点自动翻新）、冷却与倒计时、后台新数据自动刷新视图 |
| 数据管理 | `renderDmTable` / `loadDataMgr` / `deleteDatasets` / `clearDatasets` / `switchDataset` / `askConfirm` | 弹窗内查看/切换/删除/清空 + 页内二次确认 |
| 分区设置 | `renderZoneCfg` / `loadZoneCfg` / `zcAdd` / `saveZoneCfg` | 维护映射与忽略分区，保存并重算 |
| 门禁 | `todayStr` / `syncGate` / `playGateOut` / `playDashIn` | 「今日暂无数据」遮罩与入场动画 |
| 卡片工具 | `injectCardTools` / `captureCard` / `exportPng` / `copyPng` / `runCapture` | html2canvas 导出/复制图片（透视卡可按分类选范围） |
| 启动 | 底部末尾 | 拉数据集 → 判定含今天的数据集 → `refetch` 或 `clearView` + 遮罩 |

前端轮询约定：角标与手动获取按钮每 1 秒重绘（倒计时走动），每 5 秒 `umsLoadCfg()` 拉一次 `/api/ums/config` 同步后台状态（自动获取结果、冷却剩余、构建版本）；**取数进行中改为每秒轮询**，据 `progress`（`pages` / `totalPages`）在弹窗与顶栏显示「第 x / N 页」（`totalPages` 来自接口 `totalNum ÷ num`，拿到第一页即确定）。

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

### 6.2 实时获取（两条路径，同一入库口径）

```
路径 A：服务端带 Cookie
  POST /api/ums/fetch { startDate, endDate, incremental }
    → umsBusy 互斥 → 冷却检查（429）→ umsRunFetch
        → umsFetchAll：逐页 umsUrl(index) fetch → 去重 → 增量追平提前结束 → 翻页停顿
        → compute.buildFromUms(pages, meta, map, ignore)
        → saveBuilt(built, { merge: incremental, replaceDates: complete ? dates : null })

路径 B：油猴脚本（同源取数，后端无需 Cookie）
  UMS 页面内 fetch/GM_xmlhttpRequest 逐页取数
    → POST /api/ums/known { codes }        （判定是否已追平，可选）
    → POST /api/ums/agent/data { pages }   → buildFromUms → saveBuilt（同 A）
    → POST /api/ums/config { cookie }      （顺带把读到的 Cookie 存到服务端，供 A 使用）
```

服务端与脚本两条路径最终都调用 `saveBuilt`，因此**覆盖 / 增量合并规则完全一致**。

### 6.3 自动获取排期

```
setInterval(umsAutoTick, 5s)
  → 读配置与状态 → 边界判断（umsEdgeHit：时段开始 / 结束时刻额外取一次）→ 时段判断 → 排期判断（now >= auto.nextAt）→ 冷却判断
  → umsRangeCfg() 取页面「取数条件」的日期区间（未设置则当天）
  → umsRunFetch(开始日期, 结束日期, incremental = true)
  → 写回 umsAutoState：{ at, ok, error, records, added, failures, nextMin, nextAt, cfgInterval, edge }
```

`nextAt` 是**固定排期**（含抖动与退避），不再每 5 秒重新随机 —— 这样服务端判断与前端倒计时用的是同一个时间点。

`edge` 记录当天已执行的时段边界（`当天:start` / `当天:end`）：边界这一跳**不吃时段与间隔排期**（结束时刻正好在时段外），但仍受冷却与 `umsBusy` 约束；到点后 `UMS_EDGE_WINDOW_MIN` 分钟内允许补执行一次。

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
| 间隔抖动 | `umsJitter()` | 排期时乘 `1 ± UMS_INTERVAL_JITTER`（±15%），避免固定时刻规律打点 |
| 失败退避 | `umsAutoTick` catch | 等待间隔 = `intervalMin × 2^failures`，上限 `UMS_BACKOFF_MAX_MIN`（60 分钟），成功清零 |
| 取数冷却 | `umsMarkTry()` / `umsCooldownInfo()` | 手动、自动、脚本同步**共用**同一窗口：距上次尝试不足 `UMS_FETCH_COOLDOWN_SEC`（60 秒）则拒绝（手动接口返回 429） |

`umsMarkTry()` 的调用点：`umsFetchAll`（覆盖手动 + 自动）与 `/api/ums/agent/data`（脚本同步）。因此「自动刚跑过」时前端的「手动获取」按钮会同步进入冷却并显示 `冷却 N 秒`。

### 7.9 缓存分层与版本提示

| 资源 | 响应头 | 效果 |
|------|--------|------|
| `index.html` | `no-store` | 每次回源，永远拿到最新 HTML 与最新指纹路径 |
| `name.<hash8>.ext` | `public, max-age=31536000, immutable` + 强 ETag | 内容没变零请求；一变文件名即变 |
| 其它（`manifest.json`） | `no-cache` | 可缓存但每次协商 |
| `/api*` | `no-store` | 规避 express 默认 ETag 的 304 空响应 |

`HEMA_STATIC=web`（源目录）下即使没有指纹文件，`staticHeaders` 也会退回协商缓存，保证「改完即生效」。
后端 `BUILD_ID` 与前端脚本文件名哈希不一致时，顶栏角标显示「有新版本 · 点击刷新」，避免旧 JS 配新数据造成显示不符。

---

## 8. API 接口

均以 `/api` 为前缀（配置 `BASE_PATH` 时前面拼接子路径）。

**数据集与设置**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查：数据集数量、`basePath`、静态托管方式与 `features`（接口能力自检） |
| GET | `/api/logs?limit=N` | 服务端最近日志（内存环形缓冲，最多 500 条）：`{ total, max, lines[{ at, level, msg }] }` |
| POST | `/api/upload?name=文件名.xlsx` | 上传拣货单（raw body，≤100MB；文件名也可用 `x-filename` 头）。返回 `{ id, mode, added, replaced, ...dataset }` |
| GET | `/api/datasets` | 数据集列表（不含 `payload`） |
| GET | `/api/latest?date=YYYY-MM-DD` | 最新数据集完整结果（无数据 404） |
| GET | `/api/datasets/:id?date=YYYY-MM-DD` | 指定数据集完整结果 |
| DELETE | `/api/datasets/:id` | 删除数据集，返回 `{ removed }` |
| GET | `/api/settings` | 读取 `map` / `ignore` / `jobTypes` / `unmatched` / `zones` |
| POST | `/api/settings` | 保存映射与忽略列表并重算全部历史数据集，返回 `{ ok, map, ignore, updated, skipped, failed }` |

**实时获取（UMS）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ums/config` | `cookieSet` / `build` / `num` / `numChoices` / `range` / `auto` / `agent` / `lastFetch` / `progress` / `cooldown` |
| GET | `/api/ums/cookie` | 已保存的 Cookie 原文（仅在展开「Cookie 设置」时调用） |
| POST | `/api/ums/config` | 保存 Cookie / 每页条数 / 取数条件（日期区间）/ 自动获取设置，返回最新配置 |
| POST | `/api/ums/fetch` | 服务端逐页取数入库；冷却中 429、任务进行中 409 |
| POST | `/api/ums/agent/data` | 脚本回传逐页结果入库 |
| POST | `/api/ums/known` | 判定这批单号已入库多少条 → `{ known, total }` |

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
| `umsCookie` | 实时接口 Cookie |
| `umsNum` | 每页条数（50 / 100 / 200） |
| `umsRange` | 取数条件 `{ startDate, endDate }`（页面「开始/结束日期」，手动与自动共用的日期区间） |
| `umsAuto` | 自动获取设置 `{ enabled, intervalMin, timeStart, timeEnd }` |
| `umsAutoState` | 最近一次自动执行结果 + `failures` / `nextMin` / `nextAt` / `cfgInterval` / `edge`（当天已执行的时段边界） |
| `umsAgentState` | 油猴脚本最近一次同步结果 |
| `umsLastFetch` | 最近一次取数结果（角标展示） |
| `umsLastTryAt` | 最近一次取数**尝试**时间（冷却窗口起点） |

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
| `HEMA_UMS_COOKIE` | 空 | 未在页面保存 Cookie 时的兜底（设置表优先） |

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

---

## 11. 测试

`server/test/static.test.js`（`npm test` → `node --test`），共 8 个用例，分两组：

**构建（3）**

1. 资源名插入内容哈希，入口与 manifest 就位
2. 改写 HTML 引用与 CSS `url()`，外链 / 锚点不受影响
3. 内容未变则哈希不变（缓存可复用），内容一变哈希即变

**服务（5）**

4. 入口 HTML 无缓存，始终回源取最新版本
5. 指纹资源长缓存 + 强 ETag，命中协商返回 304
6. 停止使用旧指纹的页面请求旧文件名，自动回退到当前版本
7. 未指纹资源（`manifest.json`）用 `no-cache` 协商，不落强缓存
8. `HEMA_STATIC=web` 时退回协商缓存（未指纹化兜底）

---

## 12. 二次开发指引

- **新增统计指标**：在 `compute.js` 的 `buildDataset` / `buildStats` 中计算并加入返回结构 → 在 `charts.js` 增图表渲染 → 在 `app.js` 对应 `render*` 函数中调用 → 如需卡片则在 `index.html` 加 DOM 容器。
- **新增口径参数**：加在 `server/config.js`；若可在界面调整则加进 `settings` 表（参考 `MAPPING_KEY` / `IGNORE_KEY` 的用法）。
- **调整实时取数行为**：分页与入库在 `index.js` 的 `umsFetchAll` / `umsRunFetch` / `saveBuilt`；明细解析与合并键在 `compute.js` 的 `buildFromUms` / `mergeInto`；接口字段映射在 `umsRow` + `UMS_COLUMNS` + `UMS_DUTY_MAP`。
- **调整防风控强度**：只改 `config.js` 的 `UMS_PAGE_GAP_*` / `UMS_INTERVAL_JITTER` / `UMS_BACKOFF_MAX_MIN` / `UMS_FETCH_COOLDOWN_SEC` 即可，无需改逻辑。
- **修改日期的取数范围**：改 `server/index.js` 的 `withDate`。
- **切换数据来源/展示日期**：前端统一走 `refetch(id)` / `loadHistory`，不要在 `render` 之外直接改 DOM。
- **注意事项**：
  - 改 `server/*.js` 必须**重启服务**；改前端刷新页面即可（`HEMA_STATIC=auto` 时需重启以重建 `dist/`）。
  - `compute.js` 不应 `require('./db')`，映射与忽略列表始终由调用方传入，保持计算层可独立测试。
  - 入库时必须同时保存 `recs`，否则该数据集此后无法重算，也无法参与增量合并。
  - 新增接口时同步更新 `/api/health` 的 `features` 与 404 的 `availableApi`，油猴脚本依赖前者做版本自检。
