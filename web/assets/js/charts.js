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
  function round2(v) { return Math.round(v * 100) / 100; }
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

    /* 1) 各小时效率趋势（半小时刻度；旧数据无半小时时退回整点小时）
          效率线随顶栏口径开关切换：人均（各人效率算术平均）/ 按工时加权；tooltip 附带另一种口径对照 */
    var rows = (data.bySlot && data.bySlot.length) ? data.bySlot : null;
    var isSlot = !!rows;
    var hRows = rows || data.byHour;
    var hText = hRows.map(function (d) { return isSlot ? slotText(d.slot) : d.hour + '点'; });
    // 人均口径序列与刻度对齐：半小时取 jobTypeBySlot.unweighted，整点取 jobTypeByHour.unweighted
    var hUw = isSlot
      ? (data.jobTypeBySlot && data.jobTypeBySlot.unweighted)
      : (data.jobTypeByHour && data.jobTypeByHour.unweighted);
    var hAvg = uwOf(hUw, '整体');
    var hUseW = weighted || !hAvg;                           // 无人员分块时只能画加权
    var hEff = hUseW ? hRows.map(function (d) { return d.eff; }) : hAvg;
    var c1 = inst('chartHour');
    if (c1) c1.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          var i = ps[0].dataIndex, d = hRows[i];
          var other = hUseW ? (hAvg ? hAvg[i] : null) : d.eff;
          return hText[i] + '（' + (hUseW ? '加权' : '人均') + '）' +
            '<br/>效率：<b>' + fmt(hEff[i]) + '</b> 行/h' +
            (other == null ? '' : '（' + (hUseW ? '人均 ' : '加权 ') + fmt(other) + '）') +
            '<br/>行数：' + d.rows + '<br/>时长：' + d.hours + ' h';
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
        { type: 'value', name: hUseW ? '行/h' : '行/h（人均）', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, axisLabel: AXIS.axisLabel, splitLine: SPLIT },
        { type: 'value', name: '行数', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, axisLabel: AXIS.axisLabel, splitLine: { show: false } }
      ],
      series: [
        {
          name: '效率(行/h)', type: 'line', smooth: true, symbolSize: 6,
          data: hEff,
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
      c4.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: function (ps) {
            var i = ps[0].dataIndex;
            var lines = [xName(i) + '（' + (useW ? '加权' : '人均') + '）'];
            ps.forEach(function (p) {
              var uwArr = uwOf(uw, p.seriesName);
              var o = useW ? (uwArr ? uwArr[i] : null)
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
