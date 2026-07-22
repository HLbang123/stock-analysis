/**
 * AI 对话工具调用（Function Calling）
 * 定义 LLM 可调用的工具 + 执行函数，让 AI 能主动查行情/K线/RPS/大盘/北向/扫描
 */

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
      description: "获取市场宽度（涨跌家数、涨跌停、MA55上方占比、RPS强势股占比），判断市场温度",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "近几日，默认3", default: 3 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_northbound_flow",
      description: "获取北向资金流向（每日净流入+累计余额），判断外资态度",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "近几日，默认5", default: 5 } },
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
];

/** 执行工具调用，返回简洁文本结果（给 LLM 处理） */
export async function executeTool(name: string, args: any, origin: string): Promise<string> {
  try {
    switch (name) {
      case "search_stock": {
        const { prisma } = await import("@/lib/db");
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT ts_code, name, industry FROM stocks WHERE (name LIKE $1 OR ts_code LIKE $1) AND is_active = true LIMIT 5`,
          `%${args.keyword}%`
        );
        if (!rows.length) return `未找到"${args.keyword}"相关股票`;
        return rows.map((r) => {
          const m = r.ts_code?.match(/^(\d+)\.(SH|SZ|BJ)$/);
          const code = m ? `${m[2].toLowerCase()}${m[1]}` : r.ts_code;
          return `${r.name}(${code}) 行业:${r.industry || "未知"}`;
        }).join("; ");
      }
      case "get_stock_quote": {
        const r = await fetch(`${origin}/api/quote?code=${encodeURIComponent(args.code)}`);
        const d = await r.json();
        if (d.error) return `获取行情失败: ${d.error}`;
        return `${d.name}(${d.code}) 当前价${d.price} 涨跌${d.changePercent?.toFixed(2)}% 开${d.open} 高${d.high} 低${d.low} 昨收${d.preClose} 量${d.volume} 额${d.amount}`;
      }
      case "get_stock_kline": {
        const days = args.days || 20;
        const r = await fetch(`${origin}/api/kline?code=${encodeURIComponent(args.code)}&scale=240&days=${days}`);
        const d = await r.json();
        if (d.error) return `获取K线失败: ${d.error}`;
        const bars = (d as any[]).slice(-days);
        return `近${bars.length}日K线(日期 开高低调收量):\n${bars.map((b: any) => `${b.date} ${b.open} ${b.high} ${b.low} ${b.close} ${b.volume}`).join('\n')}`;
      }
      case "get_stock_rps": {
        const { prisma } = await import("@/lib/db");
        const m = (args.code as string).match(/^([a-z]+)(\d+)$/i);
        if (!m) return "无效代码";
        const tsCode = `${m[2]}.${m[1].toUpperCase()}`;
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT rps_20, rps_60, rps_120, rps_250, ret_250, "calcDate" FROM rps_scores WHERE "tsCode"=$1 ORDER BY "calcDate" DESC LIMIT 1`, tsCode
        );
        if (!rows.length) return "无RPS数据";
        const r = rows[0];
        return `RPS(${r.calcDate}): 20日=${r.rps_20?.toFixed(1)} 60日=${r.rps_60?.toFixed(1)} 120日=${r.rps_120?.toFixed(1)} 250日=${r.rps_250?.toFixed(1)} 250日涨幅=${r.ret_250?.toFixed(1)}%`;
      }
      case "get_market_breadth": {
        const days = args.days || 3;
        const { prisma } = await import("@/lib/db");
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT trade_date, advance, decline, limit_up, limit_down, above_ma55_ratio, strong_rps_ratio FROM market_breadth ORDER BY trade_date DESC LIMIT $1`, days
        );
        if (!rows.length) return "无市场宽度数据";
        return rows.map((r) => `${r.trade_date}: 涨${r.advance} 跌${r.decline} 涨停${r.limit_up} 跌停${r.limit_down} MA55上方${r.above_ma55_ratio}% RPS≥87占比${r.strong_rps_ratio}%`).join('\n');
      }
      case "get_northbound_flow": {
        const days = args.days || 5;
        const { prisma } = await import("@/lib/db");
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT trade_date, north_money, north_total FROM northbound_flow ORDER BY trade_date DESC LIMIT $1`, days
        );
        if (!rows.length) return "无北向资金数据";
        return rows.map((r) => `${r.trade_date}: 净流入${(r.north_money / 10000).toFixed(2)}亿 累计${(r.north_total / 10000).toFixed(0)}亿`).join('\n');
      }
      case "get_stock_history": {
        const { prisma } = await import("@/lib/db");
        const m = (args.code as string).match(/^([a-z]+)(\d+)$/i);
        if (!m) return "无效代码";
        const tsCode = `${m[2]}.${m[1].toUpperCase()}`;
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT "tradeDate", open, high, low, close, pre_close, change_pct, vol, amount
           FROM daily_bars WHERE "tsCode" = $1 AND "tradeDate" = $2 LIMIT 1`,
          tsCode, args.date
        );
        if (!rows.length) return `无 ${args.date} 的日线数据（可能未同步或非交易日）`;
        const r = rows[0];
        return `${args.date}: 开${r.open} 高${r.high} 低${r.low} 收${r.close} 昨收${r.pre_close} 涨跌幅${r.change_pct?.toFixed(2)}% 量${r.vol}`;
      }
      case "scan_stocks": {
        const params = new URLSearchParams();
        params.set("period", String(args.period || 250));
        params.set("filterRps", "true");
        params.set("minRps", String(args.min_rps || 87));
        if (args.industry) params.set("industry", args.industry);
        if (args.golden_cross) { params.set("goldenCross", "true"); params.set("gcDays", "5"); }
        if (args.ma55_up) params.set("ma55Up", "true");
        params.set("limit", String(args.limit || 10));
        const r = await fetch(`${origin}/api/scan?${params}`);
        const d = await r.json();
        if (d.error) return `扫描失败: ${d.error}`;
        return `扫描到${d.count}只: ` + d.items.map((s: any, i: number) => `${i + 1}.${s.name}(${s.tsCode.replace(/\.(SH|SZ|BJ)$/, '')}) RPS${s.rps?.toFixed(1)} 涨跌${s.latestChange?.toFixed(1)}%`).join('; ');
      }
      case "get_anomaly_reason": {
        const { fuyaoGet } = await import("@/lib/fuyao");
        const path = args.code
          ? "/api/a-share/special-data/anomaly-analysis-stock"
          : "/api/a-share/special-data/anomaly-analysis-list";
        const params: Record<string, string> | undefined = args.code ? { thscodes: args.code } : (args.tags ? { tag_codes: args.tags } : undefined);
        const data: any = await fuyaoGet(path, params);
        if (!data.item?.length) return args.code ? "该股票今日无异动" : "今日无异动数据";
        return data.item.slice(0, 20).map((i: any) =>
          `${i.stock_name}(${i.thscode}) [${i.tag_name}] 关键词:${i.keyword_list?.join("/")}\n${i.analysis_content?.slice(0, 150)}`
        ).join('\n---\n');
      }
      case "get_limit_up_pool": {
        const { fuyaoGet } = await import("@/lib/fuyao");
        const data: any = await fuyaoGet("/api/a-share/special-data/limit-up-pool");
        if (!data.item?.length) return "今日无涨停股票";
        return `今日涨停${data.item.length}只:\n` + data.item.map((i: any) =>
          `${i.continue_day_text} ${i.name}(${i.ticker}) 涨停时间${i.limit_up_time} 原因:${i.limit_up_reason}`
        ).join('\n');
      }
      case "get_hot_stocks": {
        const { fuyaoGet } = await import("@/lib/fuyao");
        const [hot, skyrocket]: any[] = await Promise.all([
          fuyaoGet("/api/a-share/special-data/hot-stock-list", { level: "24h" }),
          fuyaoGet("/api/a-share/special-data/skyrocket-list", { level: "1h" }),
        ]);
        const hotStr = hot.item?.slice(0, 10).map((i: any) => `${i.rank}.${i.name}(${i.ticker}) 热度${i.heat} ${i.rank_trend}`).join('; ');
        const skyStr = skyrocket.item?.slice(0, 10).map((i: any) => `${i.rank}.${i.name}(${i.ticker}) 飙升${i.rank_change > 0 ? '+' : ''}${i.rank_change}名`).join('; ');
        return `热股Top10: ${hotStr}\n飙升Top10: ${skyStr}`;
      }
      case "get_fund_holdings": {
        const { fuyaoGet } = await import("@/lib/fuyao");
        const fundType = args.code.endsWith(".OF") ? "otc" : "exchange";
        const data: any = await fuyaoGet("/api/fund/portfolio/holdings", { fund_type: fundType, thscode: args.code });
        if (!data.item?.length) return `未找到 ${args.code} 的持仓数据`;
        return `前${data.item.length}大重仓股: ` + data.item.map((h: any) => `${h.stock_name}(${h.hold_ratio.toFixed(2)}%)`).join('、');
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (e: any) {
    return `工具执行失败: ${e.message}`;
  }
}
