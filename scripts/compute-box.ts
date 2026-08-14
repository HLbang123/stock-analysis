/**
 * 吸筹箱体预计算（每日，由 run-daily 调用；形态逻辑单一事实源 = lib/box.ts）
 *
 * 全市场 active 标的 × 60 交易日窗口，每天产出两类行落 stock_box：
 *   in_box/box_quality/box_pos：窗口含当日 ——「当前在箱体内」状态（扫描器 box=in）
 *   breakout：窗口不含当日，今日收盘 > 箱顶×1.001 且 量 ≥1.6×箱体均量 且 涨幅 2~9.5%
 *             （译自 a-share-accumulation-breakout 的突破确认；涨幅上限防追涨停，
 *               20cm 标的会被 9.5% 上限挡掉，属保守口径）
 * 只落 in_box 或 breakout 的行（表保持小）；扫描器 JOIN 过滤，无行 = 不满足。
 * 前复权：close/high/low × adj_factor / 窗口内最新因子（箱体判定只用窗口内比值，常量缩放无关）。
 *
 * 运行：npx tsx scripts/compute-box.ts [--init | --backfill=N]
 *   默认只算最新交易日；--init 回补近 60 个交易日；--backfill=N 回补近 N 个（全量约 2500，一次性）
 */

import { prisma } from "../lib/db";
import { boxFeatures } from "../lib/box";

const WINDOW = 60;
const BATCH = 300; // 每批标的数（回补深历史时控制单次查询体量）

/** 本地时区格式化 YYYYMMDD（不用 toISOString，避免 UTC+8 推前一天） */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** tradeDate(YYYYMMDD) 往前 n 日历日 */
function daysBefore(tradeDate: string, n: number): string {
  const d = new Date(parseInt(tradeDate.slice(0, 4)), parseInt(tradeDate.slice(4, 6)) - 1, parseInt(tradeDate.slice(6, 8)));
  d.setDate(d.getDate() - n);
  return fmtDate(d);
}

interface Bar { c: number; h: number; l: number; v: number }

interface BoxRow {
  tsCode: string;
  tradeDate: string;
  inBox: boolean;
  boxQuality: number | null;
  boxPos: number | null;
  boxTop: number | null;
  boxBottom: number | null;
  breakout: boolean;
}

/** 单标的单日判定：i 为当日在 bars 中的下标（bars 升序、已前复权） */
function evalDay(bars: Bar[], i: number): Omit<BoxRow, "tsCode" | "tradeDate"> | null {
  if (i < WINDOW) return null; // 至少需要 60 根历史 + 当日
  const winC = bars.slice(i - WINDOW + 1, i + 1);
  const closes = winC.map((b) => b.c);
  const highs = winC.map((b) => b.h);
  const lows = winC.map((b) => b.l);

  const now = boxFeatures(closes, highs, lows, WINDOW);

  // 突破判定：箱体窗口不含今日（锚定突破日前，防突破K线自身污染箱顶）
  let breakout = false;
  const prevWin = bars.slice(i - WINDOW, i);
  const prevCloses = prevWin.map((b) => b.c);
  const prevBox = boxFeatures(prevCloses, prevWin.map((b) => b.h), prevWin.map((b) => b.l), WINDOW);
  if (prevBox.inBox && prevBox.boxTop != null) {
    const today = bars[i];
    const avgV = prevWin.reduce((a, b) => a + b.v, 0) / prevWin.length;
    const chg = prevCloses[prevCloses.length - 1] > 0
      ? (today.c / prevCloses[prevCloses.length - 1] - 1) * 100
      : 0;
    breakout = today.c > prevBox.boxTop * 1.001 && avgV > 0 && today.v >= avgV * 1.6 && chg >= 2 && chg <= 9.5;
  }

  if (!now.inBox && !breakout) return null; // 只落有效行
  return {
    inBox: now.inBox,
    boxQuality: now.boxQuality,
    boxPos: now.boxPos,
    boxTop: now.boxTop,
    boxBottom: now.boxBottom,
    breakout,
  };
}

async function main() {
  const isInit = process.argv.includes("--init");
  const backfillArg = process.argv.find((a) => a.startsWith("--backfill="));
  const backfillN = backfillArg ? parseInt(backfillArg.split("=")[1]) : 0;

  // 需要计算的交易日列表（升序处理）
  const nDates = backfillN > 0 ? backfillN : isInit ? 60 : 1;
  const dateRows: { tradeDate: string }[] = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "tradeDate" FROM daily_bars ORDER BY "tradeDate" DESC LIMIT ${Math.max(1, nDates)}`
  );
  const dates = dateRows.map((r) => r.tradeDate).sort();
  if (dates.length === 0) { console.log("[box] 无日线数据"); return; }

  const stocks = await prisma.stock.findMany({ where: { isActive: true }, select: { tsCode: true }, orderBy: { tsCode: "asc" } });
  // 数据窗口：最早目标日往前 100 日历日（覆盖 60 交易日窗口 + 缓冲）
  const dataStart = daysBefore(dates[0], 100);

  console.log(`[box] ${dates.length} 个交易日（${dates[0]}~${dates[dates.length - 1]}）× ${stocks.length} 只`);

  let totalRows = 0;
  for (let b0 = 0; b0 < stocks.length; b0 += BATCH) {
    const batch = stocks.slice(b0, b0 + BATCH).map((s) => s.tsCode);
    const bars = await prisma.dailyBar.findMany({
      where: { tsCode: { in: batch }, tradeDate: { gte: dataStart, lte: dates[dates.length - 1] } },
      select: { tsCode: true, tradeDate: true, close: true, high: true, low: true, vol: true, adjFactor: true },
      orderBy: [{ tsCode: "asc" }, { tradeDate: "asc" }],
    });

    // 分组 + 前复权归一（× adj_factor / 窗口内最新因子）+ 日期→下标索引
    const byStock = new Map<string, { bars: Bar[]; idx: Map<string, number> }>();
    const rawByStock = new Map<string, { date: string; c: number; h: number; l: number; v: number; adj: number }[]>();
    for (const b of bars) {
      if (b.close == null || b.vol == null) continue;
      let arr = rawByStock.get(b.tsCode);
      if (!arr) { arr = []; rawByStock.set(b.tsCode, arr); }
      arr.push({ date: b.tradeDate, c: b.close, h: b.high ?? b.close, l: b.low ?? b.close, v: b.vol, adj: b.adjFactor ?? 1 });
    }
    for (const [code, arr] of rawByStock) {
      const latestAdj = arr[arr.length - 1].adj || 1;
      const bars2: Bar[] = [];
      const idx = new Map<string, number>();
      for (const r of arr) {
        idx.set(r.date, bars2.length);
        bars2.push({ c: (r.c * r.adj) / latestAdj, h: (r.h * r.adj) / latestAdj, l: (r.l * r.adj) / latestAdj, v: r.v });
      }
      byStock.set(code, { bars: bars2, idx });
    }

    // 逐日逐股判定，按日批量落库（先删后插，可重跑）
    for (const date of dates) {
      const rows: BoxRow[] = [];
      for (const [code, s] of byStock) {
        const i = s.idx.get(date);
        if (i == null) continue;
        const r = evalDay(s.bars, i);
        if (r) rows.push({ tsCode: code, tradeDate: date, ...r });
      }
      if (rows.length > 0 || dates.length === 1) {
        await prisma.stockBox.deleteMany({ where: { tradeDate: date, tsCode: { in: batch } } });
        if (rows.length > 0) await prisma.stockBox.createMany({ data: rows });
      }
      totalRows += rows.length;
    }
    console.log(`[box] 批次 ${Math.min(b0 + BATCH, stocks.length)}/${stocks.length} 完成，累计 ${totalRows} 行`);
  }

  console.log(`[box] 完成：${dates.length} 日 × ${stocks.length} 只 → ${totalRows} 行`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[box] 失败:", e);
  prisma.$disconnect().then(() => process.exit(1));
});
