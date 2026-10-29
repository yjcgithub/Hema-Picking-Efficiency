/* 配置层：口径参数、作业类型字典与前后场映射默认值
   映射的实际取值保存在数据库设置表里（键名 MAPPING_KEY），可在页面「分区设置」界面修改；
   此处只提供首次运行时的默认值。
*/
/* 两套拣货模式的分区映射预设：页面「分区设置」里可一键切换（切换后仍需点「保存」生效）。
   键可写完整分区名（含编码，如「AH 水产*A」）或去掉编码的分区名（如「水产*A」），见 compute.jobType */
const MAP_MERGE = {
  '蔬菜/水果/日配/肉禽 *A': '前场合流',
  '标品/烘焙*A': '前场合流',
  '水产*A': '前场合流',
  '海鲜岛/联营*A': '前场合流',
  '后场拣货区（标品）*P': '后场合流'
};
const MAP_SPLIT = {
  'AH 水产*A': '前场合流',
  'ABCD 标品/烘焙*A': '前场合流',
  'A 日配/肉禽 *A': '前场合流',
  'P1 蔬果*A': '前场合流',
  'KTLX 海鲜岛/联营*A': '前场合流',
  'HCCLFQ 后场拣货策略分区': '后场合流',
  'P3 后场拣货区（黄金）*P': '后场合流',
  'P 后场拣货区（标品）*P': '后场合流'
};

module.exports = {
  UNIT: '行/h',

  // 作业类型字典（「分区设置」界面下拉项）
  JOB_TYPES: ['前场合流', '后场合流', '一体化'],

  // 拣货分区未匹配到映射时归入的作业类型
  UNMATCHED_TYPE: '未匹配分区',

  // 拣货分区 -> 前后场分区；该值即「作业类型」
  // 默认用「合流按单」；旧模式「拆零_根据批次组包」保留为预设，可在页面「分区设置」一键切换
  DEFAULT_FRONT_BACK_MAP: MAP_MERGE,

  // 可选的分区映射预设（页面「分区设置」里的切换按钮按此渲染）
  FRONT_BACK_MAP_PRESETS: [
    { key: 'merge', name: '合流按单', map: MAP_MERGE },
    { key: 'split', name: '拆零_根据批次组包', map: MAP_SPLIT }
  ],

  // 设置表里保存「当前拣货模式」的预设 key：切换按钮据此决定切到哪套
  // （不靠映射内容比对 —— 手工改名 / 删除分区后内容就不再等于预设，模式不应因此失效）
  FRONT_BACK_MODE_KEY: 'frontBackMode',

  // 达标线（行/h）：页面「分区设置」可改；未保存过则用 DEFAULT_TARGETS
  TARGETS_KEY: 'jobTypeTargets',
  DEFAULT_TARGETS: { '后场合流': 260 },

  // 设置表中保存映射用的键名
  MAPPING_KEY: 'frontBackMap',

  // 设置表中保存「忽略分区」列表用的键名：列表内的分区完全排除出统计（不计入任何指标）
  IGNORE_KEY: 'ignoreZones',

  // 设置表中保存「已从分区设置列表删除的分区」的键名：
  // 只影响设置界面是否列出（历史数据里仍存在这些分区，统计口径不变）
  HIDDEN_KEY: 'hiddenZones',

  // 计算口径版本：升到 4 后，并行订单时长按秒级区间并集去重（无秒级字段的旧明细回落为分钟 + 30 秒容差）；
  // 该版本号同时写进数据集 payload 的 meta.computeVersion，接口据此判断能否直接复用已算好的结果
  COMPUTE_VERSION_KEY: 'computeVersion',
  COMPUTE_VERSION: '4',

  // 拣货单类型 = 该值时判定为「一体化」
  INTEGRATED_ORDER_TYPE: '拣打一体',

  // 时间维度字段：上传文件据此确定拣货单的时间维度，并用于「覆盖 / 新增」匹配
  TIME_COLUMN: '拣货开始时间',

  // 超时相关列（非必需：旧文件没有这些列时不统计超时，也不阻塞上传）
  TIMEOUT_COLUMN: '是否拣货超时',      // 取值等于 TIMEOUT_YES 视为超时
  TIMEOUT_YES: '是',
  TIMEOUT_DUTY_COLUMN: '超时判责',     // 超时责任细分（堆积图分组）
  TIMEOUT_NO_DUTY: '未填判责',          // 「超时判责」为空时的归集项

  // 拣货数量（件数）列（非必需：旧文件 / 接口没有该字段时不统计数量，也不阻塞上传）
  // 实时接口对应字段见 QTY_FIELD（listPickOrderForB2C 明细里的 pickNum）
  QTY_COLUMN: '拣货数量',
  QTY_FIELD: 'pickNumber',

  // 门店编码：拣货单号的前缀。导入时按此鉴别门店，只接收该编码开头的明细
  STORE_CODE: '20005',

  // 必需列
  REQUIRED_COLUMNS: ['拣货单号', '拣货人', '拣货开始时间', '拣货完成时间', '拣货行数', '拣货分区', '拣货单类型'],

  /* ---------- 实时拣货单接口（ums）：后端带 Cookie 拉取 ---------- */
  // 可用环境变量 HEMA_UMS_URL 覆盖（本地模拟 / 联调时指向假接口）
  UMS_URL: process.env.HEMA_UMS_URL || 'https://ums.hemaos.com/out/PickOrderManager/listPickOrderForB2C.json',
  UMS_PAGE_SIZE: 200,                     // 默认每页条数（接口 num，index=0 为倒序第一页）
  UMS_NUM_CHOICES: [50, 100, 200],        // 「每页条数」可选项（页面里设置，存 settings 表）
  UMS_EXTRA_QUERY: { pickOperateType: '3' },
  UMS_TIMEOUT_MS: 20000,                  // 单页请求超时
  UMS_MAX_PAGES: 400,                     // 分页保护上限（100 × 400 = 4 万条）
  UMS_AUTO_MIN_INTERVAL: 1,               // 自动获取最小间隔（分钟）
  UMS_AUTO_MAX_INTERVAL: 1440,            // 自动获取最大间隔（分钟）
  UMS_EDGE_WINDOW_MIN: 2,                 // 时段「开始 / 结束」时刻额外取数一次：到点后多少分钟内允许补执行

  /* ---------- 防风控：请求节流与退避 ---------- */
  UMS_PAGE_GAP_MIN_MS: 300,               // 翻页之间的最小停顿
  UMS_PAGE_GAP_MAX_MS: 900,               // 翻页之间的最大停顿（每次随机取值）
  UMS_INTERVAL_JITTER: 0.15,              // 自动获取间隔抖动比例（±15%，避免固定整点打点）
  UMS_BACKOFF_MAX_MIN: 60,                // 连续失败后的最大退避间隔（分钟）
  UMS_FETCH_COOLDOWN_SEC: 60,             // 取数冷却：两次取数（手动 / 自动 / 脚本）之间的最小间隔秒数
  UMS_MANUAL_LOCK_SEC: 120,               // 自动获取点「前后」多少秒内拒绝手动获取（错峰，避免同一时刻两次取数）

  // 超时判责：接口英文编码 -> 报表中文口径（与 xlsx 导出一致）
  UMS_DUTY_MAP: {
    OPERATOR_RESPONSIBLE: '小二责任',
    STATION_RESPONSIBLE: '档口责任',
    NO_RESPONSIBLE: '无法判责'
  },

  // 设置表里保存接口 Cookie 用的键名（服务端代取时使用）
  UMS_COOKIE_KEY: 'umsCookie',

  // 备用接口 Cookie：与主 Cookie 一起随机先后使用（分摊请求降低风控），失败（鉴权 / 风控）时互相回退
  UMS_COOKIE_BACKUP_KEY: 'umsCookieBackup',

  // 最近一次「Cookie 鉴权失效被删除」的记录 { at, tag }，供页面提示重新同步
  UMS_COOKIE_AUTH_KEY: 'umsCookieAuth',

  // 设置表里保存「最近一次实时获取结果」的键名（首页角标显示 状态 + 距上次获取的时长）
  UMS_LAST_KEY: 'umsLastFetch',

  // 设置表里保存「最近一次取数尝试」时间的键名（含失败；手动 / 自动 / 脚本共用同一冷却窗口）
  UMS_LAST_TRY_KEY: 'umsLastTryAt',

  // 每页条数（num）设置
  UMS_NUM_KEY: 'umsNumber',

  // 取数条件（页面「开始日期 / 结束日期」）：手动与自动获取共用同一区间
  UMS_RANGE_KEY: 'umsRange',

  // 自动获取设置 { enabled, intervalMin } 与最近一次自动执行结果
  UMS_AUTO_KEY: 'umsAuto',
  UMS_AUTO_STATE_KEY: 'umsAutoState',

  // 油猴脚本同步（在 ums 页面内用登录态取数后回传）最近一次结果
  UMS_AGENT_STATE_KEY: 'umsAgentState',

  /* ---------- 钉钉群机器人推送（效率透视图发到群） ----------
     自定义机器人 Webhook 不支持「图片」类型消息，只能把图片以 markdown 链接嵌入，
     因此图片先存到服务端、由公网 URL 提供，再由钉钉客户端拉取显示 */
  DING_WEBHOOK_KEY: 'dingWebhook',        // 机器人 Webhook 完整地址（含 access_token）
  DING_SECRET_KEY: 'dingSecret',          // 安全设置「加签」的密钥（SEC 开头）
  DING_PUBLIC_BASE_KEY: 'dingPublicBase', // 公网访问地址（如 https://xl.yjmc.xyz）；留空=按本次请求 Host 推断

  /* ---------- 定时推送（服务端自绘图片后自动发到群） ----------
     服务端用 SVG 自绘「人员 × 小时」效率透视表（server/render.js，@resvg/resvg-js，
     纯 CPU、无需浏览器），再走与手动推送相同的 markdown 链路发到群。 */
  DING_AUTO_KEY: 'dingAuto',              // { enabled }：取数成功后自动自绘并推送（不再按间隔定时）
  DING_AUTO_STATE_KEY: 'dingAutoState',   // 最近一次自动推送结果 { at, ok, error, reason, count }
  DING_AT_ALL_KEY: 'dingAtAll',           // 推送正文是否在「统计时间段」前 @全体成员（未设置 = 开）
  DING_PUSH_DELAY_MIN: 1,                 // 取数成功后延迟多少分钟才推送（等数据稳定）
  DING_PUSH_MAX_RETRY: 2,                 // 推送失败自动重试次数

  /* ---------- PushPlus 微信提醒（接口 Cookie 失效时推一条） ----------
     可用环境变量 HEMA_PUSHPLUS_TOKEN 覆盖；token 置空 = 关闭提醒 */
  PUSHPLUS_TOKEN: '12b995cc86e2486b87fb641f9ed2e14b',
  PUSHPLUS_URL: 'https://www.pushplus.plus/send',
  PUSHPLUS_COOLDOWN_MIN: 30               // 同一失效状态的最短提醒间隔（分钟），避免反复刷屏
};
