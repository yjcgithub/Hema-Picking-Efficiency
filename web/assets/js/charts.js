/* 视图层-图表：ECharts 封装 */
(function (global) {
  var CFG = global.HEMA_CONFIG;
  var HEMA = global.HEMA = global.HEMA || {};
  HEMA.charts = {};

  var instances = {};
  var cache = null;
  var weighted = false;   // 效率口径：false = 人均（默认），true = 按工时加权

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
  /* 半小时刻度取值（7 / 7.5 / 8 …）-> 轴与提示文案（7:00 / 7:30 / 8:00） */
  function slotText(v) {
    var h = Math.floor(v), m = Math.round((v - h) * 60);
    return h + ':' + (m < 10 ? '0' + m : String(m));
  }

  var AXIS = { axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: '#64748b', fontSize: 11 } };
  var SPLIT = { lineStyle: { color: '#f1f5f9' } };

  function avgLine(v) {
    return {
      silent: true, symbol: 'none',
      lineStyle: { type: 'dashed', color: '#94a3b8' },
      label: { formatter: '整体 ' + fmt(v), color: '#64748b', fontSize: 11, position: 'insideEndTop' },
      data: [{ yAxis: v }]
    };
  }

  /* 不加权口径：某类型某时段内，各人效率的算术平均（忽略该时段内无记录的人）
     groups 的分块人员 data 与坐标轴逐项对齐，n = 坐标轴长度
     返回 { 作业类型名: [各时段人均效率], '整体': [...] }；无分块人员数据时返回 null */
  function unweightedFromGroups(groups, n) {
    if (!groups || !groups.length || !n) return null;
    var zeros = function () { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; };
    var out = {}, allSum = zeros(), allCnt = zeros();

    groups.forEach(function (g) {
      var acc = zeros(), cnt = zeros();
      (g.persons || []).forEach(function (p) {
        (p.data || []).forEach(function (v, i) {
          if (v == null || i >= n) return;
          acc[i] += v; cnt[i] += 1;
          allSum[i] += v; allCnt[i] += 1;
        });
      });
      out[g.type] = acc.map(function (s, i) {
        return cnt[i] ? Math.round(s / cnt[i] * 100) / 100 : null;
      });
    });

    out['整体'] = allSum.map(function (s, i) {
      return allCnt[i] ? Math.round(s / allCnt[i] * 100) / 100 : null;
    });
    return out;
  }

  HEMA.charts.render = function (data) {
    cache = data;
    if (typeof echarts === 'undefined') return;

    /* 1) 各小时效率趋势（半小时刻度；旧数据无半小时时退回整点小时） */
    var rows = (data.bySlot && data.bySlot.length) ? data.bySlot : null;
    var isSlot = !!rows;
    var hRows = rows || data.byHour;
    var hText = hRows.map(function (d) { return isSlot ? slotText(d.slot) : d.hour + '点'; });
    var c1 = inst('chartHour');
    if (c1) c1.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          var i = ps[0].dataIndex, d = hRows[i];
          return hText[i] + '<br/>效率：<b>' + fmt(d.eff) + '</b> 行/h<br/>行数：' + d.rows + '<br/>时长：' + d.hours + ' h';
        }
      },
      legend: {
        data: ['效率(行/h)', '拣货行数'], top: 0, left: 'center',
        itemGap: 14, itemWidth: 14, itemHeight: 8,
        textStyle: { fontSize: 11, color: '#64748b' }
      },
      grid: { left: 56, right: 56, top: 34, bottom: 26 },
      xAxis: Object.assign({ type: 'category', data: hText }, AXIS),
      yAxis: [
        { type: 'value', name: '行/h', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, axisLabel: AXIS.axisLabel, splitLine: SPLIT },
        { type: 'value', name: '行数', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, axisLabel: AXIS.axisLabel, splitLine: { show: false } }
      ],
      series: [
        {
          name: '效率(行/h)', type: 'line', smooth: true, symbolSize: 6,
          data: hRows.map(function (d) { return d.eff; }),
          itemStyle: { color: '#2563eb' }, lineStyle: { width: 2.5 },
          areaStyle: { color: 'rgba(37,99,235,.10)' }
        },
        {
          name: '拣货行数', type: 'bar', yAxisIndex: 1, barWidth: 14,
          data: hRows.map(function (d) { return d.rows; }),
          itemStyle: { color: 'rgba(148,163,184,.45)', borderRadius: [4, 4, 0, 0] }
        }
      ]
    }, true);

    /* 2) 作业类型 × 小时 效率（半小时刻度，半小时顶点不显示数值）
          默认人均（各人效率算术平均），可勾选切为按工时加权；tooltip 附带另一种口径对照 */
    var c4 = inst('chartJtHour');
    if (c4) {
      var jb = (data.jobTypeBySlot && data.jobTypeBySlot.slots && data.jobTypeBySlot.slots.length)
        ? data.jobTypeBySlot : data.jobTypeByHour;
      var jSlot = !!jb.slots;
      var xs = jb.slots || jb.hours;                        // 坐标轴取值（半小时为 7 / 7.5 / 8 …）
      var xName = function (i) { return jSlot ? slotText(xs[i]) : xs[i] + '点'; };
      // 分块人员数据：优先用与当前刻度对齐的 jobTypeBySlot.groups；
      // 旧数据集无该字段时退回 personByHour.groups（其人员 data 与整点小时轴逐项对齐）
      var groups = jb.groups || (data.personByHour && data.personByHour.groups);
      var uw = unweightedFromGroups(groups, xs.length);     // 无分块人员数据时为 null
      var wt = {};                                          // 加权值：Σ行数 ÷ Σ时长
      jb.series.forEach(function (s) { wt[s.name] = s.data; });
      wt['整体'] = jb.total;

      var useW = weighted || !uw;                 // 无不加权数据时只能按加权展示
      var pick = function (name, fallback) {
        return useW ? fallback : ((uw && uw[name]) || fallback);
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
      c4.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: function (ps) {
            var i = ps[0].dataIndex;
            var lines = [xName(i) + '（' + (useW ? '加权' : '人均') + '）'];
            ps.forEach(function (p) {
              var o = useW ? (uw && uw[p.seriesName] ? uw[p.seriesName][i] : null)
                           : (wt[p.seriesName] ? wt[p.seriesName][i] : null);
              lines.push(p.marker + p.seriesName + '：<b>' + fmt(p.value) + '</b> 行/h' +
                (o == null ? '' : '（' + (useW ? '人均 ' : '加权 ') + fmt(o) + '）'));
            });
            return lines.join('<br/>');
          }
        },
        legend: { top: 0, right: 8, textStyle: { fontSize: 11, color: '#64748b' } },
        grid: { left: 56, right: 24, top: 46, bottom: 30 },
        xAxis: Object.assign({ type: 'category', boundaryGap: false, data: xs.map(function (_, i) { return xName(i); }) }, AXIS),
        yAxis: Object.assign({
          type: 'value', name: useW ? '行/h' : '行/h（人均）', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, splitLine: SPLIT,
          max: function (v) { return Math.ceil(v.max * 1.12); }   // 留出空间给峰值数值
        }, { axisLabel: AXIS.axisLabel }),
        series: series
      }, true);
    }
  };

  /* 切换效率口径：true = 按工时加权，false = 人均（由顶栏统一开关调用） */
  HEMA.charts.setWeighted = function (v) {
    weighted = !!v;
    if (cache) HEMA.charts.render(cache);
  };

  window.addEventListener('resize', function () {
    Object.keys(instances).forEach(function (k) {
      if (instances[k] && !instances[k].isDisposed()) instances[k].resize();
    });
  });
})(window);
