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
    // DISTINCT ON + (tsCode, calcDate) 索引：每票一次索引下探寻最新行，只回 1 行/票
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON ("tsCode") "tsCode", rps_60, "calcDate"
       FROM rps_scores
       WHERE "tsCode" = ANY($1::text[]) AND rps_60 IS NOT NULL
       ORDER BY "tsCode", "calcDate" DESC`,
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
