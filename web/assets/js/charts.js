/* 视图层-图表：ECharts 封装 */
(function (global) {
  var CFG = global.HEMA_CONFIG;
  var HEMA = global.HEMA = global.HEMA || {};
  HEMA.charts = {};

  var instances = {};
  var cache = null;

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

  HEMA.charts.render = function (data) {
    cache = data;
    if (typeof echarts === 'undefined') return;

    /* 1) 各小时效率趋势 */
    var c1 = inst('chartHour');
    if (c1) c1.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          var d = cache.byHour[ps[0].dataIndex];
          return d.hour + '点<br/>效率：<b>' + fmt(d.eff) + '</b> 行/h<br/>行数：' + d.rows + '<br/>时长：' + d.hours + ' h';
        }
      },
      legend: {
        data: ['效率(行/h)', '拣货行数'], top: 0, left: 'center',
        itemGap: 14, itemWidth: 14, itemHeight: 8,
        textStyle: { fontSize: 11, color: '#64748b' }
      },
      grid: { left: 56, right: 56, top: 34, bottom: 26 },
      xAxis: Object.assign({ type: 'category', data: data.byHour.map(function (d) { return d.hour + '点'; }) }, AXIS),
      yAxis: [
        { type: 'value', name: '行/h', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, axisLabel: AXIS.axisLabel, splitLine: SPLIT },
        { type: 'value', name: '行数', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, axisLabel: AXIS.axisLabel, splitLine: { show: false } }
      ],
      series: [
        {
          name: '效率(行/h)', type: 'line', smooth: true, symbolSize: 6,
          data: data.byHour.map(function (d) { return d.eff; }),
          itemStyle: { color: '#2563eb' }, lineStyle: { width: 2.5 },
          areaStyle: { color: 'rgba(37,99,235,.10)' }
        },
        {
          name: '拣货行数', type: 'bar', yAxisIndex: 1, barWidth: 14,
          data: data.byHour.map(function (d) { return d.rows; }),
          itemStyle: { color: 'rgba(148,163,184,.45)', borderRadius: [4, 4, 0, 0] }
        }
      ]
    }, true);

    /* 3) 人员效率排行 Top15 */
    var c3 = inst('chartPerson');
    if (c3) {
      var top = data.byPerson.slice(0, 15).slice().reverse();
      c3.setOption({
        tooltip: {
          trigger: 'item',
          formatter: function (p) {
            var d = top[p.dataIndex];
            return d.name + '<br/>效率：<b>' + fmt(d.eff) + '</b> 行/h<br/>行数：' + d.rows + '<br/>时长：' + d.hours + ' h';
          }
        },
        grid: { left: 78, right: 56, top: 16, bottom: 26 },
        xAxis: Object.assign({ type: 'value', splitLine: SPLIT }, { axisLabel: AXIS.axisLabel }),
        yAxis: Object.assign({ type: 'category', data: top.map(function (d) { return d.name; }) }, { axisLabel: { color: '#475569', fontSize: 11 }, axisLine: AXIS.axisLine, axisTick: { show: false } }),
        series: [{
          type: 'bar', barWidth: 13,
          data: top.map(function (d) { return d.eff; }),
          itemStyle: { color: '#14b8a6', borderRadius: [0, 6, 6, 0] },
          label: { show: true, position: 'right', formatter: function (p) { return fmt(p.value); }, color: '#475569', fontSize: 11 },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { type: 'dashed', color: '#94a3b8' },
            label: { formatter: '整体 ' + fmt(data.totals.eff), color: '#64748b', fontSize: 11, position: 'insideEndTop' },
            data: [{ xAxis: data.totals.eff }]
          }
        }]
      }, true);
    }

    /* 4) 作业类型 × 小时 */
    var c4 = inst('chartJtHour');
    if (c4) {
      var series = data.jobTypeByHour.series.map(function (s) {
        return {
          name: s.name, type: 'line', smooth: true, connectNulls: true, symbolSize: 5,
          data: s.data, itemStyle: { color: colorOf(s.name) }, lineStyle: { width: 2.5 }
        };
      });
      series.push({
        name: '整体', type: 'line', smooth: true, connectNulls: true, symbol: 'none',
        data: data.jobTypeByHour.total,
        itemStyle: { color: '#94a3b8' }, lineStyle: { width: 1.6, type: 'dashed' }
      });
      c4.setOption({
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return fmt(v) + ' 行/h'; } },
        legend: { top: 0, right: 8, textStyle: { fontSize: 11, color: '#64748b' } },
        grid: { left: 56, right: 24, top: 40, bottom: 30 },
        xAxis: Object.assign({ type: 'category', boundaryGap: false, data: data.jobTypeByHour.hours.map(function (h) { return h + '点'; }) }, AXIS),
        yAxis: Object.assign({ type: 'value', name: '行/h', nameTextStyle: { color: '#94a3b8', fontSize: 11 }, splitLine: SPLIT }, { axisLabel: AXIS.axisLabel }),
        series: series
      }, true);
    }
  };

  window.addEventListener('resize', function () {
    Object.keys(instances).forEach(function (k) {
      if (instances[k] && !instances[k].isDisposed()) instances[k].resize();
    });
  });
})(window);
