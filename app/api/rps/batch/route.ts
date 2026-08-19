/** GET /api/rps/batch?codes=sz000001,sh600519 — 批量最新 RPS60（自选页标签用，一次 SQL 查回全部）
 *  2026-08-17 修复：改 DISTINCT ON 每票只取最新一条。旧写法拉全历史再 JS 去重，
 *  10 年回补后 50 票×2350 天≈12 万行/请求，并发一多直接碾爆磁盘 IO（load 9 事故根因）。 */
export async function GET(request: Request) {
  const codes = new URL(request.url).searchParams.get("codes");
  if (!codes) return Response.json({ error: "缺少 codes" }, { status: 400 });

  const list = codes.split(",").map(s => s.trim()).filter(Boolean);
  const toTs = (c: string): string | null => {
    const m = c.match(/^([a-z]+)(\d+)$/i);
    return m ? `${m[2]}.${m[1].toUpperCase()}` : null;
  };
  const codeToTs = new Map<string, string>();
  for (const c of list) { const ts = toTs(c); if (ts) codeToTs.set(c, ts); }
  if (codeToTs.size === 0) return Response.json({ rps: {} });

  try {
    const { prisma } = await import("@/lib/db");
    // 每票一次主键 (tsCode, calcDate) 索引下探，O(log n) 取最新 rps_60。
    // 不用 DISTINCT ON + ANY：后者在大数组时会把每票 10 年历史全排序再取首行，
    // 且依赖统计信息选对计划——统计过期即退化全表扫（load 9 事故同源）。
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT r."tsCode", r.rps_60, r."calcDate"
       FROM unnest($1::text[]) AS c(ts_code)
       CROSS JOIN LATERAL (
         SELECT "tsCode", rps_60, "calcDate"
         FROM rps_scores
         WHERE "tsCode" = c.ts_code AND rps_60 IS NOT NULL
         ORDER BY "calcDate" DESC
         LIMIT 1
       ) r`,
      [...codeToTs.values()]
    );
    const latest = new Map<string, { rps60: number | null; calcDate: string }>();
    for (const r of rows) {
      latest.set(r.tsCode, {
        rps60: r.rps_60 != null ? Number(r.rps_60) : null,
        calcDate: r.calcDate,
      });
    }
    const rps: Record<string, { rps60: number | null; calcDate: string }> = {};
    for (const [c, ts] of codeToTs) {
      const v = latest.get(ts);
      if (v) rps[c] = v;
    }
    return Response.json({ rps });
  } catch (e: any) {
    console.error("[api/rps/batch]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
