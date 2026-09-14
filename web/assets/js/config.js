/* 视图层配置：单位、配色、后端 API 地址
   前后场映射等口径在服务端 server/config.js
*/
window.HEMA_CONFIG = {
  UNIT: '行/h',

  /* 后端接口基地址：
     - 前端与后端同源（由 Node 服务托管前端）时用 '/api'
     - 前后端分离（前端静态托管，后端在别的域名/路径）时填完整地址，例如：
       'https://api.yjmc.xyz/hpe/api'
  */
  API_BASE: 'https://api.yjmc.xyz/hpe/api',

  // 作业类型配色
  COLORS: {
    '后场合流': '#f97316',
    '一体化': '#2563eb',
    '前场合流': '#14b8a6',
    '未匹配分区': '#94a3b8'
  }
};
