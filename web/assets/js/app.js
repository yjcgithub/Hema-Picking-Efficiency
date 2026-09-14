/* 控制层：调用后端 API（解析/计算在服务端），渲染 KPI / 图表 / 表格 */
(function (global) {
  var HEMA = global.HEMA = global.HEMA || {};
  var SAMPLE = global.HEMA_DATA;
  var API = (global.HEMA_CONFIG && global.HEMA_CONFIG.API_BASE) || '/api';
  var current = null;
  var weighted = false;   // 全局效率口径：false = 人均（默认），true = 按工时加权；由顶栏开关统一切换

  // 统一响应解析：后端未部署/地址配错时返回的是 HTML，给出可定位的错误
  function readJson(res) {
    return res.text().then(function (txt) {
      if (!res.ok) throw new Error('HTTP ' + res.status + '（' + (res.url || '') + '）');
      try { return JSON.parse(txt); } catch (e) {
        throw new Error('接口未返回 JSON，请检查 API_BASE（当前 ' + API + '）或后端部署：' +
          (res.url || '') + ' → ' + txt.replace(/\s+/g, ' ').slice(0, 60));
      }
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmt(v, d) { return v == null ? '-' : Number(v).toFixed(d == null ? 2 : d); }

  var noticeEl = document.getElementById('notice');
  function notice(msg, type) {
    if (!msg) { noticeEl.className = 'notice hidden'; return; }
    noticeEl.className = 'notice ' + (type || '');
    noticeEl.innerHTML = msg;
  }

  /* ---------- KPI：第一行 综合效率 + 各作业类型；第二行 规模指标（更小） ---------- */
  function kpiCard(c) {
    return '<div class="kpi"><div class="label">' + c.label + '</div>' +
      '<div class="value">' + c.value + '<small>' + c.unit + '</small></div>' +
      '<div class="foot">' + c.foot + '</div></div>';
  }

  /* 人均（不加权）口径取数：各人「总计效率」的算术平均（服务端已算好，前端只取数） */
  function personMean(d, type) {
    var pm = d.stats && d.stats.personMean;
    if (!pm) return { avg: null, n: 0 };
    if (type == null) return pm.all || { avg: null, n: 0 };
    return (pm.byType && pm.byType[type]) || { avg: null, n: 0 };
  }

  function renderKpis(d) {
    var t = d.totals;
    var colors = (global.HEMA_CONFIG && global.HEMA_CONFIG.COLORS) || {};
    var all = personMean(d, null);
    var useAvg = !weighted && all.avg != null;
    var main = [
      {
        label: '综合效率', value: fmt(useAvg ? all.avg : t.eff), unit: '行/h',
        foot: useAvg ? '全员人均（' + all.n + ' 人）' : '全部作业类型加权'
      }
    ];
    // 固定顺序：前场合流 / 后场合流 / 一体化（其余类型排在最后）
    (d.byJobType || []).slice().sort(function (a, b) {
      var ia = PIVOT_ORDER.indexOf(a.name), ib = PIVOT_ORDER.indexOf(b.name);
      if (ia < 0) ia = 90; if (ib < 0) ib = 90;
      return ia - ib;
    }).forEach(function (j) {
      var color = colors[j.name] || '#64748b';
      var ps = personMean(d, j.name);
      var scale = j.rows.toLocaleString() + ' 行 · ' + fmt(j.hours, 2) + ' h';
      main.push({
        label: '<span class="dot" style="background:' + color + '"></span>' + esc(j.name),
        value: fmt(!weighted && ps.avg != null ? ps.avg : j.eff), unit: '行/h',
        foot: !weighted && ps.avg != null ? ps.n + ' 人平均 · ' + scale : scale
      });
    });
    var sub = [
      { label: '拣货行数', value: t.rows.toLocaleString(), unit: '行', foot: '有效明细合计' },
      { label: '拣货人数', value: t.persons, unit: '人', foot: '参与拣货的人员' },
      { label: '有效明细', value: d.meta.recordCount.toLocaleString(), unit: '条', foot: '丢弃 ' + d.meta.dropped + ' 条（缺人/缺时间）' }
    ];
    document.getElementById('kpis').innerHTML = main.map(kpiCard).join('');
    document.getElementById('kpisSub').innerHTML = sub.map(kpiCard).join('');
  }

  /* ---------- 人员 × 小时 透视：按 前场合流 / 后场合流 / 一体化 分为 3 块 ---------- */
  function fallbackGroups(pb) {
    // 兼容旧数据（无 groups）：仅能给出整体小计
    var map = {}, order = [];
    pb.rows.forEach(function (r) {
      if (!map[r.jobType]) {
        map[r.jobType] = { type: r.jobType, rows: 0, hours: 0, total: null,
                           hourly: pb.hours.map(function () { return null; }), persons: [] };
        order.push(map[r.jobType]);
      }
      var g = map[r.jobType];
      g.rows += r.rows; g.hours += r.hours; g.persons.push(r);
    });
    order.forEach(function (g) {
      g.total = g.hours ? Math.round(g.rows / g.hours * 100) / 100 : null;
      g.hours = Math.round(g.hours * 10000) / 10000;
    });
    return order;
  }

  /* 达标值（行/h）：分块有达标线时按达标线分档，否则按块内相对色阶 */
  var TARGETS = { '后场合流': 280 };

  /* 色阶锚点：沿用原配色（偏低暖色 → 达标绿），只把分档改为连续过渡 */
  var HEAT_STOPS = [
    { r: 0.0, rgb: [254, 226, 226] },   // #fee2e2 偏低
    { r: 0.6, rgb: [254, 249, 195] },   // #fef9c3
    { r: 0.8, rgb: [236, 252, 203] },   // #ecfccb
    { r: 1.0, rgb: [220, 252, 231] }    // #dcfce7 达标
  ];

  /* 平均值 / 中位数所在行右上角的标注 */
  var STAT_TAG = { avg: '平均值', median: '中位数' };

  function heatColor(v, type, mn, mx) {
    if (v == null) return '';
    var t = TARGETS[type];
    var r = t ? (v / t) : (mx > mn ? (v - mn) / (mx - mn) : 1);
    r = Math.max(0, Math.min(1, r));
    for (var i = 1; i < HEAT_STOPS.length; i++) {
      var a = HEAT_STOPS[i - 1], b = HEAT_STOPS[i];
      if (r <= b.r) {
        var k = (r - a.r) / (b.r - a.r);
        return 'rgb(' + a.rgb.map(function (c, j) {
          return Math.round(c + (b.rgb[j] - c) * k);
        }).join(',') + ')';
      }
    }
  }

  /* 分块顺序 + 折叠记忆 */
  var PIVOT_ORDER = ['前场合流', '后场合流', '一体化'];
  var PIVOT_LS = 'hema.pivot.collapsed';

  function collapsedSet() {
    try { return JSON.parse(localStorage.getItem(PIVOT_LS) || '[]') || []; } catch (e) { return []; }
  }
  function toggleCollapsed(type) {
    var s = collapsedSet(), i = s.indexOf(type);
    if (i >= 0) s.splice(i, 1); else s.push(type);
    try { localStorage.setItem(PIVOT_LS, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }
  function orderBlocks(blocks) {
    return blocks.slice().sort(function (a, b) {
      var ia = PIVOT_ORDER.indexOf(a.type), ib = PIVOT_ORDER.indexOf(b.type);
      if (ia < 0) ia = 90; if (ib < 0) ib = 90;
      return ia - ib;
    });
  }

  /* ---------- 人员 × 小时 透视：3 块（前场合流 / 后场合流 / 一体化），可折叠并记忆 ---------- */
  function renderPivotBlocks(d) {
    var host = document.getElementById('pivotBlocks');
    if (!host) return;
    var pb = d.personByHour, hours = pb.hours;
    var colors = (global.HEMA_CONFIG && global.HEMA_CONFIG.COLORS) || {};
    var collapsed = collapsedSet();
    var th = ['拣货人'].concat(hours.map(function (h) { return h + '点'; })).concat(['总计']);
    var head = '<thead><tr>' + th.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var foot = '<tfoot><tr><td colspan="' + th.length + '" class="table-note">' +
      '小计＝该范围内 Σ拣货行数 ÷ Σ拣货时长（按工时加权，不是各人效率的算术平均）；' +
      '「平均值 / 中位数」按各人总计效率统计，浅蓝 / 浅紫边框标出与之最接近的人员行；「-」表示该时段无记录。' +
      '</td></tr></tfoot>';

    var blocks = orderBlocks((pb.groups && pb.groups.length) ? pb.groups : fallbackGroups(pb));

    host.innerHTML = blocks.map(function (g) {
      var color = colors[g.type] || '#64748b';
      var isCol = collapsed.indexOf(g.type) >= 0;
      var bvals = g.hourly.filter(function (v) { return v != null; });
      var bmin = bvals.length ? Math.min.apply(null, bvals) : 0;
      var bmax = bvals.length ? Math.max.apply(null, bvals) : 0;
      var cell = function (v, tag) {
        var bg = heatColor(v, g.type, bmin, bmax);
        return '<td' + (tag ? ' class="stat-cell"' : '') +
          (bg ? ' style="background:' + bg + '"' : '') + '>' +
          (tag ? '<span class="stat-badge ' + tag + '">' + STAT_TAG[tag] + '</span>' : '') +
          fmt(v, 1) + '</td>';
      };
      var cellArr = function (arr) { return arr.map(function (v) { return cell(v); }).join(''); };

      // 平均值 / 中位数按「总计」列口径计算（服务端给出），对应行加边框并在右上角标注
      var gs = g.stat || {};
      var avg = gs.avg == null ? null : gs.avg, med = gs.median == null ? null : gs.median;

      var body = g.persons.map(function (r) {
        var tag = r.person === gs.medianPerson ? 'median' : (r.person === gs.avgPerson ? 'avg' : '');
        return '<tr class="person' + (tag ? ' near-' + tag : '') + '">' +
          '<td>' + esc(r.person) + '</td>' + cellArr(r.data) + cell(r.total, tag) + '</tr>';
      }).join('');
      body += '<tr class="total"><td>小计</td>' + cellArr(g.hourly) + cell(g.total) + '</tr>';

      var target = TARGETS[g.type];
      return '<div class="pivot-block' + (isCol ? ' collapsed' : '') + '">' +
        '<div class="pivot-title" data-toggle="' + esc(g.type) + '" title="点击折叠 / 展开">' +
        '<span class="caret">' + (isCol ? '▶' : '▼') + '</span>' +
        '<span class="dot" style="background:' + color + '"></span>' + esc(g.type) +
        '<small>整体 ' + fmt(g.total, 1) + ' 行/h · ' + g.rows.toLocaleString() + ' 行 · ' +
        fmt(g.hours, 2) + ' h · ' + g.persons.length + ' 人' +
        (target ? ' · 达标线 ' + target + ' 行/h' : '') +
        (avg == null ? '' : ' · <span class="dot avg"></span>平均 ' + fmt(avg, 1) + ' 行/h') +
        (med == null ? '' : ' · <span class="dot median"></span>中位数 ' + fmt(med, 1) + ' 行/h') +
        '</small></div>' +
        '<div class="table-wrap"><table>' + head + '<tbody>' + body + '</tbody>' + foot + '</table></div>' +
        '</div>';
    }).join('');
  }

  /* ---------- 细分明细 ---------- */
  function renderZoneTable(d) {
    var th = ['作业类型', '拣货分区', '拣货行数', '时长(h)', '效率(行/h)', '行数占比'];
    var html = '<thead><tr>' + th.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    d.byZone.forEach(function (r) {
      html += '<tr><td>' + esc(r.type) + '</td><td>' + esc(r.zone) + '</td><td>' + r.rows + '</td><td>' +
        fmt(r.hours, 4) + '</td><td>' + fmt(r.eff) + '</td><td>' + r.share + '%</td></tr>';
    });
    html += '<tr class="total"><td>合计</td><td></td><td>' + d.totals.rows + '</td><td>' +
      fmt(d.totals.hours, 4) + '</td><td>' + fmt(d.totals.eff) + '</td><td>100%</td></tr></tbody>';
    document.getElementById('tableZone').innerHTML = html;
  }

  /* ---------- 人员效率明细（表头可点击升降序） ---------- */
  var personSort = { key: 'eff', dir: -1 };
  var PERSON_COLS = [
    { key: null, label: '排名' },
    { key: 'name', label: '拣货人' },
    { key: 'rows', label: '拣货行数' },
    { key: 'hours', label: '时长(h)' },
    { key: 'eff', label: '效率(行/h)' }
  ];

  function renderPersonTable(d) {
    var list = d.byPerson.slice();
    var k = personSort.key, dir = personSort.dir;
    if (k) {
      list.sort(function (a, b) {
        var va = a[k], vb = b[k];
        if (typeof va === 'string') return dir * va.localeCompare(vb, 'zh-Hans-CN');
        return dir * (va - vb);
      });
    }
    var head = '<thead><tr>' + PERSON_COLS.map(function (c) {
      if (!c.key) return '<th>' + c.label + '</th>';
      var mark = personSort.key === c.key ? (personSort.dir === 1 ? ' ▲' : ' ▼') : '';
      return '<th class="sortable" data-key="' + c.key + '" title="点击切换升/降序">' + c.label + mark + '</th>';
    }).join('') + '</tr></thead>';

    // 分两栏渲染，充分利用横向空间（行数多，单栏会又宽又空）
    var half = Math.ceil(list.length / 2);
    var parts = [list.slice(0, half), list.slice(half)];
    document.getElementById('tablePerson').innerHTML = parts.map(function (part, pi) {
      var body = part.map(function (r, i) {
        return '<tr><td>' + (pi * half + i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + r.rows + '</td><td>' +
          fmt(r.hours, 4) + '</td><td>' + fmt(r.eff) + '</td></tr>';
      }).join('');
      if (pi === parts.length - 1) {
        body += '<tr class="total"><td></td><td>总计</td><td>' + d.totals.rows + '</td><td>' +
          fmt(d.totals.hours, 4) + '</td><td>' + fmt(d.totals.eff) + '</td></tr>';
      }
      return '<div class="table-wrap"><table>' + head + '<tbody>' + body + '</tbody></table></div>';
    }).join('');
  }

  /* ---------- 指标小卡 ---------- */

  /* 指标小卡（分布 / 集中度卡片顶部一行） */
  function chip(k, v, unit, tip) {
    return '<div class="stat-chip"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
      '<div class="k">' + k + '</div><div class="v">' + v +
      (unit ? '<small>' + unit + '</small>' : '') + '</div></div>';
  }

  /* ---------- 卡片：人员效率分布与稳定性（指标全部由服务端计算，此处只渲染） ---------- */
  function renderDist(d) {
    var s = d.stats || {};
    var dist = s.personDist;
    if (!dist) return;
    var n = dist.n;

    document.getElementById('distStat').innerHTML = [
      chip('人员数', n, '人', '参与拣货并被统计的人员数'),
      chip('平均效率', fmt(dist.avg, 1), '行/h', '各人总计效率的算术平均'),
      chip('中位数效率', fmt(dist.median, 1), '行/h', '一半人高于此值，比平均更不受极端值影响'),
      chip('四分位区间', fmt(dist.q1, 0) + ' – ' + fmt(dist.q3, 0), '行/h', 'P25 – P75：中间 50% 的人落在这一区间'),
      chip('最高 / 最低', fmt(dist.max, 0) + ' / ' + fmt(dist.min, 0), '行/h', '个人总计效率的极值'),
      chip('变异系数', fmt(dist.cv, 2), '', '标准差 ÷ 平均：人员之间的效率差距，越大越不均衡')
    ].join('');

    /* 效率分档：看「多少人落在哪一档」与各档贡献了多少行 */
    var html = '<thead><tr><th>效率区间（行/h）</th><th>人数</th><th>人数占比</th><th>行数合计</th></tr></thead><tbody>';
    (s.effBins || []).forEach(function (b) {
      html += '<tr><td>' + b.label + '</td><td>' + b.n + '</td><td>' +
        fmt(n ? b.n / n * 100 : 0, 1) + '%</td><td>' + b.rows.toLocaleString() + '</td></tr>';
    });
    html += '<tr class="total"><td>合计</td><td>' + n + '</td><td>100.0%</td><td>' +
      d.totals.rows.toLocaleString() + '</td></tr></tbody>';
    document.getElementById('tableEffBin').innerHTML = html;

    /* 稳定性榜：波动最大 / 最稳定各 10 人（人数不足时全部列出） */
    var st = s.stability || [];
    var head = '<thead><tr>' + ['拣货人', '主要作业类型', '记录小时数', '平均效率', '标准差', '变异系数']
      .map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var rowOf = function (r) {
      return '<tr><td>' + esc(r.person) + '</td><td>' + esc(r.type) + '</td><td>' + r.n + '</td><td>' +
        fmt(r.avg, 1) + '</td><td>' + fmt(r.sd, 1) + '</td><td>' + fmt(r.cv, 2) + '</td></tr>';
    };
    var sec = function (t) {
      return '<tr class="group"><td colspan="6">' + t + '</td></tr>';
    };
    var body;
    if (!st.length) {
      body = '<tr><td colspan="6" class="dm-empty">暂无足够的每小时记录（每人需 ≥ 3 小时）</td></tr>';
    } else if (st.length <= 22) {
      body = st.map(rowOf).join('');
    } else {
      body = sec('波动最大（变异系数高，需关注）') + st.slice(-10).reverse().map(rowOf).join('') +
        sec('最稳定（变异系数低）') + st.slice(0, 10).map(rowOf).join('');
    }
    document.getElementById('tableStab').innerHTML = head + '<tbody>' + body + '</tbody>';

    document.getElementById('distNote').textContent =
      '分布：按各人总计效率（Σ拣货行数 ÷ Σ拣货时长）统计，不受顶栏口径开关影响。' +
      '稳定性：变异系数 = 标准差 ÷ 平均，越小表示该人各小时产出一致；' +
      '为避免跨作业类型的基准差异（后场合流约 250、前场合流约 70）被误判为「不稳定」，' +
      '只在该人记录最多的作业类型内计算，且仅统计记录小时数 ≥ 3 的人。';
  }

  /* ---------- 卡片：拣货行数统计（按人员分布与集中度） ---------- */
  function renderRowsStat(d) {
    var s = (d.stats && d.stats.rowsStat) || null;
    if (!s) return;
    var n = s.n;
    var totalRows = s.total;

    /* 帕累托：行数从高到低累计，前 k 人贡献的行数占比（服务端已算好） */
    var paretoChip = function (t, label) {
      if (!t) return '';
      return chip(label, fmt(t.pct, 1), '%',
        '行数最多的前 ' + t.k + ' 人（占 ' + fmt(t.k / n * 100, 0) + '%）贡献了 ' + fmt(t.pct, 1) + '% 的行数');
    };

    document.getElementById('rowsStat').innerHTML = [
      chip('总拣货行数', totalRows.toLocaleString(), '行', '有效明细合计'),
      chip('人均行数', fmt(s.avg, 0), '行', '总行数 ÷ ' + n + ' 人'),
      chip('中位数行数', fmt(s.median, 0), '行', '一半人高于此值'),
      chip('最高 / 最低', s.max.toLocaleString() + ' / ' + s.min, '行',
        '个人行数的极值，差距大说明分工不均'),
      paretoChip(s.top10, 'TOP 10% 人员行数占比'),
      paretoChip(s.top25, 'TOP 25% 人员行数占比')
    ].join('');

    /* TOP 10：条形长度按最高行数归一，右侧标注行数与占比（行名与占比均由服务端给出） */
    var top = (d.stats && d.stats.rowsTop) || [];
    var maxRows = top.length ? top[0].rows : 0;
    document.getElementById('rowsTop').innerHTML = top.map(function (r, i) {
      var w = maxRows ? r.rows / maxRows * 100 : 0;
      return '<div class="bar-item">' +
        '<span class="bar-name" title="' + esc(r.name) + '">' + (i + 1) + '. ' + esc(r.name) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + fmt(w, 1) + '%"></span></span>' +
        '<span class="bar-val">' + r.rows.toLocaleString() + ' 行 · ' + fmt(r.share, 1) + '%</span>' +
        '</div>';
    }).join('');

    /* 行数分档：人数占比看「多少人干得少」，行数占比看「产出集中在哪一档」 */
    var bins = (d.stats && d.stats.rowsBins) || [];
    var html = '<thead><tr><th>行数区间</th><th>人数</th><th>人数占比</th><th>行数合计</th><th>行数占比</th>' +
      '</tr></thead><tbody>';
    bins.forEach(function (b) {
      html += '<tr><td>' + b.label + '</td><td>' + b.n + '</td><td>' + fmt(b.n / n * 100, 1) + '%</td><td>' +
        b.rows.toLocaleString() + '</td><td>' + fmt(totalRows ? b.rows / totalRows * 100 : 0, 1) + '%</td></tr>';
    });
    html += '<tr class="total"><td>合计</td><td>' + n + '</td><td>100.0%</td><td>' +
      totalRows.toLocaleString() + '</td><td>100.0%</td></tr></tbody>';
    document.getElementById('tableRowsBin').innerHTML = html;

    document.getElementById('rowsNote').textContent =
      '占比条长度按最高个人行数归一，右侧为「行数 · 占总行数比例」。' +
      '分档表同时给两条口径：人数占比说明有多少人产出偏低；行数占比说明总产出集中在哪一档，' +
      '两者差距越大，说明产出越向少数人集中。';
  }

  /* ---------- 总渲染 ---------- */
  function render(d) {
    if (!d) { notice('没有可展示的数据', 'err'); return; }
    current = d;
    var m = d.meta;
    document.getElementById('metaLine').textContent =
      (d.id ? '数据集 #' + d.id + ' ｜ ' : '') + '数据来源：' + m.sourceFile +
      ' ｜ 日期：' + (m.dates.join('、') || '-') + ' ｜ 有效明细 ' + m.recordCount.toLocaleString() + ' 条';
    renderKpis(d);
    renderPivotBlocks(d);
    renderZoneTable(d);
    renderPersonTable(d);
    renderDist(d);
    renderRowsStat(d);
    HEMA.charts.render(d);
  }

  /* ---------- 历史数据集（顶栏自定义下拉：每项两行，第一行文件名、第二行元信息） ---------- */
  var selBtn = document.getElementById('historyBtn');
  var selMenu = document.getElementById('historyMenu');
  var selItems = [];        // [{ id, file, sub }]
  var selId = 'sample';     // 当前数据集 id；'sample' = 内置示例数据

  function selHtml(it) {
    return '<span class="sel-l1">' + esc(it.file) + '</span>' +
      '<span class="sel-l2">' + esc(it.sub) + '</span>';
  }

  // 按钮文案跟随当前选中项，并标注列表项选中态
  function syncHistory() {
    var cur = null;
    selItems.forEach(function (it) { if (String(it.id) === String(selId)) cur = it; });
    selBtn.innerHTML = selHtml(cur || selItems[0] || { file: '内置示例数据', sub: '' });
    Array.prototype.forEach.call(selMenu.querySelectorAll('.sel-item'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-id') === String(selId));
    });
  }

  function renderHistoryMenu() {
    selMenu.innerHTML = selItems.map(function (it) {
      return '<button type="button" class="sel-item" data-id="' + esc(it.id) + '">' + selHtml(it) + '</button>';
    }).join('');
    syncHistory();
  }

  function loadHistory(currentId, list) {
    selId = currentId == null ? 'sample' : currentId;
    syncHistory();
    var p = list ? Promise.resolve(list) : fetch(API + '/datasets').then(readJson);
    p.then(function (list) {
      selItems = [{ id: 'sample', file: '内置示例数据', sub: '离线示例，无需后端' }];
      list.forEach(function (x) {
        selItems.push({
          id: x.id, file: x.sourceFile,
          sub: '#' + x.id + ' · ' + x.dates + ' · ' + fmt(x.eff) + ' 行/h'
        });
      });
      renderHistoryMenu();
    }).catch(function () {
      selItems = [{ id: 'sample', file: '内置示例数据', sub: '离线示例，无需后端' }];
      renderHistoryMenu();
    });
  }

  // 选择数据集（'sample' = 内置示例数据）
  function pickHistory(id) {
    selId = id;
    syncHistory();
    if (id === 'sample') { render(SAMPLE); notice('已切换到内置示例数据。', 'ok'); return; }
    fetch(API + '/datasets/' + id).then(readJson).then(function (ds) {
      render(ds);
      notice('已加载数据集 #' + id + '。', 'ok');
    }).catch(function () { notice('加载数据集失败。', 'err'); });
  }

  selMenu.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.sel-item') : null;
    if (!btn) return;
    closeMenus();
    pickHistory(btn.getAttribute('data-id'));
  });

  /* ---------- 上传（服务端解析+计算） ---------- */
  function upload(file) {
    if (file.size > 100 * 1024 * 1024) { notice('文件过大（>100MB）', 'err'); return; }
    notice('正在上传并由服务端计算 ' + esc(file.name) + ' …', 'ok');
    fetch(API + '/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(readJson).then(function (j) {
      render(j);
      loadHistory(j.id);
      notice('已计算完成并入库（数据集 #' + j.id + '）：有效明细 ' +
        j.meta.recordCount.toLocaleString() + ' 条，丢弃 ' + j.meta.dropped +
        ' 条，综合效率 ' + fmt(j.totals.eff) + ' 行/h。', 'ok');
    }).catch(function (err) {
      notice('上传失败：' + esc(err.message || err) + '<br>接口地址：' + esc(API + '/upload'), 'err');
    });
  }

  document.getElementById('fileInput').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (f) upload(f);
    ev.target.value = '';
  });

  /* ---------- 数据管理（顶栏按钮 → 弹窗）：切换查看 / 删除单条 / 批量删除 / 清空 ---------- */
  var dmMask = document.getElementById('dataMgrMask');
  var dmTable = document.getElementById('dmTable');
  var dmSum = document.getElementById('dmSum');
  var dmAll = document.getElementById('dmAll');
  var dmDelSel = document.getElementById('dmDelSel');
  var dmList = [];

  function dmTime(s) {
    var d = new Date(s);
    if (!s || isNaN(d)) return '-';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function dmPicks() {
    return Array.prototype.slice.call(dmTable.querySelectorAll('.dm-pick:checked'))
      .map(function (el) { return el.value; });
  }

  function dmSyncBar() {
    var n = dmPicks().length, total = dmList.length;
    dmAll.checked = n > 0 && n === total;
    dmAll.indeterminate = n > 0 && n < total;
    dmDelSel.disabled = n === 0;
    dmDelSel.textContent = n ? '删除选中（' + n + '）' : '删除选中';
  }

  function renderDmTable() {
    var cur = current && current.id != null ? String(current.id) : '';
    var head = '<thead><tr><th class="dm-ck"></th><th>ID</th><th>文件名</th><th>日期</th>' +
      '<th>有效明细</th><th>丢弃</th><th>综合效率(行/h)</th><th>上传时间</th><th>操作</th></tr></thead>';
    var body = dmList.map(function (x) {
      var now = String(x.id) === cur;
      return '<tr class="' + (now ? 'now' : '') + '">' +
        '<td class="dm-ck"><input type="checkbox" class="dm-pick" value="' + x.id + '"></td>' +
        '<td>' + (now ? '<span class="dot" style="background:var(--primary)"></span> ' : '') + '#' + x.id + '</td>' +
        '<td class="dm-file" title="' + esc(x.sourceFile) + '">' + esc(x.sourceFile) + '</td>' +
        '<td>' + esc(x.dates || '-') + '</td>' +
        '<td>' + (x.recordCount || 0).toLocaleString() + '</td>' +
        '<td>' + (x.dropped || 0) + '</td>' +
        '<td>' + fmt(x.eff) + '</td>' +
        '<td>' + dmTime(x.createdAt) + '</td>' +
        '<td class="dm-act">' +
        '<button type="button" class="mini" data-view="' + x.id + '">' + (now ? '当前' : '查看') + '</button>' +
        '<button type="button" class="mini danger" data-del="' + x.id + '">删除</button>' +
        '</td></tr>';
    }).join('');
    dmTable.innerHTML = head + '<tbody>' +
      (body || '<tr><td colspan="9" class="dm-empty">暂无数据集，请先上传拣货单 xlsx</td></tr>') + '</tbody>';
    dmSum.textContent = '共 ' + dmList.length + ' 条';
    dmSyncBar();
  }

  function loadDataMgr(currentId) {
    return fetch(API + '/datasets').then(readJson).then(function (list) {
      dmList = (list || []).slice();
      renderDmTable();
      loadHistory(currentId === undefined ? (current && current.id) : currentId, dmList);
    }).catch(function (e) {
      dmList = [];
      renderDmTable();
      notice('数据管理加载失败：' + esc(e.message || e), 'err');
    });
  }

  // 删除后：当前数据集仍在则只刷新列表，否则切到最新数据集（都没有则回内置示例）
  function afterDelete(ids) {
    var curId = current && current.id != null ? String(current.id) : null;
    var curGone = curId != null && ids.some(function (x) { return String(x) === curId; });
    notice('已删除 ' + ids.length + ' 条数据集。', 'ok');
    if (!curGone) { loadDataMgr(curId); return; }
    fetch(API + '/latest').then(readJson).then(function (ds) {
      render(ds);
      loadDataMgr(ds.id);
      notice('当前数据集已删除，已切换到最新数据集 #' + ds.id + '。', 'ok');
    }).catch(function () {
      render(SAMPLE);
      loadDataMgr(null);
      notice('数据集已全部删除，已切换到内置示例数据。', 'ok');
    });
  }

  function removeThen(ids) {
    Promise.all(ids.map(function (id) {
      return fetch(API + '/datasets/' + encodeURIComponent(id), { method: 'DELETE' }).then(readJson);
    })).then(function () {
      afterDelete(ids.map(String));
    }).catch(function (e) {
      notice('删除失败：' + esc(e.message || e), 'err');
      loadDataMgr();
    });
  }

  /* 删除前的二次确认：页内弹层（不依赖浏览器原生 confirm，避免被环境拦截时静默删除） */
  var dmConfirm = document.getElementById('dmConfirm');
  var dmConfirmText = document.getElementById('dmConfirmText');
  var dmConfirmOk = document.getElementById('dmConfirmOk');
  var dmPending = null;

  function askConfirm(text, onOk) {
    dmConfirmText.textContent = text;
    dmPending = onOk;
    dmConfirm.classList.remove('hidden');
    dmConfirmOk.focus();
  }
  function closeConfirm() { dmConfirm.classList.add('hidden'); dmPending = null; }

  dmConfirmOk.addEventListener('click', function () {
    var fn = dmPending;
    closeConfirm();
    if (fn) fn();
  });
  document.getElementById('dmConfirmCancel').addEventListener('click', closeConfirm);
  dmConfirm.addEventListener('click', function (ev) { if (ev.target === dmConfirm) closeConfirm(); });

  function deleteDatasets(ids) {
    if (!ids.length) return;
    var text;
    if (ids.length === 1) {
      var one = dmList.filter(function (x) { return String(x.id) === String(ids[0]); })[0];
      text = '确认删除数据集 #' + ids[0] + (one ? '（' + one.sourceFile + '）' : '') + '？删除后不可恢复。';
    } else {
      text = '确认删除选中的 ' + ids.length + ' 条数据集？删除后不可恢复。';
    }
    askConfirm(text, function () { removeThen(ids); });
  }

  function clearDatasets() {
    if (!dmList.length) { notice('当前没有可删除的数据集。', 'ok'); return; }
    askConfirm('确认清空全部 ' + dmList.length + ' 条数据集？删除后不可恢复。', function () {
      removeThen(dmList.map(function (x) { return String(x.id); }));
    });
  }

  function switchDataset(id) {
    fetch(API + '/datasets/' + encodeURIComponent(id)).then(readJson).then(function (ds) {
      render(ds);
      loadDataMgr(ds.id);
      notice('已加载数据集 #' + ds.id + '。', 'ok');
    }).catch(function () { notice('加载数据集失败。', 'err'); });
  }

  function openDataMgr() { dmMask.classList.remove('hidden'); loadDataMgr(); }
  function closeDataMgr() { closeConfirm(); dmMask.classList.add('hidden'); }

  document.getElementById('dataMgrBtn').addEventListener('click', openDataMgr);
  document.getElementById('dataMgrClose').addEventListener('click', closeDataMgr);
  document.getElementById('dmRefresh').addEventListener('click', function () { loadDataMgr(); });
  document.getElementById('dmClear').addEventListener('click', clearDatasets);
  dmDelSel.addEventListener('click', function () { deleteDatasets(dmPicks()); });
  dmMask.addEventListener('click', function (ev) { if (ev.target === dmMask) closeDataMgr(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    if (!dmConfirm.classList.contains('hidden')) { closeConfirm(); return; }
    if (!dmMask.classList.contains('hidden')) { closeDataMgr(); return; }
    var zc = document.getElementById('zoneCfgMask');
    if (zc && !zc.classList.contains('hidden')) closeZoneCfg();
  });
  dmAll.addEventListener('change', function () {
    Array.prototype.forEach.call(dmTable.querySelectorAll('.dm-pick'), function (el) {
      el.checked = dmAll.checked;
    });
    dmSyncBar();
  });
  dmTable.addEventListener('change', function (ev) {
    if (ev.target.classList && ev.target.classList.contains('dm-pick')) dmSyncBar();
  });
  dmTable.addEventListener('click', function (ev) {
    var el = ev.target;
    if (!el.getAttribute) return;
    var view = el.getAttribute('data-view'), del = el.getAttribute('data-del');
    if (view) switchDataset(view);
    else if (del) deleteDatasets([String(del)]);
  });

  /* ---------- 分区设置（顶栏按钮 → 弹窗）：维护「拣货分区 → 前后场分区」映射 ---------- */
  var zcMask = document.getElementById('zoneCfgMask');
  var zcList = document.getElementById('zoneCfgList');
  var zcSum = document.getElementById('zoneCfgSum');
  var zcNew = document.getElementById('zoneCfgNew');
  var zcSave = document.getElementById('zoneCfgSave');
  var zcTypes = [];        // 可选作业类型（「不映射」由前端补空值选项）
  var zcRows = [];         // [{ zone, type, inData }]；type 为空串 = 不映射

  function zcOptions(cur) {
    var opts = ['<option value=""' + (cur ? '' : ' selected') + '>不映射</option>'];
    zcTypes.forEach(function (t) {
      opts.push('<option value="' + esc(t) + '"' + (t === cur ? ' selected' : '') + '>' + esc(t) + '</option>');
    });
    return opts.join('');
  }

  function zcSyncSum() {
    var mapped = zcRows.filter(function (r) { return !!r.type; }).length;
    zcSum.textContent = '共 ' + zcRows.length + ' 个分区，已映射 ' + mapped + ' 个';
  }

  function renderZoneCfg() {
    zcList.innerHTML = zcRows.length
      ? zcRows.map(function (r, i) {
        return '<div class="zone-row">' +
          '<span class="zone-name" title="' + esc(r.zone) + '">' + esc(r.zone) +
          (r.inData ? '<span class="zone-tag">数据中</span>' : '') + '</span>' +
          '<select class="zone-sel" data-i="' + i + '">' + zcOptions(r.type) + '</select>' +
          '</div>';
      }).join('')
      : '<div class="zone-empty">暂无可配置的分区，可在下方手动新增。</div>';
    zcSyncSum();
  }

  function loadZoneCfg() {
    zcSum.textContent = '加载中…';
    return fetch(API + '/settings').then(readJson).then(function (j) {
      zcTypes = j.jobTypes || [];
      zcRows = (j.zones || []).map(function (z) {
        return { zone: z.zone, type: z.type || '', inData: !!z.inData };
      });
      renderZoneCfg();
    }).catch(function (e) {
      zcList.innerHTML = '';
      zcSum.textContent = '加载失败';
      notice('分区设置加载失败：' + esc(e.message || e), 'err');
    });
  }

  zcList.addEventListener('change', function (ev) {
    var el = ev.target;
    if (!el.classList || !el.classList.contains('zone-sel')) return;
    var r = zcRows[Number(el.getAttribute('data-i'))];
    if (!r) return;
    r.type = el.value;
    zcSyncSum();
  });

  function zcAdd() {
    var name = (zcNew.value || '').trim();
    if (!name) { notice('请输入拣货分区名称。', 'err'); zcNew.focus(); return; }
    var hit = false;
    zcRows.forEach(function (r) { if (r.zone === name) hit = true; });
    if (hit) { notice('分区「' + esc(name) + '」已在列表中。', 'ok'); zcNew.select(); return; }
    zcRows.push({ zone: name, type: '', inData: false });
    zcNew.value = '';
    renderZoneCfg();
  }

  function saveZoneCfg() {
    var map = {};
    zcRows.forEach(function (r) { if (r.type) map[r.zone] = r.type; });
    zcSave.disabled = true;
    fetch(API + '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ map: map })
    }).then(readJson).then(function (j) {
      zcSave.disabled = false;
      var upd = (j.updated || []).length, skip = j.skipped || [], fail = (j.failed || []).length;
      var msg = '已保存 ' + Object.keys(j.map || {}).length + ' 个分区的映射，并按新映射重算历史数据集：成功 ' +
        upd + ' 条';
      if (skip.length) msg += '，跳过 ' + skip.length + ' 条（数据集 #' + skip.join('、') +
        ' 上传时未保存原始明细，需重新上传该文件才能重算）';
      if (fail) msg += '，失败 ' + fail + ' 条';
      notice(msg + '。', fail ? 'err' : 'ok');
      renderZoneCfg();
      // 重算只影响服务端数据：当前正查看的数据集需重新拉取才反映新映射
      var curId = current && current.id != null ? String(current.id) : null;
      loadDataMgr(curId);
      if (curId != null) {
        fetch(API + '/datasets/' + encodeURIComponent(curId)).then(readJson).then(function (ds) {
          if (String(ds.id) === curId) render(ds);
        }).catch(function () { });
      }
    }).catch(function (e) {
      zcSave.disabled = false;
      notice('保存失败：' + esc(e.message || e), 'err');
    });
  }

  function openZoneCfg() { zcMask.classList.remove('hidden'); loadZoneCfg(); }
  function closeZoneCfg() { zcMask.classList.add('hidden'); }

  document.getElementById('zoneCfgBtn').addEventListener('click', openZoneCfg);
  document.getElementById('zoneCfgClose').addEventListener('click', closeZoneCfg);
  document.getElementById('zoneCfgRefresh').addEventListener('click', loadZoneCfg);
  document.getElementById('zoneCfgAdd').addEventListener('click', zcAdd);
  zcNew.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') zcAdd(); });
  zcSave.addEventListener('click', saveZoneCfg);
  zcMask.addEventListener('click', function (ev) { if (ev.target === zcMask) closeZoneCfg(); });

  // 人员效率明细：点击表头切换升/降序
  document.getElementById('tablePerson').addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el.tagName !== 'TH') el = el.parentNode;
    if (!el || !el.className || String(el.className).indexOf('sortable') < 0) return;
    var key = el.getAttribute('data-key');
    if (personSort.key === key) personSort.dir = -personSort.dir;
    else { personSort.key = key; personSort.dir = (key === 'name') ? 1 : -1; }
    if (current) renderPersonTable(current);
  });

  // 透视分块：点击标题折叠 / 展开（状态记忆在 localStorage）
  document.getElementById('pivotBlocks').addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el !== ev.currentTarget) {
      if (el.getAttribute && el.getAttribute('data-toggle')) break;
      el = el.parentNode;
    }
    if (!el || el === ev.currentTarget || !el.getAttribute) return;
    toggleCollapsed(el.getAttribute('data-toggle'));
    if (current) renderPivotBlocks(current);
  });

  /* ---------- 卡片工具：导出为图片 / 复制为图片（透视卡片可按分类选范围） ---------- */
  var PIVOT_SCOPES = ['全部', '前场合流', '后场合流', '一体化'];

  function menuWrap(label, act) {
    var items = PIVOT_SCOPES.map(function (s) {
      return '<button type="button" data-act="' + act + '" data-scope="' + s + '">' +
        (s === '全部' ? '全部（三块）' : s) + '</button>';
    }).join('');
    return '<span class="menu-wrap"><button type="button" class="mini" data-menu="1" data-act="' + act + '">' +
      label + ' ▾</button><span class="menu">' + items + '</span></span>';
  }

  function injectCardTools() {
    Array.prototype.forEach.call(document.querySelectorAll('main .card'), function (card) {
      if (card.querySelector('.card-tools')) return;
      var h3 = card.querySelector('h3');
      if (!h3) return;
      // 标题包一层 span，与工具按钮组成一行（标题自适应，按钮靠右）
      var title = document.createElement('span');
      title.className = 'card-title';
      while (h3.firstChild) title.appendChild(h3.firstChild);
      h3.appendChild(title);
      var tools = document.createElement('div');
      tools.className = 'card-tools';
      tools.innerHTML = card.querySelector('#pivotBlocks')
        ? menuWrap('导出为图片', 'png') + menuWrap('复制为图片', 'copy')
        : '<button type="button" class="mini" data-act="png">导出为图片</button>' +
          '<button type="button" class="mini" data-act="copy">复制为图片</button>';
      h3.appendChild(tools);
    });
  }

  function closeMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('.menu-wrap.open'), function (w) {
      w.classList.remove('open');
    });
  }

  function cardName(node) {
    var h3 = node.querySelector('h3');
    var t;
    if (h3) {
      var ct = h3.querySelector('.card-title');
      t = (ct || h3).textContent;   // 排除工具按钮文字
    } else {
      var pt = node.querySelector('.pivot-title');
      t = pt ? pt.textContent.replace(/[▼▶]/g, '').split('整体')[0].trim() : 'chart';
    }
    return t.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  }

  // 透视表列多时靠横向滚动显示，导出前临时加宽节点，避免图片丢失右侧列
  function widenForCapture(node) {
    var delta = 0;
    Array.prototype.forEach.call(node.querySelectorAll('.table-wrap'), function (w) {
      delta = Math.max(delta, w.scrollWidth - w.clientWidth);
    });
    if (!delta) return null;
    var prev = node.style.width;
    node.style.width = node.clientWidth + delta + 'px';
    return function () { node.style.width = prev; };
  }

  function captureCard(card) {
    if (typeof html2canvas === 'undefined') {
      return Promise.reject(new Error('图片库 html2canvas 未加载（可能无外网）'));
    }
    var restore = widenForCapture(card);
    return html2canvas(card, {
      backgroundColor: '#ffffff',
      scale: window.devicePixelRatio > 1 ? 2 : 1.5,
      ignoreElements: function (el) {
        return !!(el.classList && el.classList.contains('card-tools'));
      }
    }).then(function (canvas) {
      if (restore) restore();
      return canvas;
    }, function (e) {
      if (restore) restore();
      throw e;
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
  }

  function exportPng(node) {
    notice('正在生成图片…', 'ok');
    return captureCard(node).then(canvasToBlob).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = cardName(node) + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      notice('图片已下载：' + esc(cardName(node)) + '.png', 'ok');
    }).catch(function (e) { notice('导出失败：' + esc(e.message || e), 'err'); throw e; });
  }

  function copyPng(node) {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
      notice('当前浏览器不支持复制图片，请改用「导出为图片」。', 'err');
      return Promise.reject(new Error('ClipboardItem 不可用'));
    }
    notice('正在生成图片…', 'ok');
    return captureCard(node).then(canvasToBlob).then(function (blob) {
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }).then(function () {
      notice('图片已复制到剪贴板，可直接粘贴（Ctrl+V）。', 'ok');
    }).catch(function (e) { notice('复制失败：' + esc(e.message || e), 'err'); throw e; });
  }

  // 按范围取节点（透视卡片可选 前场 / 后场 / 一体化）；若该块处于折叠态则临时展开、截完还原
  function runCapture(card, act, scope) {
    var node = card;
    var restore = null;
    if (scope && scope !== '全部') {
      Array.prototype.some.call(card.querySelectorAll('.pivot-block'), function (b) {
        var t = b.querySelector('.pivot-title');
        if (t && t.textContent.indexOf(scope) >= 0) { node = b; return true; }
        return false;
      });
      if (node.classList && node.classList.contains('collapsed')) {
        node.classList.remove('collapsed');
        restore = node;
      }
    }
    var p = (act === 'png') ? exportPng(node) : copyPng(node);
    if (restore) {
      Promise.resolve(p).catch(function () { }).then(function () { restore.classList.add('collapsed'); });
    }
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target;
    if (!el || !el.closest) return;
    if (!el.closest('.menu-wrap')) closeMenus();

    var menuBtn = el.closest('[data-menu]');
    if (menuBtn) {
      var wrap = menuBtn.parentNode;
      var wasOpen = wrap.classList.contains('open');
      closeMenus();
      if (!wasOpen) wrap.classList.add('open');
      ev.preventDefault();
      return;
    }
    var item = el.closest('[data-scope]');
    if (item) {
      var card = item.closest('.card');
      closeMenus();
      if (card) runCapture(card, item.getAttribute('data-act'), item.getAttribute('data-scope'));
      return;
    }
    var btn = el.closest('[data-act]');
    if (btn) {
      var c2 = btn.closest('.card');
      if (c2) runCapture(c2, btn.getAttribute('data-act'), '全部');
    }
  });

  /* 顶栏口径开关（统一入口）：联动顶端卡片与「作业类型 × 小时 效率」图 */
  var weightedToggle = document.getElementById('weightedToggle');
  if (weightedToggle) weightedToggle.addEventListener('change', function () {
    weighted = weightedToggle.checked;
    if (HEMA.charts.setWeighted) HEMA.charts.setWeighted(weighted);
    if (current) renderKpis(current);
  });

  /* ---------- 启动：优先取服务端最新数据集 ---------- */
  injectCardTools();
  if (typeof echarts === 'undefined') {
    notice('图表库 ECharts 未加载（可能无外网）。页面其余内容仍可正常使用。', 'err');
  }
  fetch(API + '/latest').then(readJson).then(function (ds) {
    render(ds);
    loadHistory(ds.id);
    notice('已加载服务端最新数据集（#' + ds.id + '）。', 'ok');
  }).catch(function (err) {
    render(SAMPLE);
    loadHistory(null);
    notice('接口未连通：' + esc(err.message || err) + '。<br>当前 API_BASE：<b>' + esc(API) +
      '</b>，已展示内置示例数据；上传将由服务端计算并入库。', 'err');
  });
})(window);
