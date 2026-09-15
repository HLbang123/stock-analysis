/**
 * 每日推荐 —— 扫描 + 落库（日更入口）
 *
 *   每天推荐 5 只主板标的，来自「今天有论点的板块」。
 *   论点的日子不推荐（宁缺勿滥）—— 见 services/picks/daily.ts 的说明。
 *
 * 用法：
 *   run-local.sh scripts/picks-scan.ts             # 扫描最新交易日并落库
 *   run-local.sh scripts/picks-scan.ts --dry       # 只打印不落库
 *   run-local.sh scripts/picks-scan.ts --date=20260914
 */
import '../lib/load-env';
import { prisma } from '../lib/db';
import { pickDaily } from '../services/picks/daily';

const pct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

async function main() {
  const dry = process.argv.includes('--dry');
  const dArg = process.argv.find((a) => a.startsWith('--date='))?.slice(7);

  const asOf = dArg ?? (
    await prisma.$queryRawUnsafe<any[]>(`SELECT max(trade_date) AS d FROM funnel_bars`)
  )[0]?.d;
  if (!asOf) throw new Error('funnel_bars 为空，先跑 scripts/funnel-setup.ts');

  console.log(`[picks] 扫描 ${asOf}…`);
  const picksResult = await pickDaily(asOf);
  const { boards, picks } = picksResult;

  // 板块只做**标注**（哪些票恰好来自今天的异动板块），不参与筛选
  console.log(`[picks] 今日异动板块 ${boards.length} 个（仅作标注）：${boards.map((b) => b.name).join(' / ') || '（无）'}`);

  if (!picks.length) {
    console.log('[picks] 今日无推荐（全市场都没有「跌幅榜前10 且 近5日急跌 且 不缩量」的标的）');
    if (!dry) {
      await prisma.$executeRawUnsafe(`DELETE FROM funnel_picks WHERE pick_date = $1`, asOf);
      await prisma.$executeRawUnsafe(
        `INSERT INTO funnel_runs (pick_date, bar_date, veto_used, pick_count, note)
         VALUES ($1,$2,false,0,$3)
         ON CONFLICT (pick_date) DO UPDATE SET bar_date=EXCLUDED.bar_date, pick_count=0, note=EXCLUDED.note`,
        asOf, asOf, `论点板块 ${boards.length} 个，无合格标的`
      );
    }
    await prisma.$disconnect();
    return;
  }

  console.log(`[picks] 推荐 ${picks.length} 只：`);
  for (const p of picks) {
    const tag = p.boardName ? `  ← ${p.boardName}（${p.boardReason}）` : '  ← 无板块归属';
    console.log(`  #${p.rankNo} ${p.tsCode} ${p.name}  近20日 ${pct(p.past20)}${tag}`);
  }

  // 【2026-09-15 去 LLM】原这里调 narratePicks 让模型写「理由 / 反证」，已移除。
  //   理由：模型拿到的输入（近20日涨跌 / 成交活跃度分档 / 板块标注）**全部是规则自己算出来的**，
  //   系统提示词还明令禁止它编造板块归属 → 输入 ⊆ 规则输入，输出只能是复述，信息论上不可能有增量。
  //   推荐页仍有一行**确定性模板**（下面的 reason 字段），页面不会变哑。
  //   services/picks/narrate.ts 与服务器 key 都保留不删，随时可加回。

  if (dry) { await prisma.$disconnect(); return; }

  // 落库：先清当天，再写（避免旧口径的孤儿行 —— 见 MEMORY.md「孤儿行」教训）
  await prisma.$executeRawUnsafe(`DELETE FROM funnel_picks WHERE pick_date = $1`, asOf);
  for (const p of picks) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO funnel_picks
         (pick_date, ts_code, rank_no, name, reason, turnover_rate, turnover_q, past20,
          veto_hit, board_code, board_name, board_reason, llm_thesis, llm_counter)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10,$11,$12,$13)`,
      asOf, p.tsCode, p.rankNo, p.name,
      `近一个月${p.past20 != null && p.past20 < 0 ? '回落' : '上涨'} ${Math.abs(p.past20 ?? 0).toFixed(1)}%，成交活跃度处于中位区间`,
      p.turnoverRate, p.turnoverQ, p.past20,
      p.boardCode, p.boardName, p.boardReason,
      null, null
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO funnel_runs (pick_date, bar_date, veto_used, pick_count, note)
     VALUES ($1,$2,false,$3,$4)
     ON CONFLICT (pick_date) DO UPDATE SET bar_date=EXCLUDED.bar_date, pick_count=EXCLUDED.pick_count, note=EXCLUDED.note`,
    asOf, asOf, picks.length, `板块 ${boards.length} 个`
  );
  console.log(`[picks] 已落库 ${picks.length} 只`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[picks] 失败:', e);
  await prisma.$disconnect();
  process.exit(1);
});
