/* 服务端自绘「效率透视表」（SVG → PNG），替代原来的无头浏览器截图。
 *
 * 为什么不截图：无头浏览器（puppeteer + Chromium）在小服务器上启动慢、吃内存。
 * 而推送要的其实是一张「人员 × 小时」效率表，服务端手里的数据集 payload 里就有一切，
 * 直接拼 SVG 再用 @resvg/resvg-js 光栅化成 PNG（纯 CPU，无需 Chrome）。
 *
 * 数据来源：db.latest() 的最新数据集 payload（personByHour / meta.period / meta.bucket）。
 * 输出：{ period, blocks: [{ name, image: 'data:image/png;base64,…', eff, avg, median }] }
 *
 * 中文字体：resvg 默认加载系统字体；容器内若没有中文字体，用环境变量指定：
 *   HEMA_SVG_FONT_FILE  字体文件路径（多个用 path.delimiter 分隔）
 *   HEMA_SVG_FONT_DIR   字体目录
 *   HEMA_SVG_FONT       默认字体名（默认 "Noto Sans SC"）
 */
'use strict';

const fs = require('fs');
const path = require('path');

let Resvg = null;
let loadErr = '';
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { loadErr = e.message || String(e); }

function available() { return !!Resvg; }
function unavailableReason() {
  if (Resvg) return '';
  return '未安装 @resvg/resvg-js（服务端无法自绘图片）：请在 server 目录执行 npm install' + (loadErr ? '（' + loadErr + '）' : '');
}

/* ---------- 视觉常量：与前端 web/assets/css/style.css 的设计变量对齐 ---------- */
// 分块标识色（web/assets/js/config.js 的 COLORS）
const COLORS = { '前场合流': '#14b8a6', '后场合流': '#f97316', '一体化': '#2563eb' };
// 分块展示顺序（前端 PIVOT_ORDER）
const PIVOT_ORDER = ['前场合流', '后场合流', '一体化'];
// 推送里的分块短名
const LABEL = { '前场合流': '前场', '后场合流': '后场' };
// 达标线（行/h）：有达标线的分块按达标线分档，否则按块内相对色阶
// 可由「分区设置」覆盖：出图前调用 setTargets(currentTargets())，传空对象 = 不设达标线
let TARGETS = { '后场合流': 260 };
function setTargets(t) {
  TARGETS = (t && typeof t === 'object') ? Object.assign({}, t) : { '后场合流': 260 };
}
// 热力色阶锚点（与前端 HEAT_STOPS 一致：红 → 黄 → 绿）
const HEAT_STOPS = [
  { r: 0.000, rgb: [254, 226, 226] },
  { r: 0.167, rgb: [254, 243, 199] },
  { r: 0.333, rgb: [254, 249, 195] },
  { r: 0.500, rgb: [217, 249, 157] },
  { r: 0.667, rgb: [167, 243, 208] },
  { r: 0.833, rgb: [110, 231, 183] },
  { r: 1.000, rgb: [52, 211, 153] }
];

// 取色板：直接对应 style.css 的 CSS 变量（--txt / --muted / --line / --line-mid …）
const TXT = '#1e293b', MUTED = '#7c8aa0', LINE_MID = '#d8e1ee';
const HEAD_BG = '#f8fafc', TH_TXT = '#475569', TOTAL_BG = '#f8fafc';
const AVG_BORDER = '#93c5fd', MEDIAN_BORDER = '#d8b4fe';
const AVG_TXT = '#1d4ed8', MEDIAN_TXT = '#7e22ce';
const TARGET_LINE = '#f59e0b', TARGET_TXT = '#b45309';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function fmtNum(v, d) { return (v == null || isNaN(Number(v))) ? '-' : Number(v).toFixed(d == null ? 1 : d); }

/* 粗略估算文本宽度（浏览器里的实际排版无法在 Node 侧量取）：
   中日韩等全角字符按 1em，数字按 0.56em（页面用了 tabular-nums），其余按 0.6em */
function textW(s, fs) {
  let w = 0;
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80 || (c >= 0x1100 && c <= 0x115f)) w += fs;
    else if (ch === ' ') w += fs * 0.3;
    else if (ch >= '0' && ch <= '9') w += fs * 0.56;
    else w += fs * 0.6;
  }
  return w;
}

// 按最大宽度折行（中文无空格，逐字累加；数字 / 英文按估算宽度）
function wrapText(s, maxW, fs) {
  const lines = [];
  let cur = '', w = 0;
  for (const ch of String(s == null ? '' : s)) {
    const cw = textW(ch, fs);
    if (w + cw > maxW && cur) { lines.push(cur); cur = ''; w = 0; }
    cur += ch; w += cw;
  }
  if (cur) lines.push(cur);
  return lines;
}

// 平滑折线（Catmull-Rom → 三次贝塞尔），对应 ECharts 的 smooth: true
function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
  const t = 0.2;
  let d = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ',' +
      c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1);
  }
  return d;
}

function heatColor(v, type, mn, mx) {
  if (v == null || isNaN(Number(v))) return '';
  const t = TARGETS[type];
  let r;
  if (t) {
    // 有达标线的分块（后场合流）：以达标线为中心的窄幅刻度，放大达标线附近的差异
    // 半幅 = max(块内离达标线最远的值, 达标线 × 15%)；原来按 v/t 分档，达标线以上全挤在同一个深绿
    const half = Math.max(mx - t, t - mn, t * 0.15);
    r = 0.5 + (v - t) / (2 * half);
  } else {
    r = mx > mn ? (v - mn) / (mx - mn) : 1;
  }
  r = Math.max(0, Math.min(1, r));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const a = HEAT_STOPS[i - 1], b = HEAT_STOPS[i];
    if (r <= b.r) {
      const k = (b.r === a.r) ? 0 : (r - a.r) / (b.r - a.r);
      const c = a.rgb.map((x, j) => Math.round(x + (b.rgb[j] - x) * k));
      return 'rgb(' + c.join(',') + ')';
    }
  }
  return '';
}

// 时间轴列头标签：小时「N点」/ 日期「MM-DD」/ 周「MM-DD~MM-DD」
function axisLabel(v, unit) {
  if (unit === 'week') {
    const s = String(v);
    const d = new Date(s + 'T00:00:00');
    if (isNaN(d.getTime())) return s;
    const e = new Date(d); e.setDate(d.getDate() + 6);
    const p = n => (n < 10 ? '0' : '') + n;
    const eStr = e.getFullYear() + '-' + p(e.getMonth() + 1) + '-' + p(e.getDate());
    return s.slice(5) + '~' + eStr.slice(5);
  }
  if (unit === 'date') return String(v).slice(5);
  return v + '点';
}

function orderBlocks(groups) {
  return groups.slice().sort((a, b) => {
    let ia = PIVOT_ORDER.indexOf(a.type), ib = PIVOT_ORDER.indexOf(b.type);
    if (ia < 0) ia = 90; if (ib < 0) ib = 90;
    return ia - ib;
  });
}

/* ---------- 单块 SVG：按 style.css 里「效率透视分块」的样式绘制 ---------- */
function blockSvg(g, hours, unit, font) {
  const n = hours.length;
  const colP = 84, colH = 58, colT = 74;                 // 首列（吸左）84，时段列 58，总计 74
  const pad = 16, rowH = 24, headH = 24, chartH = 70, noteLh = 20;
  const fTd = 13.5, fTh = 13, fTitle = 14.5, fSmall = 11.5, fNote = 11.5, fAxis = 11.5;

  const persons = g.persons || [];
  const stat = g.stat || {};
  const color = COLORS[g.type] || '#64748b';
  const hourly = g.hourly || [];
  const vals = hourly.filter(v => v != null && !isNaN(Number(v)));
  const mn = vals.length ? Math.min.apply(null, vals) : 0;
  const mx = vals.length ? Math.max.apply(null, vals) : 0;

  const small = '整体 ' + fmtNum(g.total, 1) + ' 行/h · ' + Number(g.rows || 0).toLocaleString('en-US') +
    ' 行 · ' + fmtNum(g.hours, 2) + ' h · ' + persons.length + ' 人' +
    (TARGETS[g.type] ? ' · 达标线 ' + TARGETS[g.type] + ' 行/h' : '');
  const note = '小计＝该范围内 Σ拣货行数 ÷ Σ拣货时长（按工时加权）；取消勾选顶栏「按工时加权」后，' +
    '小计改为该范围内各人效率的算术平均（人均口径，随开关同步）；' +
    '「平均值 / 中位数」按各人总计效率统计，浅蓝 / 浅紫边框标出与之最接近的人员行；「-」表示该' +
    (unit === 'hour' ? '时段' : (unit === 'week' ? '周' : '日')) + '无记录。';
  const avgTxt = stat.avg == null ? '' : ('平均 ' + fmtNum(stat.avg, 1) + ' 行/h');
  const medTxt = stat.median == null ? '' : ('中位数 ' + fmtNum(stat.median, 1) + ' 行/h');

  // 标题一行排布（与页面一致：▼ + 色点 + 作业类型 + 小字 + 「平均 / 中位数」图例，依次左排）
  let cx = 10 + 7 + 9 + 7 + textW(g.type, fTitle) + 7 + textW(small, fSmall);
  if (avgTxt) cx += 7 + 9 + 4 + textW(avgTxt, fSmall);
  if (medTxt) cx += 7 + 9 + 4 + textW(medTxt, fSmall);

  const tableW0 = colP + n * colH + colT;
  const W = Math.round(Math.max(pad * 2 + tableW0, pad + cx + pad));
  // 表格铺满卡片宽度（页面 table 为 width:100%）：多出的宽度均分给时段列
  const colHour = n > 0 ? Math.max(colH, (W - pad * 2 - colP - colT) / n) : colH;
  const tableW = colP + n * colHour + colT;

  const titleBase = (pad + 11).toFixed(1);
  const tableY = pad + 22 + 6;
  const bodyY = tableY + headH;
  const totalY = bodyY + persons.length * rowH;
  const chartY = totalY + rowH;
  const tableH = headH + rowH * (persons.length + 1) + chartH;
  const noteTop = tableY + tableH + 10;
  const noteLines = wrapText(note, tableW, fNote);
  const H = Math.round(noteTop + noteLines.length * noteLh + pad);

  const x0 = pad, x1 = pad + tableW;
  const bl = (y, rh, fs) => (y + rh / 2 + fs * 0.36).toFixed(1);
  const parts = [];

  parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>');

  // ---- 标题行 ----
  const dot = (x, c) => '<circle cx="' + (x + 4.5) + '" cy="' + (pad + 6.5) + '" r="4.5" fill="' + c + '"/>';
  let tx = pad;
  parts.push('<text x="' + tx + '" y="' + titleBase + '" font-size="10" fill="' + MUTED + '">▼</text>');
  tx += 10 + 7;
  parts.push(dot(tx, color));
  tx += 9 + 7;
  parts.push('<text x="' + tx + '" y="' + titleBase + '" font-size="' + fTitle + '" font-weight="600" fill="' + TXT +
    '">' + esc(g.type) + '</text>');
  tx += textW(g.type, fTitle) + 7;
  parts.push('<text x="' + tx + '" y="' + titleBase + '" font-size="' + fSmall + '" fill="' + MUTED + '">' +
    esc(small) + '</text>');
  tx += textW(small, fSmall);
  if (avgTxt) {
    tx += 7;
    parts.push(dot(tx, AVG_BORDER));
    tx += 9 + 4;
    parts.push('<text x="' + tx + '" y="' + titleBase + '" font-size="' + fSmall + '" fill="' + MUTED + '">' +
      esc(avgTxt) + '</text>');
    tx += textW(avgTxt, fSmall);
  }
  if (medTxt) {
    tx += 7;
    parts.push(dot(tx, MEDIAN_BORDER));
    tx += 9 + 4;
    parts.push('<text x="' + tx + '" y="' + titleBase + '" font-size="' + fSmall + '" fill="' + MUTED + '">' +
      esc(medTxt) + '</text>');
  }

  // ---- 表格（圆角外框 + 裁剪，对应 .table-wrap 的 border-radius: 10px / overflow: hidden） ----
  const clipId = 'clip' + Math.abs((g.type || '').length * 7 + n * 13);
  parts.push('<defs><clipPath id="' + clipId + '"><rect x="' + x0 + '" y="' + tableY + '" width="' + tableW +
    '" height="' + tableH + '" rx="10"/></clipPath></defs>');
  const inner = [];
  const rectAt = (x, y, w, h, fill) => inner.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' +
    h + '" fill="' + fill + '"/>');
  const textStr = (x, y, s, fs, fill, weight, anchor) => '<text x="' + x + '" y="' + y +
    '" font-size="' + fs + '" fill="' + fill + '"' + (weight ? ' font-weight="' + weight + '"' : '') +
    (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(s) + '</text>';
  const textAt = (x, y, s, fs, fill, weight, anchor) => inner.push(textStr(x, y, s, fs, fill, weight, anchor));

  // 表头
  rectAt(x0, tableY, tableW, headH, HEAD_BG);
  textAt(x0 + 8, bl(tableY, headH, fTh), '拣货人', fTh, TH_TXT, 600);
  hours.forEach((h, i) => {
    textAt(x0 + colP + (i + 0.5) * colHour, bl(tableY, headH, fTh), axisLabel(h, unit), fTh, TH_TXT, 600, 'middle');
  });
  textAt(x0 + colP + n * colHour + colT / 2, bl(tableY, headH, fTh), '总计', fTh, TH_TXT, 600, 'middle');

  // 人员行（热力底色；平均值 / 中位数最接近的行加浅蓝 / 浅紫边框 + 右上角标注）
  const heatRect = (x, y, w, v) => {
    const bg = heatColor(v, g.type, mn, mx);
    if (bg) inner.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + rowH + '" fill="' + bg + '"/>');
  };
  const nearRects = [];   // 平均值 / 中位数 所在行的彩色边框
  const badges = [];      // 边框上的小标注（最后绘制，压在边框之上，对应 .stat-badge 的 z-index: 4）
  persons.forEach((p, ri) => {
    const y = bodyY + ri * rowH;
    const isAvg = p.person === stat.avgPerson && stat.avg != null;
    const isMed = p.person === stat.medianPerson && stat.median != null;
    rectAt(x0, y, colP, rowH, '#ffffff');
    textAt(x0 + 8, bl(y, rowH, fTd), p.person, fTd, TXT);
    (p.data || []).forEach((v, i) => {
      const x = x0 + colP + i * colHour;
      heatRect(x, y, colHour, v);
      textAt(x + colHour / 2, bl(y, rowH, fTd), fmtNum(v, 1), fTd, TXT, null, 'middle');
    });
    const tx2 = x0 + colP + n * colHour;
    heatRect(tx2, y, colT, p.total);
    textAt(tx2 + colT / 2, bl(y, rowH, fTd), fmtNum(p.total, 1), fTd, TXT, null, 'middle');
    if (isMed || isAvg) {
      const c = isMed ? MEDIAN_BORDER : AVG_BORDER;
      const label = isMed ? '中位数' : '平均值';
      const lc = isMed ? MEDIAN_TXT : AVG_TXT;
      nearRects.push('<rect x="' + (x0 + 1) + '" y="' + (y + 1) + '" width="' + (tableW - 2) + '" height="' +
        (rowH - 2) + '" fill="none" stroke="' + c + '" stroke-width="2"/>');
      // 标注浮在所在行上边框上、右对齐（对应 .stat-badge，白底压在彩色边框之上）
      const bh = 13, bfs = 8.5;
      const byC = y - 1;                                  // 标注中心比行上边框高 1px（对应 .stat-badge 的 top:-1px + translateY(-50%)）
      const bw = textW(label, bfs) + 4;
      badges.push('<rect x="' + (x1 - 2 - bw) + '" y="' + (byC - bh / 2) + '" width="' + bw + '" height="' + bh +
        '" rx="2" fill="#ffffff"/>');
      // 基线按白底矩形中心推算，保证文字在白底内垂直居中
      badges.push(textStr(x1 - 4, (byC + bfs * 0.36).toFixed(1), label, bfs, lc, 700, 'end'));
    }
  });

  // 小计行
  rectAt(x0, totalY, tableW, rowH, TOTAL_BG);
  textAt(x0 + 8, bl(totalY, rowH, fTd), '小计', fTd, TXT, 700);
  hourly.forEach((v, i) => {
    const x = x0 + colP + i * colHour;
    heatRect(x, totalY, colHour, v);
    textAt(x + colHour / 2, bl(totalY, rowH, fTd), fmtNum(v, 1), fTd, TXT, 700, 'middle');
  });
  heatRect(x0 + colP + n * colHour, totalY, colT, g.total);
  textAt(x0 + colP + n * colHour + colT / 2, bl(totalY, rowH, fTd), fmtNum(g.total, 1), fTd, TXT, 700, 'middle');

  // ---- 折线图行（紧贴小计行，对应 .pivot-chart-row；绘图区只覆盖时段列） ----
  rectAt(x0, chartY, tableW, chartH, '#ffffff');
  const plotX0 = x0 + colP, plotX1 = x0 + colP + n * colHour;
  const plotY0 = chartY + 6, plotY1 = chartY + chartH - 18;
  if (n > 0 && vals.length) {
    // y 量程按数据收紧，但把「达标线」一并纳入：否则达标值高于数据最大值时，虚线会落到量程外看不见
    const tgt = TARGETS[g.type];
    let lo = mn, hi = mx;
    if (tgt != null) { lo = Math.min(lo, tgt); hi = Math.max(hi, tgt); }
    const span = Math.max(hi - lo, 1e-6);
    const yMin = lo - span * 0.08, yMax = hi + span * 0.08;
    const yOf = v => plotY1 - (v - yMin) / (yMax - yMin) * (plotY1 - plotY0);
    const pts = [];
    hourly.forEach((v, i) => {
      if (v == null || isNaN(Number(v))) return;                 // connectNulls：跳过空点，折线跨过
      pts.push([x0 + colP + (i + 0.5) * colHour, yOf(Number(v))]);
    });
    if (pts.length) {
      const d = smoothPath(pts);
      if (pts.length > 1) {
        inner.push('<path d="' + d + ' L' + pts[pts.length - 1][0].toFixed(1) + ',' + plotY1.toFixed(1) +
          ' L' + pts[0][0].toFixed(1) + ',' + plotY1.toFixed(1) + ' Z" fill="' + color + '" opacity="0.1"/>');
      }
      inner.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2"/>');
    }
    // 达标线（markLine：橙色虚线 + 右端标注）
    if (TARGETS[g.type] != null) {
      const ty = yOf(TARGETS[g.type]);
      if (ty >= plotY0 && ty <= plotY1) {
        inner.push('<line x1="' + plotX0 + '" y1="' + ty.toFixed(1) + '" x2="' + plotX1 + '" y2="' +
          ty.toFixed(1) + '" stroke="' + TARGET_LINE + '" stroke-width="1" stroke-dasharray="5 4"/>');
        textAt(plotX1 - 2, (ty - 3).toFixed(1), '达标线 ' + TARGETS[g.type], 10, TARGET_TXT, null, 'end');
      }
    }
    // x 轴刻度（只保留时间轴，弱化）
    hours.forEach((h, i) => {
      textAt(x0 + colP + (i + 0.5) * colHour, (chartY + chartH - 6).toFixed(1), axisLabel(h, unit),
        fAxis, MUTED, null, 'middle');
    });
  }

  // 单元格内容（裁剪在圆角表格内）
  parts.push('<g clip-path="url(#' + clipId + ')">' + inner.join('') + '</g>');

  // 表格分隔线：外表框（圆角）、表头下边线、各行下边线、首列右分隔线、折线行上边线
  parts.push('<rect x="' + x0 + '" y="' + tableY + '" width="' + tableW + '" height="' + tableH +
    '" rx="10" fill="none" stroke="' + LINE_MID + '" stroke-width="1"/>');
  parts.push('<line x1="' + x0 + '" y1="' + bodyY + '" x2="' + x1 + '" y2="' + bodyY +
    '" stroke="' + LINE_MID + '" stroke-width="1"/>');
  for (let i = 0; i < persons.length; i++) {
    const y = bodyY + (i + 1) * rowH;
    parts.push('<line x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y +
      '" stroke="' + LINE_MID + '" stroke-width="1"/>');
  }
  parts.push('<line x1="' + x0 + '" y1="' + chartY + '" x2="' + x1 + '" y2="' + chartY +
    '" stroke="' + LINE_MID + '" stroke-width="1"/>');
  parts.push('<line x1="' + (x0 + colP) + '" y1="' + tableY + '" x2="' + (x0 + colP) + '" y2="' + chartY +
    '" stroke="' + LINE_MID + '" stroke-width="1"/>');

  // 平均值 / 中位数所在行的彩色边框，再压上白底小标注（顺序即层级，标注在最上）
  parts.push(nearRects.join(''));
  if (badges.length) parts.push('<g clip-path="url(#' + clipId + ')">' + badges.join('') + '</g>');

  // ---- 口径说明（页面折叠时隐藏的那段 .note） ----
  noteLines.forEach((ln, i) => {
    parts.push('<text x="' + x0 + '" y="' + (noteTop + i * noteLh + 12) + '" font-size="' + fNote +
      '" fill="' + MUTED + '">' + esc(ln) + '</text>');
  });

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
    '" font-family="' + esc(font) + '">' + parts.join('') + '</svg>';
}

/* ---------- 字体配置 ---------- */
// 按系统路径分隔符拆分（Linux 为 `:`、Windows 为 `;`）
function splitPaths(v) {
  return String(v || '').split(path.delimiter).map(s => s.trim()).filter(Boolean);
}

function fontOptions() {
  const opt = {
    loadSystemFonts: true,
    defaultFontFamily: process.env.HEMA_SVG_FONT || 'Noto Sans SC'
  };
  // 只传真实存在的路径，避免 resvg 因路径不存在而报错
  const files = splitPaths(process.env.HEMA_SVG_FONT_FILE).filter(p => fs.existsSync(p));
  const dirs = splitPaths(process.env.HEMA_SVG_FONT_DIR).filter(p => fs.existsSync(p));
  if (files.length) opt.fontFiles = files;
  if (dirs.length) opt.fontDirs = dirs;
  return opt;
}

/* 供启动日志展示：字体来源，以及指定的路径是否真实存在（容器里字体常被重启清掉，便于自查） */
function fontInfo() {
  const name = process.env.HEMA_SVG_FONT || 'Noto Sans SC';
  const ok = [], miss = [];
  (files => files.forEach(p => (fs.existsSync(p) ? ok : miss).push(p)))(splitPaths(process.env.HEMA_SVG_FONT_FILE));
  (dirs => dirs.forEach(p => (fs.existsSync(p) ? ok : miss).push(p)))(splitPaths(process.env.HEMA_SVG_FONT_DIR));
  const src = [];
  if (ok.length) src.push(ok.join('、'));
  src.push('系统字体');
  return '默认字体「' + name + '」，来源：' + src.join(' + ') +
    (miss.length ? '；⚠ 指定路径不存在：' + miss.join('、') : '');
}

function svgToPng(svg, scale) {
  const r = new Resvg(svg, {
    background: '#ffffff',
    font: fontOptions(),
    fitTo: { mode: 'zoom', value: scale }
  });
  return r.render().asPng();   // Buffer
}

function scaleValue() {
  const n = Number(process.env.HEMA_SVG_SCALE);
  return (Number.isFinite(n) && n > 0) ? n : 2;
}

// 「统计时间段」文本：与前端 #periodRange 一致
function periodText(meta) {
  const p = meta && meta.period;
  if (!p || !p.start || !p.end) return '';
  return p.crossDay
    ? p.dateStart + ' ' + p.start + ' → ' + p.dateEnd + ' ' + p.end
    : p.dateStart + ' ' + p.start + ' – ' + p.end;
}

/* 自绘整张透视表：dataset 为 db.latest() 的 payload（含 personByHour / meta）。
   opts.scale 覆盖倍率；返回 { period, blocks } */
function renderPivot(dataset, opts) {
  if (!Resvg) throw new Error(unavailableReason());
  const d = dataset || {};
  const pb = d.personByHour;
  const groups = (pb && pb.groups) || [];
  if (!groups.length) throw new Error('最新数据集没有透视数据（可能当天还没有拣货单），已跳过本次推送');

  const hours = (pb && pb.hours) || [];
  const unit = (d.meta && d.meta.bucket) || 'hour';
  const scale = (opts && opts.scale) || scaleValue();
  // 字体族按前端 body 的顺序给出备选（resvg 会挑第一个可用的），最后兜底 sans-serif
  const font = (process.env.HEMA_SVG_FONT || 'Noto Sans SC') +
    ', PingFang SC, Microsoft YaHei, Hiragino Sans GB, WenQuanYi Micro Hei, sans-serif';

  const blocks = orderBlocks(groups).map(g => {
    const svg = blockSvg(g, hours, unit, font);
    const png = svgToPng(svg, scale);
    const stat = g.stat || {};
    return {
      name: LABEL[g.type] || g.type,
      image: 'data:image/png;base64,' + Buffer.from(png).toString('base64'),
      eff: g.total,
      avg: stat.avg == null ? null : stat.avg,
      median: stat.median == null ? null : stat.median,
      bytes: png.length
    };
  });
  return { period: periodText(d.meta), blocks };
}

module.exports = { available, unavailableReason, fontInfo, renderPivot, setTargets };
