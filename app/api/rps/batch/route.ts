/** GET /api/rps/batch?codes=sz000001,sh600519 — 批量最新 RPS60（自选页标签用，一次 SQL 查回全部） */
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
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT "tsCode", rps_60, "calcDate"
       FROM rps_scores
       WHERE "tsCode" = ANY($1::text[]) AND rps_60 IS NOT NULL
       ORDER BY "calcDate" DESC`,
      [...codeToTs.values()]
    );
    // 每只取最新一条（DESC 首见即最新）
    const latest = new Map<string, { rps60: number | null; calcDate: string }>();
    for (const r of rows) {
      if (latest.has(r.tsCode)) continue;
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
