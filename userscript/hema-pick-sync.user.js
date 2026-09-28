// ==UserScript==
// @name         拣货效率 · 实时同步（UMS → Hema-Picking-Efficiency）
// @namespace    hema-picking-efficiency
// @version      1.1.1
// @description  UMS 登录态是 HttpOnly Cookie，脚本读不到；因此改为在本页面内用当前登录态「同源」请求拣货单接口，把逐页结果回传后端入库 —— 后端不再需要 Cookie，也不用再手动粘贴
// @author       hema-picking-efficiency
// @match        https://ums.hemaos.com/*
// @match        https://portalpro.hemaos.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
  用法
  1. 用 Tampermonkey 安装本脚本（ums.hemaos.com 页面右上角会出现「拣货效率同步」面板）
  2. 后端地址填你的服务地址：本机调试默认 http://localhost:3001/hpe（没有子路径就是 http://localhost:3001）
  3. 勾选「自动同步」并设置间隔（默认 5 分钟），或点「立即同步」手动同步一次
  4. 保持这个标签页开着即可；登录态过期时重新登录一次就行

  面板
  · 标题栏「−/＋」折叠整个面板（折叠状态会记住）；折叠后标题栏仍显示最近一次的同步结果
  · 「调试日志」：每一步请求的完整 URL、HTTP 状态、返回片段都在这里，排查 404 / 登录失效最直接
    里面可以改「接口域名」（默认 https://ums.hemaos.com）与「接口路径」—— 页面域和接口域不是同一个
    （例如页面在 portalpro.hemaos.com、接口在 ums.hemaos.com）时，靠这里对齐
  · 「捕获的 Cookie」：用 GM_cookie 读出接口域（含 HttpOnly 的登录态）拼成 Cookie 串，
    可直接复制粘贴到后端「实时获取 → 接口 Cookie → 设置」里，作为不走脚本时的备用方案

  跨域
  · 先按普通 fetch 请求接口（浏览器自动带该域 Cookie）；被 CORS 拦住时自动改用 GM_xmlhttpRequest
    重试（走扩展网络层，不受 CORS 限制，同样自动带目标域 Cookie），调试日志里会写明用的哪种方式

  说明
  · 每页条数取后端「实时获取」弹窗里的「每页条数」设置（默认 100）
  · 「增量」勾选时从最新页往回取，遇到「整页拣货单号都已入库」即停；不勾选则整段区间全量重取
  · 整段抓取完整时，后端会把该日期范围内的旧明细整条替换（含手动上传的数据），避免同一单重复计数
*/
(function () {
  'use strict';

  /* ---------- 常量与配置 ---------- */
  var UMS_PATH = '/out/PickOrderManager/listPickOrderForB2C.json';
  var MAX_PAGES = 400;          // 分页保护上限，与后端一致
  var MAX_LOG = 300;            // 调试日志最多保留多少条

  var cfg = {
    base: GM_getValue('base', 'https://xl.yjmc.xyz/hpe'),
    enabled: GM_getValue('enabled', true),
    intervalMin: GM_getValue('intervalMin', 5),
    range: GM_getValue('range', 'today'),      // today | y2 | d3 | d7
    incremental: GM_getValue('incremental', true),
    apiOrigin: GM_getValue('apiOrigin', 'https://ums.hemaos.com'),  // 接口所在域（可能与页面域不同）
    path: GM_getValue('path', UMS_PATH),       // 接口路径，可改（排查 404 用）
    collapsed: GM_getValue('collapsed', false) // 整个面板折叠状态
  };
  var last = GM_getValue('last', null);        // { at, ok, msg, added, replaced, records, pages, range }
  var running = false;
  var stateText = '尚未同步';
  var stateCls = '';

  function saveCfg() {
    GM_setValue('base', cfg.base);
    GM_setValue('enabled', !!cfg.enabled);
    GM_setValue('intervalMin', cfg.intervalMin);
    GM_setValue('range', cfg.range);
    GM_setValue('incremental', !!cfg.incremental);
    GM_setValue('apiOrigin', cfg.apiOrigin);
    GM_setValue('path', cfg.path);
    GM_setValue('collapsed', !!cfg.collapsed);
  }

  function api(path) {
    return String(cfg.base || '').replace(/\/+$/, '') + path;
  }
  // 接口域：允许留空（留空则回退到页面所在域）
  function apiOrigin() {
    var o = String(cfg.apiOrigin || '').trim();
    if (!o) return location.origin;
    if (!/^https?:\/\//i.test(o)) o = 'https://' + o;
    return o.replace(/\/+$/, '');
  }
  function umsPath() {
    var p = String(cfg.path || UMS_PATH).trim() || UMS_PATH;
    return p.charAt(0) === '/' ? p : '/' + p;
  }

  /* ---------- 小工具 ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtTime(t) {
    var d = new Date(t);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function hm(t) {
    var d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function rangeOf() {
    var end = new Date(), start = new Date();
    if (cfg.range === 'y2') start.setDate(start.getDate() - 1);
    else if (cfg.range === 'd3') start.setDate(start.getDate() - 2);
    else if (cfg.range === 'd7') start.setDate(start.getDate() - 6);
    return { start: fmtDate(start), end: fmtDate(end) };
  }

  /* ---------- 请求 ---------- */
  // 请求后端：走 GM_xmlhttpRequest，不受页面跨域限制
  function http(method, url, body) {
    dbg('→ 后端 ' + method + ' ' + url);
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        timeout: 180000,
        onload: function (res) {
          dbg('← 后端 ' + res.status + '（' + method + ' ' + url.replace(/^.*\/api/, '/api') + '）',
            res.status >= 400 ? 'err' : 'ok');
          var j = null;
          try { j = JSON.parse(res.responseText); }
          catch (e) {
            return reject(new Error('后端未返回 JSON（HTTP ' + res.status + '）：' +
              oneLine(res.responseText).slice(0, 120)));
          }
          if (res.status >= 400) return reject(new Error(j.error || ('HTTP ' + res.status)));
          resolve(j);
        },
        ontimeout: function () {
          dbg('后端请求超时：' + url, 'err');
          reject(new Error('请求后端超时'));
        },
        onerror: function () {
          dbg('无法连接后端：' + url, 'err');
          reject(new Error('无法连接后端（检查地址、服务是否已启动）'));
        }
      });
    });
  }

  // 拣货单接口请求：先按普通 fetch（浏览器自动带该域 Cookie）；
  // 页面域与接口域不同（如 portalpro.hemaos.com → ums.hemaos.com）且接口没开放 CORS 时，
  // fetch 会直接抛网络错误，这里自动改走 GM_xmlhttpRequest（扩展网络层：不受 CORS 限制，同样自动带目标域 Cookie）
  function umsRequest(url) {
    return fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' }
    }).then(function (res) {
      return res.text().then(function (t) { return { status: res.status, text: t, via: 'fetch' }; });
    }, function (e) {
      dbg('fetch 被拦截（多为跨域 CORS）：' + ((e && e.message) || e) + ' → 改用 GM_xmlhttpRequest', 'warn');
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          headers: { Accept: 'application/json, text/plain, */*' },
          timeout: 60000,
          onload: function (r) { resolve({ status: r.status, text: r.responseText || '', via: 'GM' }); },
          ontimeout: function () { reject(new Error('接口请求超时：' + url)); },
          onerror: function () { reject(new Error('接口请求失败（网络不可达）：' + url)); }
        });
      });
    });
  }

  // 拣货单接口：按「接口域名 + 接口路径」拼 URL（同源则浏览器自动带上当前登录态 Cookie）
  function fetchPage(index, start, end, num) {
    var q = '?pickOperateType=3&pickOrderCode=&externalBatchCode=&subTaskType=&deliveryCodes=' +
      '&index=' + index + '&num=' + num +
      '&startDate=' + encodeURIComponent(start) + '&endDate=' + encodeURIComponent(end);
    var url = apiOrigin() + umsPath() + q;
    dbg('→ 接口 GET ' + url);
    return umsRequest(url).then(function (r) {
      if (r.status !== 200) {
        var extra = oneLine(r.text).slice(0, 140);
        dbg('← 接口 ' + r.status + '（via ' + r.via + '）' + (extra ? ' body: ' + extra : ''), 'err');
        throw new Error('接口返回 HTTP ' + r.status + '（via ' + r.via + '）：' + url +
          (r.status === 404 ? '　提示：接口域名/路径不对，可在「调试日志」里改' : '') +
          (extra ? '，返回片段：' + extra : ''));
      }
      var j, text = r.text;
      try { j = JSON.parse(text); }
      catch (e) {
        dbg('← 接口 200 但不是 JSON（登录态可能已失效）：' + oneLine(text).slice(0, 120), 'err');
        throw new Error('接口未返回 JSON（登录态可能已失效）：' + oneLine(text).slice(0, 100));
      }
      if (j.code !== 200 || !j.info) {
        dbg('← 接口 200 但 code=' + j.code + '：' + oneLine(JSON.stringify(j)).slice(0, 120), 'err');
        throw new Error('接口返回异常：' + oneLine(JSON.stringify(j)).slice(0, 150));
      }
      dbg('← 接口 200（via ' + r.via + '）index=' + index + ' 本页 ' + ((j.info.list || []).length) +
        ' 条 / 共 ' + (j.info.totalNum || 0) + ' 条', 'ok');
      return j;
    });
  }

  /* ---------- 同步主流程 ---------- */
  function sync() {
    if (running) return Promise.resolve();
    running = true;
    var rg = rangeOf(), pages = [], got = 0, total = 0, reached = false, complete = false, num = 100;
    setState('同步中…', 'run');
    dbg('— 开始同步 ' + rg.start + ' ~ ' + rg.end + (cfg.incremental ? '（增量）' : '（全量）') + ' —', 'run');

    return http('GET', api('/api/ums/config'))
      .then(function (j) { if (j && j.num) num = j.num; }, function (e) {
        dbg('读取后端配置失败，用默认每页 ' + num + ' 条：' + ((e && e.message) || e), 'warn');
      })
      .then(function () {
        function step(index) {
          return fetchPage(index, rg.start, rg.end, num).then(function (j) {
            var list = (j.info && j.info.list) || [];
            pages.push(j);
            got += list.length;
            total = Number(j.info && j.info.totalNum) || got;
            setState('同步中… 第 ' + (index + 1) + '/' + Math.max(1, Math.ceil(total / num)) +
              ' 页，已取 ' + got + '/' + total, 'run');
            if (!list.length || got >= total) { complete = true; return null; }
            if (pages.length >= MAX_PAGES) return null;
            if (!cfg.incremental) return step(index + 1);
            return http('POST', api('/api/ums/known'), {
              codes: list.map(function (x) { return String(x.code); })
            }).then(function (k) {
              if (k && k.known >= list.length) { reached = true; return null; }  // 整页都已入库：追平
              return step(index + 1);
            });
          });
        }
        return step(0);
      })
      .then(function () {
        dbg('回传后端：' + pages.length + ' 页，complete=' + complete + '，reached=' + reached);
        return http('POST', api('/api/ums/agent/data'), {
          startDate: rg.start, endDate: rg.end, complete: complete, reached: reached, pages: pages
        });
      })
      .then(function (r) {
        last = {
          at: Date.now(), ok: true, range: rg.start + ' ~ ' + rg.end, pages: pages.length,
          added: r.added || 0, replaced: r.replaced || 0,
          records: (r.meta && r.meta.recordCount) || 0,
          msg: (complete ? '全量' : '增量追平') + '，数据集 #' + r.id
        };
        running = false;
        GM_setValue('last', last);
        setState(lastText(), 'ok');
        tip('同步完成', 'ok');
        dbg('同步完成：新增 ' + last.added + ' 条，覆盖 ' + last.replaced + ' 条，合计 ' + last.records + ' 条', 'ok');
        refreshCookie(true);
      })
      .catch(function (e) {
        last = {
          at: Date.now(), ok: false, range: rg.start + ' ~ ' + rg.end,
          msg: (e && e.message) || String(e)
        };
        running = false;
        GM_setValue('last', last);
        setState(lastText(), 'err');
        tip('同步失败', 'err');
        dbg('同步失败：' + last.msg, 'err');
        refreshCookie(true);
      });
  }

  function lastText() {
    if (!last) return '尚未同步';
    if (!last.ok) return '上次同步失败 ' + fmtTime(last.at) + '（' + last.range + '）：' + last.msg;
    return '上次同步 ' + fmtTime(last.at) + '（' + last.range + '，' + last.msg + '）：新增 ' +
      (last.added || 0) + ' 条' +
      ((last.replaced || 0) ? '，覆盖旧明细 ' + last.replaced + ' 条' : '') +
      '，共 ' + (last.records || 0) + ' 条';
  }
  // 折叠后标题栏里显示的一行摘要
  function shortText() {
    if (running) return '同步中…';
    if (!last) return '';
    return last.ok ? '已同步 ' + hm(last.at) + ' · 新增 ' + (last.added || 0) : '同步失败 ' + hm(last.at);
  }

  function countdownText() {
    if (!cfg.enabled) return '自动同步：已关闭';
    var at = last && last.at ? last.at : 0;
    if (!at) return '自动同步：每 ' + cfg.intervalMin + ' 分钟，等待首次执行';
    var left = at + cfg.intervalMin * 60000 - Date.now();
    return '自动同步：每 ' + cfg.intervalMin + ' 分钟，' + (left > 0 ? Math.ceil(left / 1000) + ' 秒后执行' : '即将执行');
  }

  /* ---------- 面板 ---------- */
  var host = document.createElement('div');
  host.id = 'hps-host';
  (document.body || document.documentElement).appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '.wrap{position:fixed;top:10px;right:10px;z-index:2147483647;width:240px;',
    '  font:11.5px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#0f172a;',
    '  background:#fff;border:1px solid #dbe3ef;border-radius:9px;box-shadow:0 8px 24px rgba(15,23,42,.18);overflow:hidden}',
    '.hd{display:flex;align-items:center;gap:5px;padding:5px 8px;background:#f4f8ff;cursor:pointer}',
    '.hd .st1{flex:1;font-weight:600;font-size:11.5px}',
    '.hd .sum{color:#64748b;font-weight:400;font-variant-numeric:tabular-nums;font-size:11px}',
    '.hd button{border:0;background:transparent;color:#64748b;cursor:pointer;font-size:13px;line-height:1;padding:1px 3px}',
    '.bd{padding:6px 8px 7px;border-top:1px solid #e5ecf7}',
    '.row{display:flex;align-items:center;gap:5px;margin-bottom:5px;flex-wrap:wrap}',
    '.row>label{display:flex;align-items:center;gap:4px;color:#475569}',
    'input[type=text],input[type=number],select{border:1px solid #d5dced;border-radius:5px;padding:2px 5px;font:inherit;color:#0f172a;background:#fff;min-width:0;box-sizing:border-box}',
    'input[type=text]{width:100%}',
    'input[type=number]{width:44px}',
    'input[type=checkbox]{width:12px;height:12px;accent-color:#2563eb;margin:0}',
    'button.act{border:1px solid #c9d6ea;background:#f8fafd;border-radius:5px;padding:3px 8px;font:inherit;cursor:pointer;color:#0f172a}',
    'button.act:hover{background:#eef4ff;border-color:#2563eb;color:#1d4ed8}',
    '.sec{margin-top:5px;border-top:1px dashed #e5ecf7}',
    '.secH{display:flex;align-items:center;gap:5px;padding:4px 0 3px;cursor:pointer;color:#475569;font-weight:600;user-select:none;font-size:11.5px}',
    '.secH .arw{width:9px;color:#94a3b8}',
    '.secH .cnt{color:#94a3b8;font-weight:400;font-size:11px}',
    '.secH .sp{flex:1}',
    '.secH button{border:0;background:transparent;color:#2563eb;cursor:pointer;font:inherit;padding:0 2px}',
    '.secH button:hover{text-decoration:underline}',
    '.log{max-height:104px;overflow:auto;background:#f8fafc;border:1px solid #e5ecf7;border-radius:5px;padding:4px 5px}',
    '.ln{font:10px/1.4 ui-monospace,Consolas,"Courier New",monospace;color:#475569;word-break:break-all;white-space:pre-wrap}',
    '.ln.ok{color:#047857}.ln.err{color:#b91c1c}.ln.warn{color:#b45309}.ln.run{color:#1d4ed8}',
    'textarea{border:1px solid #d5dced;border-radius:5px;padding:4px 5px;width:100%;box-sizing:border-box;',
    '  height:46px;resize:vertical;font:10px/1.35 ui-monospace,Consolas,"Courier New",monospace;color:#0f172a}',
    '.st{margin-top:5px;padding-top:5px;border-top:1px dashed #e5ecf7;color:#64748b;font-variant-numeric:tabular-nums;word-break:break-all;font-size:11px}',
    '.st.run{color:#1d4ed8}.st.ok{color:#047857}.st.err{color:#b91c1c}',
    '.dot{width:7px;height:7px;border-radius:50%;background:#cbd5e1;flex:none}',
    '.dot.run{background:#2563eb}.dot.ok{background:#10b981}.dot.err{background:#ef4444}',
    '.hide{display:none}',
    '</style>',
    '<div class="wrap">',
    '  <div class="hd" id="hd"><span class="dot"></span><span class="st1">拣货效率同步</span>',
    '    <span class="sum" id="sum"></span><button id="tg" title="折叠 / 展开">−</button></div>',
    '  <div class="bd" id="bd">',
    '    <div class="row"><input type="text" id="base" placeholder="后端地址，如 http://localhost:3001/hpe"></div>',
    '    <div class="row">',
    '      <label><input type="checkbox" id="on">自动同步</label>',
    '      <label>每<input type="number" id="min" min="1" max="1440" step="1">分钟</label>',
    '    </div>',
    '    <div class="row">',
    '      <label>范围<select id="range">',
    '        <option value="today">当天</option><option value="y2">昨天 ~ 今天</option>',
    '        <option value="d3">最近 3 天</option><option value="d7">最近 7 天</option>',
    '      </select></label>',
    '      <label><input type="checkbox" id="inc">增量</label>',
    '    </div>',
    '    <div class="row"><button class="act" id="now">立即同步</button>',
    '      <button class="act" id="test">测试接口</button><span id="tip"></span></div>',
    '    <div class="st" id="st"><div id="stm"></div><div id="cd"></div></div>',
    '    <div class="sec">',
    '      <div class="secH" id="dbgH"><span class="arw" id="dbgA">▸</span><span>调试日志</span>',
    '        <span class="cnt" id="dbgN"></span><span class="sp"></span>',
    '        <button id="dbgCopy">复制</button><button id="dbgClr">清空</button></div>',
    '      <div class="hide" id="dbgB">',
    '        <div class="row"><label style="flex:1">接口域名<input type="text" id="apiOrigin" placeholder="https://ums.hemaos.com"></label></div>',
    '        <div class="row"><label style="flex:1">接口路径<input type="text" id="path"></label></div>',
    '        <div class="log" id="dbgBody"></div>',
    '      </div>',
    '    </div>',
    '    <div class="sec">',
    '      <div class="secH" id="ckH"><span class="arw" id="ckA">▸</span><span>捕获的 Cookie</span>',
    '        <span class="cnt" id="ckN"></span><span class="sp"></span>',
    '        <button id="ckCopy">复制</button><button id="ckRefresh">刷新</button></div>',
    '      <div class="hide" id="ckB">',
    '        <textarea id="ckVal" readonly placeholder="点「刷新」从浏览器读取（含 HttpOnly 登录态）"></textarea>',
    '        <div class="row" style="margin:5px 0 0"><span style="color:#94a3b8">可粘贴到后端「实时获取 → 接口 Cookie → 设置」</span></div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('');

  var $ = function (sel) { return root.querySelector(sel); };
  var elBase = $('#base'), elOn = $('#on'), elMin = $('#min'), elRange = $('#range'), elInc = $('#inc');
  var elDot = $('.dot'), elSt = $('#st'), elStm = $('#stm'), elCd = $('#cd'), elTip = $('#tip');
  var elSum = $('#sum'), elBd = $('#bd'), elTg = $('#tg');
  var elLogBody = $('#dbgBody'), elLogN = $('#dbgN'), elPath = $('#path'), elLogA = $('#dbgA');
  var elApiOrigin = $('#apiOrigin');
  var elCkVal = $('#ckVal'), elCkN = $('#ckN'), elCkA = $('#ckA');

  /* ---------- 调试日志 ---------- */
  var logBuf = [];
  function dbg(msg, cls) {
    logBuf.push({ t: Date.now(), m: String(msg), c: cls || '' });
    if (logBuf.length > MAX_LOG) logBuf.splice(0, logBuf.length - MAX_LOG);
    try { console.log('[拣货效率同步]', msg); } catch (e) { /* ignore */ }
    renderLog();
  }
  function logText() {
    return logBuf.map(function (x) { return fmtTime(x.t) + '  ' + x.m; }).join('\n');
  }
  function renderLog() {
    if (!elLogBody) return;
    elLogBody.innerHTML = logBuf.map(function (x) {
      return '<div class="ln ' + x.c + '">' + esc(hm(x.t)) + ' ' + esc(x.m) + '</div>';
    }).join('');
    elLogBody.scrollTop = elLogBody.scrollHeight;
    elLogN.textContent = logBuf.length ? '(' + logBuf.length + ')' : '';
  }

  /* ---------- Cookie 捕获（含 HttpOnly） ---------- */
  // url：要读取哪个域的 Cookie（同步用的是「接口域」的登录态，未必等于页面域）
  function readCookies(url, cb) {
    var out = [], names = {};
    // 1) 接口域与页面域相同：document.cookie 里还有非 HttpOnly 的那部分
    if (url.indexOf(location.origin) === 0) {
      try {
        (document.cookie || '').split(/;\s*/).forEach(function (kv) {
          if (!kv) return;
          var i = kv.indexOf('=');
          if (i > 0) { var n = kv.slice(0, i); names[n] = 1; out.push({ name: n, value: kv.slice(i + 1) }); }
        });
      } catch (e) { /* ignore */ }
    }
    // 2) HttpOnly（UMS 的登录态都在这）：Tampermonkey 的 GM_cookie
    if (typeof GM_cookie !== 'undefined' && GM_cookie && GM_cookie.list) {
      try {
        GM_cookie.list({ url: url }, function (list, err) {
          if (err) dbg('GM_cookie 读取失败：' + (err.message || err), 'warn');
          (list || []).forEach(function (c) {
            if (c && c.name && !names[c.name]) { names[c.name] = 1; out.push({ name: c.name, value: c.value }); }
          });
          cb(out);
        });
      } catch (e) {
        dbg('GM_cookie 调用异常：' + ((e && e.message) || e), 'warn');
        cb(out);
      }
      return;
    }
    dbg('当前脚本管理器不支持 GM_cookie，只能读到非 HttpOnly Cookie（登录态多半拿不到）', 'warn');
    cb(out);
  }
  function cookieStr(list) {
    return list.map(function (c) { return c.name + '=' + c.value; }).join('; ');
  }
  function refreshCookie(quiet) {
    var target = apiOrigin() + '/';
    readCookies(target, function (list) {
      elCkVal.value = cookieStr(list);
      elCkN.textContent = list.length ? '(' + list.length + ' 项 / ' + cookieStr(list).length + ' 字符)' : '(空)';
      if (!quiet) {
        dbg('捕获 Cookie（' + target + '）：' + list.length + ' 项' +
          (list.length ? '（' + list.map(function (c) { return c.name; }).join(', ') + '）' :
            '　—— 该域没有 Cookie，同步可能未登录'),
          list.length ? 'ok' : 'warn');
      }
      // 接口域读不到时，顺手读一下页面域的，方便对比（脚本同步用的是接口域）
      if (!list.length && target !== location.origin + '/') {
        readCookies(location.origin + '/', function (l2) {
          if (!l2.length) return;
          elCkVal.value = cookieStr(l2);
          elCkN.textContent = '(接口域为空，显示页面域 ' + l2.length + ' 项)';
          if (!quiet) dbg('页面域 ' + location.origin + ' 有 ' + l2.length + ' 项 Cookie（仅备查）', 'warn');
        });
      }
    });
  }

  /* ---------- 渲染 ---------- */
  function paint() {
    elBase.value = cfg.base;
    elOn.checked = !!cfg.enabled;
    elMin.value = cfg.intervalMin;
    elRange.value = cfg.range;
    elInc.checked = !!cfg.incremental;
    elPath.value = cfg.path;
    elApiOrigin.value = cfg.apiOrigin;
    elDot.className = 'dot' + (running ? ' run' : (stateCls ? ' ' + stateCls : ''));
    elSt.className = 'st' + (stateCls ? ' ' + stateCls : '');
    elStm.textContent = stateText;
    elCd.textContent = countdownText();
    elBd.classList.toggle('hide', !!cfg.collapsed);
    elTg.textContent = cfg.collapsed ? '+' : '−';
    elSum.textContent = cfg.collapsed ? shortText() : '';
  }

  function setState(text, cls) {
    stateText = text || stateText;
    stateCls = cls || '';
    paint();
  }

  function tip(text, cls) {
    elTip.textContent = text || '';
    elTip.style.color = cls === 'err' ? '#b91c1c' : (cls === 'ok' ? '#047857' : '#64748b');
  }

  function section(headerEl, bodyEl, arwEl) {
    headerEl.addEventListener('click', function (ev) {
      if (ev.target && ev.target.tagName === 'BUTTON') return;   // 点按钮不折叠
      var hidden = bodyEl.classList.toggle('hide');
      arwEl.textContent = hidden ? '▸' : '▾';
    });
  }

  /* ---------- 交互 ---------- */
  elBase.addEventListener('change', function () {
    cfg.base = elBase.value.trim();
    saveCfg();
    tip('后端地址已保存', 'ok');
    dbg('后端地址改为 ' + cfg.base);
  });
  elPath.addEventListener('change', function () {
    cfg.path = elPath.value.trim() || UMS_PATH;
    elPath.value = cfg.path;
    saveCfg();
    tip('接口路径已保存', 'ok');
    dbg('接口路径改为 ' + cfg.path);
  });
  elApiOrigin.addEventListener('change', function () {
    cfg.apiOrigin = elApiOrigin.value.trim();
    saveCfg();
    tip('接口域名已保存为 ' + apiOrigin(), 'ok');
    dbg('接口域名改为 ' + apiOrigin() + '（页面域 ' + location.origin + '）');
    refreshCookie(true);
  });
  elOn.addEventListener('change', function () {
    cfg.enabled = elOn.checked;
    saveCfg();
    tip(cfg.enabled ? '自动同步已开启' : '自动同步已关闭', 'ok');
    paint();
  });
  elMin.addEventListener('change', function () {
    var n = Math.round(Number(elMin.value) || 5);
    cfg.intervalMin = Math.min(1440, Math.max(1, n));
    saveCfg();
    tip('间隔已设为每 ' + cfg.intervalMin + ' 分钟', 'ok');
    paint();
  });
  elRange.addEventListener('change', function () {
    cfg.range = elRange.value;
    saveCfg();
    tip('日期范围已保存', 'ok');
    paint();
  });
  elInc.addEventListener('change', function () {
    cfg.incremental = elInc.checked;
    saveCfg();
    tip(cfg.incremental ? '增量：遇到已入库即停' : '全量：整段区间重取', 'ok');
  });
  $('#now').addEventListener('click', function () { tip('', ''); sync(); });
  $('#test').addEventListener('click', function () { tip('', ''); testApi(); });

  // 标题栏整行可点：折叠 / 展开（状态记忆）
  $('#hd').addEventListener('click', function (ev) {
    if (ev.target && ev.target.id === 'tg') return;   // 由按钮自己处理
    toggleCollapse();
  });
  elTg.addEventListener('click', toggleCollapse);
  function toggleCollapse() {
    cfg.collapsed = !cfg.collapsed;
    saveCfg();
    paint();
  }

  section($('#dbgH'), $('#dbgB'), elLogA);
  section($('#ckH'), $('#ckB'), elCkA);

  $('#dbgClr').addEventListener('click', function () { logBuf = []; renderLog(); });
  $('#dbgCopy').addEventListener('click', function () { copy(logText(), '调试日志'); });
  $('#ckRefresh').addEventListener('click', function () { refreshCookie(false); });
  $('#ckCopy').addEventListener('click', function () {
    if (!elCkVal.value) return tip('还没有读到 Cookie，先点「刷新」', 'err');
    copy(elCkVal.value, 'Cookie');
  });

  function copy(text, what) {
    if (!text) return tip('没有可复制的内容', 'err');
    function fallback() {
      try {
        elCkVal.value = text;
        elCkVal.removeAttribute('readonly');
        elCkVal.select();
        document.execCommand('copy');
        elCkVal.setAttribute('readonly', 'readonly');
        tip(what + '已复制到剪贴板', 'ok');
      } catch (e) { tip('复制失败，请手动选中「' + what + '」里的内容', 'err'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { tip(what + '已复制到剪贴板', 'ok'); }, fallback);
    } else { fallback(); }
  }

  // 测试接口：只取第 1 页，把 URL / 状态 / 返回片段写进调试日志
  function testApi() {
    dbg('— 测试接口 —', 'run');
    dbg('页面地址 ' + location.href);
    dbg('接口地址 ' + apiOrigin() + umsPath());
    dbg('User-Agent ' + navigator.userAgent);
    var rg = rangeOf(), num = 100;
    http('GET', api('/api/ums/config'))
      .then(function (j) { if (j && j.num) num = j.num; }, function (e) {
        dbg('读取后端配置失败（不影响接口测试）：' + ((e && e.message) || e), 'warn');
      })
      .then(function () { return fetchPage(0, rg.start, rg.end, num); })
      .then(function (j) {
        var list = (j.info && j.info.list) || [];
        dbg('测试成功：totalNum=' + j.info.totalNum + '，本页 ' + list.length + ' 条', 'ok');
        tip('测试成功：本页 ' + list.length + ' 条', 'ok');
      })
      .catch(function (e) {
        dbg('测试失败：' + ((e && e.message) || e), 'err');
        tip('测试失败，看调试日志', 'err');
      });
  }

  GM_registerMenuCommand('立即同步', function () { sync(); });
  GM_registerMenuCommand('测试接口', function () { testApi(); });
  GM_registerMenuCommand('显示 / 隐藏面板', function () {
    var w = $('.wrap');
    w.style.display = w.style.display === 'none' ? '' : 'none';
  });

  /* ---------- 自动同步：每 15 秒检查是否到点；每秒只更新倒计时 ---------- */
  setInterval(function () {
    if (running) return;
    var at = last && last.at ? last.at : 0;
    if (cfg.enabled && (!at || Date.now() - at >= cfg.intervalMin * 60000)) { sync(); return; }
    if (cfg.collapsed) elSum.textContent = shortText();
    else elCd.textContent = countdownText();
  }, 15000);

  setInterval(function () {
    if (running) return;
    if (cfg.collapsed) elSum.textContent = shortText();
    else elCd.textContent = countdownText();
  }, 1000);

  /* ---------- 首屏 ---------- */
  if (last) { stateText = lastText(); stateCls = last.ok ? 'ok' : 'err'; }
  renderLog();
  paint();
  dbg('面板已加载：' + location.href + '（脚本 v1.1.1）');
  dbg('页面域 ' + location.origin + ' → 接口域 ' + apiOrigin() + umsPath());
  dbg('登录态是 HttpOnly Cookie，且未必在页面域上；同步靠请求接口域时自动带上它的 Cookie', '');
  if (!cfg.collapsed) refreshCookie(true);
})();
