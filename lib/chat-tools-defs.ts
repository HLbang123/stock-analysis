/**
 * AI 对话工具定义（Function Calling 的纯数据部分）
 * 与 lib/chat-tools.ts 分离：此文件零依赖（无 db/pg 等服务器模块），
 * 浏览器直连（services/chat/browser-chat.ts）可安全 import；
 * 服务器版从 lib/chat-tools.ts re-export 保持兼容。
 */

import type { Stock, WatchlistGroup, AlertRecord } from '@/types';

export const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_stock",
      description: "按名称或代码搜索A股股票，返回代码、名称、行业。用户说股票名字时先调这个查代码",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", description: "股票名称或代码关键词，如 贵州茅台 或 600519" } },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_quote",
      description: "获取A股实时行情（当前价、涨跌幅、开盘/最高/最低/成交量/成交额）",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "股票代码，如 sz002463 或 sh600519" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_kline",
      description: "获取A股日K线历史（OHLCV开高低收成交量），用于技术分析",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "股票代码" },
          days: { type: "number", description: "返回最近几天，默认20", default: 20 },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_fundamentals",
      description: "获取个股基本面（估值 PE/PB、ROE、营收增速、总市值、北向持股比例），判断估值贵贱与盈利能力",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "股票代码，如 sz002463 或 sh600519" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_rps",
      description: "获取股票的RPS相对强度排名（20/60/120/250日百分位），判断在全市场的强弱",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "股票代码" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_breadth",
      description: "获取市场宽度（涨跌家数、涨跌停、MA55上方占比、RPS60改善占比），判断市场温度",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "近几日，默认3", default: 3 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_history",
      description: "查询某只股票在指定日期的涨跌幅和行情（从数据库查，精确到日）",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "股票代码，如 sz002463" },
          date: { type: "string", description: "日期 YYYYMMDD 格式，如 20260109" },
        },
        required: ["code", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_stocks",
      description: "按条件扫描选股（RPS排名、5/13金叉、55日线朝上），返回符合条件的股票列表",
      parameters: {
        type: "object",
        properties: {
          period: { type: "number", description: "RPS周期 20/60/120/250，默认250", default: 250 },
          min_rps: { type: "number", description: "最低RPS阈值，默认87", default: 87 },
          industry: { type: "string", description: "行业筛选词如半导体，不传=全市场" },
          golden_cross: { type: "boolean", description: "是否要求5/13金叉" },
          ma55_up: { type: "boolean", description: "是否要求55日线朝上" },
          limit: { type: "number", description: "返回数量，默认10", default: 10 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_anomaly_reason",
      description: "获取当日个股异动原因解读（涨停/跌停/大涨/大跌的原因），包含关键词和AI生成的分析内容",
      parameters: {
        type: "object",
        properties: {
          tags: { type: "string", description: "异动标签过滤，逗号分隔：LIMIT_UP(涨停)/LIMIT_DOWN(跌停)/SHARP_RISE(大涨)/SHARP_FALL(大跌)。不传=全部" },
          code: { type: "string", description: "按股票查询，传同花顺代码如 600519.SH。不传则返回全部异动列表" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_limit_up_pool",
      description: "获取当日涨停股票池，含涨停原因、连板天数、封单金额、涨停时间",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_hot_stocks",
      description: "获取同花顺热股榜单Top30和飙升榜Top30，反映市场关注度",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dragon_tiger",
      description: "查询龙虎榜（同花顺口径）：机构净买入与买卖家数、知名游资名单及个股净买入、人气排名、涨停原因。可查整个榜单或单只股票",
      parameters: {
        type: "object",
        properties: {
          board: { type: "string", description: "榜单类型：all 全部 / org 机构榜 / hot_money 游资榜，默认 all", default: "all" },
          code: { type: "string", description: "按股票过滤，6位代码或同花顺代码如 002407.SZ，不传=整榜" },
          date: { type: "string", description: "交易日 yyyy-MM-dd，默认最近交易日（只支持一年内）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fund_holdings",
      description: "查询ETF或基金的前十大重仓股及持仓占比，用于分析ETF成分",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "基金代码，如 510050.SH（ETF）或 025480.OF（场外基金）" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_chip_distribution",
      description: "查询个股筹码分布（筹码峰），含主峰价位、平均成本、获利盘比例、90%集中度、峰位漂移，用于判断筹码密集/套牢/支撑阻力",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "股票代码，如 sz002463 或 sh600519" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_watchlist",
      description: "查看用户的自选标的列表、自定义分组和持仓占比。用户问“我的自选/分组/持仓/买了什么/仓位”时调用",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_alerts",
      description: "查看用户的预警记录（未读优先）：哪些自选标的触发了哪条预警规则（见顶/破位/金叉/超卖等），含信号说明与建议。用户问“我的预警/信号/自选今天有什么动静”时调用",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_moneyflow",
      description: "获取个股主力资金流（同花顺口径）：近30日净流入、超大单/大单净额与占比，判断主力进出动向",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "股票代码，如 sz002463 或 sh600519" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_holder_number",
      description: "获取个股股东户数变化（近4期）：户数环比下降=筹码集中、上升=筹码分散",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "股票代码，如 sz002463 或 sh600519" } },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stock_box",
      description: "查询个股是否处于吸筹箱体中或刚突破箱顶（箱体质量分/箱内位置/箱顶箱底/突破标志）",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "股票代码，如 sz002463 或 sh600519" } },
        required: ["code"],
      },
    },
  },
];

/**
 * 自选+分组+持仓快照文本 — get_watchlist 工具结果与服务器中转快照共用格式。
 * 数据只存在浏览器本地（zustand persist）：直连时 executeToolBrowser 现读 store；
 * 服务器中转时由客户端把本函数产出的快照随请求体带给 executeTool。
 */
export function formatWatchlistContext(watchlist: Stock[], groups: WatchlistGroup[]): string {
  if (!watchlist.length) return "用户自选为空";
  const pos = (s: Stock) => (s.positionPercent != null ? ` 持仓${s.positionPercent}%` : '');
  const byCode = new Map(watchlist.map(s => [s.code, s]));
  const lines: string[] = [`自选共${watchlist.length}只（${groups.length}个分组）：`];
  const grouped = new Set<string>();
  for (const g of groups) {
    const members = g.stockCodes.map(c => byCode.get(c)).filter((s): s is Stock => !!s);
    members.forEach(s => grouped.add(s.code));
    if (members.length) {
      lines.push(`【${g.name}】${members.map(s => `${s.name}(${s.code})${pos(s)}`).join('、')}`);
    }
  }
  const ungrouped = watchlist.filter(s => !grouped.has(s.code));
  if (ungrouped.length) {
    lines.push(`【未分组】${ungrouped.map(s => `${s.name}(${s.code})${pos(s)}`).join('、')}`);
  }
  return lines.join('\n');
}

/**
 * 预警记录快照 — get_my_alerts 工具结果与服务器中转快照共用格式（同 watchlist：浏览器本地数据）。
 * 未读优先（用户最关心新信号），已读只留最近几条做上下文，不整段灌历史。
 */
export function formatAlertsContext(alerts: AlertRecord[]): string {
  if (!alerts.length) return "暂无预警记录";
  const lv: Record<string, string> = { INFO: '关注', WARNING: '注意', CRITICAL: '严重' };
  const unread = alerts.filter(a => !a.isRead);
  const read = alerts.filter(a => a.isRead).slice(0, 5);
  const lines: string[] = [];
  if (unread.length) {
    lines.push(`未读预警 ${unread.length} 条：`);
    for (const a of unread) {
      const level = lv[a.alertLevel] ?? a.alertLevel;
      lines.push(`- [${a.ruleId} ${a.ruleName}] ${a.stockName}(${a.stockCode}) ${level}：${a.alertMessage}${a.suggestion ? `（${a.suggestion}）` : ''}`);
    }
  } else {
    lines.push('暂无未读预警');
  }
  if (read.length) {
    lines.push(`已读最近 ${read.length} 条：`);
    for (const a of read) {
      lines.push(`- [${a.ruleId} ${a.ruleName}] ${a.stockName}(${a.stockCode}) ${a.alertMessage}`);
    }
  }
  return lines.join('\n');
}
