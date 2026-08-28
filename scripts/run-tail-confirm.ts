import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { prisma } from "../lib/db";
import { evaluateEntryTail, MinutePoint } from "../lib/strategy/limit-up-three-yin";

function tsCodeToSina(tsCode: string): string {
  const parts = tsCode.split(".");
  if (parts.length !== 2) return tsCode;
  return parts[1].toLowerCase() + parts[0];
}

async function fetchMinute(code: string): Promise<MinutePoint[]> {
  try {
    const res = await fetch("http://localhost:3000/api/minute?code=" + encodeURIComponent(code), {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { time: string; price: number }[] | { error?: string };
    if (!Array.isArray(data)) return [];
    return data.map((p) => ({ time: p.time, price: Number(p.price) || 0 })).filter((p) => p.price > 0);
  } catch {
    return [];
  }
}

async function main() {
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT id, ts_code, metrics FROM short_term_signals WHERE strategy = $1 AND phase = $2',
    "limit-up-three-yin",
    "closing"
  );
  if (!rows.length) {
    console.log("[tail-confirm] 无涨停+三连阴 closing 候选");
    return;
  }

  let passed = 0;
  let failed = 0;
  for (const r of rows) {
    const code = tsCodeToSina(String(r.ts_code));
    const points = await fetchMinute(code);
    if (points.length < 5) {
      console.log("[tail-confirm] 分钟数据不足，保留候选:", r.ts_code);
      continue;
    }
    const tail = evaluateEntryTail(points);
    let metrics: any = {};
    try { metrics = r.metrics ? JSON.parse(r.metrics) : {}; } catch {}
    metrics.tailPassed = tail.matched;
    metrics.tailTrendPct = tail.trendPct;
    metrics.tailRangePct = tail.rangePct;
    if (!tail.matched) {
      await prisma.$executeRawUnsafe('DELETE FROM short_term_signals WHERE id = $1', r.id);
      failed += 1;
      console.log("[tail-confirm] 尾盘快速拉升，剔除:", r.ts_code, tail);
    } else {
      await prisma.$executeRawUnsafe('UPDATE short_term_signals SET metrics = $2 WHERE id = $1', r.id, JSON.stringify(metrics));
      passed += 1;
      console.log("[tail-confirm] 尾盘通过:", r.ts_code, tail);
    }
  }
  console.log("[tail-confirm] 完成 passed=", passed, "failed=", failed);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[tail-confirm] 失败:", e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
