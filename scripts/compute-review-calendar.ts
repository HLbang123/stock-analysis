/**
 * 复盘日历日级快照计算（Phase 0 数据验证核心脚本）
 * 把 daily_bars(1080 万行) 一次 GROUP BY 压成 review_calendar_days(约 2497 行)，
 * 在小表上算 20 日均量 / 60·120 日分位 / 量能冰点（硬规则，对标 fupanhui）。
 *
 * 用法：
 *   npx tsx scripts/compute-review-calendar.ts --days 60   # 小窗试跑（近 60 自然日）
 *   npx tsx scripts/compute-review-calendar.ts --init      # 全量 20160506→今天
 *   npx tsx scripts/compute-review-calendar.ts             # 默认增量（近 10 自然日）
 */

import { prisma } from "../lib/db";

const FULL_START = "20160506";
const pad = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: Date) => String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate());

interface DayRow {
  trade_date: string;
  total_amount: number | null;
  advance: number; decline: number; flat: number;
  limit_up: number; limit_down: number;
  avg_change_pct: number | null;
}

async function fetchDaily(start: string): Promise<DayRow[]> {
  // 单次 GROUP BY，日期边界必带；只回 2497 行进 JS，内存安全
  const rows = await prisma.$queryRawUnsafe<DayRow[]>(
    'SELECT "tradeDate" AS trade_date, ' +
    'SUM(amount) AS total_amount, ' +
    'COUNT(*) FILTER (WHERE change_pct > 0)::int AS advance, ' +
    'COUNT(*) FILTER (WHERE change_pct < 0)::int AS decline, ' +
    'COUNT(*) FILTER (WHERE change_pct = 0)::int AS flat, ' +
    'COUNT(*) FILTER (WHERE change_pct >= 9.5)::int AS limit_up, ' +
    'COUNT(*) FILTER (WHERE change_pct <= -9.5)::int AS limit_down, ' +
    'AVG(change_pct) FILTER (WHERE change_pct IS NOT NULL) AS avg_change_pct ' +
    'FROM daily_bars ' +
    'WHERE "tradeDate" >= $1 AND amount IS NOT NULL ' +
    'GROUP BY "tradeDate" ORDER BY "tradeDate"',
    start
  );
  return rows;
}

async function fetchIdx(start: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRawUnsafe<{ trade_date: string; pct_chg: number | null }[]>("SELECT trade_date, pct_chg FROM index_daily WHERE ts_code = '000001.SH' AND trade_date >= $1 ORDER BY trade_date", start);
  const m = new Map<string, number>();
  for (const r of rows) if (r.pct_chg != null) m.set(r.trade_date, r.pct_chg);
  return m;
}

// 分位：value 在 window 内（不含自身）的百分位排名 0~100
function percentile(win: number[], v: number): number {
  if (win.length === 0) return 0;
  let below = 0;
  for (const x of win) if (x < v) below++;
  return (below / win.length) * 100;
}

function iceLevel(vr: number, idxPct: number | null): { level: string | null; ice: boolean; conf: string | null } {
  if (vr == null || !Number.isFinite(vr)) return { level: null, ice: false, conf: null };
  const near = (v: number, t: number) => Math.abs(v - t) < 0.005; // 0.5pct 内
  // 极冰 规则1：量能比 < 78%
  if (vr < 0.78) {
    return { level: "极冰", ice: true, conf: near(vr, 0.78) ? "medium" : "high" };
  }
  // 极冰 规则2：量能比 <= 90% 且 上证跌 <= -3%
  if (idxPct != null && vr <= 0.90 && idxPct <= -3) {
    const conf = near(vr, 0.90) || near(idxPct, -3) ? "medium" : "high";
    return { level: "极冰", ice: true, conf };
  }
  // 接近冰点：[78%, 85%)
  if (vr < 0.85) {
    const conf = near(vr, 0.78) || near(vr, 0.85) ? "medium" : "high";
    return { level: "接近冰点", ice: true, conf };
  }
  // 偏冷：[85%, 100%)，非冰点
  if (vr < 1.0) return { level: "偏冷", ice: false, conf: null };
  return { level: null, ice: false, conf: null };
}

async function main() {
  const arg = process.argv[2];
  const daysIdx = process.argv.indexOf("--days");
  const isInit = arg === "--init";
  const today = dateStr(new Date());

  let start: string;
  let writeFrom: string;
  if (isInit) {
    start = FULL_START;
    writeFrom = FULL_START;
    console.log("[review-calendar] --init 全量 " + FULL_START + " → " + today);
  } else {
    const n = daysIdx >= 0 && process.argv[daysIdx + 1] ? parseInt(process.argv[daysIdx + 1], 10) : 10;
    const w = new Date(Date.now() - n * 86400000);
    writeFrom = dateStr(w);
    const lookback = new Date(w.getTime() - 160 * 86400000);
    start = dateStr(lookback);
    console.log("[review-calendar] 小窗 近 " + n + " 天（回看自 " + start + "）");
  }

  const days = await fetchDaily(start);
  const idxMap = await fetchIdx(start);
  console.log("[review-calendar] 日级序列 " + days.length + " 行，指数匹配 " + idxMap.size + " 天");

  const amountHist: number[] = [];
  const upHist: number[] = [];
  const out: any[] = [];
  for (const d of days) {
    const amt = d.total_amount;
    let ma20: number | null = null;
    let vr: number | null = null;
    if (amt != null) {
      if (amountHist.length >= 20) {
        const win = amountHist.slice(-20);
        ma20 = win.reduce((a, b) => a + b, 0) / 20;
        vr = ma20 > 0 ? amt / ma20 : null;
      }
      amountHist.push(amt);
    }
    const up = d.advance;
    upHist.push(up);
    const idxPct = idxMap.get(d.trade_date) ?? null;
    const ice = vr != null ? iceLevel(vr, idxPct) : { level: null, ice: false, conf: null };
    out.push({
      trade_date: d.trade_date,
      total_amount: amt,
      advance: d.advance, decline: d.decline, flat: d.flat,
      limit_up: d.limit_up, limit_down: d.limit_down,
      amount_ma20: ma20,
      volume_ratio: vr,
      vol_pctile_60d: amt != null ? percentile(amountHist.slice(-61, -1), amt) : null,
      vol_pctile_120d: amt != null ? percentile(amountHist.slice(-121, -1), amt) : null,
      up_pctile_60d: percentile(upHist.slice(-61, -1), up),
      up_pctile_120d: percentile(upHist.slice(-121, -1), up),
      idx_pct_chg: idxPct,
      is_ice_point: ice.ice,
      ice_level: ice.level,
      ice_confidence: ice.conf,
    });
  }

  const toWrite = out.filter((r) => r.trade_date >= writeFrom);
  let idxMissing = 0;
  for (const r of toWrite) if (r.idx_pct_chg == null) idxMissing++;
  console.log("[review-calendar] 待写入 " + toWrite.length + " 行，其中指数缺失 " + idxMissing + " 天（冰点规则2跳过）");

  await upsertDays(toWrite);
  await prisma.$executeRawUnsafe("ANALYZE review_calendar_days");
  console.log("[review-calendar] 完成，写入 " + toWrite.length + " 行并 ANALYZE");
  await prisma.$disconnect();
}

async function upsertDays(rows: any[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: any[] = [];
    for (const r of batch) {
      const b = params.length;
      values.push("($" + (b + 1) + ",$" + (b + 2) + ",$" + (b + 3) + ",$" + (b + 4) + ",$" + (b + 5) + ",$" + (b + 6) + ",$" + (b + 7) + ",$" + (b + 8) + ",$" + (b + 9) + ",$" + (b + 10) + ",$" + (b + 11) + ",$" + (b + 12) + ",$" + (b + 13) + ",$" + (b + 14) + ",$" + (b + 15) + ",$" + (b + 16) + ",$" + (b + 17) + ")");
      params.push(
        r.trade_date, r.total_amount, r.advance, r.decline, r.flat, r.limit_up, r.limit_down,
        r.amount_ma20, r.volume_ratio, r.vol_pctile_60d, r.vol_pctile_120d,
        r.up_pctile_60d, r.up_pctile_120d, r.idx_pct_chg, r.is_ice_point, r.ice_level, r.ice_confidence
      );
      void b;
    }
    await prisma.$executeRawUnsafe(
      "INSERT INTO review_calendar_days (trade_date, total_amount, advance, decline, flat, limit_up, limit_down, amount_ma20, volume_ratio, vol_pctile_60d, vol_pctile_120d, up_pctile_60d, up_pctile_120d, idx_pct_chg, is_ice_point, ice_level, ice_confidence) VALUES " + values.join(", ") + " ON CONFLICT (trade_date) DO UPDATE SET total_amount=EXCLUDED.total_amount, advance=EXCLUDED.advance, decline=EXCLUDED.decline, flat=EXCLUDED.flat, limit_up=EXCLUDED.limit_up, limit_down=EXCLUDED.limit_down, amount_ma20=EXCLUDED.amount_ma20, volume_ratio=EXCLUDED.volume_ratio, vol_pctile_60d=EXCLUDED.vol_pctile_60d, vol_pctile_120d=EXCLUDED.vol_pctile_120d, up_pctile_60d=EXCLUDED.up_pctile_60d, up_pctile_120d=EXCLUDED.up_pctile_120d, idx_pct_chg=EXCLUDED.idx_pct_chg, is_ice_point=EXCLUDED.is_ice_point, ice_level=EXCLUDED.ice_level, ice_confidence=EXCLUDED.ice_confidence",
      ...params
    );
  }
}

main().catch(async (e) => {
  console.error("[review-calendar] 失败:", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
