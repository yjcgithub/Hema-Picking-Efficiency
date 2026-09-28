/* 视图层-图表：ECharts 封装 */
(function (global) {
  var CFG = global.HEMA_CONFIG;
  var HEMA = global.HEMA = global.HEMA || {};
  HEMA.charts = {};

  var instances = {};
  var cache = null;
  var weighted = true;    // 效率口径：true = 按工时加权（默认），false = 人均

  function inst(id) {
    var el = document.getElementById(id);
    if (!el || typeof echarts === 'undefined') return null;
    if (!instances[id] || instances[id].isDisposed()) {
      instances[id] = echarts.init(el, null, { renderer: 'canvas' });
    }
    return instances[id];
  }

  function colorOf(name) { return CFG.COLORS[name] || '#64748b'; }
  function fmt(v) { return v == null ? '-' : (Math.round(v * 100) / 100).toFixed(2); }
  function round2(v) { return Math.round(v * 100) / 100; }
  /* 半小时刻度取值（7 / 7.5 / 8 …）-> 轴与提示文案（7:00 / 7:30 / 8:00） */
  function slotText(v) {
    var h = Math.floor(v), m = Math.round((v - h) * 60);
    return h + ':' + (m < 10 ? '0' + m : String(m));
  }
  /* 分钟（当天 0 点起算）-> HH:MM（工作时间图的时间轴） */
  function minText(m) {
    var h = Math.floor(m / 60), mi = Math.round(m - h * 60);
    if (mi >= 60) { h += 1; mi -= 60; }
    return (h < 10 ? '0' + h : h) + ':' + (mi < 10 ? '0' + mi : mi);
  }

  var AXIS = { axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: '#64748b', fontSize: 11 } };
  var SPLIT = { lineStyle: { color: '#f1f5f9' } };
  /* 图例 / 系列的显示顺序（与透视分块一致） */
  var TYPE_ORDER = ['前场合流', '后场合流', '一体化', '未匹配分区'];
  /* 超时判责的配色：服务端按超时单数降序返回，依次取色（判责条目多于配色时循环取用） */
  var DUTY_COLORS = ['#ef4444', '#f59e0b', '#8b5cf6', '#0ea5e9', '#94a3b8'];
  /* 超时分区配色：每个分区独立色相，避免与判责色混淆 */
  var ZONE_PALETTE = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed',
    '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b91c1c'];

  /* 超时堆积柱的通用悬浮提示：逐系列列出非零值，末尾给合计 */
  function stackTip(ps) {
    var sum = 0, lines = [];
    ps.forEach(function (p) {
      if (!p.value) return;
      sum += p.value;
      lines.push(p.marker + p.seriesName + '：<b>' + p.value + '</b> 单');
    });
    if (!sum) return ps[0].axisValue + '<br/>无超时单';
    return '<b>' + ps[0].axisValue + '</b><br/>' + lines.join('<br/>') +
      '<br/>合计：<b>' + sum + '</b> 单';
  }

  /* 超时堆积柱的系列（作业类型口径）：颜色复用作业类型配色，未匹配分区回落为灰色；
     柱顶标数值，与「按判责」图保持同一观感 */
  function typeStackSeries(types, stackName, width) {
    return (types || []).map(function (s) {
      return {
        name: s.name, type: 'bar', stack: stackName, barMaxWidth: width,
        itemStyle: { color: colorOf(s.name) },
        label: {
          show: true, fontSize: 10, color: '#475569',
          formatter: function (p) { return p.value ? p.value : ''; }
        },
        data: s.data
      };
    });
  }

  /* 工作时间图：一行 = 一个「人·日」班次的最小行高（px）
     行高不足时 ECharts 会自动抽稀纵轴标签（人员名会「消失」一部分），故取 18 保证标签完整可见 */
  var TL_ROW_MIN_H = 18;
  var TL_GRID_TOP = 34, TL_GRID_BOTTOM = 72;   // 底部含时间轴标签 + 横轴缩放条
  var TL_GRID_LEFT = 128, TL_GRID_RIGHT = 34;  // 左侧放宽以容纳「人员 日期」标签
  /* 横/纵缩放条统一外观（细长、浅灰），避免默认样式喧宾夺主 */
  var TL_ZOOM_STYLE = {
    showDetail: false, brushSelect: false, realTime: true,
    backgroundColor: '#f8fafc', borderColor: '#e2e8f0',
    fillerColor: 'rgba(148,163,184,0.18)',
    handleStyle: { color: '#94a3b8', borderColor: '#94a3b8' },
    moveHandleStyle: { color: '#cbd5e1' }
  };

  /* 工作时间图：点击「色块」或左侧「人员名」-> 高亮该行，同一时刻只保留一行高亮 */
  var TL_HL_ID = 'tlHighlight';   // 高亮行系列的 id（增量 setOption 时按 id 合并）
  var tlSel = -1;                 // 当前高亮行下标（对应 tlRows 的序号），-1 = 无高亮
  var tlSelRows = null;           // 高亮所属的数据行（切换数据集后失效，需清空）

  /* 工作时间图：把一段在岗区间画成圆角矩形（x 轴为当天的分钟刻度，y 轴为「人·日」分类） */
  function timelineItem(params, api) {
    var i = api.value(0);
    var a = api.coord([api.value(1), i]);
    var b = api.coord([api.value(2), i]);
    var band = api.size([0, 1])[1];
    // 高度跟随行高，上限 18px；绝不能超过行高，否则色块跨到相邻行、与左侧行名对不上
    var h = Math.min(band * 0.6, 18, band);
    var rect = echarts.graphic.clipRectByRect({
      x: a[0], y: a[1] - h / 2,
      width: Math.max(b[0] - a[0], 1.5), height: h
    }, {
      x: params.coordSys.x, y: params.coordSys.y,
      width: params.coordSys.width, height: params.coordSys.height
    });
    return rect && {
      type: 'rect',
      shape: Object.assign({ r: 1.5 }, rect),
      style: api.style()
    };
  }

  /* 工作时间图：高亮行的整行底色 + 边框（silent —— 不拦截色块的点击与悬浮） */
  function timelineHlItem(params, api) {
    var y = api.coord([0, api.value(0)])[1];
    var band = api.size([0, 1])[1];
    return {
      type: 'rect',
      shape: {
        x: params.coordSys.x + 1, y: y - band / 2,
        width: Math.max(params.coordSys.width - 2, 2),
        height: Math.max(band, 2), r: 3
      },
      style: { fill: 'rgba(37,99,235,0.10)', stroke: 'rgba(37,99,235,0.65)', lineWidth: 1.5 }
    };
  }

  function avgLine(v) {
    return {
      silent: true, symbol: 'none',
      lineStyle: { type: 'dashed', color: '#94a3b8' },
      label: { formatter: '整体 ' + fmt(v), color: '#64748b', fontSize: 11, position: 'insideEndTop' },
      data: [{ yAxis: v }]
    };
  }

  /* 人均口径序列由服务端一并返回（{ 作业类型名: [各时段人均], '整体': [...] }）；
     取某一条序列，缺数据或为空时返回 null（此时只能按加权口径展示） */
  function uwOf(uw, name) {
    if (!uw) return null;
    var a = uw[name];
    return (a && a.length) ? a : null;
  }

  HEMA.charts.render = function (data) {
    cache = data;
    if (typeof echarts === 'undefined') return;

    /* 1) 效率总览 · 各小时效率趋势（合并为一张图）
          x 轴为半小时刻度（旧数据无半小时时退回整点小时）
          左轴：各作业类型效率线 + 整体效率线（灰虚线），随顶栏口径开关切换：人均 / 按工时加权
          右轴：拣货行数柱；tooltip 附带另一种口径对照 */
    var hRows = (data.bySlot && data.bySlot.length) ? data.bySlot : (data.byHour || []);
    var c4 = inst('chartJtHour');
    if (c4) {
      var jb = (data.jobTypeBySlot && data.jobTypeBySlot.slots && data.jobTypeBySlot.slots.length)
        ? data.jobTypeBySlot : data.jobTypeByHour;
      var jSlot = !!jb.slots;
      var xs = jb.slots || jb.hours;                        // 坐标轴取值（半小时为 7 / 7.5 / 8 …）
      var xName = function (i) { return jSlot ? slotText(xs[i]) : xs[i] + '点'; };
      // 人均口径序列（服务端给出，与当前刻度对齐）；旧数据集无该字段时为 null
      var uw = jb.unweighted || null;
      var wt = {};                                          // 加权值：Σ行数 ÷ Σ时长
      jb.series.forEach(function (s) { wt[s.name] = s.data; });
      wt['整体'] = jb.total;

      var useW = weighted || !uwOf(uw, '整体');    // 无不加权数据时只能按加权展示
      var pick = function (name, fallback) {
        return useW ? fallback : (uwOf(uw, name) || fallback);
      };

      var series = jb.series.map(function (s) {
        var color = colorOf(s.name);
        return {
          name: s.name, type: 'line', smooth: true, connectNulls: true, symbolSize: 5,
          data: pick(s.name, s.data),
          itemStyle: { color: color }, lineStyle: { width: 2.5 },
          // 整点顶点显示数值，半小时顶点不显示
          label: {
            show: true, position: 'top', distance: 5,
            color: color, fontSize: 10, fontWeight: 600,
            formatter: function (p) { return xs[p.dataIndex] % 1 ? '' : fmt(p.value); }
          }
        };
      });
      series.push({
        name: '整体', type: 'line', smooth: true, connectNulls: true, symbol: 'none',
        data: pick('整体', jb.total),
        itemStyle: { color: '#94a3b8' }, lineStyle: { width: 1.6, type: 'dashed' }
      });
      // 拣货行数柱（右轴）：与效率线共用同一时间刻度；旧数据集长度不一致时按索引缺省为 null
      series.push({
        name: '拣货行数', type: 'bar', yAxisIndex: 1, barWidth: 14,
        data: xs.map(function (_, i) { return hRows[i] ? hRows[i].rows : null; }),
        itemStyle: { color: 'rgba(148,163,184,.35)', borderRadius: [4, 4, 0, 0] },
        // 柱顶只在整点显示行数；柱色浅、效率线可能压过来，垫一层半透明白底保证可读
        label: {
          show: true, position: 'top', distance: 3,
          color: '#64748b', fontSize: 10, fontWeight: 600,
          backgroundColor: 'rgba(255,255,255,.78)', padding: [2, 3], borderRadius: 3,
          formatter: function (p) {
            if (p.value == null || (jSlot && xs[p.dataIndex] % 1)) return '';
            return Number(p.value).toLocaleString();
          }
        }
      });
      c4.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: function (ps) {
            var i = ps[0].dataIndex;
            var lines = [xName(i) + '（' + (useW ? '加权' : '人均') + '）'];
            ps.forEach(function (p) {
              if (p.seriesName === '拣货行数') {
                if (p.value != null) lines.push(p.marker + '拣货行数：<b>' + Number(p.value).toLocaleString() + '</b>');
                if (hRows[i]) lines.push('时长：' + hRows[i].hours + ' h');
                return;
              }
              var uwArr = uwOf(uw, p.seriesName);
              var o = useW ? (uwArr ? uwArr[i] : null)
                           : (wt[p.seriesName] ? wt[p.seriesName][i] : null);
              lines.push(p.marker + p.seriesName + '：<b>' + fmt(p.value) + '</b> 行/h' +
                (o == null ? '' : '（' + (useW ? '人均 ' : '加权 ') + fmt(o) + '）'));
            });
            return lines.join('<br/>');
          }
        },
        // 图例项较多（各作业类型 + 整体 + 拣货行数），grid.top 留足 56px 供其换行
        legend: { top: 0, left: 'center', itemGap: 14, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11, color: '#64748b' } },
        grid: { left: 56, right: 56, top: 56, bottom: 30 },
        xAxis: Object.assign({ type: 'category', boundaryGap: true, data: xs.map(function (_, i) { return xName(i); }) }, AXIS),
        yAxis: [
          Object.assign({
            type: 'value', name: useW ? '行/h' : '行/h（人均）', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, splitLine: SPLIT,
            max: function (v) { return Math.ceil(v.max * 1.12); }   // 留出空间给峰值数值
          }, { axisLabel: AXIS.axisLabel }),
          { type: 'value', name: '行数', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, axisLabel: AXIS.axisLabel, splitLine: { show: false } }
        ],
        series: series
      }, true);
    }

    /* 3) 人员效率分布（箱线图：整体 + 各作业类型）
          固定用「各人总计效率」（Σ拣货行数 ÷ Σ拣货时长），不随顶栏口径开关变化 */
    var c5 = inst('chartDist');
    if (c5) {
      // 分位数与均值由服务端算好（stats.boxplot，样本 < 2 人的分组不返回）
      var bp = (data.stats && data.stats.boxplot) || [];
      var cats = [], boxes = [], means = [];
      bp.forEach(function (s) {
        var color = s.name === '整体' ? '#94a3b8' : colorOf(s.name);
        cats.push(s.name + '（' + s.n + ' 人）');
        boxes.push({
          value: [s.min, s.q1, s.median, s.q3, s.max].map(round2),
          itemStyle: { color: '#f1f5f9', borderColor: color, borderWidth: 1.6 }
        });
        means.push(round2(s.mean));
      });

      c5.setOption({
        tooltip: {
          trigger: 'item',
          formatter: function (p) {
            if (p.seriesType === 'scatter') {
              return cats[p.dataIndex] + '<br/>平均：<b>' + fmt(p.value) + '</b> 行/h';
            }
            var v = (boxes[p.dataIndex] || {}).value;
            if (!v) return '';
            return cats[p.dataIndex] +
              '<br/>最高：' + fmt(v[4]) + '<br/>P75：' + fmt(v[3]) +
              '<br/>中位数：<b>' + fmt(v[2]) + '</b><br/>P25：' + fmt(v[1]) +
              '<br/>最低：' + fmt(v[0]) + '（行/h）';
          }
        },
        legend: {
          top: 0, right: 8, data: ['各人效率分布', '平均值'],
          textStyle: { fontSize: 11, color: '#64748b' }
        },
        grid: { left: 56, right: 24, top: 40, bottom: 26 },
        xAxis: Object.assign({ type: 'category', data: cats }, AXIS),
        yAxis: Object.assign({
          type: 'value', name: '行/h', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, splitLine: SPLIT
        }, { axisLabel: AXIS.axisLabel }),
        series: [
          { name: '各人效率分布', type: 'boxplot', boxWidth: [16, 44], data: boxes },
          {
            name: '平均值', type: 'scatter', symbolSize: 9, data: means,
            itemStyle: { color: '#f97316', borderColor: '#fff', borderWidth: 1.5 }
          }
        ]
      }, true);
    }

    /* 4) 人员工作时间图（由拣货单起止时间反推的在岗时段）
          一行 = 一个「人·日」班次，x 轴为当天时刻，色块 = 该时刻的一段在岗区间（按作业类型着色） */
    var c6 = inst('chartTimeline');
    if (c6 && data.timeline && data.timeline.rows && data.timeline.rows.length) {
      var tlRows = data.timeline.rows;

      // 换数据集后行数据是新数组，旧的高亮下标已失效 -> 清空；同一份数据重渲染（如切换效率口径）则保留
      if (tlSelRows !== tlRows) tlSel = -1;
      tlSelRows = tlRows;
      if (tlSel >= tlRows.length) tlSel = -1;

      // 同一人出现多天时纵轴标签补上日期，避免同名重复难分辨
      var nameCnt = {};
      tlRows.forEach(function (r) { nameCnt[r.person] = (nameCnt[r.person] || 0) + 1; });
      var cats = tlRows.map(function (r) {
        return nameCnt[r.person] > 1 ? r.person + ' ' + r.date.slice(5) : r.person;
      });

      // 高亮行的「人员名」加粗着主色，与网格内的整行底色共同构成整行高亮
      var yDataOf = function (sel) {
        return cats.map(function (c, i) {
          return i === sel ? { value: c, textStyle: { color: '#1d4ed8', fontWeight: 'bold' } } : c;
        });
      };
      var hlDataOf = function (sel) { return sel >= 0 ? [{ value: [sel] }] : []; };

      /* 高亮行底色系列：整行铺一层浅蓝底 + 主色描边，置于色块之下（z:1 < 系列默认 z:2），
         silent 使其不拦截色块的点击与悬浮。
         encode 必须显式声明：纵轴 dataZoom 默认 filterMode:'filter'，会把「无法映射到
         分类轴的数据」从数据模型里过滤掉。custom 系列不声明 encode 时无从得知哪个维度是
         纵轴，这条数据即被过滤为 0 条 -> renderItem 不执行、整行高亮带画不出来（只剩人员名变色）。
         补 encode:{ y: 0 } 声明 value[0] 是纵轴维度后，数据得以保留并正常渲染。 */
      var hlSeries = function (sel) {
        return {
          id: TL_HL_ID, name: TL_HL_ID, type: 'custom', silent: true, z: 1,
          encode: { y: 0 },
          renderItem: timelineHlItem,
          data: hlDataOf(sel)
        };
      };

      // 时间轴范围：首个拣货开始 ~ 末个拣货结束，两侧各留 30 分钟
      var tMin = Infinity, tMax = -Infinity;
      tlRows.forEach(function (r) {
        if (r.first < tMin) tMin = r.first;
        if (r.last > tMax) tMax = r.last;
      });

      // 按作业类型分系列（同色即同类型），段分别落在各自的行上
      var tlNames = [], byType = {};
      tlRows.forEach(function (r, i) {
        r.segs.forEach(function (sg) {
          if (!byType[sg.type]) { byType[sg.type] = []; tlNames.push(sg.type); }
          byType[sg.type].push({
            // [行下标, 段起点, 段终点, 行数, 拣货单, 效率, 人员, 日期]
            value: [i, sg.s, sg.e, sg.rows, sg.orders, sg.eff, r.person, r.date]
          });
        });
      });
      tlNames.sort(function (a, b) {
        var ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
        if (ia < 0) ia = 90;
        if (ib < 0) ib = 90;
        return ia - ib;
      });

      // 行数多于 40 时默认只展示前 40 行（其余靠纵轴缩放查看），否则行高过密无法辨认
      var win = tlRows.length > 40 ? Math.round(40 / tlRows.length * 100) : 100;

      // 最小行高：容器高度按「当前可见班次数 × TL_ROW_MIN_H」撑开（不低于 620px），
      // 这样缩放到最小（显示全部班次）时行高仍有下限，色块与左侧行名一一对应
      var total = tlRows.length;
      var tlEl = document.getElementById('chartTimeline');
      var applyHeight = function (visible) {
        if (!tlEl) return;
        var h = Math.max(620, TL_GRID_TOP + TL_GRID_BOTTOM + Math.ceil(visible) * TL_ROW_MIN_H);
        if (tlEl.style.height !== h + 'px') { tlEl.style.height = h + 'px'; c6.resize(); }
      };
      applyHeight(total * win / 100);

      c6.setOption({
        tooltip: {
          trigger: 'item',
          formatter: function (p) {
            var v = p.value;
            return '<b>' + v[6] + '</b>（' + v[7] + '）<br/>' +
              p.marker + p.seriesName + '　' + minText(v[1]) + ' – ' + minText(v[2]) +
              '（' + (v[2] - v[1]) + ' 分钟）<br/>' +
              '行数：' + v[3] + '　拣货单：' + v[4] +
              (v[5] == null ? '' : '<br/>该段效率：' + fmt(v[5]) + ' 行/h');
          }
        },
        legend: {
          data: tlNames, top: 0, left: 'center',
          itemGap: 14, itemWidth: 14, itemHeight: 8,
          textStyle: { fontSize: 11, color: '#64748b' }
        },
        grid: { left: TL_GRID_LEFT, right: TL_GRID_RIGHT, top: TL_GRID_TOP, bottom: TL_GRID_BOTTOM },
        xAxis: {
          type: 'value',
          min: Math.max(0, Math.floor(tMin / 60) * 60 - 30),
          max: Math.ceil(tMax / 60) * 60 + 30,
          name: '时间', nameLocation: 'end', nameGap: 8,
          nameTextStyle: { color: '#94a3b8', fontSize: 11, align: 'right', verticalAlign: 'top' },
          axisTick: { show: false },
          axisLine: { show: true, lineStyle: { color: '#cbd5e1' } },
          axisLabel: { color: '#64748b', fontSize: 11, margin: 10, hideOverlap: true, formatter: minText },
          splitLine: SPLIT
        },
        yAxis: {
          type: 'category', data: yDataOf(tlSel), inverse: true,
          // 打开轴标签的交互：否则标签默认 silent，点击「人员名」不会有 click 事件
          triggerEvent: true,
          axisTick: { show: false },
          axisLine: { show: true, lineStyle: { color: '#cbd5e1' } },
          // interval: 0 —— 强制显示全部人员名；行高压到最小时 ECharts 默认会抽稀分类轴标签，
          // 这正是「缩放到最小后部分人员名消失」的原因
          axisLabel: {
            interval: 0,
            color: '#64748b', fontSize: 11, margin: 8,
            width: TL_GRID_LEFT - 20, overflow: 'truncate'
          },
          splitLine: { show: false }
        },
        // 纵轴（班次）与横轴（时刻）均可缩放：班次多时逐行看，时段集中时放大看细节
        dataZoom: [
          { type: 'inside', yAxisIndex: 0, start: 0, end: win },
          Object.assign({
            type: 'slider', yAxisIndex: 0, start: 0, end: win,
            right: 6, width: 10, top: TL_GRID_TOP, bottom: TL_GRID_BOTTOM
          }, TL_ZOOM_STYLE),
          { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: false },
          Object.assign({
            type: 'slider', xAxisIndex: 0,
            height: 14, bottom: 12, left: TL_GRID_LEFT, right: TL_GRID_RIGHT
          }, TL_ZOOM_STYLE)
        ],
        series: [hlSeries(tlSel)].concat(tlNames.map(function (name) {
          return {
            name: name, type: 'custom', renderItem: timelineItem,
            encode: { x: [1, 2], y: 0 },
            itemStyle: { color: colorOf(name) },
            data: byType[name]
          };
        }))
      }, true);

      // 纵轴缩放后按可见班次数重算容器高度，保证每行不低于 TL_ROW_MIN_H
      // （横轴缩放只改时间窗口、不改行数，取 yAxisIndex 的那一条即可）
      c6.off('dataZoom');
      c6.on('dataZoom', function () {
        var dzs = c6.getOption().dataZoom || [], dz = null;
        for (var i = 0; i < dzs.length; i++) {
          if (dzs[i].yAxisIndex === 0) { dz = dzs[i]; break; }
        }
        if (dz) applyHeight(total * (dz.end - dz.start) / 100);
      });

      // 点击「色块」或左侧「人员名」-> 高亮所在的整行（同一时刻只保留一行，再次点击该行取消）
      // 两者都由 canvas 绘制，只能走 ECharts 的事件机制，无法用 DOM 监听
      c6.off('click');
      c6.on('click', function (p) {
        var idx = -1;
        if (p.componentType === 'series') {
          // 色块：value[0] 即该段所属的行下标（见上方 byType 的组装），不能用 dataIndex（那是系列内序号）
          if (p.value && typeof p.value[0] === 'number') idx = p.value[0];
        } else if (p.componentType === 'yAxis' && p.targetType === 'axisLabel') {
          idx = p.dataIndex;
        }
        if (idx < 0 || idx >= total) return;
        tlSel = (tlSel === idx) ? -1 : idx;
        // 增量更新（不整图重绘）：按 id 合并高亮系列，同时刷新该行的人员名样式
        c6.setOption({
          yAxis: { data: yDataOf(tlSel) },
          series: [hlSeries(tlSel)]
        });
      });
    }

    /* 5) 超时数统计（按「超时判责」细分的堆积柱状图）
          仅当上传文件含「是否拣货超时」列时展示（服务端算好 data.timeout，否则为 null -> 隐藏整张卡片） */
    var toCard = document.getElementById('timeoutCard');
    if (toCard) toCard.classList.toggle('hidden', !data.timeout);
    if (data.timeout) {
      var to = data.timeout;
      var dutyColor = {};
      (to.duties || []).forEach(function (d, i) { dutyColor[d.name] = DUTY_COLORS[i % DUTY_COLORS.length]; });

      var c7 = inst('chartTimeout');
      if (c7) {
        c7.setOption({
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: stackTip },
          legend: {
            data: (to.duties || []).map(function (d) { return d.name; }),
            top: 0, left: 'center', itemGap: 14, itemWidth: 14, itemHeight: 8,
            textStyle: { fontSize: 11, color: '#64748b' }
          },
          grid: { left: 56, right: 24, top: 40, bottom: 26 },
          xAxis: Object.assign({
            type: 'category', data: (to.hours || []).map(function (h) { return h + '点'; })
          }, AXIS),
          yAxis: Object.assign({
            type: 'value', name: '超时单数', minInterval: 1, splitLine: SPLIT
          }, { axisLabel: AXIS.axisLabel }),
          series: (to.series || []).map(function (s) {
            return {
              name: s.name, type: 'bar', stack: 'timeout', barMaxWidth: 30,
              itemStyle: { color: dutyColor[s.name] },
              label: {
                show: true, fontSize: 10, color: '#475569',
                formatter: function (p) { return p.value ? p.value : ''; }
              },
              data: s.data
            };
          })
        }, true);
      }

      /* 5b) 超时数统计 · 按小时 × 作业类型（前场 / 后场 / 一体化 / 未匹配分区）
             与上图同源同刻度，只是换一个切分口径（判责 -> 前后场） */
      var c7b = inst('chartTimeoutType');
      if (c7b && (to.typeSeries || []).length) {
        c7b.setOption({
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: stackTip },
          legend: {
            data: to.typeSeries.map(function (s) { return s.name; }),
            top: 0, left: 'center', itemGap: 14, itemWidth: 14, itemHeight: 8,
            textStyle: { fontSize: 11, color: '#64748b' }
          },
          grid: { left: 56, right: 24, top: 40, bottom: 26 },
          xAxis: Object.assign({
            type: 'category', data: (to.hours || []).map(function (h) { return h + '点'; })
          }, AXIS),
          yAxis: Object.assign({
            type: 'value', name: '超时单数', minInterval: 1, splitLine: SPLIT
          }, { axisLabel: AXIS.axisLabel }),
          series: typeStackSeries(to.typeSeries, 'timeoutType', 30)
        }, true);
      }

      var toStatEl = document.getElementById('timeoutStat');
      if (toStatEl) {
        var toTotal = to.total || 0;
        var recN = (data.meta && data.meta.recordCount) || 0;
        var peakH = null, peakN = 0;
        (to.hourly || []).forEach(function (v, i) {
          if (v > peakN) { peakN = v; peakH = (to.hours || [])[i]; }
        });
        var chipOf = function (k, v, unit) {
          return '<div class="stat-chip"><div class="k">' + k + '</div><div class="v">' + v +
            (unit ? '<small>' + unit + '</small>' : '') + '</div></div>';
        };
        toStatEl.innerHTML = [
          chipOf('超时单数', toTotal.toLocaleString(), '单'),
          chipOf('超时单占比', fmt(recN ? toTotal / recN * 100 : 0), '%'),
          chipOf('超时最多时段', peakN ? peakH + '点' : '-', peakN ? peakN + ' 单' : '')
        ].concat((to.duties || []).map(function (d) {
          return chipOf(d.name, d.count.toLocaleString(), '单');
        })).join('');
      }

      var toNoteEl = document.getElementById('timeoutNote');
      if (toNoteEl) toNoteEl.textContent =
        '超时判定：「是否拣货超时」列为「是」的明细计入（其余取值与空值都不算）；' +
        '判责直接读取该明细的「超时判责」列，未填写的单独归为一组；' +
        '作业类型与「人员 × 小时 效率透视」同一口径：拣货单类型为「一体化」的归入一体化，' +
        '其余按「拣货分区」的前后场映射归入前场 / 后场，未命中的归「未匹配分区」；' +
        '上传文件缺少「是否拣货超时」列时不展示本卡片。';

      /* 6) 超时数统计 · 按人员（只列有超时单的人员；判责 / 作业类型两张图共用同一坐标与提示）
            位于默认折叠的区块内，展开时由 app.js 调用 HEMA.charts.resize() 重新测量尺寸 */
      var tpRows = to.byPerson || [];
      // field: 该人的分组计数挂在哪个字段（duties / types）；colorOfName: 分组名 -> 颜色
      var personOption = function (groups, field, colorOfName, stackName) {
        return {
          tooltip: {
            trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: function (ps) {
              var r = tpRows[ps[0].dataIndex];
              var sum = 0, lines = [];
              ps.forEach(function (p) {
                if (!p.value) return;
                sum += p.value;
                lines.push(p.marker + p.seriesName + '：<b>' + p.value + '</b> 单');
              });
              if (!sum) return '<b>' + r.person + '</b><br/>无超时单';
              return '<b>' + r.person + '</b>（明细 ' + r.all + ' 条）<br/>' + lines.join('<br/>') +
                '<br/>超时：<b>' + sum + '</b> 单（超时率 ' + fmt(r.rate * 100) + '%）';
            }
          },
          legend: {
            data: groups.map(function (g) { return g.name; }),
            top: 0, left: 'center', itemGap: 14, itemWidth: 14, itemHeight: 8,
            textStyle: { fontSize: 11, color: '#64748b' }
          },
          grid: { left: 56, right: 24, top: 40, bottom: 76 },
          xAxis: Object.assign({
            type: 'category', data: tpRows.map(function (r) { return r.person; }),
            // 人员多时标签旋转并抽稀，避免文字互相压叠
            axisLabel: { color: '#64748b', fontSize: 11, rotate: 45, hideOverlap: true }
          }, AXIS),
          yAxis: Object.assign({
            type: 'value', name: '超时单数', minInterval: 1, splitLine: SPLIT
          }, { axisLabel: AXIS.axisLabel }),
          series: groups.map(function (g) {
            return {
              name: g.name, type: 'bar', stack: stackName, barMaxWidth: 26,
              itemStyle: { color: colorOfName(g.name) },
              data: tpRows.map(function (r) { return (r[field] && r[field][g.name]) || 0; })
            };
          })
        };
      };

      var c8 = inst('chartTimeoutPerson');
      if (c8 && tpRows.length) {
        c8.setOption(personOption(to.duties || [], 'duties',
          function (n) { return dutyColor[n]; }, 'timeoutPerson'), true);
      }

      /* 6b) 超时数统计 · 按人员 × 作业类型（前场 / 后场 / 一体化 / 未匹配分区） */
      var c8b = inst('chartTimeoutPersonType');
      if (c8b && tpRows.length && (to.types || []).length) {
        c8b.setOption(personOption(to.types, 'types', colorOf, 'timeoutPersonType'), true);
      }

      /* 6c) 超时数统计 · 按分区（堆叠柱：x=小时，系列=分区，每分区独立颜色） */
      var c8c = inst('chartTimeoutZone');
      if (c8c && (to.zoneSeries || []).length) {
        var zoneColorMap = {};
        (to.zones || []).forEach(function (z, i) { zoneColorMap[z.name] = ZONE_PALETTE[i % ZONE_PALETTE.length]; });
        c8c.setOption({
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: stackTip },
          legend: {
            data: to.zoneSeries.map(function (s) { return s.name; }),
            top: 0, left: 'center', itemGap: 14, itemWidth: 14, itemHeight: 8,
            textStyle: { fontSize: 11, color: '#64748b' }
          },
          grid: { left: 56, right: 24, top: 40, bottom: 26 },
          xAxis: Object.assign({
            type: 'category', data: (to.hours || []).map(function (h) { return h + '点'; })
          }, AXIS),
          yAxis: Object.assign({
            type: 'value', name: '超时单数', minInterval: 1, splitLine: SPLIT
          }, { axisLabel: AXIS.axisLabel }),
          series: to.zoneSeries.map(function (s, i) {
            return {
              name: s.name, type: 'bar', stack: 'timeoutZone', barMaxWidth: 30,
              itemStyle: { color: zoneColorMap[s.name] || ZONE_PALETTE[i % ZONE_PALETTE.length] },
              label: {
                show: true, fontSize: 10, color: '#475569',
                formatter: function (p) { return p.value ? p.value : ''; }
              },
              data: s.data
            };
          })
        }, true);
      }
    }

    /* 8) 分区 × 小时效率热力图 */
    var c10 = inst('chartZoneHeat');
    if (c10 && data.zoneByHour) {
      var zh = data.zoneByHour;
      var zhHours = (zh.hours || []).map(function (h) { return h + '点'; });
      // y 轴：分区名列表（倒序，使第一个分区显示在最下方）
      var zhSeries = zh.series || [];
      var zhNames = zhSeries.map(function (s) { return s.name; }).reverse();
      var zhTotal = zhNames.length;
      // 收集所有非 null 值以计算 min/max
      var zhVals = [];
      zhSeries.forEach(function (s) { (s.data || []).forEach(function (v) { if (v != null) zhVals.push(v); }); });
      var zhMin = zhVals.length ? Math.min.apply(null, zhVals) : 0;
      var zhMax = zhVals.length ? Math.max.apply(null, zhVals) : 100;
      // 构造热力图数据 [xIndex, yIndex, value]（y 倒序映射）
      var heatData = [];
      zhSeries.forEach(function (s, yi) {
        (s.data || []).forEach(function (v, xi) {
          if (v != null) heatData.push([xi, zhTotal - 1 - yi, round2(v)]);
        });
      });

      c10.setOption({
        tooltip: {
          formatter: function (p) {
            return '<b>' + zhNames[p.value[1]] + '</b> · ' + zhHours[p.value[0]] +
              '<br/>效率：<b>' + fmt(p.value[2]) + '</b> 行/h';
          }
        },
        grid: { left: 140, right: 80, top: 10, bottom: 46 },
        xAxis: Object.assign({
          type: 'category', data: zhHours, splitArea: { show: true }
        }, AXIS),
        yAxis: Object.assign({
          type: 'category', data: zhNames,
          axisLabel: { color: '#475569', fontSize: 11, width: 120, overflow: 'truncate' }
        }, {}),
        visualMap: {
          min: zhMin, max: zhMax, calculable: true,
          orient: 'vertical', right: 6, top: 'center',
          inRange: { color: ['#fee2e2', '#fef3c7', '#fef9c3', '#d9f99d', '#a7f3d0', '#6ee7b7', '#34d399'] },
          textStyle: { color: '#64748b', fontSize: 11 }
        },
        series: [{
          type: 'heatmap', data: heatData,
          label: { show: true, fontSize: 10, color: '#334155', formatter: function (p) { return fmt(p.value[2], 0); } },
          emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(37,99,235,.35)' } }
        }]
      }, true);

      var zhNote = document.getElementById('zoneHeatNote');
      if (zhNote) zhNote.textContent =
        '颜色越深（绿）效率越高，越浅（红）效率越低；空白表示该分区在该时段无拣货记录。' +
        '分区名格式为「作业类型 · 分区代码」。悬停查看具体数值。';
    }
  };

  /* 重新测量所有图表尺寸：折叠区块内的图表在隐藏状态下初始化只能拿到 0 尺寸，
     展开后必须调用一次，否则画布宽高仍为 0、图表不可见 */
  HEMA.charts.resize = function () {
    Object.keys(instances).forEach(function (k) {
      if (instances[k] && !instances[k].isDisposed()) instances[k].resize();
    });
  };

  /* 切换效率口径：true = 按工时加权，false = 人均（由顶栏统一开关调用） */
  HEMA.charts.setWeighted = function (v) {
    weighted = !!v;
    if (cache) HEMA.charts.render(cache);
  };

  window.addEventListener('resize', HEMA.charts.resize);
})(window);
