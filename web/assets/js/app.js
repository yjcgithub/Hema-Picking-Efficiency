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

  /* 人均（不加权）口径取数：各人「总计效率」的算术平均 */
  function personsOf(d, type) {
    var pb = d.personByHour;
    if (!pb || !pb.groups) return [];
    if (type == null) {
      var all = [];
      pb.groups.forEach(function (g) { all = all.concat(g.persons || []); });
      return all;
    }
    for (var i = 0; i < pb.groups.length; i++) {
      if (pb.groups[i].type === type) return pb.groups[i].persons || [];
    }
    return [];
  }
  function meanEff(list) {
    var s = 0, n = 0;
    list.forEach(function (p) { if (p.total != null) { s += p.total; n++; } });
    return n ? Math.round(s / n * 100) / 100 : null;
  }

  function renderKpis(d) {
    var t = d.totals;
    var colors = (global.HEMA_CONFIG && global.HEMA_CONFIG.COLORS) || {};
    var all = personsOf(d, null);
    var allAvg = meanEff(all);
    var useAvg = !weighted && allAvg != null;
    var main = [
      {
        label: '综合效率', value: fmt(useAvg ? allAvg : t.eff), unit: '行/h',
        foot: useAvg ? '全员人均（' + all.length + ' 人）' : '全部作业类型加权'
      }
    ];
    // 固定顺序：前场合流 / 后场合流 / 一体化（其余类型排在最后）
    (d.byJobType || []).slice().sort(function (a, b) {
      var ia = PIVOT_ORDER.indexOf(a.name), ib = PIVOT_ORDER.indexOf(b.name);
      if (ia < 0) ia = 90; if (ib < 0) ib = 90;
      return ia - ib;
    }).forEach(function (j) {
      var color = colors[j.name] || '#64748b';
      var ps = personsOf(d, j.name);
      var avg = meanEff(ps);
      var scale = j.rows.toLocaleString() + ' 行 · ' + fmt(j.hours, 2) + ' h';
      main.push({
        label: '<span class="dot" style="background:' + color + '"></span>' + esc(j.name),
        value: fmt(!weighted && avg != null ? avg : j.eff), unit: '行/h',
        foot: !weighted && avg != null ? ps.length + ' 人平均 · ' + scale : scale
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

  /* 最接近给定值的行号（忽略空值），无有效值返回 -1 */
  function nearestIdx(arr, v) {
    if (v == null) return -1;
    var bi = -1, bd = Infinity;
    arr.forEach(function (x, i) {
      if (x == null) return;
      var dd = Math.abs(x - v);
      if (dd < bd) { bd = dd; bi = i; }
    });
    return bi;
  }

  /* 一列数值的平均值 / 中位数（忽略空值） */
  function statOf(arr, kind) {
    var vals = arr.filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
    if (!vals.length) return null;
    if (kind === 'avg') {
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    }
    var m = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
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

      // 平均值 / 中位数按「总计」列口径计算，对应行加边框并在右上角标注
      var totals = g.persons.map(function (r) { return r.total; });
      var avg = statOf(totals, 'avg'), med = statOf(totals, 'median');
      var iAvg = nearestIdx(totals, avg), iMed = nearestIdx(totals, med);

      var body = g.persons.map(function (r, i) {
        var tag = i === iMed ? 'median' : (i === iAvg ? 'avg' : '');
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
    HEMA.charts.render(d);
  }

  /* ---------- 历史数据集 ---------- */
  var sel = document.getElementById('historySelect');
  function loadHistory(currentId) {
    fetch(API + '/datasets').then(readJson).then(function (list) {
      var opts = ['<option value="sample">内置示例数据</option>'];
      list.forEach(function (x) {
        opts.push('<option value="' + x.id + '">#' + x.id + ' · ' + esc(x.sourceFile) +
          ' · ' + esc(x.dates) + ' · ' + fmt(x.eff) + ' 行/h</option>');
      });
      sel.innerHTML = opts.join('');
      sel.value = currentId ? String(currentId) : 'sample';
    }).catch(function () {
      sel.innerHTML = '<option value="sample">内置示例数据</option>';
    });
  }

  sel.addEventListener('change', function () {
    var v = sel.value;
    if (v === 'sample') { render(SAMPLE); notice('已切换到内置示例数据。', 'ok'); return; }
    fetch(API + '/datasets/' + v).then(readJson).then(function (ds) {
      render(ds);
      notice('已加载数据集 #' + v + '。', 'ok');
    }).catch(function () { notice('加载数据集失败。', 'err'); });
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
  document.getElementById('resetBtn').addEventListener('click', function () {
    render(SAMPLE);
    sel.value = 'sample';
    notice('已切换到内置示例数据。', 'ok');
  });

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
