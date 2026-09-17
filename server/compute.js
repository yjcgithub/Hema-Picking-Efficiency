/* 计算层：解析 xlsx，计算效率与全部统计口径（前端只负责渲染）
   效率 = Σ拣货行数 / Σ拣货时长(h)
   作业类型 = IF(拣货单类型=拣打一体, "一体化", 前后场映射(拣货分区))
   细分 = 作业类型 × 拣货分区
   映射（拣货分区 -> 前后场分区）由调用方传入（来自数据库设置，可在页面「分区设置」修改）；
   「忽略分区」列表内的分区完全排除出统计，其明细条数单独记为 meta.ignored
*/
const XLSX = require('xlsx');
const CFG = require('./config');

function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

const pad = n => (n < 10 ? '0' : '') + n;

// 超时判定：「是否拣货超时」列取值等于 TIMEOUT_YES 视为超时（其它取值、空值均不算）
const isTimeout = v => String(v == null ? '' : v).trim() === CFG.TIMEOUT_YES;

// 「当日 00:00 起的分钟数」-> HH:mm
const minText = m => pad(Math.floor(m / 60) % 24) + ':' + pad(Math.floor(m % 60));

function parseTime(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number' && isFinite(v)) {
    // Excel 序列号 -> 墙上时间
    const ms = Math.round((v - 25569) * 86400000);
    const u = new Date(ms);
    return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
                    u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
  }
  if (typeof v === 'string' && v.trim()) {
    const m = v.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  return null;
}

const dateStr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

// 作业类型：拣货单类型为「一体化」时优先；否则按映射表取前后场分区，未命中归入「未匹配分区」
function jobType(part, orderType, map) {
  if (String(orderType == null ? '' : orderType).trim() === CFG.INTEGRATED_ORDER_TYPE) return '一体化';
  const m = map || CFG.DEFAULT_FRONT_BACK_MAP;
  const p = m[String(part == null ? '' : part).trim()];
  return p || CFG.UNMATCHED_TYPE;
}

function zoneCode(z) {
  const s = String(z == null ? '' : z).trim();
  const i = s.indexOf(' ');
  return i > 0 ? s.slice(0, i) : s;
}

// 门店鉴别：拣货单号以门店编码开头才属于本门店（单号可能被 Excel 读成数字，统一转字符串比较）
function isStoreOf(no) {
  return String(no == null ? '' : no).trim().indexOf(CFG.STORE_CODE) === 0;
}

/* 忽略分区：命中的「拣货分区」完全排除出统计。
   按分区（zone）判定，先于作业类型：拣打一体的被忽略分区同样排除，不会混进「一体化」。
   明细本身仍原样保存，改回设置后可直接重算恢复 */
function splitIgnored(recs, ignore) {
  const set = {};
  (Array.isArray(ignore) ? ignore : []).forEach(z => {
    const s = String(z == null ? '' : z).trim();
    if (s) set[s] = 1;
  });
  if (!Object.keys(set).length) return { recs, ignored: 0 };

  const kept = [];
  let ignored = 0;
  recs.forEach(r => { if (set[r.zone]) ignored++; else kept.push(r); });
  return { recs: kept, ignored };
}

// 时间维度（拣货单标识）：取文件内全部明细的日期集合，不受忽略分区影响，
// 否则某天明细全被忽略时时间维度会变化，重传同一文件会被判为新拣货单而重复入库
function dateSetOf(recs) {
  const out = [];
  recs.forEach(r => { if (out.indexOf(r.date) < 0) out.push(r.date); });
  return out.sort();
}

function sum(rs) {
  let h = 0, t = 0;
  for (const r of rs) { h += r.rows; t += r.hours; }
  return [h, t];
}
const eff = (h, t) => (t ? Math.round(h / t * 100) / 100 : null);
const r2 = v => Math.round(v * 100) / 100;
const r4 = v => Math.round(v * 10000) / 10000;

function groupBy(recs, key) {
  const g = {};
  for (const r of recs) {
    const k = key(r);
    (g[k] = g[k] || []).push(r);
  }
  return g;
}

/* ---------- 统计工具（前端展示所需口径全部在此计算） ---------- */

// 分档区间：固定档位便于跨数据集对比；含下界不含上界，末档开区间
const EFF_BINS = [[0, 60], [60, 90], [90, 120], [120, 180], [180, 240], [240, Infinity]];
const ROWS_BINS = [[0, 100], [100, 250], [250, 500], [500, 800], [800, Infinity]];

const binLabel = b => (b[1] === Infinity ? '≥ ' + b[0] : b[0] + ' – ' + b[1]);

// 按 key 落档，归集每档人数、行数（忽略空值）
function binAgg(list, key, bins) {
  const out = bins.map(b => ({ label: binLabel(b), n: 0, rows: 0 }));
  list.forEach(x => {
    const v = x[key];
    if (v == null) return;
    for (let i = 0; i < bins.length; i++) {
      if (v >= bins[i][0] && v < bins[i][1]) { out[i].n++; out[i].rows += x.rows || 0; return; }
    }
  });
  return out;
}

// 升序数组的分位数（线性插值）
function quantile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const meanOf = vals => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);

// 总体标准差（分母 n）
function stdOf(vals, avg) {
  if (vals.length < 2) return null;
  const m = avg == null ? meanOf(vals) : avg;
  let s = 0;
  vals.forEach(v => { s += (v - m) * (v - m); });
  return Math.sqrt(s / vals.length);
}

// 取某一列数值并升序排序（忽略空值）
function numsOf(list, key) {
  const out = [];
  list.forEach(x => { if (x[key] != null) out.push(x[key]); });
  return out.sort((a, b) => a - b);
}

/* 人均口径：某作业类型（或整体）在某个时段内，各人效率的算术平均（忽略该时段无记录的人）
   groups 为「人员分块」，其 persons[].data 与坐标轴逐项对齐，n = 坐标轴长度
   返回 { 作业类型名: [各时段人均], '整体': [...] } */
function unweightedFromGroups(groups, n) {
  const zeros = () => { const a = []; for (let i = 0; i < n; i++) a.push(0); return a; };
  const out = {}, allSum = zeros(), allCnt = zeros();

  (groups || []).forEach(g => {
    const acc = zeros(), cnt = zeros();
    (g.persons || []).forEach(p => {
      (p.data || []).forEach((v, i) => {
        if (v == null || i >= n) return;
        acc[i] += v; cnt[i] += 1;
        allSum[i] += v; allCnt[i] += 1;
      });
    });
    out[g.type] = acc.map((s, i) => (cnt[i] ? r2(s / cnt[i]) : null));
  });

  out['整体'] = allSum.map((s, i) => (allCnt[i] ? r2(s / allCnt[i]) : null));
  return out;
}

/* 每人效率的波动：取该人记录最多的作业类型，用其每小时效率算变异系数（标准差 ÷ 平均）
   跨作业类型基准差异大（后场 ~250、前场 ~70），混算会把「多类型支援」误判为不稳定 */
function stabilityList(groups) {
  const map = {}, order = [];
  (groups || []).forEach(g => {
    (g.persons || []).forEach(p => {
      const vals = (p.data || []).filter(v => v != null);
      const cur = map[p.person];
      if (!cur) { order.push(p.person); map[p.person] = null; }
      if (!cur || vals.length > cur.vals.length) {
        map[p.person] = { person: p.person, type: g.type, vals, rows: p.rows, hours: p.hours };
      }
    });
  });
  const out = [];
  order.forEach(name => {
    const r = map[name];
    if (!r || r.vals.length < 3) return;                 // 小时数太少，波动指标无意义
    const avg = meanOf(r.vals), sd = stdOf(r.vals, avg);
    if (!avg || sd == null) return;
    out.push({ person: r.person, type: r.type, n: r.vals.length, avg, sd, cv: sd / avg });
  });
  out.sort((a, b) => a.cv - b.cv);
  return out;
}

/* 帕累托：行数降序累计，前 frac 比例的人贡献的行数占比 */
function paretoTop(desc, totalRows, frac) {
  const n = desc.length;
  const run = [];
  let s = 0;
  desc.forEach(r => { s += r.rows; run.push(s); });
  const k = Math.max(1, Math.round(n * frac));
  return { k, pct: totalRows ? r2(run[k - 1] / totalRows * 100) : null };
}

/* ---------- 数据集构建 ---------- */

function buildDataset(recs, meta) {
  const hours = [], dates = [], personSet = {}, jtSet = {};
  for (const r of recs) {
    if (hours.indexOf(r.hour) < 0) hours.push(r.hour);
    if (dates.indexOf(r.date) < 0) dates.push(r.date);
    personSet[r.person] = 1;
    jtSet[r.jobType] = 1;
  }
  hours.sort((a, b) => a - b);
  dates.sort();

  const H = sum(recs), totalEff = eff(H[0], H[1]);

  const byJobType = Object.keys(jtSet).map(k => {
    const a = sum(groupBy(recs, x => x.jobType)[k] || []);
    return { name: k, rows: Math.round(a[0]), hours: r4(a[1]), eff: eff(a[0], a[1]) };
  }).sort((a, b) => b.eff - a.eff);

  const gp = groupBy(recs, x => x.person);
  const byPerson = Object.keys(gp).map(k => {
    const a = sum(gp[k]);
    return { name: k, rows: Math.round(a[0]), hours: r4(a[1]), eff: eff(a[0], a[1]) };
  }).sort((a, b) => b.eff - a.eff);

  const gh = groupBy(recs, x => x.hour);
  const byHour = hours.map(h => {
    const a = sum(gh[h]);
    return { hour: h, rows: Math.round(a[0]), hours: r4(a[1]), eff: eff(a[0], a[1]) };
  });

  // 细分：作业类型 × 拣货分区
  const typeRank = {};
  byJobType.forEach((d, i) => { typeRank[d.name] = i; });
  const gz = groupBy(recs, x => x.jobType + '\u0001' + x.zone);
  const byZone = Object.keys(gz).map(k => {
    const p = k.split('\u0001'), a = sum(gz[k]);
    // 人均口径：该「作业类型 × 分区」内各人效率的算术平均（顶栏取消勾选「按工时加权」时使用）
    const gp = groupBy(gz[k], x => x.person);
    const pv = Object.keys(gp).map(n => eff(...sum(gp[n]))).filter(v => v != null);
    return {
      type: p[0], zone: p[1], code: zoneCode(p[1]),
      rows: Math.round(a[0]), hours: r4(a[1]), eff: eff(a[0], a[1]),
      avg: pv.length ? r2(meanOf(pv)) : null,
      share: Math.round(a[0] / (H[0] || 1) * 1000) / 10
    };
  }).sort((a, b) => (typeRank[a.type] - typeRank[b.type]) || (b.eff - a.eff));

  const seriesJT = byJobType.map(d => {
    const rs = recs.filter(x => x.jobType === d.name);
    return {
      name: d.name,
      data: hours.map(h => {
        const sub = rs.filter(x => x.hour === h);
        return sub.length ? eff(...sum(sub)) : null;
      })
    };
  });

  const zoneByHour = {
    hours,
    series: byZone.map(z => {
      const rs = recs.filter(x => x.jobType === z.type && x.zone === z.zone);
      return {
        name: z.type + '·' + z.code, type: z.type,
        data: hours.map(h => {
          const sub = rs.filter(x => x.hour === h);
          return sub.length ? eff(...sum(sub)) : null;
        })
      };
    })
  };

  // 半小时刻度（细分粒度，仅供「作业类型 × 小时 效率」「各小时效率趋势」两张图使用；透视仍按整点小时）
  const slots = [];
  for (const r of recs) if (slots.indexOf(r.slot) < 0) slots.push(r.slot);
  slots.sort((a, b) => a - b);

  const gsl = groupBy(recs, x => x.slot);
  const bySlot = slots.map(s => {
    const a = sum(gsl[s]);
    return { slot: s, rows: Math.round(a[0]), hours: r4(a[1]), eff: eff(a[0], a[1]) };
  });

  const seriesJTSlot = byJobType.map(d => {
    const rs = recs.filter(x => x.jobType === d.name);
    return {
      name: d.name,
      data: slots.map(s => {
        const sub = rs.filter(x => x.slot === s);
        return sub.length ? eff(...sum(sub)) : null;
      })
    };
  });

  // 分块人员 × 半小时（供「人均」口径在半小时刻度上取数）
  const groupsSlot = byJobType.map(jt => {
    const rs = recs.filter(x => x.jobType === jt.name);
    const names = {};
    rs.forEach(x => { names[x.person] = 1; });
    return {
      type: jt.name,
      persons: Object.keys(names).sort().map(p => {
        const rs2 = rs.filter(x => x.person === p);
        return {
          person: p,
          data: slots.map(s => {
            const sub = rs2.filter(x => x.slot === s);
            return sub.length ? eff(...sum(sub)) : null;
          })
        };
      })
    };
  });

  // 人员（含作业类型）× 小时
  const personRows = [];
  byJobType.forEach(jt => {
    const rs = recs.filter(x => x.jobType === jt.name);
    const names = {};
    rs.forEach(x => { names[x.person] = 1; });
    Object.keys(names).sort().forEach(p => {
      const rs2 = rs.filter(x => x.person === p);
      const a = sum(rs2);
      personRows.push({
        jobType: jt.name, person: p,
        data: hours.map(h => {
          const sub = rs2.filter(x => x.hour === h);
          return sub.length ? eff(...sum(sub)) : null;
        }),
        rows: Math.round(a[0]), hours: r4(a[1]), total: eff(a[0], a[1])
      });
    });
  });
  personRows.sort((a, b) => b.total - a.total);

  // 按「作业类型」分组的人员×小时结构（组头带各小时/整体小计；附平均值/中位数及其最接近的人员）
  const groups = byJobType.map(jt => {
    const rs = recs.filter(x => x.jobType === jt.name);
    const a = sum(rs);
    const persons = personRows.filter(r => r.jobType === jt.name);
    return {
      type: jt.name,
      rows: Math.round(a[0]), hours: r4(a[1]), total: eff(a[0], a[1]),
      hourly: hours.map(h => {
        const sub = rs.filter(x => x.hour === h);
        return sub.length ? eff(...sum(sub)) : null;
      }),
      persons,
      stat: groupStat(persons)
    };
  });

  /* 人均口径序列（顶栏「按工时加权 / 人均」开关的另一种取值） */
  const uwSlot = unweightedFromGroups(groupsSlot, slots.length);
  const uwHour = unweightedFromGroups(groups, hours.length);

  /* 统计时间段：文件内最早开始 → 最晚结束（顶栏展示；跨天时给出各自的日期） */
  let sRec = null, eRec = null;
  for (const r of recs) {
    if (r.t0m == null || r.t1m == null) continue;
    if (!sRec || r.date < sRec.date || (r.date === sRec.date && r.t0m < sRec.t0m)) sRec = r;
    if (!eRec || r.date > eRec.date || (r.date === eRec.date && r.t1m > eRec.t1m)) eRec = r;
  }
  const period = sRec ? {
    dateStart: sRec.date, dateEnd: eRec.date,
    startMin: Math.round(sRec.t0m), endMin: Math.round(eRec.t1m),
    start: minText(sRec.t0m), end: minText(eRec.t1m),
    crossDay: sRec.date !== eRec.date
  } : null;

  /* 超时统计：按「超时判责」细分的小时堆积图；文件无「是否拣货超时」列时为 null。
     duties / series 按判责分组，types / typeSeries 按作业类型（前场/后场/一体化/未匹配分区）分组，
     两者是同一批超时明细的两种切分口径，供不同图表使用 */
  const tRecs = recs.filter(r => r.timeout === true);
  let timeout = null;
  if (recs.some(r => typeof r.timeout === 'boolean')) {
    const dutyOf = r => r.duty || CFG.TIMEOUT_NO_DUTY;
    const typeOf = r => r.jobType || CFG.UNMATCHED_TYPE;
    const tally = (of, all) => Object.keys(groupBy(all, of))
      .map(name => ({ name, count: all.filter(r => of(r) === name).length }))
      .sort((a, b) => b.count - a.count);
    const duties = tally(dutyOf, tRecs);
    const types = tally(typeOf, tRecs);
    // 按人员：只列出有超时单的人员（无超时的不必占表）；超时率 = 该人超时明细 ÷ 该人全部明细
    const tByPerson = groupBy(tRecs, r => r.person);
    const allByPerson = groupBy(recs, r => r.person);
    const byPerson = Object.keys(tByPerson).map(p => {
      const rs = tByPerson[p];
      const counts = {}, tcounts = {};
      rs.forEach(r => {
        const n = dutyOf(r); counts[n] = (counts[n] || 0) + 1;
        const t = typeOf(r); tcounts[t] = (tcounts[t] || 0) + 1;
      });
      const all = (allByPerson[p] || []).length;
      return { person: p, timeout: rs.length, all, rate: all ? rs.length / all : 0, duties: counts, types: tcounts };
    }).sort((a, b) => b.timeout - a.timeout);
    timeout = {
      total: tRecs.length,
      hours,
      duties,
      types,
      byPerson,
      hourly: hours.map(h => tRecs.filter(r => r.hour === h).length),
      series: duties.map(d => ({
        name: d.name,
        data: hours.map(h => tRecs.filter(r => r.hour === h && dutyOf(r) === d.name).length)
      })),
      typeSeries: types.map(d => ({
        name: d.name,
        data: hours.map(h => tRecs.filter(r => r.hour === h && typeOf(r) === d.name).length)
      }))
    };
  }

  return {
    meta: {
      sourceFile: meta.sourceFile,
      dates: meta.dates || dates,     // 时间维度：上传文件的完整日期集合（不受忽略分区影响）
      hours,
      period,
      recordCount: recs.length, dropped: meta.dropped || 0, ignored: meta.ignored || 0,
      otherStore: meta.otherStore || 0
    },
    totals: {
      rows: Math.round(H[0]), hours: r4(H[1]), eff: totalEff,
      persons: byPerson.length, jobTypes: byJobType.length
    },
    byJobType, byPerson, byHour, byZone,
    jobTypeByHour: { hours, series: seriesJT, total: byHour.map(d => d.eff), unweighted: uwHour },
    zoneByHour,
    bySlot,
    jobTypeBySlot: { slots, series: seriesJTSlot, total: bySlot.map(d => d.eff), groups: groupsSlot, unweighted: uwSlot },
    personByHour: { hours, rows: personRows, groups },
    stats: buildStats(recs, groups, byPerson, H),
    timeline: buildTimeline(recs),
    timeout
  };
}

/* 人员工作时间图：由拣货单的「起止时间」反推每人每天的在岗时段
   - 按「人 × 日期」成组，每组即一个「人·日班次」
   - 每笔拣货单取其实时区间 [t0m, t1m]（当日 00:00 起的分钟数）；
     早期数据集没有该字段，回退为「半小时槽位起点 + 拣货时长」近似
   - 上一笔拣货结束到下一笔拣货开始的间隔 <= BUFFER(分钟) 时视为连续作业，合并为一段
   - 行级指标：first/last/span（首末与跨度）、busy（Σ段长）、idle（空档）、rate（在岗率）、maxGap（最大空档）
   行按拣货效率（Σ行数 ÷ Σ有效作业时长）降序排列，效率相同再按 first 升序。 */
const TIMELINE_MERGE_GAP = 2;   // 上次拣货结束 → 下次拣货开始 的缓冲（分钟）

// 单笔拣货的时间区间（当日 00:00 起的分钟数）
function recRange(r) {
  if (r.t0m != null && r.t1m != null && r.t1m > r.t0m) return [r.t0m, r.t1m];
  const s = (r.slot != null ? r.slot : r.hour) * 60;
  return [s, s + r.hours * 60];
}

function buildTimeline(recs) {
  const order = [], g = new Map();
  recs.forEach(r => {
    const k = r.person + '\u0001' + r.date;
    let e = g.get(k);
    if (!e) { e = { person: r.person, date: r.date, list: [] }; g.set(k, e); order.push(k); }
    e.list.push(r);
  });

  const rows = order.map(k => {
    const grp = g.get(k);

    // 1) 取每笔拣货的起止区间，按开始时间排序
    const list = grp.list.map(r => ({ r: r, rg: recRange(r) })).sort((a, b) => a.rg[0] - b.rg[0]);

    // 2) 逐笔合并：与上一段间隔 <= BUFFER 视为连续作业（重叠亦接续）
    const segs = [];
    let busy = 0, maxGap = 0, totalRows = 0;
    list.forEach(it => {
      const s = Math.round(it.rg[0]), e = Math.round(it.rg[1]);
      const last = segs[segs.length - 1];
      if (last && s - last.e <= TIMELINE_MERGE_GAP) {
        if (e > last.e) { busy += e - last.e; last.e = e; }
        last.orders++;
        last.rows += it.r.rows;
        last.types[it.r.jobType] = (last.types[it.r.jobType] || 0) + it.r.rows;
      } else {
        if (last) maxGap = Math.max(maxGap, s - last.e);
        segs.push({ s, e, orders: 1, rows: it.r.rows, types: { [it.r.jobType]: it.r.rows } });
        busy += e - s;
      }
      totalRows += it.r.rows;
    });

    // 3) 段内主要作业类型按行数取最大；段效率 = 行数 ÷ 段长(h)
    const out = segs.map(sg => {
      let type = '', best = -1;
      Object.keys(sg.types).forEach(t => { if (sg.types[t] > best) { best = sg.types[t]; type = t; } });
      const mins = sg.e - sg.s;
      return {
        s: sg.s, e: sg.e, type,
        rows: Math.round(sg.rows), orders: sg.orders,
        eff: mins > 0 ? r2(sg.rows / (mins / 60)) : null
      };
    });

    // 4) 行级指标
    const first = segs[0].s, lastEnd = segs[segs.length - 1].e, span = lastEnd - first;
    return {
      person: grp.person, date: grp.date,
      first, last: lastEnd, span, busy, idle: span - busy,
      rate: span ? r4(busy / span) : null, maxGap,
      orders: list.length, rows: Math.round(totalRows),
      segs: out
    };
  });

  // 按拣货效率（Σ行数 ÷ Σ有效作业时长，即行/min）降序；有效作业时长为 0 的排最后
  const effOf = r => (r.busy > 0 ? r.rows / r.busy : -1);
  rows.sort((a, b) => (effOf(b) - effOf(a)) || (a.first - b.first));
  return { mergeGap: TIMELINE_MERGE_GAP, rows };
}

// 组内「各人总计效率」的平均值 / 中位数，以及最接近它们的人员（透视表标注用）
function groupStat(persons) {
  const vals = persons.map(p => p.total);
  const sorted = vals.filter(v => v != null).sort((a, b) => a - b);
  const avg = meanOf(sorted), med = quantile(sorted, 0.5);
  const nearest = v => {
    let bi = -1, bd = Infinity;
    vals.forEach((x, i) => {
      if (x == null) return;
      const d = Math.abs(x - v);
      if (d < bd) { bd = d; bi = i; }
    });
    return bi < 0 ? null : persons[bi].person;
  };
  return {
    avg, median: med,
    avgPerson: avg == null ? null : nearest(avg),
    medianPerson: med == null ? null : nearest(med)
  };
}

/* 统计口径（前端直接渲染） */
function buildStats(recs, groups, byPerson, H) {
  const totalRows = Math.round(H[0]);
  const allPersons = [];
  groups.forEach(g => { allPersons.push.apply(allPersons, g.persons || []); });
  const personStats = list => {
    const vs = list.map(p => p.total).filter(v => v != null);
    return { avg: vs.length ? r2(meanOf(vs)) : null, n: vs.length };
  };
  const personMean = { all: personStats(allPersons), byType: {} };
  groups.forEach(g => { personMean.byType[g.type] = personStats(g.persons || []); });

  // 人员效率分布（按各人总计效率）
  const effs = numsOf(byPerson, 'eff');
  let personDist = null;
  if (effs.length) {
    const avg = meanOf(effs), sd = stdOf(effs, avg);
    personDist = {
      n: byPerson.length, avg, median: quantile(effs, 0.5),
      q1: quantile(effs, 0.25), q3: quantile(effs, 0.75),
      min: effs[0], max: effs[effs.length - 1], sd,
      cv: (avg && sd != null) ? sd / avg : null
    };
  }

  // 行数分布与集中度
  const rowsArr = numsOf(byPerson, 'rows');
  const desc = byPerson.slice().sort((a, b) => b.rows - a.rows);

  return {
    personMean,
    personDist,
    effBins: binAgg(byPerson, 'eff', EFF_BINS),
    stability: stabilityList(groups),
    boxplot: buildBoxplot(groups),
    rowsStat: rowsArr.length ? {
      n: byPerson.length, total: totalRows,
      avg: totalRows / byPerson.length,
      median: quantile(rowsArr, 0.5),
      min: rowsArr[0], max: rowsArr[rowsArr.length - 1],
      top10: paretoTop(desc, totalRows, 0.1),
      top25: paretoTop(desc, totalRows, 0.25)
    } : null,
    rowsTop: desc.slice(0, 10).map(r => ({
      name: r.name, rows: r.rows,
      share: totalRows ? r2(r.rows / totalRows * 100) : 0
    })),
    rowsBins: binAgg(byPerson, 'rows', ROWS_BINS)
  };
}

// 箱线图（整体 + 各作业类型，按各人总计效率；样本不足 2 人的组不画）
function buildBoxplot(groups) {
  const sets = [{ name: '整体', vals: [] }];
  groups.forEach(g => sets.push({ name: g.type, vals: [] }));
  groups.forEach(g => {
    (g.persons || []).forEach(p => {
      if (p.total == null) return;
      sets[0].vals.push(p.total);
      for (let i = 1; i < sets.length; i++) {
        if (sets[i].name === g.type) { sets[i].vals.push(p.total); break; }
      }
    });
  });
  return sets.filter(s => s.vals.length >= 2).map(s => {
    s.vals.sort((a, b) => a - b);
    const n = s.vals.length;
    return {
      name: s.name, n,
      min: s.vals[0], max: s.vals[n - 1],
      q1: quantile(s.vals, 0.25), median: quantile(s.vals, 0.5), q3: quantile(s.vals, 0.75),
      mean: meanOf(s.vals)
    };
  });
}

/* ---------- 解析入口 ---------- */

/* 时间维度校验：上传文件以「拣货开始时间」的日期集合作为时间维度，覆盖/新增的匹配依据
   - 整列没有任何可解析取值 -> 缺失有效时间字段
   - 非空取值无法解析           -> 时间格式非法
   空单元格沿用原有口径：该行作为无效明细被丢弃，不阻断上传 */
function validateStartTime(matrix, col) {
  let valid = 0;
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row) continue;
    const raw = row[col];
    if (raw == null || String(raw).trim() === '') continue;
    if (!parseTime(raw)) {
      throw new Error('时间字段格式非法：第 ' + (r + 1) + ' 行「' + CFG.TIME_COLUMN + '」=' +
        JSON.stringify(raw) + '，应为 YYYY-MM-DD HH:mm[:ss] 或 Excel 日期');
    }
    valid++;
  }
  if (!valid) {
    throw new Error('上传文件缺少有效时间字段：「' + CFG.TIME_COLUMN + '」列没有任何可解析的时间值' +
      '，无法确定拣货单的时间维度');
  }
}

function buildFromMatrix(matrix, meta, map) {
  if (!matrix || !matrix.length) throw new Error('表格为空');
  const header = matrix[0].map(h => String(h == null ? '' : h).trim());
  const idx = {};
  header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });

  if (!(CFG.TIME_COLUMN in idx)) {
    throw new Error('上传文件缺少时间字段「' + CFG.TIME_COLUMN + '」，无法确定拣货单的时间维度');
  }
  const missing = CFG.REQUIRED_COLUMNS.filter(n => !(n in idx));
  if (missing.length) throw new Error('上传文件缺少必需列：' + missing.join('、'));

  validateStartTime(matrix, idx[CFG.TIME_COLUMN]);

  // 超时相关列在旧文件里可能不存在：缺失时该明细的 timeout 记 null，前端不展示超时统计
  const tmIdx = CFG.TIMEOUT_COLUMN in idx ? idx[CFG.TIMEOUT_COLUMN] : null;
  const dutyIdx = CFG.TIMEOUT_DUTY_COLUMN in idx ? idx[CFG.TIMEOUT_DUTY_COLUMN] : null;

  const recs = [];
  let dropped = 0;
  let otherStore = 0;
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row) continue;
    const no = row[idx['拣货单号']];
    const person = row[idx['拣货人']];
    if (no == null || no === '' || person == null || String(person).trim() === '') { dropped++; continue; }
    // 门店鉴别：非本门店（单号前缀不是门店编码）的明细整行排除，单独计数，不计入「丢弃」
    if (!isStoreOf(no)) { otherStore++; continue; }
    const t0 = parseTime(row[idx[CFG.TIME_COLUMN]]);
    const t1 = parseTime(row[idx['拣货完成时间']]);
    if (!t0 || !t1) { dropped++; continue; }
    const hrs = (t1 - t0) / 3600000;
    if (!(hrs > 0)) { dropped++; continue; }
    const zone = String(row[idx['拣货分区']] == null ? '' : row[idx['拣货分区']]).trim();
    // orderType（拣货单类型）随明细一起保留，改映射后可只重算作业类型而不必重新上传
    const orderType = String(row[idx['拣货单类型']] == null ? '' : row[idx['拣货单类型']]).trim();
    const h0 = t0.getHours();
    // 工作时间图用：当日起始分钟数 + 时长（分钟），保证「完成 − 开始」与 hrs 一致（精确到分钟）
    const t0m = Math.round(h0 * 60 + t0.getMinutes() + t0.getSeconds() / 60);
    recs.push({
      date: dateStr(t0), hour: h0, slot: h0 + (t0.getMinutes() >= 30 ? 0.5 : 0),
      t0m, t1m: t0m + Math.round(hrs * 60),
      jobType: jobType(zone, orderType, map),
      zone, orderType, code: zoneCode(zone),
      person: String(person).trim(),
      rows: toNumber(row[idx['拣货行数']]), hours: hrs,
      timeout: tmIdx == null ? null : isTimeout(row[tmIdx]),
      duty: dutyIdx == null ? '' : String(row[dutyIdx] == null ? '' : row[dutyIdx]).trim()
    });
  }
  if (!recs.length) {
    if (otherStore) {
      throw new Error('暂时只支持门店' + CFG.STORE_CODE + '的数据分析');
    }
    throw new Error('未解析到有效明细（请确认是「门店视角：拣货单」导出文件）');
  }
  return { recs, meta: { sourceFile: (meta && meta.sourceFile) || '上传文件', dropped, otherStore } };
}

// 从 xlsx Buffer 解析：返回 { dataset, recs }（recs 为未过滤的原始明细，供改设置后重算）
function buildFromBuffer(buf, sourceFile, map, ignore) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const name = wb.SheetNames.indexOf('data') >= 0 ? 'data' : wb.SheetNames[0];
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
  const built = buildFromMatrix(matrix, { sourceFile }, map);
  const kept = splitIgnored(built.recs, ignore);
  if (!kept.recs.length) {
    throw new Error('全部有效明细的分区都被「忽略分区」排除，无数据可统计（请先在「分区设置」中取消忽略）');
  }
  return {
    dataset: buildDataset(kept.recs, {
      sourceFile, dropped: built.meta.dropped, ignored: kept.ignored,
      otherStore: built.meta.otherStore,
      dates: dateSetOf(built.recs)
    }),
    recs: built.recs
  };
}

// 用新映射与忽略列表重算作业类型并重建数据集（改「分区设置」后调用）
// date 非空时只重算该日期的明细（前端日期下拉切换用），时间维度仍保留原数据集的完整日期集合
function rebuild(recs, meta, map, ignore, date) {
  const mapped = recs.map(r => Object.assign({}, r, { jobType: jobType(r.zone, r.orderType, map) }));
  const scope = date ? mapped.filter(r => r.date === date) : mapped;
  if (!scope.length) throw new Error('数据集内没有日期 ' + date + ' 的明细');
  const kept = splitIgnored(scope, ignore);
  if (!kept.recs.length) throw new Error('全部有效明细的分区都被「忽略分区」排除，无数据可统计');
  return buildDataset(kept.recs, {
    sourceFile: meta.sourceFile, dropped: meta.dropped || 0, ignored: kept.ignored,
    otherStore: meta.otherStore || 0,
    dates: meta.dates || dateSetOf(mapped)
  });
}

module.exports = { buildFromBuffer, buildFromMatrix, buildDataset, rebuild, jobType, zoneCode };
