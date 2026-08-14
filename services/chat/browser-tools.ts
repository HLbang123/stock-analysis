/**
 * AI 对话工具执行 — 浏览器直连版（镜像 lib/chat-tools.ts executeTool）
 *
 * 直连时服务器不再接触 LLM 请求，工具数据改由浏览器直接调自己的 /api 接口拿
 * （同域 + cookie 鉴权，与页面其它请求一致）。DB 直查的两处（search_stock /
 * get_stock_history）已接口化为 /api/stock/search、/api/stock/history。
 * 输出文本格式与服务器版完全一致，LLM 消费无感。
 */

/** 同域 fetch 的简化封装：失败抛错，正常返回 JSON */
async function getJSONAny<T = any>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw new Error(d?.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function executeToolBrowser(name: string, args: any): Promise<string> {
  try {
    switch (name) {
      case "search_stock": {
        const d = await getJSONAny<{ items?: { ts_code: string; name: string; industry: string | null }[] }>(
          `/api/stock/search?keyword=${encodeURIComponent(args.keyword)}`
        );
        const rows = d.items || [];
        if (!rows.length) return `未找到"${args.keyword}"相关股票`;
        return rows.map((r) => {
          const m = r.ts_code?.match(/^(\d+)\.(SH|SZ|BJ)$/);
          const code = m ? `${m[2].toLowerCase()}${m[1]}` : r.ts_code;
          return `${r.name}(${code}) 行业:${r.industry || "未知"}`;
        }).join("; ");
      }
      case "get_stock_quote": {
        const d = await getJSONAny<any>(`/api/quote?code=${encodeURIComponent(args.code)}`);
        if (d.error) return `获取行情失败: ${d.error}`;
        return `${d.name}(${d.code}) 当前价${d.price} 涨跌${d.changePercent?.toFixed(2)}% 开${d.open} 高${d.high} 低${d.low} 昨收${d.preClose} 量${d.volume} 额${d.amount}`;
      }
      case "get_stock_kline": {
        const days = args.days || 20;
        const d = await getJSONAny<any[]>(`/api/kline?code=${encodeURIComponent(args.code)}&scale=240&days=${days}`);
        if ((d as any).error) return `获取K线失败: ${(d as any).error}`;
        const bars = (Array.isArray(d) ? d : []).slice(-days);
        return `近${bars.length}日K线(日期 开高低调收量):\n${bars.map((b: any) => `${b.date} ${b.open} ${b.high} ${b.low} ${b.close} ${b.volume}`).join('\n')}`;
      }
      case "get_stock_fundamentals": {
        const d = await getJSONAny<any>(`/api/tushare/stock-data?code=${encodeURIComponent(args.code)}`);
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
        const d = await getJSONAny<any>(`/api/stock/rps?code=${encodeURIComponent(args.code)}`);
        if (d.error) return `获取RPS失败: ${d.error}`;
        return `RPS(${d.calcDate}): 20日=${d.rps20?.toFixed(1)} 60日=${d.rps60?.toFixed(1)} 120日=${d.rps120?.toFixed(1)} 250日=${d.rps250?.toFixed(1)} 250日涨幅=${d.ret250?.toFixed(1)}%`;
      }
      case "get_market_breadth": {
        const days = args.days || 3;
        const d = await getJSONAny<{ items?: any[] }>(`/api/market/breadth?days=${days}`);
        const rows = d.items || [];
        if (!rows.length) return "无市场宽度数据";
        return rows.map((r) => `${r.trade_date}: 涨${r.advance} 跌${r.decline} 涨停${r.limit_up} 跌停${r.limit_down} MA55上方${r.above_ma55_ratio}% RPS60改善占比${r.rps_improve_ratio}%`).join('\n');
      }
      case "get_stock_history": {
        const d = await getJSONAny<{ row?: any | null; error?: string }>(`/api/stock/history?code=${encodeURIComponent(args.code)}&date=${encodeURIComponent(args.date)}`);
        if (d.error) return `查询失败: ${d.error}`;
        const r = d.row;
        if (!r) return `无 ${args.date} 的日线数据（可能未同步或非交易日）`;
        return `${args.date}: 开${r.open} 高${r.high} 低${r.low} 收${r.close} 昨收${r.preClose} 涨跌幅${r.changePct?.toFixed(2)}% 量${r.vol}`;
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
        const d = await getJSONAny<{ count: number; items: any[]; error?: string }>(`/api/scan?${params}`);
        if (d.error) return `扫描失败: ${d.error}`;
        return `扫描到${d.count}只: ` + d.items.map((s, i) => `${i + 1}.${s.name}(${s.tsCode.replace(/\.(SH|SZ|BJ)$/, '')}) RPS${s.rps?.toFixed(1)} 涨跌${s.latestChange?.toFixed(1)}%`).join('; ');
      }
      case "get_anomaly_reason": {
        const path = args.code
          ? `/api/fuyao/anomaly?code=${encodeURIComponent(args.code)}`
          : `/api/fuyao/anomaly?tags=${encodeURIComponent(args.tags || '')}`;
        const d = await getJSONAny<{ item?: any[] }>(path);
        if (!d.item?.length) return args.code ? "该股票今日无异动" : "今日无异动数据";
        return d.item.slice(0, 20).map((i: any) =>
          `${i.stock_name}(${i.thscode}) [${i.tag_name}] 关键词:${i.keyword_list?.join("/")}\n${i.analysis_content?.slice(0, 150)}`
        ).join('\n---\n');
      }
      case "get_limit_up_pool": {
        const d = await getJSONAny<{ pool?: { item?: any[] } }>('/api/fuyao/limit-up');
        const items = d.pool?.item || [];
        if (!items.length) return "今日无涨停股票";
        return `今日涨停${items.length}只:\n` + items.map((i: any) =>
          `${i.continue_day_text} ${i.name}(${i.ticker}) 涨停时间${i.limit_up_time} 原因:${i.limit_up_reason}`
        ).join('\n');
      }
      case "get_hot_stocks": {
        const d = await getJSONAny<{ hot?: { item?: any[] }; skyrocket?: { item?: any[] } }>('/api/fuyao/hot-stocks?level=24h');
        const hotStr = d.hot?.item?.slice(0, 10).map((i: any) => `${i.rank}.${i.name}(${i.ticker}) 热度${i.heat} ${i.rank_trend}`).join('; ');
        const skyStr = d.skyrocket?.item?.slice(0, 10).map((i: any) => `${i.rank}.${i.name}(${i.ticker}) 飙升${i.rank_change > 0 ? '+' : ''}${i.rank_change}名`).join('; ');
        return `热股Top10: ${hotStr}\n飙升Top10: ${skyStr}`;
      }
      case "get_dragon_tiger": {
        const qs = new URLSearchParams();
        qs.set("board", args.board || "all");
        if (args.code) qs.set("code", args.code);
        if (args.date) qs.set("date", args.date);
        const d = await getJSONAny<any>(`/api/fuyao/dragon-tiger?${qs}`);
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
        const d = await getJSONAny<{ holdings?: any[] }>(`/api/fuyao/fund?code=${encodeURIComponent(args.code)}`);
        if (!d.holdings?.length) return `未找到 ${args.code} 的持仓数据`;
        return `前${d.holdings.length}大重仓股: ` + d.holdings.map((h: any) => `${h.stock_name}(${h.hold_ratio.toFixed(2)}%)`).join('、');
      }
      case "get_chip_distribution": {
        const d = await getJSONAny<any>(`/api/chip?code=${encodeURIComponent(args.code)}`);
        if (d.error) return `无 ${args.code} 的筹码数据（需≥5根含换手率的日线，可能历史未回补）`;
        return `${args.code} 筹码分布：\n主峰价位: ${d.dominantPeak} | 平均成本: ${d.avgCost} | 获利盘: ${(d.profitRatio * 100).toFixed(1)}% | 90%集中度: ${d.concentration90.toFixed(3)}（越小越密集） | 峰位相对位置: ${d.peakPos.toFixed(3)}（站上主峰为正） | 5日峰位漂移: ${d.peakDrift.toFixed(3)}（下移为吸筹）`;
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (e: any) {
    return `工具执行失败: ${e.message}`;
  }
}
