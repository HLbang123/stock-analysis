import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * 复盘日历只读接口（数据源 review_calendar_days / index_daily，均为预计算小表）
 * GET /api/review-calendar?month=2026-08   → 该月逐日（格子着色 + 图例数据 + 冰点历史统计）
 * GET /api/review-calendar?date=20260825    → 单日详情（含三大指数）
 */

// 冰点等级 → 其后 1/5/20 个交易日上证表现的历史统计（纯历史事实，非预测）
async function computeForwardStats() {
  const days = await prisma.$queryRawUnsafe<{ trade_date: string; ice_level: string | null }[]>("SELECT trade_date, ice_level FROM review_calendar_days ORDER BY trade_date");
  const closes = await prisma.$queryRawUnsafe<{ trade_date: string; close: number | null }[]>("SELECT trade_date, close FROM index_daily WHERE ts_code = '000001.SH' ORDER BY trade_date");
  const valid = closes.filter((c) => c.close != null);
  const dates = valid.map((c) => c.trade_date);
  const idx = new Map(dates.map((d, i) => [d, i]));
  const close = new Map(valid.map((c) => [c.trade_date, Number(c.close)]));
  const levels = ["极冰", "接近冰点"];
  const horizons = [1, 5, 20];
  const out: Record<string, any> = {};
  for (const lv of levels) {
    const rows = days.filter((d) => d.ice_level === lv);
    out[lv] = { n: rows.length, fwd: {} as Record<number, { n: number; winRate: number | null; mean: number | null }> };
    for (const h of horizons) {
      const rets: number[] = [];
      for (const d of rows) {
        const i = idx.get(d.trade_date);
        if (i == null || i + h >= dates.length) continue;
        const c0 = close.get(dates[i]);
        const c1 = close.get(dates[i + h]);
        if (c0 && c1) rets.push(c1 / c0 - 1);
      }
      const n = rets.length;
      out[lv].fwd[h] = {
        n,
        winRate: n ? Math.round((rets.filter((r) => r > 0).length / n) * 1000) / 10 : null,
        mean: n ? Math.round((rets.reduce((a, b) => a + b, 0) / n) * 10000) / 100 : null,
      };
    }
  }
  return out;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const month = url.searchParams.get("month");
    const date = url.searchParams.get("date");

    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "month 格式应为 YYYY-MM" }, { status: 400 });
      const start = month.replace("-", "") + "01";
      const [y, m] = month.split("-").map(Number);
      const end = month.replace("-", "") + String(new Date(y, m, 0).getDate()).padStart(2, "0");
      const rows = await prisma.$queryRawUnsafe<any[]>("SELECT trade_date, advance, decline, flat, limit_up, limit_down, total_amount, volume_ratio, idx_pct_chg, is_ice_point, ice_level, ice_confidence, regime, regime_day FROM review_calendar_days WHERE trade_date >= $1 AND trade_date <= $2 ORDER BY trade_date", start, end);
      const days = rows.map((r) => ({
        date: r.trade_date,
        advance: r.advance, decline: r.decline, flat: r.flat,
        limitUp: r.limit_up, limitDown: r.limit_down,
        amountYi: r.total_amount != null ? Math.round((Number(r.total_amount) / 1e5) * 100) / 100 : null, // 亿元
        volumeRatio: r.volume_ratio != null ? Number(r.volume_ratio) : null,
        idxPctChg: r.idx_pct_chg != null ? Number(r.idx_pct_chg) : null,
        isIcePoint: !!r.is_ice_point,
        iceLevel: r.ice_level, iceConfidence: r.ice_confidence,
        regime: r.regime, regimeDay: r.regime_day,
      }));
      const forwardStats = await computeForwardStats();
      return NextResponse.json({ code: 0, data: { year: y, month: m, days, forwardStats } });
    }

    if (date) {
      if (!/^\d{8}$/.test(date)) return NextResponse.json({ error: "date 格式应为 YYYYMMDD" }, { status: 400 });
      const rows = await prisma.$queryRawUnsafe<any[]>("SELECT trade_date, advance, decline, flat, limit_up, limit_down, total_amount, amount_ma20, volume_ratio, vol_pctile_60d, vol_pctile_120d, up_pctile_60d, up_pctile_120d, idx_pct_chg, is_ice_point, ice_level, ice_confidence, regime, regime_day FROM review_calendar_days WHERE trade_date = $1", date);
      if (!rows.length) return NextResponse.json({ code: 0, data: null });
      const r = rows[0];
      const idx = await prisma.$queryRawUnsafe<any[]>("SELECT ts_code, close, pct_chg FROM index_daily WHERE trade_date = $1 AND ts_code IN ('000001.SH','399001.SZ','399006.SZ') ORDER BY ts_code", date);
      const nameOf: Record<string, string> = { "000001.SH": "上证指数", "399001.SZ": "深证成指", "399006.SZ": "创业板指" };
      return NextResponse.json({
        code: 0,
        data: {
          date: r.trade_date,
          advance: r.advance, decline: r.decline, flat: r.flat,
          limitUp: r.limit_up, limitDown: r.limit_down,
          amountYi: r.total_amount != null ? Math.round((Number(r.total_amount) / 1e5) * 100) / 100 : null,
          volumeRatio: r.volume_ratio != null ? Number(r.volume_ratio) : null,
          volPctile60d: r.vol_pctile_60d != null ? Number(r.vol_pctile_60d) : null,
          volPctile120d: r.vol_pctile_120d != null ? Number(r.vol_pctile_120d) : null,
          upPctile60d: r.up_pctile_60d != null ? Number(r.up_pctile_60d) : null,
          upPctile120d: r.up_pctile_120d != null ? Number(r.up_pctile_120d) : null,
          idxPctChg: r.idx_pct_chg != null ? Number(r.idx_pct_chg) : null,
          isIcePoint: !!r.is_ice_point, iceLevel: r.ice_level, iceConfidence: r.ice_confidence,
          regime: r.regime, regimeDay: r.regime_day,
          indices: idx.map((x) => ({ code: x.ts_code, name: nameOf[x.ts_code] ?? x.ts_code, close: x.close != null ? Number(x.close) : null, pctChg: x.pct_chg != null ? Number(x.pct_chg) : null })),
        },
      });
    }

    return NextResponse.json({ error: "缺少 month 或 date 参数" }, { status: 400 });
  } catch (e: any) {
    console.error("[api/review-calendar]", e);
    return NextResponse.json({ error: e.message || "查询失败" }, { status: 500 });
  }
}
