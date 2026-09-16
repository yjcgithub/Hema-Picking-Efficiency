
/** 视图层配置：单位、配色、后端 API 地址
   前后场映射等口径在服务端 server/config.js
*/

window.HEMA_CONFIG = {
  UNIT: '行/h',

  /* 后端接口基地址：
   * 根据当前访问方式自动选择后端地址：
   * - 本地调试（localhost / 127.0.0.1）→ 走本机 http://localhost:3001/hpe/api
   * - 通过域名访问（xl.yjmc.xyz）→ 走 https://api.yjmc.xyz/hpe/api
   * - 通过 IP（8.137.63.172）访问 → 走 http://8.137.63.172:3001/hpe/api
   */
  API_BASE: (function () {
    var host = window.location.hostname;
    // 本地调试：本机访问时直接请求本机后端
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return 'http://' + host + ':3001/hpe/api';
    }
    // 判断当前是通过 IP 还是域名访问的
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      // IP 地址访问，直接请求本地后端服务
      return 'http://8.137.63.172:3001/hpe/api';
    }
    // 域名访问，走域名后端接口
    return 'https://api.yjmc.xyz/hpe/api';
  })(),

  // 作业类型配色
  COLORS: {
    '后场合流': '#f97316',
    '一体化': '#2563eb',
    '前场合流': '#14b8a6',
    '未匹配分区': '#94a3b8'
  }
}