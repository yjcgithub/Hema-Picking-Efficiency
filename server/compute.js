/* 计算层：解析 xlsx 并计算效率（口径与报表一致）
   效率 = Σ拣货行数 / Σ拣货时长(h)
   作业类型 = IF(任务子类型=拆零拣打一体, "一体化", 前后场映射(拣货分区))
   细分 = 作业类型 × 拣货分区
*/
const XLSX = require('xlsx');
const CFG = require('./config');

function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}

const pad = n => (n < 10 ? '0' : '') + n;

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

function jobType(part, sub) {
  if (String(sub == null ? '' : sub).trim() === CFG.INTEGRATED_SUBTYPE) return '一体化';
  const p = CFG.FRONT_BACK_MAP[String(part == null ? '' : part).trim()];
  return p || '未匹配分区';
}

function zoneCode(z) {
  const s = String(z == null ? '' : z).trim();
  const i = s.indexOf(' ');
  return i > 0 ? s.slice(0, i) : s;
}

function sum(rs) {
  let h = 0, t = 0;
  for (const r of rs) { h += r.rows; t += r.hours; }
  return [h, t];
}
const eff = (h, t) => (t ? Math.round(h / t * 100) / 100 : null);
const r4 = v => Math.round(v * 10000) / 10000;

function groupBy(recs, key) {
  const g = {};
  for (const r of recs) {
    const k = key(r);
    (g[k] = g[k] || []).push(r);
  }
  return g;
}

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
    return {
      type: p[0], zone: p[1], code: zoneCode(p[1]),
      rows: Math.round(a[0]), hours: r4(a[1]), eff: eff(a[0], a[1]),
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

  // 按「作业类型」分组的人员×小时结构（组头带各小时/整体小计）
  const groups = byJobType.map(jt => {
    const rs = recs.filter(x => x.jobType === jt.name);
    const a = sum(rs);
    return {
      type: jt.name,
      rows: Math.round(a[0]), hours: r4(a[1]), total: eff(a[0], a[1]),
      hourly: hours.map(h => {
        const sub = rs.filter(x => x.hour === h);
        return sub.length ? eff(...sum(sub)) : null;
      }),
      persons: personRows.filter(r => r.jobType === jt.name)
    };
  });

  return {
    meta: {
      sourceFile: meta.sourceFile, dates, hours,
      recordCount: recs.length, dropped: meta.dropped || 0
    },
    totals: {
      rows: Math.round(H[0]), hours: r4(H[1]), eff: totalEff,
      persons: byPerson.length, jobTypes: byJobType.length
    },
    byJobType, byPerson, byHour, byZone,
    jobTypeByHour: { hours, series: seriesJT, total: byHour.map(d => d.eff) },
    zoneByHour,
    bySlot,
    jobTypeBySlot: { slots, series: seriesJTSlot, total: bySlot.map(d => d.eff), groups: groupsSlot },
    personByHour: { hours, rows: personRows, groups }
  };
}

function buildFromMatrix(matrix, meta) {
  if (!matrix || !matrix.length) throw new Error('表格为空');
  const header = matrix[0].map(h => String(h == null ? '' : h).trim());
  const idx = {};
  header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });

  const missing = CFG.REQUIRED_COLUMNS.filter(n => !(n in idx));
  if (missing.length) throw new Error('上传文件缺少必需列：' + missing.join('、'));

  const recs = [];
  let dropped = 0;
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row) continue;
    const no = row[idx['拣货单号']];
    const person = row[idx['拣货人']];
    if (no == null || no === '' || person == null || String(person).trim() === '') { dropped++; continue; }
    const t0 = parseTime(row[idx['拣货开始时间']]);
    const t1 = parseTime(row[idx['拣货完成时间']]);
    if (!t0 || !t1) { dropped++; continue; }
    const hrs = (t1 - t0) / 3600000;
    if (!(hrs > 0)) { dropped++; continue; }
    const zone = String(row[idx['拣货分区']] == null ? '' : row[idx['拣货分区']]).trim();
    const h0 = t0.getHours();
    recs.push({
      date: dateStr(t0), hour: h0, slot: h0 + (t0.getMinutes() >= 30 ? 0.5 : 0),
      jobType: jobType(zone, row[idx['任务子类型']]),
      zone, code: zoneCode(zone),
      person: String(person).trim(),
      rows: toNumber(row[idx['拣货行数']]), hours: hrs
    });
  }
  if (!recs.length) throw new Error('未解析到有效明细（请确认是「门店视角：拣货单」导出文件）');
  return buildDataset(recs, { sourceFile: (meta && meta.sourceFile) || '上传文件', dropped });
}

// 从 xlsx Buffer 解析并计算
function buildFromBuffer(buf, sourceFile) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const name = wb.SheetNames.indexOf('data') >= 0 ? 'data' : wb.SheetNames[0];
  const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
  return buildFromMatrix(matrix, { sourceFile });
}

module.exports = { buildFromBuffer, buildFromMatrix, buildDataset, jobType, zoneCode };
