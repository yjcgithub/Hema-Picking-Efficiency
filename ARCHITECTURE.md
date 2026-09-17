# 拣货效率计算统计工具 — 项目架构文档

> 本文档描述系统的整体分层、模块职责、数据流、接口与关键机制，供开发/维护/二次开发参考。
> 业务口径与使用说明见 [README.md](./README.md)。

---

## 1. 项目概述

从盒马门店「门店视角：拣货单」导出文件（xlsx）解析拣货明细，按**作业类型 / 拣货分区 / 人员 / 时段**计算效率指标，并以看板形式呈现的可视化系统。

三条核心设计原则：

- **口径唯一**：所有统计口径只在服务端 `compute.js` 实现，前端不做任何计算，仅渲染服务端返回的结果，避免前后端各写一套导致口径漂移。
- **零构建前端**：前端为纯静态 HTML/CSS/JS（原生 JS），无打包构建步骤，由 Express 直接托管，改完刷新即生效。
- **原始明细留库**：上传时同时保存原始明细 `recs`，使「分区设置」变更后能重算全部历史数据集，无需重新上传。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                          浏览器（web/）                                │
│   index.html  ──  assets/js/config.js  （API 地址 / 配色）             │
│               ──  assets/js/charts.js  （ECharts 封装：图 / 表渲染）    │
│               ──  assets/js/app.js     （视图逻辑：拉数 / 渲染 / 交互）  │
│                       │ fetch(API_BASE + /api/...)                     │
└───────────────────────┼──────────────────────────────────────────────┘
                        │ HTTP (JSON / xlsx 原始字节)
┌───────────────────────▼──────────────────────────────────────────────┐
│                     服务端（server/，Express）                         │
│                                                                        │
│  ① HTTP 层   index.js   路由 / CORS / 路径归一化 / 静态托管 / 404 提示   │
│        │                                                               │
│        ▼                                                               │
│  ② 计算层   compute.js  xlsx 解析 + 全部统计口径（唯一口径实现）          │
│        │                                                               │
│        ▼                                                               │
│  ③ 存储层   db.js       node:sqlite（datasets / settings）              │
│                                                                        │
│     配置层  config.js   作业类型字典、默认前后场映射、必需列、门店编码     │
└──────────────────────────────────────────────────────────────────────┘
```

**分层依赖方向**：`index.js → compute.js → config.js`、`index.js → db.js`。`compute.js` 不依赖 `db.js`（映射与忽略列表由调用方传入），保持计算层可独立测试。

---

## 3. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 运行环境 | Node.js ≥ 22.5.0 | 依赖内置 `node:sqlite`，免原生编译 |
| HTTP | Express 4 | 路由、`express.static`、`express.raw`（上传）/`express.json`（设置） |
| 解析 | SheetJS `xlsx` | 读取工作表 `data`（缺失则取第一个）为矩阵 |
| 存储 | `node:sqlite`（`DatabaseSync`） | 单文件库 `server/data/hema.db` |
| 前端 | 原生 HTML / CSS / JS | 无框架、无构建；`HEMA` 全局命名空间 + IIFE |
| 图表 | ECharts 5.5.1（CDN） | 所有图表渲染 |
| 导出 | html2canvas 1.4.1（CDN） | 卡片「导出为图片 / 复制为图片」 |
| 测试 | Node 内置测试运行器 | `node --test` |

---

## 4. 目录结构

```
Hema-Picking-Efficiency/
├── server/                        # npm 工程根（所有 npm 命令在此执行）
│   ├── index.js                   # ① HTTP 层：路由、CORS、路径归一化、静态托管
│   ├── compute.js                 # ② 计算层：xlsx 解析 + 全部统计口径
│   ├── db.js                      # ③ 存储层：SQLite（datasets / settings）
│   ├── config.js                  # 配置层：口径参数与默认值
│   ├── package.json               # 依赖与脚本（start / test）
│   ├── .env                       # PORT / BASE_PATH / ALLOW_ORIGIN / HEMA_DB_PATH
│   ├── data/hema.db               # SQLite 库文件（运行时生成）
│   └── test/upload.test.js        # 上传与分区设置测试（14 组场景）
├── web/                           # 前端静态资源（由 Express 托管）
│   ├── index.html                 # 页面结构（顶栏 + 9 张卡片 + 3 个弹窗 + 门禁遮罩）
│   └── assets/
│       ├── css/style.css
│       └── js/
│           ├── config.js          # API_BASE（按访问来源自动选择）、配色、单位
│           ├── charts.js          # ECharts 封装：图表渲染 / 自适应 / 双口径
│           └── app.js             # 视图逻辑：拉数、渲染、交互、上传、门禁
├── ARCHITECTURE.md                # 本文档
├── README.md                      # 使用与业务口径说明
└── .gitignore
```

---

## 5. 分层设计

### 5.1 HTTP 层 — [server/index.js](./server/index.js)

职责：协议处理与编排，不含业务计算。

- **入口编排**：`require` 配置/计算/存储三层，组装 Express 应用；`require.main === module` 时才 `listen`，被 `require`（测试）时只导出 `app`。
- **路径归一化中间件**（最先注册）：容忍反向代理的两种写法——压缩重复斜杠 `//`、剥离 `BASE_PATH` 前缀、兜底截取 `/api/` 之后的部分。使 `/hpe/api/...` 与 `/api/...` 均可用。
- **CORS 中间件**：`ALLOW_ORIGIN`（默认 `*`），允许 `GET/POST/DELETE/OPTIONS`，预检直接 `204`。
- **当前设置读取器**：`currentMap()` / `currentIgnore()`——数据库设置优先，未保存过则回退 `config.js` 默认映射。
- **分区清单**：`dataZones()`（汇总所有数据集出现过的拣货分区，新数据用 `recs`、旧数据用 `payload.byZone` 兜底）、`zoneRows()`（分区 + 映射 + 已忽略的去重排序清单，供「分区设置」界面渲染）。
- **重算编排**：`rebuildAll(map, ignore)`——用新设置遍历 `db.rebuildTargets()` 逐条 `compute.rebuild(...)` 并 `db.updatePayload(...)`；缺 `recs` 的归入 `skipped`。
- **按日重算**：`withDate(ds, date)`——见 [7.2](#72-按日重算-withdate)。
- **静态托管**：`express.static(WEB_DIR)`（`web/` 实时读盘）。
- **自解释 404**：未匹配路径返回 `{ error, hint, availableApi }`，专门提示反向代理子路径与 `BASE_PATH` 不一致的问题。

### 5.2 计算层 — [server/compute.js](./server/compute.js)

职责：**唯一口径实现**。xlsx 解析、明细清洗、全部统计聚合。对外导出 `{ buildFromBuffer, buildFromMatrix, buildDataset, rebuild, jobType, zoneCode }`。

**解析入口**

| 函数 | 说明 |
|------|------|
| `buildFromBuffer(buf, sourceFile, map, ignore)` | 解析 xlsx Buffer → `{ dataset, recs }`。`recs` 为**未过滤**原始明细（含被忽略分区），供改设置后重算 |
| `buildFromMatrix(matrix, meta, map)` | 校验必需列与时间列，逐行解析为 `recs`，统计 `dropped` / `otherStore` |
| `validateStartTime(matrix, col)` | 时间列校验：整列无可解析值 → 报错；非空单元格解析失败 → 报错并带行号；空单元格按「丢弃」 |
| `rebuild(recs, meta, map, ignore, date)` | 用新映射/忽略列表重算；`date` 非空时仅重算该日明细，但保留原完整日期集合 |

**统计工具**（纯函数，无副作用）

| 函数 | 用途 |
|------|------|
| `jobType(part, orderType, map)` | 作业类型判定：`拣打一体 → 一体化`，否则查映射，未命中 → `未匹配分区` |
| `splitIgnored(recs, ignore)` | 按**分区**排除忽略明细，返回 `{ recs, ignored }` |
| `dateSetOf(recs)` | 时间维度：文件内全部明细的日期集合（**不受忽略分区影响**） |
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
meta           { sourceFile, dates[], hours[], period, recordCount, dropped, ignored, otherStore }
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

职责：SQLite 读写。库文件 `server/data/hema.db`，可用 `HEMA_DB_PATH` 覆盖（测试用临时库）。旧库启动时自动补列 `recs` / `ignored` / `other_store`。

导出函数分组：

- **数据集 CRUD**：`insert`、`overwrite`、`list`（不含 `payload`）、`get`、`latest`、`remove`、`count`
- **时间维度匹配**：`findByDates(dates)`（`timeKey` 规范化后比较，同维度多条取最新）
- **重算支持**：`rebuildTargets()`（`recs` + meta 字段，并固化旧格式 `sub → orderType` 迁移）、`withoutRecs()`、`recsOf(id)`、`saveRecs`、`updatePayload`
- **键值设置**：`getSetting` / `setSetting`（JSON 序列化，`ON CONFLICT` upsert）

### 5.4 配置层 — [server/config.js](./server/config.js)

口径参数与默认值：`UNIT`、`JOB_TYPES`（前场合流/后场合流/一体化）、`UNMATCHED_TYPE`、`DEFAULT_FRONT_BACK_MAP`（8 项默认映射）、`MAPPING_KEY` / `IGNORE_KEY`（设置表键名）、`INTEGRATED_ORDER_TYPE`、`TIME_COLUMN`、超时相关列、`STORE_CODE`、`REQUIRED_COLUMNS`。

映射的实际取值存于设置表，此处仅为**首次运行**的默认值。

### 5.5 前端 — web/

`web/assets/js/`（按引入顺序）：

- **config.js**：[web/assets/js/config.js](./web/assets/js/config.js) 定义 `window.HEMA_CONFIG`（`UNIT` / `COLORS` / `API_BASE`）。`API_BASE` 按 `location.hostname` 自动选择：`localhost`/`127.0.0.1` → 本机 `:3001`；IP → 固定 IP 后端；域名 → `https://api.yjmc.xyz/hpe/api`。
- **charts.js**：[web/assets/js/charts.js](./web/assets/js/charts.js) 导出 `HEMA.charts.render(data)` / `HEMA.charts.resize()` / `HEMA.charts.setWeighted(v)`。内部以 `instances` 缓存并复用 ECharts 实例，`cache` 保存最近数据以便切换双口径时无需重新拉数；监听 `resize` 自适应。含 `stackTip`（堆叠 tooltip）、`timelineItem`（自定义工作时间色块）等。
- **app.js**：[web/assets/js/app.js](./web/assets/js/app.js) 视图逻辑主体，`(function(window){ ... })(window)` IIFE，挂 `HEMA` 命名空间。

**app.js 模块划分**（按文件中的 `/* ---------- */` 段落）：

| 段落 | 关键函数 | 职责 |
|------|---------|------|
| 基础工具 | `readJson` / `esc` / `fmt` / `notice` | 请求、转义、格式化、顶部提示 |
| KPI | `renderKpis` / `kpiCard` / `personMean` | 顶部 KPI 卡与次级规模指标 |
| 表格排序 | `sortState` / `theadHtml` / `bindSort` | 所有表格表头点击升/降序（空值恒末尾） |
| 人员透视 | `renderPivotBlocks` / `heatColor` / `collapsedSet` | 按作业类型分 3 块的 人员×小时 透视，可折叠并记忆 |
| 明细表 | `renderZoneTable` / `renderPersonTable` | 拣货分区效率、人员效率明细 |
| 超时 | `renderTimeoutPerson` | 超时卡片「按人员统计」（默认折叠） |
| 分布与行数 | `renderDist` / `renderRowsStat` | 效率分布箱线图、分档、稳定性榜、行数 TOP/分档/集中度 |
| 工作时间 | `renderTimeline` / `clockOf` | 人员工作时间图与班次明细表 |
| 顶栏品牌 | `renderPeriod` / `renderSource` / `renderDates` | 统计时间段、来源/有效明细、日期下拉 |
| 总渲染 | `render(d)` / `clearView(errMsg, latestMeta)` | 渲染全部卡片 / 清空视图 |
| 历史数据集 | `selHtml` / `syncHistory` / `renderHistoryMenu` / `refetch` / `loadHistory` / `pickHistory` | 顶栏与门禁同款自定义下拉 |
| 上传 | `upload(file)` | POST xlsx 原始字节 |
| 数据管理 | `renderDmTable` / `loadDataMgr` / `deleteDatasets` / `clearDatasets` / `switchDataset` / `askConfirm` | 弹窗内查看/切换/删除/清空 + 页内二次确认 |
| 分区设置 | `renderZoneCfg` / `loadZoneCfg` / `zcAdd` / `saveZoneCfg` | 维护映射与忽略分区，保存并重算 |
| 门禁 | `todayStr` / `syncGate` / `playGateOut` / `playDashIn` | 「今日暂无数据」遮罩与入场动画 |
| 卡片工具 | `injectCardTools` / `captureCard` / `exportPng` / `copyPng` / `runCapture` | html2canvas 导出/复制图片（透视卡可按分类选范围） |
| 启动 | 底部末尾 | 拉数据集 → 判定含今天的数据集 → `refetch` 或 `clearView` + 遮罩 |

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
    → db.findByDates(dataset.meta.dates)
        ├─ 命中 → db.overwrite(hit.id, dataset, recs)   （保留原 id）
        └─ 未命中 → db.insert(dataset, recs)
  → 响应 { id, mode: 'create'|'overwrite', ...dataset }
→ 前端 refetch(id) → render(dataset)
```

### 6.2 读取（展示）

```
启动 → GET /api/datasets（列表，按 id 倒序）
  ├─ 命中「日期集合含今天」的数据集 → refetch(id) → GET /api/datasets/:id → render
  └─ 未命中 → loadHistory(null, list) + clearView('', 最新一条的 meta) → syncGate 显示遮罩

切换数据集 / 切日期 → GET /api/datasets/:id?date=YYYY-MM-DD
  服务端 withDate()：按 date 过滤后用 recs 重算再返回（见 7.2）
前端 render(d)：
  ├─ charts.render(d)       → 全部 ECharts 图
  ├─ renderKpis / renderPivotBlocks / renderZoneTable / renderPersonTable ...
  └─ syncGate(d)            → 依 meta.dates 是否含今天决定遮罩显隐
```

### 6.3 设置变更（重算）

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

时间维度 = 文件内**全部明细**（含被忽略分区）的「拣货开始时间」日期集合，规范化（去重 + 排序 + 逗号拼接）后作为数据集标识：

- 命中同维度历史记录 → 整条覆盖（`db.overwrite`，**保留原 id**，前端选中态与引用不变）；
- 未命中 → 新增一条（`db.insert`）；
- 同维度存在多条历史记录 → 只覆盖最新一条（兼容历史遗留重复数据）。

> 之所以用「全部明细」的日期集合而非过滤后的，是为了避免某天明细全被忽略时维度变化，导致重传同一文件被判为新数据集而重复入库。

### 7.2 按日重算 `withDate`

展示范围默认只取数据集内**最新一天**（隔天不显示前天），其余日期由顶栏日期下拉手动选择：

- `meta.dates` 始终是**完整**日期集合（下拉用），`meta.date` 为本次实际展示日期；
- 有原始明细的数据集一律按**最新口径重算后再返回**（库里 `payload` 是上传时算好的旧版，直接返回会缺后加字段）；
- 缺原始明细的旧数据集或重算失败时，退回原 `payload`，仅补 `meta.date`。

### 7.3 门禁遮罩（今日暂无数据）

`syncGate(d, errMsg)` 依 `d.meta.dates` 是否含**今天**决定遮罩显隐：

- 启动时若没有任何含今天的数据集 → 显示遮罩（`clearView` 清空 DOM/图表，不后台渲染最近一天数据）；
- `gateDismissed`：本次访问是否已手动关闭——用户**主动导入**或**手动选择**历史数据集后置位，`syncGate` 直接隐藏，避免遮罩挡住用户刚导入/选择的数据；
- `introPending`：是否播放「导入成功」入场动画（仅当遮罩原本可见 **且** 新数据含今天）。

### 7.4 双效率口径

| 口径 | 计算 | 默认 |
|------|------|------|
| 按工时加权 | Σ拣货行数 ÷ Σ拣货时长(h) | ✅ |
| 人均 | 各人效率的算术平均（忽略该时段无记录的人） | |

顶栏 `weightedToggle` 切换，`HEMA.charts.setWeighted(v)` 统一切换所有**聚合**效率（KPI 卡、透视分块含小计/整体、细分与人员表合计行、两张趋势图）。**人员级**数字（各人自身效率、效率分布卡、稳定性榜、工作时间图）不受开关影响。

### 7.5 明细的三种归宿

| 状态 | 判定 | 处理 |
|------|------|------|
| 有效 | 默认 | 参与全部统计 |
| 已忽略 | 拣货分区在「忽略分区」列表 | 完全排除出统计，仅记 `meta.ignored`，明细仍存库 |
| 丢弃 | 缺拣货人或缺时间/时长非法 | 记 `meta.dropped` |

另有 `meta.otherStore`：拣货单号前缀不是门店编码（`STORE_CODE=20005`）的其它门店明细，整行排除并单独计数。

> 忽略判定按**分区**进行，先于作业类型判定，因此「拣打一体」的被忽略分区不会混入「一体化」；取消忽略后重算即可恢复。

### 7.6 工作时间图合并规则

每笔拣货按真实起止时间 `[t0m, t1m]`（当日 00:00 起的分钟数）取区间；上一笔结束到下一笔开始间隔 ≤ `TIMELINE_MERGE_GAP = 2` 分钟视为连续作业并合并（重叠亦接续）。色块宽度 = 真实段长；在岗率 = Σ段长 ÷ (末段结束 − 首段开始)。

---

## 8. API 接口

均以 `/api` 为前缀（配置 `BASE_PATH` 时前面拼接子路径）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查：数据集数量、`basePath` |
| POST | `/api/upload?name=文件名.xlsx` | 上传拣货单（raw body，≤100MB；文件名也可用 `x-filename` 头）。返回 `{ id, mode, ...dataset }` |
| GET | `/api/datasets` | 数据集列表（不含 `payload`） |
| GET | `/api/latest?date=YYYY-MM-DD` | 最新数据集完整结果（无数据 404） |
| GET | `/api/datasets/:id?date=YYYY-MM-DD` | 指定数据集完整结果 |
| DELETE | `/api/datasets/:id` | 删除数据集，返回 `{ removed }` |
| GET | `/api/settings` | 读取 `map` / `ignore` / `jobTypes` / `unmatched` / `zones` |
| POST | `/api/settings` | 保存映射与忽略列表并重算全部历史数据集，返回 `{ ok, map, ignore, updated, skipped, failed }` |

错误响应统一为 `{ error: string }`；404 兜底额外带 `hint` 与 `availableApi`。`POST /api/settings` 的 `map` 值非法或 `ignore` 非数组均返回 400。

---

## 9. 数据模型

### datasets（数据集）

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | INTEGER PK AUTOINCREMENT | 数据集 id |
| `source_file` | TEXT | 源文件名 |
| `dates` | TEXT | 时间维度（逗号拼接的日期集合） |
| `record_count` | INTEGER | 有效明细条数 |
| `dropped` | INTEGER | 丢弃条数 |
| `ignored` | INTEGER | 已忽略条数（旧库后补列） |
| `other_store` | INTEGER | 其它门店条数（旧库后补列） |
| `eff` | REAL | 综合效率（列表展示用） |
| `payload` | TEXT NOT NULL | 整份计算结果的 JSON |
| `recs` | TEXT | 原始明细 JSON，用于改设置后重算（旧库后补列） |
| `created_at` | TEXT NOT NULL | ISO 时间；索引 `idx_datasets_created(created_at DESC)` |

### settings（键值设置）

| 列 | 类型 | 说明 |
|----|------|------|
| `key` | TEXT PK | 键名（`frontBackMap` / `ignoreZones`） |
| `value` | TEXT NOT NULL | JSON 序列化值 |
| `updated_at` | TEXT NOT NULL | ISO 时间 |

---

## 10. 环境变量与部署

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3001` | 监听端口 |
| `BASE_PATH` | 空 | 反向代理子路径前缀（如 `/hpe`） |
| `ALLOW_ORIGIN` | `*` | CORS 允许来源 |
| `HEMA_DB_PATH` | `server/data/hema.db` | SQLite 路径（测试用独立库） |

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

> 部署到新环境时需调整 [web/assets/js/config.js](./web/assets/js/config.js) 中硬编码的 `API_BASE` 域名 / IP。

---

## 11. 测试

`server/test/upload.test.js`（`npm test` → `node --test`），通过 `HEMA_DB_PATH` 指向 `os.tmpdir()` 下的临时库并在结束后清理，**不污染** `server/data/hema.db`；用例间 `beforeEach` 清空数据集。共 14 组场景：

1. 时间维度无匹配 → 新增
2. 时间维度匹配 → 覆盖更新，完全替换
3. 同维度多条历史 → 仅覆盖最新一条
4. 多日期文件按日期集合整体匹配
5. 缺少时间列 / 整列无有效时间 → 终止并提示
6. 时间格式非法 → 终止并提示（带行号）
7. 空时间单元格仍按丢弃处理
8. 覆盖后数据仍可供分区设置重算
9. 忽略分区：明细排除出统计、条数单独记录
10. 忽略按分区判定：拣打一体的被忽略分区不进入「一体化」
11. 上传时忽略未命中分区 → 取消忽略后重算可恢复
12. 忽略列表格式非法 / 全部分区被忽略 → 异常处理
13. 门店鉴别：仅导入门店编码（20005）开头的明细
14. 文件内无本门店明细 → 终止并提示

---

## 12. 二次开发指引

- **新增统计指标**：在 `compute.js` 的 `buildDataset` / `buildStats` 中计算并加入返回结构 → 在 `charts.js` 增图表渲染 → 在 `app.js` 对应 `render*` 函数中调用 → 如需卡片则在 `index.html` 加 DOM 容器。
- **新增口径参数**：加在 `server/config.js`；若可在界面调整则加进 `settings` 表（参考 `MAPPING_KEY` / `IGNORE_KEY` 的用法）。
- **修改日期的取数范围**：改 `server/index.js` 的 `withDate`。
- **切换数据来源/展示日期**：前端统一走 `refetch(id)` / `loadHistory`，不要在 `render` 之外直接改 DOM。
- **注意事项**：
  - 改 `server/*.js` 必须**重启服务**；改前端刷新页面即可（无构建）。
  - `compute.js` 不应 `require('./db')`，映射与忽略列表始终由调用方传入，保持计算层可独立测试。
  - 上传时必须同时保存 `recs`，否则该数据集此后无法重算。
