/* 服务端无头浏览器截图（定时推送用）
   看板里的「效率透视表」是浏览器用 html2canvas 现截的，服务端自己画不出来。
   定时推送因此用 puppeteer 打开看板页，在页面内调用 HEMA.dingPayload() 拿到三块图片与统计数据。

   · puppeteer 为可选依赖：未安装时 available() 为 false，调用方跳过本次推送并给出提示；
   · 容器内自装 Chromium 时可用环境变量 HEMA_CHROME_PATH 指定可执行文件路径；
   · 无头浏览器运行在服务器上，需要能被本机访问到看板（默认 http://127.0.0.1:<PORT><BASE_PATH>/）；
   · opts.log(msg) 可传入日志回调，过程与失败诊断会写进服务端日志。
*/
let puppeteer = null;
let loadErr = '';
try { puppeteer = require('puppeteer'); } catch (e) { loadErr = e.message || String(e); }

function available() { return !!puppeteer; }
function unavailableReason() {
  if (puppeteer) return '';
  return '未安装 puppeteer（服务端无法截图）：请在 server 目录执行 npm install' + (loadErr ? '（' + loadErr + '）' : '');
}

/* 采集一次打开期间的页面信号：脚本异常 / 失败请求 / 接口响应，失败时拼进报错，便于定位卡点 */
function makeDiag(page) {
  const d = { errors: [], failed: [], api: [], console: [] };
  page.on('pageerror', function (e) { d.errors.push(String((e && e.message) || e).slice(0, 200)); });
  page.on('requestfailed', function (r) {
    const f = r.failure();
    d.failed.push(r.url().slice(0, 160) + '（' + ((f && f.errorText) || '?') + '）');
  });
  page.on('response', function (r) {
    const u = r.url();
    if (/\/api\//.test(u)) d.api.push(r.status() + ' ' + u.slice(0, 140));
  });
  page.on('console', function (m) { if (m.type() === 'error') d.console.push(m.text().slice(0, 160)); });
  return d;
}
function diagText(d) {
  const parts = [];
  if (d.errors.length) parts.push('页面报错 ' + d.errors.slice(0, 3).join(' | '));
  if (d.console.length) parts.push('console.error ' + d.console.slice(0, 3).join(' | '));
  if (d.failed.length) parts.push('请求失败 ' + d.failed.slice(0, 5).join(' | '));
  parts.push(d.api.length ? '接口响应 ' + d.api.slice(-5).join(' | ')
    : '本次未捕获到任何 /api/ 请求（页面可能没触发取数，或用的是其它域名）');
  return '；' + parts.join('；');
}

// 打开看板页 → 等「效率透视表」渲染出分块 → 在页面内取回三块载荷 { period, blocks }
async function capturePivot(url, opts) {
  if (!puppeteer) throw new Error(unavailableReason());
  opts = opts || {};
  const timeout = opts.timeout || 60000;
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  // 截图降采样倍率：传给页面 html2canvas 的 scale，越小越快、图越糊。可用 HEMA_DING_SCALE 覆盖，默认 1 倍
  const scale = (function () {
    const n = Number(process.env.HEMA_DING_SCALE);
    return (Number.isFinite(n) && n > 0) ? n : 1;
  })();
  const launch = {
    headless: true,
    // 页面内 html2canvas 逐块截图较慢，放宽 CDP 调用超时（默认 180s 会被 Runtime.evaluate 超时打断）
    protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN']
  };
  if (process.env.HEMA_CHROME_PATH) launch.executablePath = process.env.HEMA_CHROME_PATH;

  log('启动无头浏览器…');
  const browser = await puppeteer.launch(launch);
  try {
    const page = await browser.newPage();
    const diag = makeDiag(page);
    // 转发页面里的截图进度（app.js 用 [ding-push] 前缀打点）
    page.on('console', function (m) {
      const t = m.text();
      if (t.indexOf('[ding-push]') === 0) log(t.slice('[ding-push]'.length).trim());
    });
    // 页面用「浏览器本地时区」判断今天，而容器时区通常是 UTC：
    // 北京时间 00:00~08:00 会被算成前一天，导致选到昨天的数据集。这里强制页面时区为东八区
    await page.emulateTimezone('Asia/Shanghai').catch(function (e) {
      log('时区设为 Asia/Shanghai 失败（按容器时区）:' + ((e && e.message) || e));
    });
    // 1 倍像素密度：DPR=1，避免 2x 画布放大（实际倍率另由 window.HEMA_DING_SCALE 指定）
    await page.setViewport({ width: 1680, height: 1200, deviceScaleFactor: 1 });
    page.setDefaultTimeout(timeout);
    // 不用 networkidle：看板会周期性轮询接口，网络很难真正空闲；改用 domcontentloaded + 显式等待
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout });
    const status = resp ? resp.status() : 0;
    log('已打开 ' + page.url() + '（HTTP ' + status + '）');

    // 打开的不是看板页（例如该服务只提供 API、前端由 nginx 托管，或地址填错）：
    // 直接给出可定位的报错，而不是干等超时
    const isDashboard = await page.evaluate(
      '!!(document.getElementById("pivotBlocks") && document.getElementById("gateMask"))'
    );
    if (!isDashboard) {
      const title = await page.title().catch(function () { return ''; });
      let head = '';
      try { head = (await page.evaluate('document.body.innerText.slice(0,120)')) || ''; } catch (e) { /* 忽略 */ }
      throw new Error('看板地址打开的不是看板页（' + url + '，HTTP ' + status +
        (title ? '，标题「' + title + '」' : '') +
        (head ? '，页面开头「' + head.replace(/\s+/g, ' ').trim() + '」' : '') +
        '）：请确认该地址能打开本看板（容器需托管前端，或把「看板地址」改成本站点入口地址）');
    }

    // 预设降采样倍率：页面 html2canvas 读取 window.HEMA_DING_SCALE（仅影响本次无头截图）
    await page.evaluate('window.HEMA_DING_SCALE = ' + scale);
    log('截图倍率 ' + scale + 'x');

    // 等数据渲染：出现透视分块，或出现「今日暂无数据」门禁遮罩（说明确实没数据）
    log('等待透视表渲染（最多 ' + Math.round(timeout / 1000) + ' 秒）…');
    try {
      await page.waitForFunction(
        '(() => {' +
        '  var has = document.querySelector("#pivotBlocks .pivot-block");' +
        '  if (has) return true;' +
        '  var g = document.getElementById("gateMask");' +
        '  return !!(g && !g.classList.contains("hidden"));' +
        '})()',
        { timeout: timeout }
      );
    } catch (e) {
      throw new Error('看板页 ' + Math.round(timeout / 1000) + ' 秒内未渲染出透视表（' + url +
        '）：可能页面接口不可达 / 一直加载中，或当天无数据且遮罩未显示' + diagText(diag));
    }
    const hasBlocks = await page.evaluate('!!document.querySelector("#pivotBlocks .pivot-block")');
    if (!hasBlocks) throw new Error('看板当前无数据（可能当天还没有拣货单），已跳过本次推送' + diagText(diag));

    await new Promise(function (r) { setTimeout(r, 1000); });   // 等 ECharts 画完 / 字体就绪
    if (typeof page.waitForNetworkIdle === 'function') {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(function () {});
    }
    log('透视表已渲染，开始截图…');
    const payload = await page.evaluate('window.HEMA.dingPayload()');
    if (!payload || !Array.isArray(payload.blocks) || !payload.blocks.length) {
      throw new Error('页面未返回可推送的透视数据' + diagText(diag));
    }
    return payload;
  } finally {
    await browser.close().catch(function () {});
  }
}

module.exports = { available, unavailableReason, capturePivot };
