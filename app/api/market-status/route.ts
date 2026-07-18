/**
 * 获取当日市场状态（含 Tushare 交易日历校验）
 * GET /api/market-status
 */
import { NextResponse } from "next/server";
import { isTradeDay } from "@/lib/tushare";

export async function GET() {
  try {
    const now = new Date();
    const ds = now.toISOString().slice(0, 10).replace(/-/g, "");
    const isTrade = await isTradeDay(ds);

    const day = now.getDay();
    const h = now.getHours();
    const m = now.getMinutes();
    const time = h * 60 + m;

    let isOpen = false;
    let note = "";

    if (!isTrade) {
      const isWeekend = day === 0 || day === 6;
      note = isWeekend ? "今天是周末，A股休市。以下数据为最近交易日收盘数据。" : "今日节假日休市。以下数据为最近交易日收盘数据。";
    } else if (time >= 570 && time < 690) {
      isOpen = true;
      note = "当前A股正在交易中（上午盘），价格仍在实时波动，今日K线尚未定型。";
    } else if (time >= 780 && time < 900) {
      isOpen = true;
      note = "当前A股正在交易中（下午盘），价格仍在实时波动，今日K线尚未定型。";
    } else if (time < 570) {
      note = "当前为盘前时段，A股尚未开盘。以下数据为最近交易日收盘数据。";
    } else if (time >= 690 && time < 780) {
      note = "当前为午间休市时段。上午交易已结束，下午将于13:00开盘。";
    } else {
      note = "A股已收盘。以下数据为今日最终收盘数据。";
    }

    return NextResponse.json({ isOpen, note });
  } catch {
    // 降级：仅周末判断
    const now = new Date();
    const day = now.getDay();
    const isWeekend = day === 0 || day === 6;
    return NextResponse.json({
      isOpen: false,
      note: isWeekend ? "今天是周末，A股休市。" : "以下数据为最近交易日收盘数据。",
    });
  }
}
