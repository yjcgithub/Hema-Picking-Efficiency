/* 配置层：口径参数、作业类型字典与前后场映射默认值
   映射的实际取值保存在数据库设置表里（键名 MAPPING_KEY），可在页面「分区设置」界面修改；
   此处只提供首次运行时的默认值。
*/
module.exports = {
  UNIT: '行/h',

  // 作业类型字典（「分区设置」界面下拉项）
  JOB_TYPES: ['前场合流', '后场合流', '一体化'],

  // 拣货分区未匹配到映射时归入的作业类型
  UNMATCHED_TYPE: '未匹配分区',

  // 拣货分区 -> 前后场分区；该值即「作业类型」
  DEFAULT_FRONT_BACK_MAP: {
    'AH 水产*A': '前场合流',
    'HCCLFQ 后场拣货策略分区': '后场合流',
    'ABCD 标品/烘焙*A': '前场合流',
    'A 日配/肉禽 *A': '前场合流',
    'P3 后场拣货区（黄金）*P': '后场合流',
    'P1 蔬果*A': '前场合流',
    'P 后场拣货区（标品）*P': '后场合流',
    'KTLX 海鲜岛/联营*A': '前场合流'
  },

  // 设置表中保存映射用的键名
  MAPPING_KEY: 'frontBackMap',

  // 设置表中保存「忽略分区」列表用的键名：列表内的分区完全排除出统计（不计入任何指标）
  IGNORE_KEY: 'ignoreZones',

  // 拣货单类型 = 该值时判定为「一体化」
  INTEGRATED_ORDER_TYPE: '拣打一体',

  // 时间维度字段：上传文件据此确定拣货单的时间维度，并用于「覆盖 / 新增」匹配
  TIME_COLUMN: '拣货开始时间',

  // 超时相关列（非必需：旧文件没有这些列时不统计超时，也不阻塞上传）
  TIMEOUT_COLUMN: '是否拣货超时',      // 取值等于 TIMEOUT_YES 视为超时
  TIMEOUT_YES: '是',
  TIMEOUT_DUTY_COLUMN: '超时判责',     // 超时责任细分（堆积图分组）
  TIMEOUT_NO_DUTY: '未填判责',          // 「超时判责」为空时的归集项

  // 门店编码：拣货单号的前缀。导入时按此鉴别门店，只接收该编码开头的明细
  STORE_CODE: '20005',

  // 必需列
  REQUIRED_COLUMNS: ['拣货单号', '拣货人', '拣货开始时间', '拣货完成时间', '拣货行数', '拣货分区', '拣货单类型'],

  /* ---------- 实时拣货单接口（ums）：后端带 Cookie 拉取 ---------- */
  UMS_URL: 'https://ums.hemaos.com/out/PickOrderManager/listPickOrderForB2C.json',
  UMS_PAGE_SIZE: 100,                     // 默认每页条数（接口 num，index=0 为倒序第一页）
  UMS_NUM_CHOICES: [50, 100, 200],        // 「每页条数」可选项（页面里设置，存 settings 表）
  UMS_EXTRA_QUERY: { pickOperateType: '3' },
  UMS_TIMEOUT_MS: 20000,                  // 单页请求超时
  UMS_MAX_PAGES: 400,                     // 分页保护上限（100 × 400 = 4 万条）
  UMS_AUTO_MIN_INTERVAL: 1,               // 自动获取最小间隔（分钟）
  UMS_AUTO_MAX_INTERVAL: 1440,            // 自动获取最大间隔（分钟）

  /* ---------- 防风控：请求节流与退避 ---------- */
  UMS_PAGE_GAP_MIN_MS: 300,               // 翻页之间的最小停顿
  UMS_PAGE_GAP_MAX_MS: 900,               // 翻页之间的最大停顿（每次随机取值）
  UMS_INTERVAL_JITTER: 0.15,              // 自动获取间隔抖动比例（±15%，避免固定整点打点）
  UMS_BACKOFF_MAX_MIN: 60,                // 连续失败后的最大退避间隔（分钟）
  UMS_FETCH_COOLDOWN_SEC: 60,             // 取数冷却：两次取数（手动 / 自动 / 脚本）之间的最小间隔秒数

  // 超时判责：接口英文编码 -> 报表中文口径（与 xlsx 导出一致）
  UMS_DUTY_MAP: {
    OPERATOR_RESPONSIBLE: '小二责任',
    STATION_RESPONSIBLE: '档口责任',
    NO_RESPONSIBLE: '无法判责'
  },

  // 设置表里保存接口 Cookie 用的键名（服务端代取时使用）
  UMS_COOKIE_KEY: 'umsCookie',

  // 设置表里保存「最近一次实时获取结果」的键名（首页角标显示 状态 + 距上次获取的时长）
  UMS_LAST_KEY: 'umsLastFetch',

  // 设置表里保存「最近一次取数尝试」时间的键名（含失败；手动 / 自动 / 脚本共用同一冷却窗口）
  UMS_LAST_TRY_KEY: 'umsLastTryAt',

  // 每页条数（num）设置
  UMS_NUM_KEY: 'umsNum',

  // 取数条件（页面「开始日期 / 结束日期」）：手动与自动获取共用同一区间
  UMS_RANGE_KEY: 'umsRange',

  // 自动获取设置 { enabled, intervalMin } 与最近一次自动执行结果
  UMS_AUTO_KEY: 'umsAuto',
  UMS_AUTO_STATE_KEY: 'umsAutoState',

  // 油猴脚本同步（在 ums 页面内用登录态取数后回传）最近一次结果
  UMS_AGENT_STATE_KEY: 'umsAgentState'
};
