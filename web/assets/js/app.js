/* 控制层：调用后端 API（解析/计算在服务端），渲染 KPI / 图表 / 表格 */
(function (global) {
  var HEMA = global.HEMA = global.HEMA || {};
  var API = (global.HEMA_CONFIG && global.HEMA_CONFIG.API_BASE) || '/api';
  var current = null;
  var curDate = null;     // 当前展示日期；null = 取数据集内最新日期
  var viewMode = 'day';   // 视图范围：day = 单日；week = 自然周（周一~周日）；month = 自然月
  var weighted = true;    // 全局效率口径：true = 按工时加权（默认），false = 人均；由顶栏开关统一切换

  /* 「周视图 / 月视图」：点击顶栏按钮在「本页」直接切换视图范围，读取库内已有数据按自然周 / 自然月聚合；
     也支持用 ?view=week|month&date=YYYY-MM-DD 直接进入（此时 viewPage = true，锚点日期由 URL 带入） */
  var viewPage = false;   // 由 URL 深链直接进入周 / 月视图（非本页切换）
  var qDate = null;       // 视图锚点日期（URL 带入）
  try {
    var qs = new URLSearchParams(global.location.search);
    var qView = qs.get('view');
    if (qView === 'week' || qView === 'month') { viewMode = qView; viewPage = true; }
    var qd = qs.get('date');
    if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) { qDate = qd; curDate = qd; }
  } catch (e) { /* 不支持 URLSearchParams 的环境按日视图处理 */ }

  // 统一响应解析：后端未部署/地址配错时返回的是 HTML，给出可定位的错误
  function readJson(res) {
    return res.text().then(function (txt) {
      var body = null;
      try { body = JSON.parse(txt); } catch (e) { body = null; }
      if (!res.ok) {
        // 业务错误（如「暂无数据，请先上传拣货单」）：优先透出服务端给出的原因
        var err = new Error((body && body.error) ||
          'HTTP ' + res.status + '（' + (res.url || '') + '）');
        err.status = res.status;
        throw err;
      }
      if (!body) {
        throw new Error('接口未返回 JSON，请检查 API_BASE（当前 ' + API + '）或后端部署：' +
          (res.url || '') + ' → ' + txt.replace(/\s+/g, ' ').slice(0, 60));
      }
      return body;
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmt(v, d) { return v == null ? '-' : Number(v).toFixed(d == null ? 2 : d); }

  var noticeEl = document.getElementById('notice');
  var noticeTimer = null;

  /* 访问方式判定（本地 / IP / 域名）：与 config.js 的 API_BASE 判定保持同一套规则。
     纯 IP 访问时页面处于非安全上下文，浏览器禁用剪贴板 API，需引导改用域名。 */
  var ACCESS = (function () {
    var host = (global.location && global.location.hostname) || '';
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
      return { kind: '本地', host: host || '-' };
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return { kind: 'IP', host: host, domain: 'https://xl.yjmc.xyz/' };
    }
    return { kind: '域名', host: host || '-' };
  })();

  function domainLink() {
    return '<a href="' + ACCESS.domain + '" target="_blank" rel="noopener">域名访问 ' + ACCESS.domain + '</a>';
  }

  /* 手机 + IP 访问：自动跳到域名。IP 是 http 非安全上下文，移动端剪贴板等能力受限；
     只在 IP 访问时跳转，已用域名访问时不再跳（避免死循环）。保留 query / hash（如 ?view=week） */
  var MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|BlackBerry|HarmonyOS|MicroMessenger/i;
  if (ACCESS.kind === 'IP' && MOBILE_UA.test((global.navigator && global.navigator.userAgent) || '')) {
    global.location.replace(ACCESS.domain + (global.location.search || '') + (global.location.hash || ''));
    return;   // 已发起跳转，不再继续初始化本页
  }

  /* 顶栏品牌区右侧（h1 右边）：常显当前访问方式；IP 访问的剪贴板限制说明与域名入口
     由顶栏主行下方的红色提示条（#ipWarn）常显给出 */
  function renderAccess() {
    var el = document.getElementById('accessInfo');
    if (el) {
      el.innerHTML = '当前访问方式：<b>' + esc(ACCESS.kind) + '</b>（' + esc(ACCESS.host) + '）';
    }
    var warn = document.getElementById('ipWarn');
    if (warn) {
      warn.innerHTML = ACCESS.kind === 'IP'
        ? '因浏览器限制，IP访问时无法复制图片到剪贴板，请使用' + domainLink()
        : '';
      warn.classList.toggle('hidden', ACCESS.kind !== 'IP');
    }
  }

  /* 顶部居中吐司提示：成功/进行中提示数秒后自动消失，
     错误提示保留至手动关闭或被下一条覆盖 */
  function notice(msg, type) {
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
    if (!msg) { noticeEl.className = 'notice hidden'; noticeEl.innerHTML = ''; return; }
    noticeEl.className = 'notice ' + (type || '');
    noticeEl.innerHTML = '<button type="button" class="notice-close" title="关闭">×</button>' + msg;
    if (type !== 'err') {
      noticeTimer = setTimeout(function () {
        noticeTimer = null;
        noticeEl.className = 'notice hidden';
      }, 4000);
    }
  }

  noticeEl.addEventListener('click', function (ev) {
    if (ev.target && ev.target.classList.contains('notice-close')) {
      if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
      // 上传进行中手动关闭：本次上传不再刷新提示条（结束后仍会给出最终结果）
      if (upState) upState.hidden = true;
      noticeEl.className = 'notice hidden';
      noticeEl.innerHTML = '';
    }
  });

  /* ---------- KPI：第一行 综合效率 + 各作业类型；第二行 规模指标（更小） ---------- */
  function kpiCard(c) {
    return '<div class="kpi"><div class="label">' + c.label + '</div>' +
      '<div class="value" data-num="' + esc(String(c.raw != null ? c.raw : c.value)) + '">' +
        c.value + '<small>' + c.unit + '</small></div>' +
      '<div class="foot">' + c.foot + '</div></div>';
  }

  /* KPI 数字跳动动画：把 data-num 目标值在 500ms 内从 0 过渡到目标值 */
  function animateKpiNumbers() {
    var els = document.querySelectorAll('.kpi .value[data-num]');
    var DURATION = 520;
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var raw = el.getAttribute('data-num');
        if (!raw) return;
        var target = parseFloat(String(raw).replace(/,/g, ''));
        if (isNaN(target)) return;
        var small = el.querySelector('small');
        var unitHtml = small ? small.outerHTML : '';
        var isInt = raw.indexOf('.') < 0;
        el.classList.add('counting');
        var started = null;
        function tick(ts) {
          if (!started) started = ts;
          var p = Math.min(1, (ts - started) / DURATION);
          // ease-out-expo: 快起慢停
          var ease = 1 - Math.pow(1 - p, 3);
          var cur = target * ease;
          el.innerHTML = (isInt ? Math.round(cur).toLocaleString() : cur.toFixed(2)) + unitHtml;
          if (p < 1) requestAnimationFrame(tick);
          else { el.innerHTML = (isInt ? target.toLocaleString() : target.toFixed(2)) + unitHtml; el.classList.remove('counting'); }
        }
        requestAnimationFrame(tick);
      })(els[i]);
    }
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
        raw: useAvg ? all.avg : t.eff,
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
      var val = !weighted && ps.avg != null ? ps.avg : j.eff;
      main.push({
        label: '<span class="dot" style="background:' + color + '"></span>' + esc(j.name),
        value: fmt(val), unit: '行/h', raw: val,
        foot: !weighted && ps.avg != null ? ps.n + ' 人平均 · ' + scale : scale
      });
    });
    var sub = [
      { label: '拣货行数', value: t.rows.toLocaleString(), unit: '行', raw: t.rows, foot: '有效明细合计' }
    ];
    // 数据含「拣货数量」字段时才显示数量卡（与「拣货数量统计」卡片同一存在条件）
    if (d.stats && d.stats.qtyStat) {
      sub.push({ label: '拣货数量', value: (t.qty || 0).toLocaleString(), unit: '件', raw: t.qty || 0,
        foot: '有效明细「拣货数量」合计' });
    }
    sub.push(
      { label: '拣货人数', value: t.persons, unit: '人', raw: t.persons, foot: '参与拣货的人员' },
      { label: '有效明细', value: d.meta.recordCount.toLocaleString(), unit: '条', raw: d.meta.recordCount,
        foot: '丢弃 ' + d.meta.dropped + ' 条（缺人/缺时间）' +
          (d.meta.otherStore ? '，已过滤 ' + d.meta.otherStore + ' 条（非本门店）' : '') +
          (d.meta.ignored ? '，已忽略 ' + d.meta.ignored + ' 条（分区设置）' : '') }
    );
    document.getElementById('kpis').innerHTML = main.map(kpiCard).join('');
    document.getElementById('kpisSub').innerHTML = sub.map(kpiCard).join('');
    animateKpiNumbers();
  }

  /* ---------- 表格排序（所有表格表头均可点击切换升/降序） ---------- */
  // 每个表一份排序状态 { key, dir }（dir = 1 升序，-1 降序）；key 为 null 表示保持服务端给出的顺序
  var SORTS = {};
  function sortState(name, defKey, defDir) {
    var st = SORTS[name];
    if (!st) st = SORTS[name] = { key: defKey || null, dir: defDir || -1 };
    return st;
  }

  /* 表头 HTML：cols = [{ key, label, text, cls }]；无 key 的列不可排序
     text = 1 表示文本列（首次点击按升序，其余按降序） */
  function theadHtml(cols, st) {
    return '<thead><tr>' + cols.map(function (c) {
      if (!c.key) return '<th' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + c.label + '</th>';
      var mark = st && st.key === c.key ? (st.dir === 1 ? ' ▲' : ' ▼') : '';
      return '<th class="sortable' + (c.cls ? ' ' + c.cls : '') + '" data-key="' + c.key + '"' +
        (c.text ? ' data-text="1"' : '') + ' title="点击切换升/降序">' + c.label + mark + '</th>';
    }).join('') + '</tr></thead>';
  }

  /* 按当前排序状态排序（返回新数组，不改动原数据）；getters = { key: 取值函数 }
     空值恒排在末尾，文本按拼音比较 */
  function sortRows(list, st, getters) {
    var get = (st && st.key && getters) ? getters[st.key] : null;
    if (!get) return list.slice();
    return list.slice().sort(function (a, b) {
      var va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        return st.dir * String(va).localeCompare(String(vb), 'zh-Hans-CN');
      }
      return st.dir * (va - vb);
    });
  }

  /* 分档标签（如「≥ 240」「0 – 60」）的起始数值：用于按区间大小排序 */
  function labelNum(label) {
    var m = String(label).match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  /* 表头点击排序（事件委托到表格容器）：容器内含多张表（如分两栏渲染）时同样有效 */
  function bindSort(container, name, onSorted) {
    if (!container) return;
    container.addEventListener('click', function (ev) {
      var el = ev.target;
      while (el && el.tagName !== 'TH') el = el.parentNode;
      if (!el || !el.tagName || String(el.className || '').indexOf('sortable') < 0) return;
      var key = el.getAttribute('data-key');
      var st = sortState(name);
      if (st.key === key) st.dir = -st.dir;
      else { st.key = key; st.dir = el.getAttribute('data-text') === '1' ? 1 : -1; }
      onSorted();
    });
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
  var TARGETS = { '后场合流': 260 };

  /* 色阶锚点：与「分区 × 小时效率热力图」visualMap.inRange.color 一致（7 档：红→黄→绿） */
  var HEAT_STOPS = [
    { r: 0.000, rgb: [254, 226, 226] },   // #fee2e2
    { r: 0.167, rgb: [254, 243, 199] },   // #fef3c7
    { r: 0.333, rgb: [254, 249, 195] },   // #fef9c3
    { r: 0.500, rgb: [217, 249, 157] },   // #d9f99d
    { r: 0.667, rgb: [167, 243, 208] },   // #a7f3d0
    { r: 0.833, rgb: [110, 231, 183] },   // #6ee7b7
    { r: 1.000, rgb: [52, 211, 153] }     // #34d399
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

  /* 时间轴列头标签：小时「N点」/ 日期「MM-DD」/ 周「MM-DD~MM-DD」。
     月视图按自然周分桶，首 / 末周会跨出当月（如 10 月 1 日所在周的周一为 9-28），
     标签裁到当前聚合区间，避免 10 月视图出现 9 月的日期 */
  function axisColLabel(v, unit) {
    if (unit === 'week') {
      var s = String(v);
      var d = new Date(s + 'T00:00:00');
      if (isNaN(d.getTime())) return s;
      var e = new Date(d); e.setDate(d.getDate() + 6);
      var eStr = ymd(e);
      var r = viewRange();
      if (r) { if (s < r.from) s = r.from; if (eStr > r.to) eStr = r.to; }
      return s.slice(5) + '~' + eStr.slice(5);
    }
    if (unit === 'date') return String(v).slice(5);
    return v + '点';
  }

  /* ---------- 人员 × 小时 透视：3 块（前场合流 / 后场合流 / 一体化），可折叠并记忆 ---------- */
  function renderPivotBlocks(d) {
    var host = document.getElementById('pivotBlocks');
    if (!host) return;
    var pb = d.personByHour, hours = pb.hours;
    var unit = (d.meta && d.meta.bucket) || 'hour';   // 周 / 月聚合：列头为日期 / 周
    var colors = (global.HEMA_CONFIG && global.HEMA_CONFIG.COLORS) || {};
    var collapsed = collapsedSet();
    /* 人均口径（顶栏口径开关未勾选时）：按作业类型给出各时段「各人效率的算术平均」 */
    var uwHour = (d.jobTypeByHour && d.jobTypeByHour.unweighted) || null;

    var cols = [{ key: 'person', label: '拣货人', text: 1 }]
      .concat(hours.map(function (h) {
        return { key: 'h' + h, label: axisColLabel(h, unit) };
      }))
      .concat([{ key: 'total', label: '总计' }]);
    var pSt = sortState('pivot', null, -1);
    var head = theadHtml(cols, pSt);
    /* 口径说明：原先作为表格末尾的一行（td.table-note），现移到该块折线图下方，故单独成串 */
    var noteText =
      '小计＝该范围内 Σ拣货行数 ÷ Σ拣货时长（按工时加权）；取消勾选顶栏「按工时加权」后，' +
      '小计改为该范围内各人效率的算术平均（人均口径，随开关同步）；' +
      '「平均值 / 中位数」按各人总计效率统计，浅蓝 / 浅紫边框标出与之最接近的人员行；「-」表示该' +
      (unit === 'hour' ? '时段' : (unit === 'week' ? '周' : '日')) + '无记录。';
    // 点击表头可排序：按人或按某个小时（或总计）的效率升降序
    var getters = { person: function (r) { return r.person; }, total: function (r) { return r.total; } };
    hours.forEach(function (h, i) { getters['h' + h] = function (r) { return r.data[i]; }; });

    var blocks = orderBlocks((pb.groups && pb.groups.length) ? pb.groups : fallbackGroups(pb));

    var subCharts = [];   // 每块「小计」折线图的数据（HTML 建好后统一渲染到对应容器）
    // 重建 DOM 前先释放上一轮的折线图实例，否则它们会残留在被移除的节点上造成泄漏
    if (typeof echarts !== 'undefined') {
      Array.prototype.forEach.call(host.querySelectorAll('.pivot-chart'), function (el) {
        var p = echarts.getInstanceByDom(el);
        if (p) p.dispose();
      });
    }
    host.innerHTML = blocks.map(function (g, bi) {
      var color = colors[g.type] || '#64748b';
      var isCol = collapsed.indexOf(g.type) >= 0;
      var gs = g.stat || {};
      /* 口径：勾选顶栏「按工时加权」用服务端给出的 Σ行数 ÷ Σ时长；
         取消勾选改用各时段各人效率的算术平均（人均口径，随顶栏开关同步） */
      var uwh = (!weighted && uwHour) ? uwHour[g.type] : null;
      var hourly = (uwh && uwh.length === g.hourly.length) ? uwh : g.hourly;
      var bTotal = (!weighted && gs.avg != null) ? gs.avg : g.total;
      var bvals = hourly.filter(function (v) { return v != null; });
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
      var avg = gs.avg == null ? null : gs.avg, med = gs.median == null ? null : gs.median;

      var body = sortRows(g.persons, pSt, getters).map(function (r) {
        var tag = r.person === gs.medianPerson ? 'median' : (r.person === gs.avgPerson ? 'avg' : '');
        return '<tr class="person' + (tag ? ' near-' + tag : '') + '">' +
          '<td>' + esc(r.person) + '</td>' + cellArr(r.data) + cell(r.total, tag) + '</tr>';
      }).join('');
      body += '<tr class="total"><td>小计</td>' + cellArr(hourly) + cell(bTotal) + '</tr>';

      var target = TARGETS[g.type];
      var chartId = 'pvSub' + bi;
      subCharts.push({
        id: chartId,
        color: color,
        target: target == null ? null : target,
        unit: unit,
        keys: hours.slice(),   // 原始时间值（小时数 / 日期 / 周起始日）：折线按真实时间定位，非等距
        labels: hours.map(function (h) { return axisColLabel(h, unit); }),
        values: hourly
      });
      /* 折线图行：紧贴「小计」行（tfoot 首行）。左右各留一个空单元格，
         使绘图区只覆盖时段列（不含首列「拣货人」与末列「总计」） */
      var subRow = '<tfoot><tr class="pivot-chart-row">' +
        '<td class="pivot-chart-pad"></td>' +
        '<td colspan="' + hours.length + '" class="pivot-chart-cell">' +
        '<div class="pivot-chart" id="' + chartId + '"></div></td>' +
        '<td class="pivot-chart-pad"></td></tr></tfoot>';
      return '<div class="pivot-block' + (isCol ? ' collapsed' : '') + '">' +
        '<div class="pivot-title" data-toggle="' + esc(g.type) + '" title="点击折叠 / 展开">' +
        '<span class="caret">' + (isCol ? '▶' : '▼') + '</span>' +
        '<span class="dot" style="background:' + color + '"></span>' + esc(g.type) +
        '<small>整体 ' + fmt(bTotal, 1) + ' 行/h · ' + g.rows.toLocaleString() + ' 行 · ' +
        fmt(g.hours, 2) + ' h · ' + g.persons.length + ' 人' +
        (target ? ' · 达标线 ' + target + ' 行/h' : '') + '</small>' +
        (avg == null ? '' : '<span class="pv-legend"><span class="dot avg"></span>平均 ' + fmt(avg, 1) + ' 行/h</span>') +
        (med == null ? '' : '<span class="pv-legend"><span class="dot median"></span>中位数 ' + fmt(med, 1) + ' 行/h</span>') +
        '</div>' +
        '<div class="table-wrap"><table>' + head + '<tbody>' + body + '</tbody>' + subRow + '</table></div>' +
        '<div class="note">' + noteText + '</div>' +
        '</div>';
    }).join('');

    /* 量取表格「完整显示且不出现左右滑动」所需的最小宽度，写入 --pivot-min：
       用 min-content 量取（可换行的脚注行会折行，数据 / 表头为 nowrap 保持原样），
       即表格在不产生横向滚动时能收缩到的最小宽度 —— 用它而非 max-content，
       否则脚注长文本会把宽度撑大，导致宽屏下也只能并排两块。
       各块人员不同、首列宽窄略有差异，取三块最大值兜底 */
    var minW = 0;
    Array.prototype.forEach.call(host.querySelectorAll('table'), function (t) {
      var prevW = t.style.width;
      t.style.width = 'min-content';
      minW = Math.max(minW, Math.ceil(t.getBoundingClientRect().width));
      t.style.width = prevW;
    });
    if (minW > 0) host.style.setProperty('--pivot-min', (minW + 2) + 'px');   // +2：表格容器左右各 1px 边框

    /* 每块「小计」行下方的折线图：数据为该块各时段的小计效率（口径随顶栏开关）。
       折叠中的块尺寸为 0，跳过绘制，展开时会重渲染本函数再画 */
    if (HEMA.charts && HEMA.charts.renderPivotSubtotals) {
      subCharts.forEach(function (s) { s.el = document.getElementById(s.id); });
      HEMA.charts.renderPivotSubtotals(subCharts);
    }
  }

  /* ---------- 细分明细（表头可点击升/降序） ---------- */
  var ZONE_COLS = [
    { key: 'type', label: '作业类型', text: 1 },
    { key: 'zone', label: '拣货分区', text: 1 },
    { key: 'rows', label: '拣货行数' },
    { key: 'hours', label: '时长(h)' },
    { key: 'eff', label: '效率(行/h)' },
    { key: 'share', label: '行数占比' }
  ];
  /* 人均口径下的「整体效率」（各人总计效率的算术平均）：顶栏取消勾选时与 KPI 卡保持一致 */
  function meanEff(d) {
    var all = personMean(d, null);
    return all.avg == null ? d.totals.eff : all.avg;
  }

  var ZONE_GET = {
    type: function (r) { return r.type; },
    zone: function (r) { return r.zone; },
    rows: function (r) { return r.rows; },
    hours: function (r) { return r.hours; },
    eff: function (r) { return (!weighted && r.avg != null) ? r.avg : r.eff; },
    share: function (r) { return r.share; }
  };

  function renderZoneTable(d) {
    var st = sortState('zone');
    var html = theadHtml(ZONE_COLS, st) + '<tbody>';
    sortRows(d.byZone, st, ZONE_GET).forEach(function (r) {
      html += '<tr><td>' + esc(r.type) + '</td><td>' + esc(r.zone) + '</td><td>' + r.rows + '</td><td>' +
        fmt(r.hours, 4) + '</td><td>' + fmt(ZONE_GET.eff(r)) + '</td><td>' + r.share + '%</td></tr>';
    });
    html += '<tr class="total"><td>合计</td><td></td><td>' + d.totals.rows + '</td><td>' +
      fmt(d.totals.hours, 4) + '</td><td>' + fmt(weighted ? d.totals.eff : meanEff(d)) +
      '</td><td>100%</td></tr></tbody>';
    document.getElementById('tableZone').innerHTML = html;
  }

  /* ---------- 人员效率明细（表头可点击升降序） ---------- */
  var PERSON_COLS = [
    { key: null, label: '排名' },
    { key: 'name', label: '拣货人', text: 1 },
    { key: 'rows', label: '拣货行数' },
    { key: 'hours', label: '时长(h)' },
    { key: 'eff', label: '效率(行/h)' }
  ];
  var PERSON_GET = {
    name: function (r) { return r.name; },
    rows: function (r) { return r.rows; },
    hours: function (r) { return r.hours; },
    eff: function (r) { return r.eff; }
  };

  function renderPersonTable(d) {
    var st = sortState('person', 'eff', -1);      // 默认：按效率降序
    var list = sortRows(d.byPerson, st, PERSON_GET);
    var head = theadHtml(PERSON_COLS, st);

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
          fmt(d.totals.hours, 4) + '</td><td>' +
          fmt(weighted ? d.totals.eff : meanEff(d)) + '</td></tr>';
      }
      return '<div class="table-wrap"><table>' + head + '<tbody>' + body + '</tbody></table></div>';
    }).join('');
  }

  /* ---------- 超时卡片的「按人员统计」（默认折叠，点击标题展开） ---------- */
  function renderTimeoutPerson(d) {
    var table = document.getElementById('tableTimeoutPerson');
    if (!table) return;
    var to = (d && d.timeout) || null;
    var sub = document.getElementById('timeoutPersonSub');
    if (!to) { table.innerHTML = ''; if (sub) sub.textContent = ''; return; }
    var rows = to.byPerson || [];
    var duties = to.duties || [];
    if (sub) sub.textContent = rows.length ? '共 ' + rows.length + ' 人有超时单' : '无超时单';

    var cols = [
      { key: 'person', label: '拣货人', text: 1 },
      { key: 'timeout', label: '超时单数' },
      { key: 'all', label: '明细条数' },
      { key: 'rate', label: '超时率' }
    ].concat(duties.map(function (du) { return { key: 'duty:' + du.name, label: du.name }; }));
    var getters = {
      person: function (r) { return r.person; },
      timeout: function (r) { return r.timeout; },
      all: function (r) { return r.all; },
      rate: function (r) { return r.rate; }
    };
    var dutyOf = function (r, name) { return (r.duties && r.duties[name]) || 0; };
    duties.forEach(function (du) { getters['duty:' + du.name] = function (r) { return dutyOf(r, du.name); }; });

    var st = sortState('timeoutPerson', 'timeout', -1);
    var list = sortRows(rows, st, getters);
    var sum = function (f) { return rows.reduce(function (s, r) { return s + f(r); }, 0); };
    var sumT = sum(function (r) { return r.timeout; }), sumAll = sum(function (r) { return r.all; });

    var body = list.map(function (r) {
      return '<tr><td>' + esc(r.person) + '</td><td>' + r.timeout + '</td><td>' + r.all + '</td><td>' +
        fmt(r.rate * 100, 1) + '%</td>' +
        duties.map(function (du) { return '<td>' + dutyOf(r, du.name) + '</td>'; }).join('') + '</tr>';
    }).join('');
    // 合计行放在 tbody 内（与其它表格一致，复用 tbody tr.total 的加粗底色），不参与排序
    body += '<tr class="total"><td>合计</td><td>' + sumT + '</td><td>' + sumAll + '</td><td>' +
      fmt(sumAll ? sumT / sumAll * 100 : 0, 1) + '%</td>' +
      duties.map(function (du) { return '<td>' + sum(function (r) { return dutyOf(r, du.name); }) + '</td>'; }).join('') +
      '</tr>';
    table.innerHTML = theadHtml(cols, st) + '<tbody>' + body + '</tbody>';
  }

  /* ---------- 超时 × 分区统计 ---------- */
  /* 分区配色表（与 charts.js ZONE_PALETTE 保持一致） */
  var ZONE_PALETTE = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed',
    '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b91c1c'];

  function renderTimeoutZone(d) {
    var table = document.getElementById('tableTimeoutZone');
    if (!table) return;
    var to = (d && d.timeout) || null;
    if (!to || !to.zones || !to.zones.length) { table.innerHTML = ''; return; }
    var zones = to.zones || [];
    var total = to.total || 0;
    // 为每个分区分配颜色（按超时单数降序，与图表一致）
    var zoneColorMap = {};
    zones.forEach(function (z, i) { zoneColorMap[z.name] = ZONE_PALETTE[i % ZONE_PALETTE.length]; });

    var st = sortState('timeoutZone', 'count', -1);
    var cols = [
      { key: 'name', label: '拣货分区', text: 1 },
      { key: 'count', label: '超时单数' },
      { key: 'share', label: '占比' }
    ];
    var getters = {
      name: function (r) { return r.name; },
      count: function (r) { return r.count; },
      share: function (r) { return total ? r.count / total : 0; }
    };
    var list = sortRows(zones.slice(), st, getters);
    var body = list.map(function (r) {
      var color = zoneColorMap[r.name] || '#64748b';
      return '<tr><td><span class="dot" style="background:' + color + ';width:8px;height:8px;margin-right:6px"></span>' +
        esc(r.name) + '</td><td>' + r.count + '</td><td>' +
        fmt(total ? r.count / total * 100 : 0, 1) + '%</td></tr>';
    }).join('');
    body += '<tr class="total"><td>合计</td><td>' + total + '</td><td>100%</td></tr>';
    table.innerHTML = theadHtml(cols, st) + '<tbody>' + body + '</tbody>';
  }

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
    var unit = (d.meta && d.meta.bucket) || 'hour';   // 周 / 月聚合：稳定性按日期 / 周衡量
    var spanW = unit === 'week' ? '周' : (unit === 'date' ? '日' : '小时');
    var countW = unit === 'week' ? '记录周数' : (unit === 'date' ? '记录天数' : '记录小时数');
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
    var binSt = sortState('effBin');
    var binCols = [
      { key: 'label', label: '效率区间（行/h）', text: 1 },
      { key: 'n', label: '人数' },
      { key: 'nshare', label: '人数占比' },
      { key: 'rows', label: '行数合计' }
    ];
    var binGet = {
      label: function (b) { return labelNum(b.label); },
      n: function (b) { return b.n; },
      nshare: function (b) { return n ? b.n / n : 0; },
      rows: function (b) { return b.rows; }
    };
    var html = theadHtml(binCols, binSt) + '<tbody>';
    sortRows(s.effBins || [], binSt, binGet).forEach(function (b) {
      html += '<tr><td>' + b.label + '</td><td>' + b.n + '</td><td>' +
        fmt(n ? b.n / n * 100 : 0, 1) + '%</td><td>' + b.rows.toLocaleString() + '</td></tr>';
    });
    html += '<tr class="total"><td>合计</td><td>' + n + '</td><td>100.0%</td><td>' +
      d.totals.rows.toLocaleString() + '</td></tr></tbody>';
    document.getElementById('tableEffBin').innerHTML = html;

    /* 稳定性榜：波动最大 / 最稳定各 10 人（人数不足时全部列出） */
    var st = s.stability || [];
    var stbSt = sortState('stability');
    var stbCols = [
      { key: 'person', label: '拣货人', text: 1 },
      { key: 'type', label: '主要作业类型', text: 1 },
      { key: 'n', label: countW },
      { key: 'avg', label: '平均效率' },
      { key: 'sd', label: '标准差' },
      { key: 'cv', label: '变异系数' }
    ];
    var stbGet = {
      person: function (r) { return r.person; },
      type: function (r) { return r.type; },
      n: function (r) { return r.n; },
      avg: function (r) { return r.avg; },
      sd: function (r) { return r.sd; },
      cv: function (r) { return r.cv; }
    };
    var head = theadHtml(stbCols, stbSt);
    var rowOf = function (r) {
      return '<tr><td>' + esc(r.person) + '</td><td>' + esc(r.type) + '</td><td>' + r.n + '</td><td>' +
        fmt(r.avg, 1) + '</td><td>' + fmt(r.sd, 1) + '</td><td>' + fmt(r.cv, 2) + '</td></tr>';
    };
    var sec = function (t) {
      return '<tr class="group"><td colspan="6">' + t + '</td></tr>';
    };
    var body;
    if (!st.length) {
      body = '<tr><td colspan="6" class="dm-empty">暂无足够的每' + spanW +
        '记录（每人需 ≥ 3 ' + spanW + '）</td></tr>';
    } else if (st.length <= 22) {
      body = sortRows(st, stbSt, stbGet).map(rowOf).join('');
    } else {
      // 分两组展示（组内可按各列排序；未选排序列时保持「波动大→小 / 稳定→波动大」的默认序）
      body = sec('波动最大（变异系数高，需关注）') +
        sortRows(st.slice(-10).reverse(), stbSt, stbGet).map(rowOf).join('') +
        sec('最稳定（变异系数低）') + sortRows(st.slice(0, 10), stbSt, stbGet).map(rowOf).join('');
    }
    document.getElementById('tableStab').innerHTML = head + '<tbody>' + body + '</tbody>';

    document.getElementById('distNote').textContent =
      '分布：按各人总计效率（Σ拣货行数 ÷ Σ拣货时长）统计，不受顶栏口径开关影响。' +
      '稳定性：变异系数 = 标准差 ÷ 平均，越小表示该人各' + spanW + '产出一致；' +
      '为避免跨作业类型的基准差异（后场合流约 250、前场合流约 70）被误判为「不稳定」，' +
      '只在该人记录最多的作业类型内计算，且仅统计记录' + countW + ' ≥ 3 的人。';
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
    var rbSt = sortState('rowsBin');
    var rbCols = [
      { key: 'label', label: '行数区间', text: 1 },
      { key: 'n', label: '人数' },
      { key: 'nshare', label: '人数占比' },
      { key: 'rows', label: '行数合计' },
      { key: 'rshare', label: '行数占比' }
    ];
    var rbGet = {
      label: function (b) { return labelNum(b.label); },
      n: function (b) { return b.n; },
      nshare: function (b) { return n ? b.n / n : 0; },
      rows: function (b) { return b.rows; },
      rshare: function (b) { return totalRows ? b.rows / totalRows : 0; }
    };
    var html = theadHtml(rbCols, rbSt) + '<tbody>';
    sortRows(bins, rbSt, rbGet).forEach(function (b) {
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

  /* ---------- 卡片：拣货数量统计（件数，按人员分布与集中度） ---------- */
  function renderQtyStat(d) {
    var card = document.getElementById('qtyCard');
    var s = (d.stats && d.stats.qtyStat) || null;
    if (!s) { if (card) card.classList.add('hidden'); return; }   // 数据无「拣货数量」字段：整卡隐藏
    if (card) card.classList.remove('hidden');
    var n = s.n;
    var totalQty = s.total;

    /* 帕累托：数量从高到低累计，前 k 人贡献的数量占比（服务端已算好） */
    var paretoChip = function (t, label) {
      if (!t) return '';
      return chip(label, fmt(t.pct, 1), '%',
        '数量最多的前 ' + t.k + ' 人（占 ' + fmt(t.k / n * 100, 0) + '%）贡献了 ' + fmt(t.pct, 1) + '% 的数量');
    };

    document.getElementById('qtyStat').innerHTML = [
      chip('总拣货数量', totalQty.toLocaleString(), '件', '有效明细「拣货数量」之和'),
      chip('人均数量', fmt(s.avg, 0), '件', '总数量 ÷ ' + n + ' 人'),
      chip('中位数数量', fmt(s.median, 0), '件', '一半人高于此值'),
      chip('最高 / 最低', s.max.toLocaleString() + ' / ' + s.min, '件',
        '个人数量的极值，差距大说明分工不均'),
      paretoChip(s.top10, 'TOP 10% 人员数量占比'),
      paretoChip(s.top25, 'TOP 25% 人员数量占比')
    ].join('');

    /* TOP 10：条形长度按最高个人数量归一，右侧标注数量与占比 */
    var top = (d.stats && d.stats.qtyTop) || [];
    var maxQty = top.length ? top[0].qty : 0;
    document.getElementById('qtyTop').innerHTML = top.map(function (r, i) {
      var w = maxQty ? r.qty / maxQty * 100 : 0;
      return '<div class="bar-item">' +
        '<span class="bar-name" title="' + esc(r.name) + '">' + (i + 1) + '. ' + esc(r.name) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + fmt(w, 1) + '%"></span></span>' +
        '<span class="bar-val">' + r.qty.toLocaleString() + ' 件 · ' + fmt(r.share, 1) + '%</span>' +
        '</div>';
    }).join('');

    /* 数量分档：人数占比看「多少人干得少」，数量占比看「产出集中在哪一档」 */
    var bins = (d.stats && d.stats.qtyBins) || [];
    var qbSt = sortState('qtyBin');
    var qbCols = [
      { key: 'label', label: '数量区间（件）', text: 1 },
      { key: 'n', label: '人数' },
      { key: 'nshare', label: '人数占比' },
      { key: 'qty', label: '数量合计' },
      { key: 'qshare', label: '数量占比' }
    ];
    var qbGet = {
      label: function (b) { return labelNum(b.label); },
      n: function (b) { return b.n; },
      nshare: function (b) { return n ? b.n / n : 0; },
      qty: function (b) { return b.rows; },              // 分档产出量（数量）统一放在 rows 字段
      qshare: function (b) { return totalQty ? b.rows / totalQty : 0; }
    };
    var html = theadHtml(qbCols, qbSt) + '<tbody>';
    sortRows(bins, qbSt, qbGet).forEach(function (b) {
      html += '<tr><td>' + b.label + '</td><td>' + b.n + '</td><td>' + fmt(n ? b.n / n * 100 : 0, 1) + '%</td><td>' +
        b.rows.toLocaleString() + '</td><td>' + fmt(totalQty ? b.rows / totalQty * 100 : 0, 1) + '%</td></tr>';
    });
    html += '<tr class="total"><td>合计</td><td>' + n + '</td><td>100.0%</td><td>' +
      totalQty.toLocaleString() + '</td><td>100.0%</td></tr></tbody>';
    document.getElementById('tableQtyBin').innerHTML = html;

    document.getElementById('qtyNote').textContent =
      '口径：Σ「拣货数量」列（件），按人员汇总（与「行数」同口径：取消勾选顶栏「按工时加权」不影响本卡）。' +
      '占比条长度按最高个人数量归一，右侧为「数量 · 占总数量比例」。' +
      '分档表同时给两条口径：人数占比说明有多少人产出偏低；数量占比说明总产出集中在哪一档，' +
      '两者差距越大，说明产出越向少数人集中。';
  }

  /* ---------- 卡片：人员工作时间图（由拣货单起止时间反推的在岗时段） ---------- */

  /* 工作时间图与下方「各人·日 班次明细」共用 d.timeline.rows 这一份数据：
     按「人员效率明细」(d.byPerson) 的效率(行/h)降序排列，同一人的各天相邻，再按日期 / 首次拣货时间。
     就地排序 —— 图表（charts.js）随后直接读同一数组，且靠数组引用判断已选高亮行是否失效。 */
  function sortTimelineRows(d) {
    var tl = d && d.timeline;
    if (!tl || !tl.rows || tl.rows.length < 2) return;
    var rank = {};
    (d.byPerson || []).forEach(function (p, i) { rank[p.name] = i; });   // byPerson 已按效率降序
    tl.rows.sort(function (a, b) {
      var ra = rank[a.person], rb = rank[b.person];
      if (ra == null) ra = Infinity;
      if (rb == null) rb = Infinity;
      if (ra !== rb) return ra - rb;
      return a.date === b.date ? a.first - b.first : (a.date < b.date ? -1 : 1);
    });
  }

  /* 分钟（当天 0 点起算）-> HH:MM */
  function clockOf(min) {
    var h = Math.floor(min / 60), m = Math.round(min - h * 60);
    if (m >= 60) { h += 1; m -= 60; }
    return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
  }

  function renderTimeline(d) {
    var wrap = document.getElementById('timelineStat');
    var tableEl = document.getElementById('tableTimeline');
    var noteEl = document.getElementById('timelineNote');
    if (!wrap || !tableEl) return;

    var tl = d.timeline;
    var rows = (tl && tl.rows) || [];
    if (!rows.length) {
      wrap.innerHTML = '';
      tableEl.innerHTML = '';
      if (noteEl) noteEl.textContent = '当前数据集没有可用的拣货起止时间，无法反推在岗时段。';
      return;
    }

    /* 汇总指标：在岗时长按「首次拣货开始 → 末次拣货结束」计；在岗率 = Σ有效作业时长 ÷ Σ在岗时长 */
    var seen = {}, persons = 0;
    var sumSpan = 0, sumBusy = 0, maxGap = 0;
    rows.forEach(function (r) {
      if (!seen[r.person]) { seen[r.person] = 1; persons++; }
      sumSpan += r.span; sumBusy += r.busy;
      if (r.maxGap > maxGap) maxGap = r.maxGap;
    });
    var n = rows.length;

    wrap.innerHTML = [
      chip('在岗人数', persons, '人', '当天出现过拣货记录的人数'),
      chip('人·日 班次', n, '个', '按「拣货人 × 日期」拆分的班次数（一人多天算多个）'),
      chip('平均在岗时长', fmt(sumSpan / n / 60, 2), 'h', '各人·日 从首次拣货开始到末次拣货结束的平均跨度'),
      chip('平均在岗率', fmt(sumSpan ? sumBusy / sumSpan * 100 : 0, 1), '%',
        'Σ有效作业时长 ÷ Σ在岗时长：在岗期间真正在拣货的比例，越低说明空档越多'),
      chip('最大空档', maxGap, '分钟', '全员中最大的单次连续空档（相邻两段在岗之间的间隔）'),
      chip('总在岗时长', fmt(sumSpan / 60, 2), 'h', '全部人·日 班次的在岗时长合计')
    ].join('');

    /* 明细：每行一个「人·日」班次，默认与上方图表同序（按人员效率降序，见 sortTimelineRows） */
    var tlSt = sortState('timeline');
    var tlCols = [
      { key: 'person', label: '拣货人', text: 1 },
      { key: 'date', label: '日期', text: 1 },
      { key: 'first', label: '首次拣货' },
      { key: 'last', label: '末次拣货' },
      { key: 'span', label: '在岗时长' },
      { key: 'rate', label: '在岗率' },
      { key: 'busy', label: '有效作业' },
      { key: 'idle', label: '空闲时长' },
      { key: 'maxGap', label: '最大空档' },
      { key: 'orders', label: '拣货单数' }
    ];
    var tlGet = {
      person: function (r) { return r.person; },
      date: function (r) { return r.date; },
      first: function (r) { return r.first; },
      last: function (r) { return r.last; },
      span: function (r) { return r.span; },
      rate: function (r) { return r.rate; },
      busy: function (r) { return r.busy; },
      idle: function (r) { return r.idle; },
      maxGap: function (r) { return r.maxGap; },
      orders: function (r) { return r.orders; }
    };
    var head = theadHtml(tlCols, tlSt);
    var body = sortRows(rows, tlSt, tlGet).map(function (r) {
      return '<tr><td>' + esc(r.person) + '</td><td>' + esc(r.date) + '</td><td>' +
        clockOf(r.first) + '</td><td>' + clockOf(r.last) + '</td><td>' +
        fmt(r.span / 60, 2) + ' h</td><td>' + fmt(r.rate == null ? null : r.rate * 100, 1) + '%</td><td>' +
        fmt(r.busy / 60, 2) + ' h</td><td>' + fmt(r.idle / 60, 2) + ' h</td><td>' +
        r.maxGap + ' 分</td><td>' + r.orders + '</td></tr>';
    }).join('');
    tableEl.innerHTML = head + '<tbody>' + body + '</tbody>';

    if (noteEl) noteEl.textContent =
      '反推方法：按「拣货人 × 日期」分组，把每笔拣货单按其真实起止时间（当日 00:00 起的分钟数）取区间；' +
      '上一笔结束到下一笔开始的间隔不超过 ' + ((tl && tl.mergeGap) || 2) + ' 分钟时，视为连续作业并合并为一段（重叠亦接续）。' +
      '在岗时长 = 末次拣货结束 − 首次拣货开始；有效作业 = 各段在岗区间时长之和（即在拣货的时间）；' +
      '空闲时长 = 在岗时长 − 有效作业；在岗率 = 有效作业 ÷ 在岗时长。' +
      '在岗率偏低通常来自等单、备货、休息等未产生拣货记录的时间。';
  }

  /* ---------- 顶栏品牌区（h1 右侧）：时间范围 + 数据来源/有效明细 + 访问方式 ---------- */
  /* 时间范围（大字，与 h1 同字号）：文件内最早开始 → 最晚结束；跨天时带出首末日期 */
  function renderPeriod(m) {
    var bar = document.getElementById('periodBar');
    var rng = document.getElementById('periodRange');
    if (!bar || !rng) return;
    var p = m && m.period;
    if (!p || !p.start || !p.end) { bar.classList.add('hidden'); rng.textContent = ''; return; }
    rng.textContent = p.crossDay
      ? p.dateStart + ' ' + p.start + ' → ' + p.dateEnd + ' ' + p.end
      : p.dateStart + ' ' + p.start + ' – ' + p.end;
    bar.classList.remove('hidden');
  }

  /* 小字行左半：数据来源 + 有效明细（无数据集时给出引导文案）；周 / 月视图追加聚合范围 */
  function renderSource(m) {
    var el = document.getElementById('metaSource');
    if (!el) return;
    if (!m) { el.textContent = '当前无数据集，请先上传拣货单 xlsx。'; return; }
    var txt = '数据来源：' + (m.sourceFile || '-') +
      ' ｜ 有效明细 ' + Number(m.recordCount || 0).toLocaleString() + ' 条';
    if (m.range) {
      txt += ' ｜ 统计范围 ' + m.range.from + ' ~ ' + m.range.to +
        (viewMode === 'week' ? '（按天）' : (viewMode === 'month' ? '（按月 · 按周出数）' : ''));
    }
    el.textContent = txt;
  }

  /* 卡片标题随「时间轴粒度」切换：周 / 月聚合视图按日期，单日视图按小时 */
  var timelineHidden = null;        // 「人员工作时间图」当前是否隐藏（null = 尚未判定）
  var timelineLayoutDirty = false;  // 该卡片显隐刚变化：图表渲染后需 resize 重新测量
  /* 时间轴粒度的中文名：'hour' 小时 / 'date' 日期 / 'week' 周 */
  function unitWord(unit) { return unit === 'week' ? '周' : (unit === 'date' ? '日期' : '小时'); }

  function renderAxisTitles(d) {
    var unit = (d && d.meta && d.meta.bucket) || 'hour';
    var byDate = unit !== 'hour';
    var word = unitWord(unit);
    var set = function (id, txt) {
      var el = document.getElementById(id);
      if (el) el.textContent = txt;
    };
    set('trendTitle', unit === 'hour' ? '效率总览 · 各小时效率趋势'
      : (unit === 'week' ? '效率总览 · 月效率趋势（按周）' : '效率总览 · 周效率趋势'));
    set('zoneHeatTitle', '分区 × ' + word + '效率热力图');
    set('timeoutSubDuty', '按' + word + ' × 超时判责');
    set('timeoutSubType', '按' + word + ' × 作业类型（前场 / 后场 / 一体化）');
    set('timeoutSubZone', '按' + word + ' × 拣货分区');
    // 周 / 月聚合视图下不展示「人员工作时间图」（x 轴为当天时刻，跨天聚合后无意义）
    var tl = document.getElementById('timelineCard');
    if (tl && timelineHidden !== byDate) {
      tl.classList.toggle('hidden', byDate);
      timelineHidden = byDate;
      timelineLayoutDirty = true;      // 显隐变化会改布局：图表渲染完成后需重新测量尺寸
    }
  }

  /* 日期下拉：默认取数据集内最新日期；只有多天数据时才需要手动切换 */
  function renderDates(m) {
    var wrap = document.getElementById('dateWrap');
    var sel = document.getElementById('dateSel');
    if (!wrap || !sel) return;
    // 周 / 月聚合视图隐藏日期下拉：改用顶栏「◀ 区间 ▶」步进 + 区间标签
    //（下拉里是零散的数据集日期，跨数据集聚合时作为锚点选择容易混淆）
    if (m && m.bucket && m.bucket !== 'hour') { wrap.classList.add('hidden'); sel.innerHTML = ''; return; }
    var dates = (m && m.dates) || [];
    if (dates.length <= 1) { wrap.classList.add('hidden'); sel.innerHTML = ''; return; }
    sel.innerHTML = dates.map(function (dt) {
      return '<option value="' + esc(dt) + '"' + (dt === curDate ? ' selected' : '') + '>' +
        esc(dt) + '</option>';
    }).join('');
    wrap.classList.remove('hidden');
  }

  /* ---------- 总渲染 ---------- */
  function render(d) {
    if (!d) { notice('没有可展示的数据', 'err'); return; }
    current = d;
    var m = d.meta || {};
    // 当前展示日期：日视图以服务端返回的日期为准；周 / 月视图保留所选锚点日期（据此推算聚合区间，避免视图漂移）
    if (viewMode === 'day' || !curDate) {
      curDate = m.date || (m.dates && m.dates.length ? m.dates[m.dates.length - 1] : null);
    }
    renderPeriod(m);
    renderSource(m);
    renderDates(m);
    renderAxisTitles(d);
    rangePaint();
    renderKpis(d);
    renderPivotBlocks(d);
    renderZoneTable(d);
    renderPersonTable(d);
    renderDist(d);
    renderRowsStat(d);
    renderQtyStat(d);
    renderTimeoutPerson(d);
    renderTimeoutZone(d);
    sortTimelineRows(d);   // 图表与下方「人·日 班次明细」共用同一排序（就地排序，保持数组引用）
    renderTimeline(d);
    HEMA.charts.render(d);
    if (timelineLayoutDirty) {   // 时间轴粒度切换使「人员工作时间图」显隐变化：重新测量图表尺寸
      timelineLayoutDirty = false;
      if (HEMA.charts.resize) HEMA.charts.resize();
    }
    syncGate(d);           // 数据集内没有今天的日期时，提示「今日暂无数据」
    animateTableRows();    // 表格行交错入场
  }

  /* 表格行交错入场动画：给 tbody 内非合计行按顺序设置 --row-i，触发 CSS .row-in */
  function animateTableRows() {
    var tbodies = document.querySelectorAll('table tbody');
    for (var t = 0; t < tbodies.length; t++) {
      var rows = tbodies[t].querySelectorAll('tr:not(.total)');
      for (var i = 0; i < rows.length; i++) {
        rows[i].classList.remove('row-in');
        rows[i].style.setProperty('--row-i', String(i));
        // 强制 reflow 以重新触发 animation
        void rows[i].offsetWidth;
        rows[i].classList.add('row-in');
      }
    }
  }

  /* 空视图（服务端尚无数据 / 数据集被全部删除 / 接口未连通 / 有数据集但都不含今天）：
     latestMeta 非空表示「库里有数据集、但今天没单」，只借它的元信息组织遮罩文案（不渲染任何数据） */
  function clearView(errMsg, latestMeta) {
    current = null;
    curDate = null;
    // 无数据时顶栏第二行常驻引导文案
    renderPeriod(null);
    renderSource(null);
    renderDates(null);
    ['kpis', 'kpisSub', 'pivotBlocks', 'tableZone', 'tableEffBin', 'tableStab',
      'tableRowsBin', 'qtyStat', 'qtyTop', 'tableQtyBin',
      'tableTimeline', 'tableTimeoutPerson'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    var qc = document.getElementById('qtyCard');
    if (qc) qc.classList.add('hidden');
    var tp = document.getElementById('tablePerson');
    if (tp) tp.innerHTML = '';
    // 重新取数后回到「默认折叠」初始态：否则上一份数据展开过时会被带过来
    var tc = document.getElementById('timeoutCard');
    if (tc) {
      tc.classList.add('hidden', 'collapsed');
      var tcCaret = tc.querySelector('.caret');
      if (tcCaret) tcCaret.textContent = '▶';
    }
    var tpb = document.getElementById('timeoutPerson');
    if (tpb) {
      tpb.classList.add('collapsed');
      var tpbCaret = tpb.querySelector('.caret');
      if (tpbCaret) tpbCaret.textContent = '▶';
    }
    ['chartJtHour', 'chartDist', 'chartTimeline',
      'chartTimeout', 'chartTimeoutType', 'chartTimeoutPerson', 'chartTimeoutPersonType'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || typeof echarts === 'undefined') return;
      var inst = echarts.getInstanceByDom(el);
      if (inst) inst.clear();
    });
    // 有数据集但都不含今天时传入最近一条的元信息：遮罩显示「今日暂无数据 + 最近日期」，
    // 而不是退化成「暂无可用数据 / 当前没有任何数据集」（syncGate 只读 d.meta）
    syncGate(latestMeta ? { meta: latestMeta } : null, errMsg);
  }

  /* ---------- 历史数据集（顶栏自定义下拉：每项两行，第一行日期、第二行文件名） ---------- */
  var selBtn = document.getElementById('historyBtn');
  var selMenu = document.getElementById('historyMenu');
  var selItems = [];        // [{ id, dates, file }]
  var selId = null;         // 当前数据集 id

  // 第一行日期（该数据集内的日期集合），第二行「#id · 文件名」
  function selHtml(it) {
    return '<span class="sel-l1">' + esc(it.dates) + '</span>' +
      '<span class="sel-l2">' + (it.id == null ? '' : '#' + esc(it.id) + ' · ') + esc(it.file) + '</span>';
  }

  // 按钮文案跟随当前选中项，并标注列表项选中态（遮罩卡片内的同款按钮/列表一并同步）
  function syncHistory() {
    var cur = null;
    selItems.forEach(function (it) { if (String(it.id) === String(selId)) cur = it; });
    selBtn.innerHTML = selHtml(cur || selItems[0] || { dates: '暂无数据集', file: '请先上传拣货单 xlsx' });
    if (gateHistBtn) gateHistBtn.innerHTML = selBtn.innerHTML;
    if (gateHistWrap) gateHistWrap.classList.toggle('hidden', !selItems.length);
    Array.prototype.forEach.call([selMenu, gateHistMenu], function (menu) {
      if (!menu) return;
      Array.prototype.forEach.call(menu.querySelectorAll('.sel-item'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-id') === String(selId));
      });
    });
  }

  function renderHistoryMenu() {
    var html = selItems.map(function (it) {
      return '<button type="button" class="sel-item" data-id="' + esc(it.id) + '">' + selHtml(it) + '</button>';
    }).join('');
    selMenu.innerHTML = html;
    if (gateHistMenu) gateHistMenu.innerHTML = html;
    syncHistory();
  }

  // 日期 → YYYY-MM-DD（本地时区）
  function ymd(dt) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }

  /* 「周视图 / 月视图」聚合区间：自然周（周一 ~ 周日）、自然月（1 日 ~ 月末）。
     基准日 = 当前所选日期（curDate），日视图返回 null（按单日出数） */
  function viewRange() {
    if (viewMode === 'day') return null;
    var base = curDate || todayStr();
    var d = new Date(base + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    var from, to;
    if (viewMode === 'week') {
      var dow = (d.getDay() + 6) % 7;                       // 周一 = 0
      from = new Date(d); from.setDate(d.getDate() - dow);
      to = new Date(from); to.setDate(from.getDate() + 6);
    } else {
      from = new Date(d.getFullYear(), d.getMonth(), 1);
      to = new Date(d.getFullYear(), d.getMonth() + 1, 0);  // 下月第 0 天 = 本月最后一天
    }
    return { from: ymd(from), to: ymd(to) };
  }

  /* 按当前视图范围重新拉取：
     - 周 / 月视图：/api/range?from=&to= —— 服务端汇总区间内「所有」数据集的明细
       （库内每个数据集通常只含一天，跨数据集合并才有整周 / 整月的数据），不依赖单个数据集
     - 日视图：指定数据集 + 日期；没有具体数据集时按日期跨数据集定位（/api/day） */
  function refetch(id) {
    var url, r = viewRange();
    if (r) {
      // 周视图按天分桶（7 个点）；月视图按自然周分桶（以周为数值，不是整月一个总计）
      url = API + '/range?from=' + r.from + '&to=' + r.to +
        '&bucket=' + (viewMode === 'month' ? 'week' : 'date');
    } else if (id == null && curDate) {
      url = API + '/day?date=' + encodeURIComponent(curDate);
    } else {
      url = id == null ? API + '/latest' : API + '/datasets/' + encodeURIComponent(id);
      if (curDate) url += '?date=' + encodeURIComponent(curDate);
    }
    return fetch(url).then(readJson).then(function (ds) { render(ds); return ds; });
  }

  function loadHistory(currentId, list) {
    selId = currentId == null ? null : currentId;
    syncHistory();
    var p = list ? Promise.resolve(list) : fetch(API + '/datasets').then(readJson);
    p.then(function (list) {
      selItems = [];
      (list || []).forEach(function (x) {
        selItems.push({ id: x.id, dates: x.dates, file: x.sourceFile });
      });
      renderHistoryMenu();
    }).catch(function () {
      selItems = [];
      renderHistoryMenu();
    });
  }

  // 选择数据集：用户手动选定后，「今日暂无数据」遮罩本次访问内不再挡住这份数据
  function pickHistory(id) {
    selId = id;
    gateDismissed = true;
    syncHistory();
    refetch(id).then(function () {
      notice('已加载数据集 #' + id, 'ok');
    }).catch(function (e) { notice('加载数据集失败：' + esc(e.message || e), 'err'); });
  }

  selMenu.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.sel-item') : null;
    if (!btn) return;
    closeMenus();
    pickHistory(btn.getAttribute('data-id'));
  });

  /* ---------- 上传（服务端解析+计算） ---------- */
  /* 上传提示条：内嵌进度条 + 明细（大小 / 已传 / 速度 / 耗时）。
     fetch 无法上报上传进度，故上传改用 XHR；上传期间提示条常驻不自动消失。
     客户端上传阶段按字节推进，传完后进入「服务端解析计算」阶段（不确定进度）。 */
  var upState = null;   // 当前上传状态；非空 = 有上传正在进行

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* 进度浮层结构只建一次，之后只改文本与进度条宽度。
     若每次刷新都重建 innerHTML，进度条 <i> 会被替换成新节点，
     CSS 的 width 过渡无从触发，进度就会「一格一格」地跳 —— 这是卡顿的根源 */
  function upMount(t) {
    noticeEl.className = 'notice ok upload';
    noticeEl.innerHTML =
      '<button type="button" class="notice-close" title="关闭">×</button>' +
      '<div class="up-head">' +
        '<span class="up-title"></span>' +
        '<span class="up-pct"></span>' +
      '</div>' +
      '<div class="up-bar"><i></i></div>' +
      '<div class="up-meta"></div>';
    t.dom = {
      title: noticeEl.querySelector('.up-title'),
      pct: noticeEl.querySelector('.up-pct'),
      bar: noticeEl.querySelector('.up-bar'),
      fill: noticeEl.querySelector('.up-bar > i'),
      meta: noticeEl.querySelector('.up-meta')
    };
  }

  function upPaint(t) {
    if (upState !== t || t.hidden) return;
    if (!t.dom) upMount(t);
    var d = t.dom;
    var sec = (Date.now() - t.startedAt) / 1000;
    var computing = t.phase === 'compute';
    var pct = computing ? 100 : t.pct;

    // 标题 / 百分比：仅在内容变化时写入，避免无谓重排
    var titleHtml = (computing ? '上传完成，正在由服务端计算 ' : '正在上传并计算 ') +
      '<b>' + esc(t.name) + '</b>';
    if (t._title !== titleHtml) { d.title.innerHTML = titleHtml; t._title = titleHtml; }
    if (t._pct !== pct) { d.pct.textContent = pct + '%'; t._pct = pct; }

    // 进度条：复用同一个 <i>，只改 width，让 CSS 过渡平滑推进
    if (t._indet !== computing) { d.bar.classList.toggle('indet', computing); t._indet = computing; }
    d.fill.style.width = pct + '%';

    // 明细 chips
    var items = ['大小 ' + fmtBytes(t.size)];
    if (computing) {
      items.push('已上传 ' + fmtBytes(t.size), '服务端解析计算中…');
    } else if (t.loaded) {
      items.push('已上传 ' + fmtBytes(t.loaded));
      if (sec > 0.3) items.push('速度 ' + fmtBytes(t.loaded / sec) + '/s');
    }
    if (sec > 0.3) items.push('已用 ' + sec.toFixed(1) + ' s');
    var metaHtml = items.map(function (s) { return '<span>' + s + '</span>'; }).join('');
    if (t._meta !== metaHtml) { d.meta.innerHTML = metaHtml; t._meta = metaHtml; }
  }

  function upload(file) {
    if (file.size > 100 * 1024 * 1024) { notice('文件过大（>100MB）', 'err'); return; }
    var t = {
      name: file.name, size: file.size, phase: 'upload',
      pct: 0, loaded: 0, startedAt: Date.now(), hidden: false
    };
    upState = t;
    upPaint(t);
    // 定时重绘：让「已用时长」在上传与计算阶段都持续走动
    var tick = setInterval(function () { upPaint(t); }, 250);
    function stop() { clearInterval(tick); if (upState === t) upState = null; }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/upload?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      t.loaded = e.loaded;
      t.pct = Math.min(99, Math.round(e.loaded / e.total * 100));  // 留出最后 1% 给服务端计算阶段
      upPaint(t);
    };
    // 请求体发送完毕即进入计算阶段（服务端读完文件后才开始解析计算、再返回响应）
    xhr.upload.onload = function () {
      t.phase = 'compute'; t.loaded = t.size; t.pct = 100;
      upPaint(t);
    };
    xhr.onerror = function () {
      stop();
      notice('上传失败：无法连接服务端（' + esc(API) + '），请确认后端已启动', 'err');
    };
    xhr.onload = function () {
      stop();
      // 复用 readJson 的错误文案：把 XHR 包成 fetch 的 Response 形状
      var res = {
        ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, url: API + '/upload',
        text: function () { return Promise.resolve(xhr.responseText); }
      };
      readJson(res).then(function (j) {
        // 上传响应含文件内全部日期；这里按默认口径重新拉取（只显示最新一天，其余由日期下拉手动选择）
        var hasToday = (j.meta.dates || []).indexOf(todayStr()) >= 0;
        // 上传前若正被「今日暂无数据」遮罩挡住，且这份数据含今天：渲染后播放遮罩退场 + 看板入场动画
        introPending = !gateMask.classList.contains('hidden') && hasToday;
        // 明确导入了不含今天的数据集：本次访问内不要让遮罩挡住刚导入的这份数据
        if (!hasToday) gateDismissed = true;
        curDate = null;
        refetch(j.id);
        loadHistory(j.id);
        notice('已计算完成并' + (j.mode === 'overwrite' ? '覆盖更新' : '新增入库') +
          '（数据集 #' + j.id + '）：有效明细 ' +
          j.meta.recordCount.toLocaleString() + ' 条，丢弃 ' + j.meta.dropped +
          ' 条' + (j.meta.otherStore ? '，已过滤 ' + j.meta.otherStore + ' 条（非本门店）' : '') +
          (j.meta.ignored ? '，已忽略 ' + j.meta.ignored + ' 条（分区设置）' : '') +
          '，综合效率 ' + fmt(j.totals.eff) + ' 行/h', 'ok');
      }).catch(function (err) {
        notice('上传失败：' + esc(err.message || err), 'err');
      });
    };
    xhr.send(file);
  }

  document.getElementById('fileInput').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (f) upload(f);
    ev.target.value = '';
  });

  /* ---------- 实时获取（拣货单接口 listPickOrderForB2C） ----------
     由后端带 Cookie 翻页拉取，走 compute.buildFromUms，入库口径与上传 xlsx 完全一致。
     分页：index=0 为倒序第一页（最新），按 totalNum 自动探测总页数；
     增量：从最新页往回取，遇到「整页单号都已入库」即停，只并入新增明细 */
  var umsMask = document.getElementById('umsMask');
  var umsSum = document.getElementById('umsSum');
  var umsMetaEl = document.getElementById('umsMeta');
  var umsBar = document.getElementById('umsBar');
  var umsStartBtn = document.getElementById('umsStart');
  var umsStartDate = document.getElementById('umsStartDate');
  var umsEndDate = document.getElementById('umsEndDate');
  var umsCookieWrap = document.getElementById('umsCookieWrap');
  var umsCookieInput = document.getElementById('umsCookie');
  var umsCookieState = document.getElementById('umsCookieState');
  var umsCookieToggle = document.getElementById('umsCookieToggle');
  var umsCookieBackupWrap = document.getElementById('umsCookieBackupWrap');
  var umsCookieBackupInput = document.getElementById('umsCookieBackup');
  var umsCookieBackupState = document.getElementById('umsCookieBackupState');
  var umsCookieBackupToggle = document.getElementById('umsCookieBackupToggle');
  var umsChip = document.getElementById('umsChip');
  var umsManualBtn = document.getElementById('umsManual');
  var umsIncChk = document.getElementById('umsIncremental');
  var umsNumSel = document.getElementById('umsNum');
  var umsAutoOn = document.getElementById('umsAutoOn');
  var umsAutoMin = document.getElementById('umsAutoMin');
  var umsAutoStateEl = document.getElementById('umsAutoState');
  var umsAutoStart = document.getElementById('umsAutoStart');
  var umsAutoEnd = document.getElementById('umsAutoEnd');
  var umsCfg = { cookieSet: false, cookieBackupSet: false, num: 100, numChoices: [50, 100, 200], auto: {}, lastFetch: null, progress: null };
  var umsRunning = false, umsT0 = 0, umsLast = null, umsTick = null, umsCookieShown = false, umsCookieBackupShown = false;
  var umsPrev = null;   // 上一次获取结果（成功 / 失败），首页角标据它显示
  var umsCdUntil = 0;   // 取数冷却截止时间戳（与服务端 60 秒窗口对应，手动 / 自动共用）
  var umsCdSec = 60;    // 冷却时长（秒），由服务端配置返回
  var umsManualWait = false;   // 已启动后台手动取数任务、等待结果
  var umsManualAt = null;      // 已领取过的手动结果时间戳（避免轮询重复领取）

  // Cookie 失效 / 未保存时的统一指引：跑一次油猴脚本即会重新读取并保存 Cookie
  var UMS_COOKIE_HINT = '请打开盒马工作台页面，点右下角插件面板里的「立即同步」手动同步一次，脚本会重新读取并保存 Cookie';

  function umsIncremental() { return !!(umsIncChk && umsIncChk.checked); }

  // 自动获取的每日执行时段（HH:MM ~ HH:MM）；未设置返回空串
  function umsAutoWindow(auto) {
    auto = auto || (umsCfg.auto || {});
    return (auto.timeStart || auto.timeEnd)
      ? (auto.timeStart || '00:00') + ' ~ ' + (auto.timeEnd || '23:59') : '';
  }
  // 当前是否在时段内（按本机时间判断，仅用于提示；实际执行由服务端按东八区判断）
  function umsAutoActive(auto) {
    auto = auto || (umsCfg.auto || {});
    if (!auto.timeStart && !auto.timeEnd) return true;
    var d = new Date();
    var cur = d.getHours() * 60 + d.getMinutes();
    var a1 = (auto.timeStart || '00:00').split(':'), a2 = (auto.timeEnd || '23:59').split(':');
    return cur >= (+a1[0] * 60 + +a1[1]) && cur <= (+a2[0] * 60 + +a2[1]);
  }

  // 弹窗内的「每页条数 / 自动获取」设置与状态
  function umsAutoPaint() {
    var auto = umsCfg.auto || {};
    var choices = umsCfg.numChoices || [50, 100, 200];
    if (umsNumSel.options.length !== choices.length) {
      umsNumSel.innerHTML = choices.map(function (n) { return '<option value="' + n + '">' + n + ' 条</option>'; }).join('');
    }
    umsNumSel.value = String(umsCfg.num || 100);
    umsAutoOn.checked = !!auto.enabled;
    if (document.activeElement !== umsAutoMin) umsAutoMin.value = auto.intervalMin || 30;
    if (umsAutoStart && document.activeElement !== umsAutoStart) umsAutoStart.value = auto.timeStart || '';
    if (umsAutoEnd && document.activeElement !== umsAutoEnd) umsAutoEnd.value = auto.timeEnd || '';

    var win = umsAutoWindow(auto);
    var range = win ? '（时段 ' + win + '，首尾各额外获取一次）' : '（全天）';

    if (!umsCfg.cookieSet && !umsCfg.cookieBackupSet) {
      umsAutoStateEl.className = 'ums-auto-state err';
      umsAutoStateEl.textContent = '未保存 Cookie，自动获取不会执行。' + UMS_COOKIE_HINT;
    } else if (!auto.enabled) {
      umsAutoStateEl.className = 'ums-auto-state';
      umsAutoStateEl.textContent = '自动获取已关闭' + range;
    } else if (!umsAutoActive(auto)) {
      umsAutoStateEl.className = 'ums-auto-state';
      umsAutoStateEl.textContent = '当前在时段外，已暂停（时段 ' + win + '）';
    } else if (!auto.at) {
      umsAutoStateEl.className = 'ums-auto-state';
      umsAutoStateEl.textContent = '等待首次执行（每 ' + (auto.intervalMin || 30) + ' 分钟）' + range;
    } else if (auto.ok) {
      umsAutoStateEl.className = 'ums-auto-state ok';
      umsAutoStateEl.textContent = '上次自动获取 ' + umsAgo(auto.at) + ' · 新增 ' + (auto.added || 0) + ' 条' + range;
    } else {
      umsAutoStateEl.className = 'ums-auto-state err';
      umsAutoStateEl.textContent = '上次自动获取失败 ' + umsAgo(auto.at) + '：' + auto.error +
        (auto.nextMin ? '（' + auto.nextMin + ' 分钟后重试）' : '');
    }
  }

  // 保存设置（Cookie / 每页条数 / 自动获取），成功后用服务端返回值重绘
  function umsSaveCfg(body) {
    return fetch(API + '/ums/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(readJson).then(function (j) {
      umsCfg = j;
      umsSetCookieState(j.cookieSet, j.cookieBackupSet);
      umsAutoPaint();
      return j;
    });
  }

  // 取数条件持久化：把页面「开始日期 / 结束日期」存到服务端，自动获取跟随同一区间
  function umsSaveRange(s, e) {
    if (!s) return;
    if (!e || e < s) e = s;
    umsSaveCfg({ range: { startDate: s, endDate: e } })
      .catch(function () { /* 失败静默：不影响本次取数 */ });
  }

  /* 「开始 / 结束日期」默认当天，并跨过 0 点（24 点）自动翻到新的一天：
     仅当输入框仍是「上次自动填写的当天日期」（用户没手动改过）时才跟随，
     避免覆盖手动指定的历史区间；翻新时同步到服务端，让自动获取也跟着走。
     （服务端另有「单日区间过期自动顺延」兜底，故首屏默认值不必写回，免得冲掉固定的多日区间） */
  var umsDateAuto = null;      // 上次自动填写的当天日期（YYYY-MM-DD）
  function umsDateSync() {
    var t = todayStr();
    var rolled = false;
    [umsStartDate, umsEndDate].forEach(function (el) {
      if (!el.value) { el.value = t; return; }                                  // 空值补当天（仅显示，不落库）
      if (umsDateAuto && el.value === umsDateAuto && umsDateAuto !== t) {       // 仍是自动填的旧日期 → 翻新
        el.value = t;
        rolled = true;
      }
    });
    umsDateAuto = t;
    if (rolled) {
      umsSaveRange(umsStartDate.value, umsEndDate.value);
      notice('日期已更新为当天（' + t + '），自动获取同步', 'ok');
    }
    return rolled;
  }

  // 距上次获取的时长（10 分钟以内按「X 分 Y 秒」显示，便于确认自动获取是否在跑）
  function umsAgo(iso) {
    var t = Date.parse(iso);
    if (!t) return '—';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function umsClock(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
  }

  // 自动获取临近触发的倒计时秒数：只在服务端排期的下次执行前 60 秒（1 分钟）内返回，其余返回 0
  function umsAutoCountdown() {
    var auto = umsCfg.auto || {};
    if (!auto.enabled || !auto.nextAt) return 0;
    var left = Math.ceil((Date.parse(auto.nextAt) - Date.now()) / 1000);
    return left > 0 && left <= 60 ? left : 0;
  }

  // 首页角标：获取中显示进度与已用时长；空闲显示「上次获取 X 前 · N 条」
  // 自动获取只显示开关状态（开 / 关），临近触发前 1 分钟追加倒计时；其余细节在弹窗内查看
  function umsChipPaint() {
    if (!umsChip) return;
    var autoOn = !!(umsCfg.auto && umsCfg.auto.enabled);
    var cdSec = umsAutoCountdown();
    var autoText = ' · 自动获取：' + (autoOn ? '开' : '关') + (cdSec ? ' · ' + cdSec + ' 秒后获取' : '');
    var autoTip = '　自动获取：' + (autoOn ? '已开启' : '已关闭');
    if (umsStale) {                                  // 页面 JS 是旧版本：提示刷新，避免显示与数据不符
      umsChip.className = 'ums-chip warn';
      umsChip.textContent = '有新版本 · 点击刷新';
      umsChip.title = '页面运行的仍是旧版本前端（' + umsBuild + '），点此刷新加载最新版本';
      return;
    }
    var pr = umsCfg.progress || {};
    if (umsRunning || pr.active) {                   // 本页发起或服务端（自动获取）正在取数
      var t0 = umsT0 || pr.startedAt || Date.now();
      var sec = ((Date.now() - t0) / 1000).toFixed(0);
      var pageTxt = umsPageText();
      umsChip.className = 'ums-chip run';
      umsChip.textContent = '获取中 · ' + (pageTxt || '已用 ' + sec + 's');
      umsChip.title = pageTxt ? ('正在获取：' + pageTxt + '，已用 ' + sec + 's') : '点击查看实时获取进度';
      return;
    }
    if (umsPrev && umsPrev.ok) {
      umsChip.className = 'ums-chip ok';
      umsChip.textContent = '上次获取 ' + umsAgo(umsPrev.at) + ' · ' +
        (umsPrev.records || 0).toLocaleString() + ' 条' + autoText;
      umsChip.title = (umsPrev.label || '实时接口') + '　' + umsClock(umsPrev.at) +
        (umsPrev.added ? '　新增 ' + umsPrev.added + ' 条' : '') + autoTip + '\n点击打开实时获取';
    } else if (umsPrev) {
      umsChip.className = 'ums-chip err';
      umsChip.textContent = '上次获取失败 ' + umsAgo(umsPrev.at) + autoText;
      umsChip.title = (umsPrev.msg || '实时获取失败') + autoTip + '\n点击打开实时获取';
    } else {
      umsChip.className = 'ums-chip';
      umsChip.textContent = '尚未实时获取' + autoText;
      umsChip.title = autoTip.replace('　', '') + '\n点击打开实时获取';
    }
  }

  // 顶栏「手动获取」按钮：获取中 / 冷却倒计时（与自动获取共用）时禁用
  function umsManualPaint() {
    if (!umsManualBtn) return;
    if (umsRunning) {
      umsManualBtn.disabled = true;
      umsManualBtn.textContent = '获取中…';
      umsManualBtn.title = '正在获取，请稍候';
      return;
    }
    var left = umsCdLeft();
    if (left > 0) {
      umsManualBtn.disabled = true;
      umsManualBtn.textContent = '冷却 ' + left + ' 秒';
      umsManualBtn.title = '为避免触发接口风控，与自动获取共用 ' + umsCdSec + ' 秒冷却，剩 ' + left + ' 秒';
      return;
    }
    umsManualBtn.disabled = false;
    umsManualBtn.textContent = '手动获取';
    umsManualBtn.title = '立即按页面「取数条件」的日期区间增量获取（与自动获取共用 ' + umsCdSec + ' 秒冷却）';
  }

  // 顶栏「手动获取」：抓页面「取数条件」的日期区间（默认当天），未保存 Cookie 时引导到弹窗
  umsManualBtn.addEventListener('click', function () {
    if (umsRunning) { notice('正在获取中，请稍候', 'err'); return; }
    var left = umsCdLeft();
    if (left > 0) {
      notice('冷却中：为避免触发接口风控，请 ' + left + ' 秒后再试（自动获取同样计入冷却）', 'err');
      return;
    }
    if (!umsCfg.cookieSet && !umsCfg.cookieBackupSet) {
      notice('未保存接口 Cookie。' + UMS_COOKIE_HINT, 'err');
      openUms();
      return;
    }
    var s = umsStartDate.value || todayStr();
    var e = umsEndDate.value || s;
    umsRun(s, e, true);   // 页面取数条件 + 增量，与自动获取口径一致
  });

  // 每隔一秒走动「距上次获取的时长」；每 5 秒拉一次服务端状态（后台自动获取的结果），保证角标与后端同步
  var umsChipTicks = 0;
  setInterval(function () {
    umsDateSync();                                   // 跨过 0 点自动把取数日期翻到当天
    umsChipPaint();
    umsManualPaint();
    umsChipTicks++;
    // 取数进行中（本页发起或服务端自动获取）每秒拉一次进度，其余每 5 秒一次
    var busy = umsRunning || !!(umsCfg.progress && umsCfg.progress.active);
    if (busy || umsChipTicks % 5 === 0) umsLoadCfg();
    // 弹窗开着时顺带刷新「上次自动获取」状态文字
    if (umsChipTicks % 5 === 2 && umsMask && !umsMask.classList.contains('hidden')) umsAutoPaint();
  }, 1000);

  function umsProg(pct, indet, items) {
    umsBar.classList.remove('hidden');
    umsBar.classList.toggle('indet', !!indet);
    umsBar.firstElementChild.style.width = pct + '%';
    umsMetaEl.innerHTML = (items || []).map(function (s) { return '<span>' + s + '</span>'; }).join('');
  }

  // 服务端取数进度文案：totalPages 由接口 totalNum ÷ num 直接算出，拿到第一页即显示「第 x / N 页」
  function umsPageText() {
    var pr = umsCfg.progress || {};
    if (!pr.active) return '';
    return pr.totalPages ? ('第 ' + pr.pages + ' / ' + pr.totalPages + ' 页') : '正在取第 1 页…';
  }

  // 进度重绘（定时器驱动，让「已用时长」持续走动），同时刷新首页角标
  function umsPaint() {
    if (!umsLast) { umsChipPaint(); return; }
    var sec = ((Date.now() - umsT0) / 1000).toFixed(0);
    var pr = umsCfg.progress || {};
    var pageTxt = umsPageText();
    umsSum.textContent = '服务端获取中 · ' + pageTxt;
    if (pr.active && pr.totalPages) {
      umsProg(Math.round(pr.pages / pr.totalPages * 100), false, [pageTxt, '已用 ' + sec + ' s']);
    } else {
      umsProg(100, true, [pageTxt, '已用 ' + sec + ' s']);
    }
    umsChipPaint();
  }

  /* 启动取数：服务端只「接单」后立即返回（202），实际取数在后台跑。
     完成与否由轮询 /ums/config（progress / manual）感知，避免全量取数时长连接被中间层掐断而误报失败 */
  function umsStartReq(s, e, incremental) {
    return fetch(API + '/ums/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: s, endDate: e, incremental: !!incremental,
        cookie: (umsCookieInput.value || '').trim(),
        cookieBackup: (umsCookieBackupInput.value || '').trim()
      })
    }).then(readJson);
  }

  // 入库成功后的收尾：与上传一致（遮罩退场动画 / 切到最新数据 / 刷新历史列表）
  function umsAfterImport(j, label) {
    umsPrev = {
      ok: true, at: (j.last && j.last.at) || new Date().toISOString(),
      records: j.meta.recordCount, added: j.added || 0, replaced: j.replaced || 0,
      id: j.id, label: label
    };
    umsShownAt = umsPrev.at;   // 手动获取已自行刷新视图，避免下一轮轮询重复刷新
    umsChipPaint();
    if (j.mode === 'merge' && !j.added && !j.replaced) {
      loadHistory(j.id);
      notice('实时获取：无新增数据（区间内拣货单均已入库' + (j.reached ? '，已在最新页追平后提前结束' : '') + '）', 'ok');
      return;
    }
    var hasToday = (j.meta.dates || []).indexOf(todayStr()) >= 0;
    introPending = !gateMask.classList.contains('hidden') && hasToday;
    if (!hasToday) gateDismissed = true;
    curDate = null;
    refetch(j.id);
    loadHistory(j.id);
    notice('实时获取完成并' + (j.mode === 'merge' ? '增量并入' : (j.mode === 'overwrite' ? '覆盖更新' : '新增入库')) +
      '（数据集 #' + j.id + '，' + esc(label) + '）：有效明细 ' +
      j.meta.recordCount.toLocaleString() + ' 条' +
      (j.mode === 'merge' ? '（本次新增 ' + (j.added || 0) + ' 条' +
        (j.replaced ? '，覆盖当天旧明细 ' + j.replaced + ' 条' : '') + '）' : '') +
      '，丢弃 ' + j.meta.dropped +
      ' 条' + (j.meta.otherStore ? '，已过滤 ' + j.meta.otherStore + ' 条（非本门店）' : '') +
      (j.meta.ignored ? '，已忽略 ' + j.meta.ignored + ' 条（分区设置）' : '') +
      '，综合效率 ' + fmt(j.totals.eff) + ' 行/h' +
      (j.cookieFallback ? '（注：本次首选的 Cookie 未成功，已改用' + (j.cookieTag || '另一份') + ' Cookie 获取）' : ''), 'ok');
  }

  function umsStop() {
    umsRunning = false;
    umsStartBtn.disabled = false;
    if (umsTick) { clearInterval(umsTick); umsTick = null; }
  }

  // 取数冷却剩余秒数（本地推算，服务端每 5 秒回填一次以保证一致）
  function umsCdLeft() {
    return umsCdUntil ? Math.max(0, Math.ceil((umsCdUntil - Date.now()) / 1000)) : 0;
  }

  // 开始获取；s/e/inc 省略时取弹窗里的日期范围与「增量」勾选
  function umsRun(s, e, inc) {
    if (umsRunning) { notice('正在获取中，请稍候', 'err'); return; }
    var left = umsCdLeft();
    if (left > 0) {
      notice('冷却中：为避免触发接口风控，请 ' + left + ' 秒后再试（自动获取同样计入冷却）', 'err');
      return;
    }
    if (!s) s = umsStartDate.value;
    if (!e) e = umsEndDate.value || s;
    if (!s) { notice('请先选择开始日期', 'err'); umsStartDate.focus(); return; }
    if (e < s) { notice('结束日期不能早于开始日期', 'err'); return; }
    umsSaveRange(s, e);   // 记录本次取数条件，自动获取跟随同一区间

    var incFlag = inc == null ? umsIncremental() : !!inc;
    umsRunning = true;
    umsStartBtn.disabled = true;
    umsCdUntil = Date.now() + umsCdSec * 1000;   // 冷却窗口与服务端一致，含自动获取
    umsT0 = Date.now();
    umsLast = { phase: 'run' };
    umsManualWait = false;
    umsPaint();
    umsTick = setInterval(umsPaint, 300);

    umsStartReq(s, e, incFlag).then(function () {
      // 服务端已在后台开始取数：保持「获取中」，完成与结果由轮询感知
      umsManualWait = true;
      umsLoadCfg();
    }).catch(function (err) {
      umsStop();
      umsLast = null;
      var msg = (err && err.message) || String(err);
      umsPrev = { ok: false, at: new Date().toISOString(), msg: msg };
      umsChipPaint();
      umsBar.classList.add('hidden');
      umsSum.textContent = '获取失败';
      umsMetaEl.innerHTML = '<span>' + esc(msg) + '</span>';
      notice('实时获取失败：' + esc(msg), 'err');
    });
  }

  /* 领取后台手动取数结果并按成功 / 失败收尾（由 umsLoadCfg 在任务结束时触发） */
  function umsTakeResult() {
    return fetch(API + '/ums/result', { cache: 'no-store' }).then(readJson).then(function (r) {
      umsManualWait = false;
      umsStop();
      umsLast = null;
      if (r && r.ok) {
        var j = r.out || {};
        var label = (j.last && j.last.label) || ('实时接口 ' + (r.range || ''));
        umsBar.classList.add('hidden');
        umsMetaEl.innerHTML = '';
        umsSum.textContent = '已完成：' + label + '（共 ' + (j.pages || 1) + '/' + (j.totalPages || 1) + ' 页' +
          (j.reached ? '，已追平提前结束' : '') + '）';
        umsAfterImport(j, label);
        return;
      }
      var msg = (r && r.error) || '获取失败';
      umsPrev = { ok: false, at: (r && r.at) || new Date().toISOString(), msg: msg };
      umsChipPaint();
      umsBar.classList.add('hidden');
      umsSum.textContent = '获取失败';
      umsMetaEl.innerHTML = '<span>' + esc(msg) + '</span>';
      notice('实时获取失败：' + esc(msg), 'err');
    }).catch(function (err) {
      umsManualWait = false;
      umsStop();
      umsLast = null;
      umsBar.classList.add('hidden');
      notice('领取获取结果失败：' + esc((err && err.message) || String(err)), 'err');
    });
  }

  // 首页角标是否已反映的获取记录（服务端 lastFetch.at）；用来识别后台新写入的数据
  var umsShownAt = null;

  // 已提示过的「后台自动获取失败」时间点：同一次失败只弹一次；首屏不打扰
  var umsAutoSeenAt = null;

  // 页面当前运行的前端构建版本（app.<hash>.js）与服务端最新版本不一致时提示刷新，
  // 避免「页面还是旧版本 JS」造成的显示与数据不符
  function umsBuildId() {
    var s = document.querySelector('script[src*="assets/js/app."]');
    var m = s && /app\.([0-9a-f]{8})\.js/.exec(s.src || '');
    return m ? m[1] : '';
  }
  var umsBuild = umsBuildId();
  var umsStale = false;

  /* 后台（自动获取 / 其它标签页）写入了新数据：当前正看这份数据集时自动刷新视图，
     这样不用手动点「实时获取」也能看到最新数据与图表 */
  function umsApplyServerFetch(lf) {
    if (!lf || !lf.at || lf.at === umsShownAt) return;
    var first = !umsShownAt;
    umsShownAt = lf.at;
    if (first || umsRunning || upState) return;      // 首屏加载 / 正在获取 / 正在上传：不打扰
    var changed = (lf.added || 0) > 0 || (lf.replaced || 0) > 0;
    var empty = !current;                            // 页面当前空着（如「今日暂无数据」遮罩）
    if (!changed && !empty) return;                  // 数据没变：只更新角标
    // 当前看的是别的数据集：只刷新历史菜单，不动当前视图
    if (!empty && selId != null && String(selId) !== String(lf.id)) {
      loadHistory(selId);
      return;
    }
    var id = (empty || selId == null) ? null : selId; // 看最新就仍看最新
    refetch(id).then(function () {
      loadHistory(id);
      if (changed) {
        notice('实时数据已更新（数据集 #' + lf.id + '：新增 ' + (lf.added || 0) + ' 条' +
          ((lf.replaced || 0) > 0 ? '，覆盖旧明细 ' + lf.replaced + ' 条' : '') + '）', 'ok');
      }
    }).catch(function (e) {
      notice('自动刷新数据失败：' + esc((e && e.message) || e), 'err');
    });
  }

  function umsLoadCfg() {
    return fetch(API + '/ums/config', { cache: 'no-store' }).then(readJson).then(function (j) {
      umsCfg = j;
      umsStale = !!(j.build && umsBuild && j.build !== umsBuild);
      umsSetCookieState(j.cookieSet, j.cookieBackupSet);
      // 取数冷却：以服务端为准往前推（只延长不缩短，避免在途响应把倒计时拉回）
      var cd = j.cooldown || {};
      umsCdSec = cd.sec || umsCdSec;
      if (cd.waitSec > 0) umsCdUntil = Math.max(umsCdUntil, Date.now() + cd.waitSec * 1000);
      umsManualPaint();
      umsAutoPaint();
      // 后台自动获取失败：弹出提示并附上错误原因（同一次失败只提示一次；首屏不打扰）
      var au = j.auto;
      if (au && au.at && au.at !== umsAutoSeenAt) {
        var firstAuto = umsAutoSeenAt === null;
        umsAutoSeenAt = au.at;
        if (!firstAuto && au.ok === false) {
          notice('自动获取失败（' + umsClock(au.at) + '）：' + esc(au.error || '未知原因'), 'err');
        }
      }
      // 首页角标：服务端记录比本地新（如后台自动获取刚跑过）时以服务端为准
      var lf = j.lastFetch;
      if (lf && lf.at && (!umsPrev || !umsPrev.at || Date.parse(lf.at) >= Date.parse(umsPrev.at))) {
        umsPrev = {
          ok: true, at: lf.at, records: lf.records || 0, added: lf.added || 0,
          replaced: lf.replaced || 0, id: lf.id, label: lf.label
        };
      }
      // 后台手动取数完成：领取完整结果并按成功 / 失败收尾；
      // 本轮跳过通用 lastFetch 刷新，避免与手动结果重复提示 / 重复刷新
      var manualDone = false;
      if (umsManualWait && j.manual && j.manual.at && j.manual.at !== umsManualAt) {
        manualDone = true;
        umsManualAt = j.manual.at;
        umsTakeResult();
      }
      umsChipPaint();
      if (!manualDone) umsApplyServerFetch(lf);
    }).catch(function (e) {
      umsCookieState.className = 'ums-cookie-state err';
      umsCookieState.textContent = '接口配置读取失败：' + ((e && e.message) || e);
    });
  }

  function umsSetCookieState(ok, backupOk) {
    umsCookieState.className = 'ums-cookie-state' + (ok ? ' ok' : '');
    umsCookieState.textContent = ok ? '服务端已保存 Cookie' : '服务端未保存 Cookie';
    umsCookieBackupState.className = 'ums-cookie-state' + (backupOk ? ' ok' : '');
    umsCookieBackupState.textContent = backupOk ? '已保存备用 Cookie' : '';
  }

  function umsSyncCookie() {
    umsCookieWrap.classList.toggle('hidden', !umsCookieShown);
    umsCookieToggle.textContent = umsCookieShown ? '收起' : '设置';
    umsCookieBackupWrap.classList.toggle('hidden', !umsCookieBackupShown);
    umsCookieBackupToggle.textContent = umsCookieBackupShown ? '收起' : '设置';
  }

  // 打开「Cookie 设置」时从服务端拉取已保存的 Cookie 回填（用户手动改过则不覆盖）
  var umsCookieDirty = false, umsCookieBackupDirty = false;
  umsCookieInput.addEventListener('input', function () { umsCookieDirty = true; });
  umsCookieBackupInput.addEventListener('input', function () { umsCookieBackupDirty = true; });
  function umsLoadCookie() {
    return fetch(API + '/ums/cookie', { cache: 'no-store' }).then(readJson).then(function (j) {
      if (!umsCookieDirty && j && j.cookie) umsCookieInput.value = j.cookie;
      if (!umsCookieBackupDirty && j && j.backup) umsCookieBackupInput.value = j.backup;
    }).catch(function () { /* 读取失败静默：不打扰正在编辑的用户 */ });
  }

  function openUms() {
    umsDateSync();   // 默认当天；跨过 0 点则自动翻到新的一天
    // 主 / 备用 Cookie 都没保存时默认展开粘贴框（服务端代取必须先有 Cookie）
    if (!umsCfg.cookieSet && !umsCfg.cookieBackupSet) umsCookieShown = true;
    umsSyncCookie();
    if (umsCookieShown || umsCookieBackupShown) umsLoadCookie();
    umsMask.classList.remove('hidden');
    umsLoadCfg();
  }
  function closeUms() {
    umsMask.classList.add('hidden');
    umsCookieShown = false;          // 关闭后恢复折叠，下次打开从「设置」按钮进入
    umsCookieBackupShown = false;
    umsSyncCookie();
  }

  document.getElementById('umsBtn').addEventListener('click', openUms);
  umsChip.addEventListener('click', function () {
    if (umsStale) { location.reload(); return; }   // 旧版本前端：先刷新加载新版本
    openUms();
  });
  umsChipPaint();
  umsManualPaint();
  umsDateSync();   // 取数日期默认当天；此后每秒检查是否跨过 0 点
  umsLoadCfg();   // 首页角标：读取服务端记录的「最近一次获取结果」
  document.getElementById('umsClose').addEventListener('click', closeUms);
  umsMask.addEventListener('click', function (ev) { if (ev.target === umsMask) closeUms(); });
  umsStartBtn.addEventListener('click', function () { umsRun(); });
  umsCookieToggle.addEventListener('click', function () {
    umsCookieShown = !umsCookieShown;
    umsSyncCookie();
    if (umsCookieShown) umsLoadCookie();   // 展开时回填服务端已保存的 Cookie
  });
  umsCookieBackupToggle.addEventListener('click', function () {
    umsCookieBackupShown = !umsCookieBackupShown;
    umsSyncCookie();
    if (umsCookieBackupShown) umsLoadCookie();
  });
  document.getElementById('umsCookieSave').addEventListener('click', function () {
    var cookie = (umsCookieInput.value || '').trim();
    if (!cookie) { notice('请先粘贴 Cookie', 'err'); return; }
    // force：页面显式保存 = 覆盖主 Cookie（脚本推送才走「相同跳过 / 不同写备用」）
    umsSaveCfg({ cookie: cookie, force: true }).then(function () {
      umsCookieInput.value = '';
      umsCookieDirty = false;
      umsCookieShown = false;
      umsSyncCookie();
      notice('接口 Cookie 已保存到服务端', 'ok');
    }).catch(function (e) { notice('Cookie 保存失败：' + esc((e && e.message) || e), 'err'); });
  });
  document.getElementById('umsCookieClear').addEventListener('click', function () {
    umsCookieInput.value = '';
    umsCookieDirty = false;
    umsSaveCfg({ cookie: '', force: true })
      .then(function () { notice('接口 Cookie 已清除', 'ok'); })
      .catch(function (e) { notice('Cookie 清除失败：' + esc((e && e.message) || e), 'err'); });
  });
  document.getElementById('umsCookieBackupSave').addEventListener('click', function () {
    var cookie = (umsCookieBackupInput.value || '').trim();
    if (!cookie) { notice('请先粘贴备用 Cookie', 'err'); return; }
    umsSaveCfg({ cookieBackup: cookie }).then(function () {
      umsCookieBackupInput.value = '';
      umsCookieBackupDirty = false;
      umsCookieBackupShown = false;
      umsSyncCookie();
      notice('备用 Cookie 已保存到服务端', 'ok');
    }).catch(function (e) { notice('备用 Cookie 保存失败：' + esc((e && e.message) || e), 'err'); });
  });
  document.getElementById('umsCookieBackupClear').addEventListener('click', function () {
    umsCookieBackupInput.value = '';
    umsCookieBackupDirty = false;
    umsSaveCfg({ cookieBackup: '' })
      .then(function () { notice('备用 Cookie 已清除', 'ok'); })
      .catch(function (e) { notice('备用 Cookie 清除失败：' + esc((e && e.message) || e), 'err'); });
  });

  // 使用说明：默认收起，点击标题展开 / 收起
  var umsNoteToggle = document.getElementById('umsNoteToggle');
  var umsNoteBody = document.getElementById('umsNoteBody');
  umsNoteToggle.addEventListener('click', function () {
    var nowHidden = umsNoteBody.classList.toggle('hidden');
    umsNoteToggle.textContent = nowHidden ? '使用说明 ▸' : '使用说明 ▾';
  });

  // 每页条数 / 自动获取：改动即保存到服务端（自动获取由服务端常驻定时执行）
  // 取数条件（开始/结束日期）：改动即保存，自动获取跟随同一区间
  umsStartDate.addEventListener('change', function () { umsSaveRange(umsStartDate.value, umsEndDate.value); });
  umsEndDate.addEventListener('change', function () { umsSaveRange(umsStartDate.value, umsEndDate.value); });
  umsNumSel.addEventListener('change', function () {
    umsSaveCfg({ num: Number(umsNumSel.value) })
      .then(function (j) { notice('每页条数已设为 ' + j.num + ' 条', 'ok'); })
      .catch(function (e) { notice('设置保存失败：' + esc((e && e.message) || e), 'err'); });
  });
  function umsSaveAuto() {
    return umsSaveCfg({ auto: {
      enabled: umsAutoOn.checked,
      intervalMin: Number(umsAutoMin.value) || 30,
      timeStart: umsAutoStart ? umsAutoStart.value : '',
      timeEnd: umsAutoEnd ? umsAutoEnd.value : ''
    } });
  }
  umsAutoOn.addEventListener('change', function () {
    umsSaveAuto()
      .then(function () { notice(umsAutoOn.checked ? '已开启自动获取（服务端常驻执行）' : '已关闭自动获取', 'ok'); })
      .catch(function (e) { notice('设置保存失败：' + esc((e && e.message) || e), 'err'); });
  });
  umsAutoMin.addEventListener('change', function () {
    umsSaveAuto()
      .then(function (j) { notice('自动获取间隔已设为每 ' + j.auto.intervalMin + ' 分钟', 'ok'); })
      .catch(function (e) { notice('设置保存失败：' + esc((e && e.message) || e), 'err'); });
  });
  umsAutoStart.addEventListener('change', umsSaveAuto);
  umsAutoEnd.addEventListener('change', umsSaveAuto);

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
    var dmSt = sortState('dm');
    var dmCols = [
      { key: null, label: '', cls: 'dm-ck' },
      { key: 'id', label: 'ID' },
      { key: 'file', label: '文件名', text: 1 },
      { key: 'dates', label: '日期', text: 1 },
      { key: 'recordCount', label: '有效明细' },
      { key: 'dropped', label: '丢弃' },
      { key: 'otherStore', label: '非本门店' },
      { key: 'ignored', label: '已忽略' },
      { key: 'eff', label: '综合效率(行/h)' },
      { key: 'createdAt', label: '上传时间', text: 1 },
      { key: null, label: '操作', cls: 'dm-act' }
    ];
    var dmGet = {
      id: function (x) { return x.id; },
      file: function (x) { return x.sourceFile; },
      dates: function (x) { return x.dates; },
      recordCount: function (x) { return x.recordCount; },
      dropped: function (x) { return x.dropped; },
      otherStore: function (x) { return x.otherStore; },
      ignored: function (x) { return x.ignored; },
      eff: function (x) { return x.eff; },
      createdAt: function (x) { return x.createdAt; }
    };
    var head = theadHtml(dmCols, dmSt);
    var body = sortRows(dmList, dmSt, dmGet).map(function (x) {
      var now = String(x.id) === cur;
      return '<tr class="' + (now ? 'now' : '') + '">' +
        '<td class="dm-ck"><input type="checkbox" class="dm-pick" value="' + x.id + '"></td>' +
        '<td>' + (now ? '<span class="dot" style="background:var(--primary)"></span> ' : '') + '#' + x.id + '</td>' +
        '<td class="dm-file" title="' + esc(x.sourceFile) + '">' + esc(x.sourceFile) + '</td>' +
        '<td>' + esc(x.dates || '-') + '</td>' +
        '<td>' + (x.recordCount || 0).toLocaleString() + '</td>' +
        '<td>' + (x.dropped || 0) + '</td>' +
        '<td>' + (x.otherStore || 0) + '</td>' +
        '<td>' + (x.ignored || 0) + '</td>' +
        '<td>' + fmt(x.eff) + '</td>' +
        '<td>' + dmTime(x.createdAt) + '</td>' +
        '<td class="dm-act">' +
        '<button type="button" class="mini" data-view="' + x.id + '">' + (now ? '当前' : '查看') + '</button>' +
        '<button type="button" class="mini danger" data-del="' + x.id + '">删除</button>' +
        '</td></tr>';
    }).join('');
    dmTable.innerHTML = head + '<tbody>' +
      (body || '<tr><td colspan="10" class="dm-empty">暂无数据集，请先上传拣货单 xlsx</td></tr>') + '</tbody>';
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

  // 删除后：当前数据集仍在则只刷新列表，否则切到最新数据集（都没有则显示空视图）
  function afterDelete(ids) {
    var curId = current && current.id != null ? String(current.id) : null;
    var curGone = curId != null && ids.some(function (x) { return String(x) === curId; });
    notice('已删除 ' + ids.length + ' 条数据集', 'ok');
    if (!curGone) { loadDataMgr(curId); return; }
    fetch(API + '/latest').then(readJson).then(function (ds) {
      render(ds);
      loadDataMgr(ds.id);
      notice('当前数据集已删除，已切换到最新数据集 #' + ds.id, 'ok');
    }).catch(function () {
      clearView('数据集已全部删除，请先上传拣货单 xlsx。');
      loadDataMgr(null);
      notice('数据集已全部删除，请先上传拣货单 xlsx', 'ok');
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
      text = '确认删除数据集 #' + ids[0] + (one ? '（' + one.sourceFile + '）' : '') + '？删除后不可恢复';
    } else {
      text = '确认删除选中的 ' + ids.length + ' 条数据集？删除后不可恢复';
    }
    askConfirm(text, function () { removeThen(ids); });
  }

  function clearDatasets() {
    if (!dmList.length) { notice('当前没有可删除的数据集', 'ok'); return; }
    askConfirm('确认清空全部 ' + dmList.length + ' 条数据集？删除后不可恢复', function () {
      removeThen(dmList.map(function (x) { return String(x.id); }));
    });
  }

  function switchDataset(id) {
    refetch(id).then(function (ds) {
      loadDataMgr(ds.id);
      notice('已加载数据集 #' + ds.id, 'ok');
    }).catch(function () { notice('加载数据集失败', 'err'); });
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
    if (logsMask && !logsMask.classList.contains('hidden')) { closeLogs(); return; }
    var zc = document.getElementById('zoneCfgMask');
    if (zc && !zc.classList.contains('hidden')) closeZoneCfg();
    if (umsMask && !umsMask.classList.contains('hidden')) closeUms();
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

  /* ---------- 日志查看（顶栏按钮 → 弹窗）：读服务端环形缓冲里的最近日志 ---------- */
  var logsMask = document.getElementById('logsMask');
  var logsPre = document.getElementById('logsPre');
  var logsSum = document.getElementById('logsSum');
  var logsAuto = document.getElementById('logsAuto');
  var logsLimit = document.getElementById('logsLimit');
  var logsTick = null;

  function logsLoad() {
    var limit = logsLimit.value || '200';
    return fetch(API + '/logs?limit=' + encodeURIComponent(limit), { cache: 'no-store' })
      .then(readJson).then(function (j) {
        var lines = j.lines || [];
        logsPre.innerHTML = lines.length
          ? lines.map(function (l) {
              return '<div class="lg' + (l.level === 'warn' ? ' warn' : '') + '">[' +
                esc(l.at) + '] ' + esc(l.msg) + '</div>';
            }).join('')
          : '<div class="lg">暂无日志</div>';
        logsSum.textContent = '最近 ' + lines.length + ' 条 / 共 ' + (j.total || 0) +
          ' 条（最多保留 ' + (j.max || 0) + ' 条）';
        logsPre.scrollTop = logsPre.scrollHeight;   // 始终停在最新一行
      }).catch(function (e) {
        logsPre.innerHTML = '<div class="lg warn">日志读取失败：' + esc((e && e.message) || e) + '</div>';
        logsSum.textContent = '—';
      });
  }

  function openLogs() {
    logsMask.classList.remove('hidden');
    logsLoad();
    if (logsTick) clearInterval(logsTick);
    logsTick = setInterval(function () { if (logsAuto.checked) logsLoad(); }, 3000);
  }
  function closeLogs() {
    logsMask.classList.add('hidden');
    if (logsTick) { clearInterval(logsTick); logsTick = null; }
  }

  document.getElementById('logsBtn').addEventListener('click', openLogs);
  document.getElementById('logsClose').addEventListener('click', closeLogs);
  logsMask.addEventListener('click', function (ev) { if (ev.target === logsMask) closeLogs(); });
  document.getElementById('logsRefresh').addEventListener('click', logsLoad);
  logsLimit.addEventListener('change', logsLoad);

  /* ---------- 分区设置（顶栏按钮 → 弹窗）：维护「拣货分区 → 前后场分区」映射与忽略分区 ---------- */
  var IGNORE_VAL = '__ignore__';    // 下拉里的「忽略」档位（哨兵值，不会与作业类型重名）
  var zcMask = document.getElementById('zoneCfgMask');
  var zcList = document.getElementById('zoneCfgList');
  var zcSum = document.getElementById('zoneCfgSum');
  var zcNew = document.getElementById('zoneCfgNew');
  var zcSave = document.getElementById('zoneCfgSave');
  var zcTypes = [];        // 可选作业类型（「不映射」由前端补空值选项）
  var zcRows = [];         // [{ zone, type, ignored, inData }]；type 为空串 = 不映射

  function zcOptions(r) {
    var opts = ['<option value=""' + (!r.ignored && !r.type ? ' selected' : '') + '>不映射</option>'];
    zcTypes.forEach(function (t) {
      opts.push('<option value="' + esc(t) + '"' + (!r.ignored && t === r.type ? ' selected' : '') + '>' + esc(t) + '</option>');
    });
    opts.push('<option value="' + IGNORE_VAL + '"' + (r.ignored ? ' selected' : '') + '>忽略（排除统计）</option>');
    return opts.join('');
  }

  function zcSyncSum() {
    var mapped = zcRows.filter(function (r) { return !r.ignored && !!r.type; }).length;
    var ignored = zcRows.filter(function (r) { return !!r.ignored; }).length;
    zcSum.textContent = '共 ' + zcRows.length + ' 个分区，已映射 ' + mapped + ' 个，已忽略 ' + ignored + ' 个';
  }

  function renderZoneCfg() {
    zcList.innerHTML = zcRows.length
      ? zcRows.map(function (r, i) {
        return '<div class="zone-row">' +
          '<span class="zone-name" title="' + esc(r.zone) + '">' + esc(r.zone) +
          (r.inData ? '<span class="zone-tag">数据中</span>' : '') +
          (r.ignored ? '<span class="zone-tag off">已忽略</span>' : '') + '</span>' +
          '<select class="zone-sel" data-i="' + i + '">' + zcOptions(r) + '</select>' +
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
        return { zone: z.zone, type: z.type || '', ignored: !!z.ignored, inData: !!z.inData };
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
    r.ignored = el.value === IGNORE_VAL;
    r.type = r.ignored ? '' : el.value;
    renderZoneCfg();
  });

  function zcAdd() {
    var name = (zcNew.value || '').trim();
    if (!name) { notice('请输入拣货分区名称', 'err'); zcNew.focus(); return; }
    var hit = false;
    zcRows.forEach(function (r) { if (r.zone === name) hit = true; });
    if (hit) { notice('分区「' + esc(name) + '」已在列表中', 'ok'); zcNew.select(); return; }
    zcRows.push({ zone: name, type: '', ignored: false, inData: false });
    zcNew.value = '';
    renderZoneCfg();
  }

  function saveZoneCfg() {
    var map = {}, ignore = [];
    zcRows.forEach(function (r) {
      if (r.ignored) ignore.push(r.zone);
      else if (r.type) map[r.zone] = r.type;
    });
    zcSave.disabled = true;
    fetch(API + '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ map: map, ignore: ignore })
    }).then(readJson).then(function (j) {
      zcSave.disabled = false;
      var upd = (j.updated || []).length, skip = j.skipped || [], fail = (j.failed || []).length;
      var msg = '已保存 ' + Object.keys(j.map || {}).length + ' 个分区的映射、' + (j.ignore || []).length +
        ' 个忽略分区，并按新设置重算历史数据集：成功 ' + upd + ' 条';
      if (skip.length) msg += '，跳过 ' + skip.length + ' 条（数据集 #' + skip.join('、') +
        ' 上传时未保存原始明细，需重新上传该文件才能重算）';
      if (fail) msg += '，失败 ' + fail + ' 条';
      notice(msg, fail ? 'err' : 'ok');
      renderZoneCfg();
      // 重算只影响服务端数据：当前正查看的数据集需重新拉取才反映新映射
      var curId = current && current.id != null ? String(current.id) : null;
      loadDataMgr(curId);
      if (curId != null) {
        refetch(curId).catch(function () { });
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

  /* ---------- 今日暂无数据：全屏遮罩（背景模糊）+ 正中提示卡 ---------- */
  /* 打开页面时若数据集内还没有今天的日期，说明当天的拣货单尚未上传：
     盖一层模糊遮罩并在正中给出登录页样式的提示卡，卡片内保留上传 / 历史数据集 / 数据管理 / 分区设置入口；
     从卡片选一个历史数据集后遮罩关闭，本次访问内不再自动弹出（上传到今日数据后自动复位）。 */
  var gateMask = document.getElementById('gateMask');
  var gateTitle = document.getElementById('gateTitle');
  var gateMsg = document.getElementById('gateMsg');
  var gateHistWrap = document.getElementById('gateHistWrap');
  var gateHistBtn = document.getElementById('gateHistBtn');
  var gateHistMenu = document.getElementById('gateHistMenu');
  var gateDismissed = false;
  var introPending = false;   // 是否在本次渲染完成后播放「导入成功」动画（由上传成功时置位）

  function todayStr() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* d = 当前数据集（null 表示无数据集 / 接口未连通）；errMsg 仅在没有数据集时用于说明原因 */
  function syncGate(d, errMsg) {
    if (!gateMask) return;
    var m = (d && d.meta) || {};
    var dates = (m.dates && m.dates.length) ? m.dates : (m.date ? [m.date] : []);
    var today = todayStr();
    if (d && dates.indexOf(today) >= 0) {   // 今天已有数据：关闭遮罩，并允许下次缺数据时再提示
      gateDismissed = false;
      if (!gateMask.classList.contains('hidden')) {
        // 遮罩正开着：说明是首次导入今日数据，播退场动画（内含看板入场）
        if (introPending) { introPending = false; playGateOut(); }
        else gateMask.classList.add('hidden');
      } else if (introPending) {            // 遮罩此前已手动关闭：仍然播一遍看板入场，给出导入成功的反馈
        introPending = false;
        playDashIn();
      }
      return;
    }
    introPending = false;                   // 本次渲染里没有今日数据：上传标记作废，避免后续误播
    if (!d) gateDismissed = false;          // 完全没有数据时背后没有任何内容可看，遮罩始终给提示
    if (gateDismissed) {                    // 用户已手动看过历史数据集：本次访问内不再自动弹出
      gateMask.classList.add('hidden');
      return;
    }
    var last = dates.length ? dates[dates.length - 1] : '-';
    gateTitle.textContent = d ? '今日（' + today + '）暂无数据' : '暂无可用数据';
    gateMsg.innerHTML = d
      ? '数据集内已有历史数据，最近日期为 <b>' + esc(last) + '</b>（' + esc(m.sourceFile || '-') + '）'
      : esc(errMsg || '当前没有任何数据集，请先上传拣货单 xlsx');
    gateMask.classList.remove('hidden');
  }

  /* 遮罩退场：卡片上弹收缩淡出、背景模糊消散，同时冒出绿勾成功徽标 + 冲击波 + 页面氛围光晕，看板错峰弹出 */
  function playGateOut() {
    if (gateMask.classList.contains('leaving')) return;
    gateMask.classList.add('leaving');
    document.body.classList.add('intro-flash');   // 页面氛围：蓝绿光晕自中心荡开
    var burst = document.createElement('div');
    burst.className = 'ok-burst';
    burst.innerHTML =
      '<div class="ring"></div><div class="ring r2"></div><div class="ring glow"></div>' +
      '<svg viewBox="0 0 112 112" aria-hidden="true">' +
      '<circle cx="56" cy="56" r="48"/><path d="M35 58 L50 73 L79 41"/></svg>';
    document.body.appendChild(burst);
    playDashIn();
    setTimeout(function () {                       // 与 CSS gate-out .46s 对齐后再真正隐藏遮罩
      gateMask.classList.remove('leaving');
      gateMask.classList.add('hidden');
    }, 460);
    setTimeout(function () {                       // 徽标与氛围光晕播完自行清理，避免残留覆盖层
      if (burst.parentNode) burst.parentNode.removeChild(burst);
      document.body.classList.remove('intro-flash');
    }, 1200);
  }

  /* 看板入场：顶栏 → KPI 卡片 → main 内各卡片依次升入（--intro-i 控制错峰），播完即摘掉类，不留残余 transform */
  function playDashIn() {
    var nodes = [document.querySelector('.topbar')]
      .concat(Array.prototype.slice.call(document.querySelectorAll('#kpis .kpi, #kpisSub .kpi')))
      .concat(Array.prototype.slice.call(document.querySelectorAll('main > .card')))
      .filter(function (el) { return el && !el.classList.contains('hidden'); });
    nodes.forEach(function (el, i) {
      el.style.setProperty('--intro-i', i);
      el.classList.add('intro');
    });
    setTimeout(function () {
      nodes.forEach(function (el) {
        el.classList.remove('intro');
        el.style.removeProperty('--intro-i');
      });
    }, 1500);
  }

  gateHistMenu.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('.sel-item') : null;
    if (!btn) return;
    closeMenus();
    gateMask.classList.add('hidden');   // 先立即收掉遮罩，不等取数返回（gateDismissed 由 pickHistory 置位）
    pickHistory(btn.getAttribute('data-id'));
  });
  document.getElementById('gateDataMgr').addEventListener('click', function () { openDataMgr(); });
  document.getElementById('gateZoneCfg').addEventListener('click', function () { openZoneCfg(); });
  document.getElementById('gateUms').addEventListener('click', function () { openUms(); });

  /* ---------- 各表格表头排序注册（点击表头切换升/降序） ---------- */
  bindSort(document.getElementById('pivotBlocks'), 'pivot', function () { if (current) renderPivotBlocks(current); });
  bindSort(document.getElementById('tableZone'), 'zone', function () { if (current) renderZoneTable(current); });
  bindSort(document.getElementById('tablePerson'), 'person', function () { if (current) renderPersonTable(current); });
  bindSort(document.getElementById('tableEffBin'), 'effBin', function () { if (current) renderDist(current); });
  bindSort(document.getElementById('tableStab'), 'stability', function () { if (current) renderDist(current); });
  bindSort(document.getElementById('tableRowsBin'), 'rowsBin', function () { if (current) renderRowsStat(current); });
  bindSort(document.getElementById('tableTimeline'), 'timeline', function () { if (current) renderTimeline(current); });
  bindSort(document.getElementById('tableTimeoutPerson'), 'timeoutPerson', function () { if (current) renderTimeoutPerson(current); });
  bindSort(document.getElementById('dmTable'), 'dm', function () { renderDmTable(); });

  /* 折叠开关通用绑定：toggleId 为标题元素、blockId 为被折叠的容器。
     默认折叠、状态不记忆（每次进页面都从折叠开始）；展开后重测图表尺寸
     —— 容器隐藏时 echarts 初始化只能拿到 0 尺寸，不重测画布仍是 0×0 */
  function bindCollapse(toggleId, blockId) {
    var tg = document.getElementById(toggleId);
    if (!tg) return;
    tg.addEventListener('click', function (ev) {
      // 卡片标题同一行还挂着导出 / 复制按钮，点按钮时不应触发折叠
      if (ev.target && ev.target.closest && ev.target.closest('.card-tools')) return;
      var b = document.getElementById(blockId);
      if (!b) return;
      var collapsed = b.classList.toggle('collapsed');
      var caret = tg.querySelector('.caret');
      if (caret) caret.textContent = collapsed ? '▶' : '▼';
      if (!collapsed && HEMA.charts.resize) HEMA.charts.resize();
    });
  }

  // 超时数统计卡片 + 其内部「按人员统计」区块：均默认折叠
  bindCollapse('timeoutToggle', 'timeoutCard');
  bindCollapse('timeoutPersonToggle', 'timeoutPerson');

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
  // match 为 null 表示整张卡片；含多项表示这几块合并成同一张图片
  var PIVOT_SCOPES = [
    { key: '全部', label: '全部（三块）', match: null },
    { key: '前场合流', label: '前场合流', match: ['前场合流'] },
    { key: '后场合流', label: '后场合流', match: ['后场合流'] },
    { key: '一体化', label: '一体化', match: ['一体化'] },
    { key: '后场+一体化', label: '后场合流＋一体化（同图）', match: ['后场合流', '一体化'] }
  ];

  function menuWrap(label, act) {
    var items = PIVOT_SCOPES.map(function (s) {
      return '<button type="button" data-act="' + act + '" data-scope="' + s.key + '">' + s.label + '</button>';
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
      // 先克隆一份去掉折叠箭头与「点击展开」提示，避免混进文件名
      var cl = (h3.querySelector('.card-title') || h3).cloneNode(true);
      Array.prototype.forEach.call(cl.querySelectorAll('.caret, small'), function (n) {
        n.parentNode.removeChild(n);
      });
      t = cl.textContent;   // 排除工具按钮文字
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
      },
      // html2canvas 把节点克隆到独立文档再渲染，克隆体会重放入场动画（表格行 row-in 的逐行延迟、
      // 卡片 dash-in、KPI 数字跳动），截图时仍停在 opacity:0 / translateX 初始态 → 图片显示不全。
      // 只在克隆文档内关闭动画与过渡，不影响页面本身的动效。
      onclone: function (doc) {
        var st = doc.createElement('style');
        st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;}';
        (doc.head || doc.documentElement).appendChild(st);
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

  function exportPng(node, name) {
    name = name || cardName(node);
    notice('正在生成图片…', 'ok');
    return captureCard(node).then(canvasToBlob).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      notice('图片已下载：' + esc(name) + '.png', 'ok');
    }).catch(function (e) { notice('导出失败：' + esc(e.message || e), 'err'); throw e; });
  }

  function copyPng(node) {
    // IP 访问 → 非安全上下文，浏览器不提供剪贴板写入；原因与域名入口由顶栏下方的红色提示条（#ipWarn）统一给出，
    // 此处只提示可执行的替代方案，避免整句重复
    if (ACCESS.kind === 'IP') {
      notice('复制图片失败，可改用「导出为图片」', 'err');
      return Promise.reject(new Error('IP 访问不支持复制图片到剪贴板'));
    }
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
      notice('当前浏览器不支持复制图片，请改用「导出为图片」', 'err');
      return Promise.reject(new Error('ClipboardItem 不可用'));
    }
    notice('正在生成图片…', 'ok');

    // 截图与 toBlob 是异步的，若等图片生成完再调 clipboard.write，用户激活（transient activation）
    // 已过期，Safari 必定报 NotAllowedError、Chrome 大卡片也可能失败。
    // 因此把「生成图片」的 Promise 直接交给 ClipboardItem 并在点击的同步流程内完成写入；
    // 注意 Safari 只接受 Promise<Blob>，不接受已就绪的 Blob。
    var blobPromise = captureCard(node).then(canvasToBlob).then(function (blob) {
      if (!blob) throw new Error('生成图片失败（canvas 未产出图片数据）');
      return blob;
    });

    var write;
    try {
      write = navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    } catch (e) {
      // 老浏览器不接受 Promise 值：退化为先等图片生成，再用 Blob 写入
      write = blobPromise.then(function (blob) {
        return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      });
    }

    return Promise.resolve(write).then(function () {
      notice('图片已复制到剪贴板，可直接粘贴（Ctrl+V）', 'ok');
    }).catch(function (e) {
      notice('复制失败：' + esc(e.message || e) +
        '<br>可改用「导出为图片」，或直接在图表上右键选择「复制图片」', 'err');
      throw e;
    });
  }

  // 把多个块临时收进一个容器，便于截成同一张图片；返回容器与还原函数
  function mergeNodes(nodes) {
    var wrap = document.createElement('div');
    nodes[0].parentNode.insertBefore(wrap, nodes[0]);
    nodes.forEach(function (n) { wrap.appendChild(n); });
    return {
      node: wrap,
      restore: function () {
        var p = wrap.parentNode;
        if (!p) return;                        // 期间整卡已重绘，无需还原
        nodes.forEach(function (n) { p.insertBefore(n, wrap); });
        p.removeChild(wrap);
      }
    };
  }

  // 按范围取节点（透视卡片可选 全部 / 单块 / 后场＋一体化合并）；折叠块临时展开、截完还原
  function runCapture(card, act, scopeKey) {
    var sc = null, i;
    for (i = 0; i < PIVOT_SCOPES.length; i++) {
      if (PIVOT_SCOPES[i].key === scopeKey) { sc = PIVOT_SCOPES[i]; break; }
    }

    var node = card, merged = null, name = null, expand = [];
    // 卡片自身默认折叠时（超时数统计）先临时展开，否则截到的只有标题
    var cardCollapsed = card.classList.contains('collapsed');
    if (cardCollapsed) {
      card.classList.remove('collapsed');
      var cardCaret = card.querySelector('h3 .caret');
      if (cardCaret) cardCaret.textContent = '▼';
      if (HEMA.charts.resize) HEMA.charts.resize();
    }
    if (sc && sc.match) {
      var blocks = [];
      Array.prototype.forEach.call(card.querySelectorAll('.pivot-block'), function (b) {
        var t = b.querySelector('.pivot-title');
        if (!t) return;
        var txt = t.textContent;
        for (var k = 0; k < sc.match.length; k++) {
          if (txt.indexOf(sc.match[k]) >= 0) { blocks.push(b); break; }
        }
      });
      blocks.forEach(function (b) {
        if (b.classList.contains('collapsed')) { b.classList.remove('collapsed'); expand.push(b); }
      });
      if (blocks.length > 1) {
        merged = mergeNodes(blocks);
        node = merged.node;
        name = cardName(card) + '_' + sc.match.join('+');
      } else if (blocks.length === 1) {
        node = blocks[0];
      }
    }

    var p = (act === 'png') ? exportPng(node, name) : copyPng(node);
    if (merged || expand.length || cardCollapsed) {
      Promise.resolve(p).catch(function () { }).then(function () {
        if (merged) merged.restore();
        expand.forEach(function (b) { b.classList.add('collapsed'); });
        // 卡片本身的折叠态也要还原，截图后回到默认折叠
        if (cardCollapsed) {
          card.classList.add('collapsed');
          var cc = card.querySelector('h3 .caret');
          if (cc) cc.textContent = '▶';
        }
      });
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

  /* 顶栏口径开关（统一入口）：勾选 = 按工时加权（Σ行数 ÷ Σ时长），不勾选 = 人均（各人效率算术平均）。
     所有「按工时加权」的口径在此一处切换：KPI 卡、透视分块（含小计 / 整体）、各含合计行的表格、两张效率趋势图 */
  var weightedToggle = document.getElementById('weightedToggle');
  if (weightedToggle) weightedToggle.addEventListener('change', function () {
    weighted = weightedToggle.checked;
    if (HEMA.charts.setWeighted) HEMA.charts.setWeighted(weighted);   // 效率趋势图 + 作业类型×小时图
    if (current) {
      renderKpis(current);
      renderPivotBlocks(current);
      renderZoneTable(current);
      renderPersonTable(current);
    }
  });

  /* 顶栏日期下拉：隔天不显示前天（默认只显示数据集内最新日期），其余日期在这里手动选择 */
  var dateSel = document.getElementById('dateSel');
  if (dateSel) dateSel.addEventListener('change', function () {
    curDate = dateSel.value || null;
    if (!current) return;
    refetch(current.id).catch(function (e) { notice('切换日期失败：' + esc(e.message || e), 'err'); });
  });

  /* 顶栏「周视图 / 月视图」：点击在「本页」切换视图范围，读库内已有数据按自然周（周一 ~ 周日）/
     自然月聚合；再次点击同一个按钮回到日视图 */
  var viewWeekBtn = document.getElementById('viewWeek');
  var viewMonthBtn = document.getElementById('viewMonth');
  function viewPaint() {
    if (viewWeekBtn) viewWeekBtn.className = 'btn view-btn' + (viewMode === 'week' ? ' on' : '');
    if (viewMonthBtn) viewMonthBtn.className = 'btn view-btn' + (viewMode === 'month' ? ' on' : '');
  }

  /* 周 / 月视图的日期步进控件：◀ / ▶ 按自然周（±7 天）或自然月（±1 月）移动锚点日期，
     中间显示当前统计区间；日视图隐藏。原日期下拉保留，可直接跳到某天所在的周 / 月 */
  var rangeNavEl = document.getElementById('rangeNav');
  var rangeLabelEl = document.getElementById('rangeLabel');
  var rangePrevBtn = document.getElementById('rangePrev');
  var rangeNextBtn = document.getElementById('rangeNext');

  function rangePaint() {
    if (!rangeNavEl) return;
    if (viewMode === 'day') { rangeNavEl.classList.add('hidden'); return; }
    var unit = viewMode === 'month' ? '月' : '周';
    var r = viewRange();
    if (rangeLabelEl) rangeLabelEl.textContent = r ? (r.from + ' ~ ' + r.to) : '';
    if (rangePrevBtn) rangePrevBtn.title = '上一个' + unit;
    if (rangeNextBtn) rangeNextBtn.title = '下一个' + unit;
    rangeNavEl.classList.remove('hidden');
  }

  /* 锚点日期整体前 / 后移一个自然周（±7 天）或自然月（±1 月，月末自动收敛，如 1/31 + 1 月 → 2/28） */
  function shiftAnchor(delta) {
    var d = new Date((curDate || todayStr()) + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    if (viewMode === 'month') {
      var day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + delta);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    } else {
      d.setDate(d.getDate() + delta * 7);
    }
    return ymd(d);
  }

  function rangeStep(delta) {
    var next = shiftAnchor(delta);
    if (!next || next === curDate) return;
    var prev = curDate;
    curDate = next;
    rangePaint();
    refetch(current ? current.id : null).then(function () {
      var r = viewRange();
      notice('已切换到 ' + r.from + ' ~ ' + r.to, 'ok');
    }).catch(function (e) {
      curDate = prev;              // 目标区间无数据：回退锚点，避免停在空白页
      rangePaint();
      notice('切换失败：' + esc(e.message || e), 'err');
    });
  }

  if (rangePrevBtn) rangePrevBtn.addEventListener('click', function () { rangeStep(-1); });
  if (rangeNextBtn) rangeNextBtn.addEventListener('click', function () { rangeStep(1); });

  function setView(mode) {
    var next = viewMode === mode ? 'day' : mode;      // 再点一次 → 回到日视图
    if (next === viewMode) return;
    viewMode = next;
    if (next !== 'day') gateDismissed = true;         // 聚合视图与「今日」无关：不弹「今日暂无数据」遮罩
    viewPaint();
    rangePaint();
    notice(next === 'day' ? '已切回日视图'
      : (next === 'week' ? '周视图：按自然周（周一 ~ 周日）聚合' : '月视图：按自然月聚合'), 'ok');
    /* 聚合视图不依赖单个数据集：即使日视图这边没有数据（current 为空）也照常按区间取数。
       回退：聚合视图的锚点只是「区间位置」，不一定是数据日期，目标区间可能 404
       （如锚点 9-02 所在周 8-31~9-06 无数据）；此时改用上一区间内最后一个有数据的日期再试一次 */
    refetch(current ? current.id : null).catch(function (e) {
      if (e.status !== 404) throw e;                  // 非「无数据」错误（如网络）直接抛出
      var rg = current && current.meta && current.meta.range;
      var ds = (rg && rg.dates) || [];
      if (!ds.length) throw e;
      curDate = ds[ds.length - 1];
      return refetch(null);
    }).catch(function (e) { notice('切换视图失败：' + esc(e.message || e), 'err'); });
  }
  /* 点击「周视图 / 月视图」：在「本页」直接切换视图范围（不再另开标签页），
     再次点击同一个按钮回到日视图；URL 仍支持 ?view=week|month&date=… 直接进入聚合视图 */
  if (viewWeekBtn) viewWeekBtn.addEventListener('click', function () { setView('week'); });
  if (viewMonthBtn) viewMonthBtn.addEventListener('click', function () { setView('month'); });
  viewPaint();
  rangePaint();
  if (viewPage) {
    document.title = '拣货效率统计 · ' + (viewMode === 'week' ? '周视图' : '月视图') +
      (curDate ? '（' + curDate + '）' : '');
  }

  /* ---------- 启动：只加载「含今天日期」的数据集；今天没单就不加载任何数据，只给遮罩提示 ---------- */
  injectCardTools();
  renderAccess();
  if (viewPage) gateDismissed = true;   // 视图页面展示的是指定区间，不弹「今日暂无数据」遮罩
  if (typeof echarts === 'undefined') {
    notice('图表库 ECharts 未加载（可能无外网），页面其余内容仍可正常使用', 'err');
  }
  fetch(API + '/datasets').then(readJson).then(function (list) {
    var today = todayStr();
    // 视图页面：不绑定单个数据集 —— 由服务端按区间汇总「所有」数据集（每个数据集常只含一天）
    if (viewPage) {
      loadHistory(null, list);
      return refetch(null).then(function (ds) {
        var rg = (ds.meta && ds.meta.range) || null;
        notice('已按' + (viewMode === 'week' ? '自然周' : '自然月') + '汇总区间内所有数据集' +
          (rg ? '（' + rg.from + ' ~ ' + rg.to + '）' : ''), 'ok');
      });
    }
    // 列表按 id 倒序：只要某条数据集的日期集合里有今天就用它。今天的数据常不是最新一条
    //（例如先传今日单、再补传历史单），只用 /latest 会误判成「今日暂无数据」
    var hit = (list || []).filter(function (x) {
      return String(x.dates == null ? '' : x.dates).split(',').indexOf(today) >= 0;
    })[0];
    if (!hit) {
      // 今天没单：不回退加载 /latest（否则遮罩后面会偷偷渲染最近一天的数据）。
      // 只把历史下拉填好供手动选择，并借日期最新的那条的元信息组织遮罩文案
      var latest = (list || []).slice().sort(function (a, b) {
        var la = String(a.dates == null ? '' : a.dates).split(',').pop() || '';
        var lb = String(b.dates == null ? '' : b.dates).split(',').pop() || '';
        return la < lb ? 1 : (la > lb ? -1 : 0);
      })[0];
      loadHistory(null, list);
      clearView('', latest ? {
        dates: String(latest.dates == null ? '' : latest.dates).split(',').filter(Boolean).sort(),
        sourceFile: latest.sourceFile
      } : null);
      return;
    }
    return refetch(hit.id).then(function (ds) {
      loadHistory(hit.id, list);
      notice('已加载今日（' + today + '）数据集 #' + ds.id, 'ok');
    });
  }).catch(function (err) {
    // err.status 存在说明服务端已响应（如 404「暂无数据」），只有网络层失败才算「接口未连通」
    var why = (err && err.message) || String(err);
    loadHistory(null);
    if (err && err.status) {
      clearView(why);
      notice(esc(why) + '（服务端已连通）', 'ok');
    } else {
      clearView('接口未连通：' + why + '。请确认服务端已启动。');
      notice('接口未连通：' + esc(why) + '<br>当前 API_BASE：<b>' + esc(API) +
        '</b>，请确认服务端已启动后再上传拣货单', 'err');
    }
  });
})(window);
