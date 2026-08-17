
/**
 * AI 对话工具执行（服务器版）— 浏览器直连版见 services/chat/browser-tools.ts
 * 工具定义（纯数据）从 lib/chat-tools-defs.ts re-export，供浏览器直连复用。
 */
export { CHAT_TOOLS } from '@/lib/chat-tools-defs';

/** 执行工具调用，返回简洁文本结果（给 LLM 处理）
 *  userContext：自选/预警等只存在浏览器本地的数据，服务器中转时由客户端随请求体捎来的快照文本 */
export async function executeTool(
  name: string,
  args: any,
  origin: string,
  userContext?: { watchlistContext?: string; alertsContext?: string },
): Promise<string> {
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
      case "get_stock_fundamentals": {
        const r = await fetch(`${origin}/api/tushare/stock-data?code=${encodeURIComponent(args.code)}`);
        const d = await r.json();
        if (d.error) return `获取基本面失败: ${d.error}`;
        const data = d.data;
        const db = data?.dailyBasic?.[0];
        const fi = data?.finaIndicator?.[0];
        const hk = data?.hkHold?.[0];
        const parts: string[] = [];
        if (db?.pe_ttm != null) parts.push(`PE ${db.pe_ttm.toFixed(1)}`);
        if (db?.pb != null) parts.push(`PB ${db.pb.toFixed(2)}`);
        if (fi?.roe != null) parts.push(`ROE ${fi.roe.toFixed(1)}%`);
        if (fi?.or_yoy != null) parts.push(`营收增速${fi.or_yoy > 0 ? '+' : ''}${fi.or_yoy.toFixed(1)}%`);
        if (db?.total_mv != null) { const yi = db.total_mv / 10000; parts.push(`总市值${yi >= 1 ? yi.toFixed(1) + '亿' : db.total_mv.toFixed(0) + '万'}`); }
        if (hk?.hold_ratio != null) parts.push(`北向持股${hk.hold_ratio.toFixed(2)}%`);
        if (!parts.length) return `${args.code} 无基本面数据`;
        return `${args.code} 基本面：${parts.join(' | ')}`;
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
          `SELECT trade_date, advance, decline, limit_up, limit_down, above_ma55_ratio, rps_improve_ratio FROM market_breadth ORDER BY trade_date DESC LIMIT $1`, days
        );
        if (!rows.length) return "无市场宽度数据";
        return rows.map((r) => `${r.trade_date}: 涨${r.advance} 跌${r.decline} 涨停${r.limit_up} 跌停${r.limit_down} MA55上方${r.above_ma55_ratio}% RPS60改善占比${r.rps_improve_ratio}%`).join('\n');
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
      case "get_dragon_tiger": {
        const qs = new URLSearchParams();
        qs.set("board", args.board || "all");
        if (args.code) qs.set("code", args.code);
        if (args.date) qs.set("date", args.date);
        const r = await fetch(`${origin}/api/fuyao/dragon-tiger?${qs}`);
        const d = await r.json();
        if (d.error) return `龙虎榜查询失败: ${d.error}`;
        const fmtYi = (v?: number) => v == null ? "--" : `${v > 0 ? "+" : ""}${(v / 1e8).toFixed(2)}亿`;
        if (args.code) {
          const items = d.stock_items || [];
          const hm = (d.hot_money_items || []).filter((h: any) => h.rows?.length);
          if (!items.length && !hm.length) return `${args.code} 在 ${d.trade_date} 未上龙虎榜`;
          const lines = items.map((s: any) =>
            `${s.name}(${s.ticker}) [${s.range_days === 3 ? "3日榜" : "当日榜"}] 净买入${fmtYi(s.net_value)} 机构净买${fmtYi(s.org_net_value)}(买${s.org_buy_num ?? 0}家/卖${s.org_sell_num ?? 0}家) 游资净买${fmtYi(s.hot_money_net_value)} 人气${s.hot_rank ?? "--"}${s.limit_reason ? ` 原因:${s.limit_reason}` : ""}`
          );
          const hmLines = hm.map((h: any) => `游资 ${h.name}: ${h.rows.map((r: any) => `净买${fmtYi(r.hot_money_item_net_value)}`).join("")}`);
          return `龙虎榜 ${d.trade_date}:\n${[...lines, ...hmLines].join("\n")}`;
        }
        if (d.board_type === "hot_money") {
          const rows = (d.hot_money_items || []).slice(0, 15);
          if (!rows.length) return `${d.trade_date} 游资榜无数据`;
          return `游资榜 ${d.trade_date} Top${rows.length}:\n` + rows.map((h: any) =>
            `${h.name} 净买${fmtYi(h.buying)} → ${(h.rows || []).slice(0, 3).map((r: any) => `${r.name}(${fmtYi(r.hot_money_item_net_value)})`).join("、")}`
          ).join("\n");
        }
        const items = (d.stock_items || []).slice(0, 20);
        if (!items.length) return `${d.trade_date} 龙虎榜无数据`;
        const boardLabel = d.board_type === "org" ? "机构榜" : "龙虎榜";
        return `${boardLabel} ${d.trade_date} 共${d.stock_count}只,按净买入Top${items.length}:\n` + items.map((s: any) =>
          `${s.name}(${s.ticker}) 净买${fmtYi(s.net_value)} 机构${fmtYi(s.org_net_value)}(买${s.org_buy_num ?? 0}/卖${s.org_sell_num ?? 0}家) 人气${s.hot_rank ?? "--"}`
        ).join("\n");
      }
      case "get_fund_holdings": {
        const { fuyaoGet } = await import("@/lib/fuyao");
        const fundType = args.code.endsWith(".OF") ? "otc" : "exchange";
        const data: any = await fuyaoGet("/api/fund/portfolio/holdings", { fund_type: fundType, thscode: args.code });
        if (!data.item?.length) return `未找到 ${args.code} 的持仓数据`;
        return `前${data.item.length}大重仓股: ` + data.item.map((h: any) => `${h.stock_name}(${h.hold_ratio.toFixed(2)}%)`).join('、');
      }
      case "get_chip_distribution": {
        const { getChipDistribution, formatChipSummary } = await import("@/lib/chip");
        const chip = await getChipDistribution(args.code);
        if (!chip) return `无 ${args.code} 的筹码数据（需≥5根含换手率的日线，可能历史未回补）`;
        return `${args.code} 筹码分布：\n${formatChipSummary(chip)}`;
      }
      case "get_watchlist": {
        // 数据在浏览器本地，只能回客户端捎来的快照（无快照=老版本客户端/非对话入口）
        return userContext?.watchlistContext || "用户自选数据不可用（请升级到支持自选快照的客户端或使用浏览器直连模式）";
      }
      case "get_my_alerts": {
        return userContext?.alertsContext || "用户预警数据不可用（请升级到支持预警快照的客户端或使用浏览器直连模式）";
      }
      case "get_moneyflow": {
        const r = await fetch(`${origin}/api/tushare/stock-data?code=${encodeURIComponent(args.code)}`);
        const d = await r.json();
        const mf = d.data?.moneyflow || [];
        if (!mf.length) return `${args.code} 无主力资金数据`;
        const fmt = (v?: number) => (v == null ? '--' : `${v > 0 ? '+' : ''}${v.toFixed(0)}`);
        return `主力资金(近${mf.length}日,万元):\n` + mf.slice(0, 10).map((m: any) =>
          `${m.tradeDate} 净流入${fmt(m.netAmount)} 超大单${fmt(m.buyElgAmount)}(占${m.buyElgRate ?? 0}%) 大单${fmt(m.buyLgAmount)}(占${m.buyLgRate ?? 0}%)`
        ).join('\n');
      }
      case "get_holder_number": {
        const r = await fetch(`${origin}/api/tushare/stock-data?code=${encodeURIComponent(args.code)}`);
        const d = await r.json();
        const hn = d.data?.holderNumber || [];
        if (!hn.length) return `${args.code} 无股东户数数据`;
        return `股东户数(近${hn.length}期):\n` + hn.map((h: any) =>
          `${h.end_date} 户数${h.holder_num ?? '--'} 环比${h.holder_num_ratio != null ? `${h.holder_num_ratio > 0 ? '+' : ''}${h.holder_num_ratio}%` : '--'}`
        ).join('\n');
      }
      case "get_stock_box": {
        const r = await fetch(`${origin}/api/stock/box?code=${encodeURIComponent(args.code)}`);
        const d = await r.json();
        if (d.error) return `箱体查询失败: ${d.error}`;
        const b = d.row;
        if (!b) return `${args.code} 当前不在吸筹箱体中（且无最新突破记录）`;
        const parts: string[] = [`数据日${b.tradeDate}`];
        if (b.breakout) parts.push('已突破箱顶(放量突破)');
        else if (b.inBox) parts.push(`在箱体内 位置${b.boxPos != null ? (b.boxPos * 100).toFixed(0) + '%' : '--'} 质量${b.boxQuality != null ? b.boxQuality.toFixed(0) : '--'}`);
        parts.push(`箱顶${b.boxTop?.toFixed(2)} 箱底${b.boxBottom?.toFixed(2)}`);
        return `${args.code} 吸筹箱体：${parts.join(' ')}`;
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (e: any) {
    return `工具执行失败: ${e.message}`;
  }
}
