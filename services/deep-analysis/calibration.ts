import { prisma } from '@/lib/db';

/**
 * 深度分析历史校准（P2）— 裁决 prompt 注入用。
 * 从 DeepAnalysisRecord/Eval 回测数据算全局 + 个股 T+5 胜率，
 * 拼成一段简短中文注入裁决 user prompt（## 分析师报告 之前），
 * 让模型据此校准置信度，避免系统性高估/某方向长期偏低而不自知。
 *
 * 全局聚合带 10 分钟内存缓存（每次分析都跑，避免重复扫表）；个股聚合量小直查。
 * 样本不足（全局 <10 次评估）时不注入，避免噪声误导。
 */

const isWin = (action: string, returnPct: number) =>
  action === '买入' ? returnPct > 0 : action === '卖出' ? returnPct < 0 : Math.abs(returnPct) < 5;

interface ActionCal { action: string; count: number; winRate: number }
interface GlobalCal {
  total: number;
  byAction: ActionCal[];
  confHigh: { count: number; winRate: number } | null; // 置信度 ≥71
  confLow: { count: number; winRate: number } | null;  // 置信度 ≤30
}

let globalCache: { at: number; data: GlobalCal } | null = null;
const GLOBAL_TTL = 10 * 60 * 1000;

async function getGlobalCal(): Promise<GlobalCal> {
  if (globalCache && Date.now() - globalCache.at < GLOBAL_TTL) return globalCache.data;

  const records = await prisma.deepAnalysisRecord.findMany({ include: { evals: true } });
  const byActionMap = new Map<string, { count: number; wins: number }>();
  let total = 0;
  let highC = 0, highW = 0, lowC = 0, lowW = 0;

  for (const r of records) {
    const e5 = r.evals.find((e) => e.nDays === 5 && e.returnPct != null);
    if (!e5) continue;
    total++;
    const win = isWin(r.action, e5.returnPct!);
    const g = byActionMap.get(r.action) ?? { count: 0, wins: 0 };
    g.count++; if (win) g.wins++;
    byActionMap.set(r.action, g);
    if (r.confidence != null) {
      if (r.confidence >= 71) { highC++; if (win) highW++; }
      else if (r.confidence <= 30) { lowC++; if (win) lowW++; }
    }
  }

  const data: GlobalCal = {
    total,
    byAction: Array.from(byActionMap.entries()).map(([action, g]) => ({
      action, count: g.count, winRate: Math.round((g.wins / g.count) * 1000) / 10,
    })),
    confHigh: highC > 0 ? { count: highC, winRate: Math.round((highW / highC) * 1000) / 10 } : null,
    confLow: lowC > 0 ? { count: lowC, winRate: Math.round((lowW / lowC) * 1000) / 10 } : null,
  };
  globalCache = { at: Date.now(), data };
  return data;
}

async function getStockCal(stockCode: string): Promise<ActionCal[]> {
  const records = await prisma.deepAnalysisRecord.findMany({
    where: { stockCode },
    include: { evals: true },
    take: 100,
  });
  const byActionMap = new Map<string, { count: number; wins: number }>();
  for (const r of records) {
    const e5 = r.evals.find((e) => e.nDays === 5 && e.returnPct != null);
    if (!e5) continue;
    const g = byActionMap.get(r.action) ?? { count: 0, wins: 0 };
    g.count++;
    if (isWin(r.action, e5.returnPct!)) g.wins++;
    byActionMap.set(r.action, g);
  }
  return Array.from(byActionMap.entries()).map(([action, g]) => ({
    action, count: g.count, winRate: Math.round((g.wins / g.count) * 1000) / 10,
  }));
}

/**
 * 拼裁决注入文本；样本不足或查询失败返回空串（调用方 filter(Boolean) 掉）。
 * 保持简短——占裁决 prompt token 预算，每条只给数字不给废话。
 */
export async function buildCalibrationNote(stockCode?: string): Promise<string> {
  try {
    const g = await getGlobalCal();
    if (g.total < 10) return ''; // 样本太少，校准无意义

    const lines: string[] = ['## 历史校准（本系统真实回测，T+5 口径）'];
    lines.push(
      '- 你过去的建议胜率：' +
      g.byAction.map((a) => `「${a.action}」${a.winRate}%（${a.count}次）`).join('，')
    );
    if (g.confHigh && g.confLow) {
      lines.push(`- 高置信度(≥70)建议胜率 ${g.confHigh.winRate}%，低置信度(≤30)胜率 ${g.confLow.winRate}%`);
    } else if (g.confHigh) {
      lines.push(`- 高置信度(≥70)建议胜率 ${g.confHigh.winRate}%（${g.confHigh.count}次）`);
    }
    if (stockCode) {
      const stock = await getStockCal(stockCode);
      if (stock.length > 0) {
        lines.push('- 对本标的，你过去的建议：' + stock.map((a) => `「${a.action}」胜率${a.winRate}%（${a.count}次）`).join('，'));
      }
    }
    lines.push('请据此校准：历史胜率持续偏低的方向，应降低置信度或改为更保守的方向；置信度须与上述历史命中率大体一致，避免系统性高估。');
    return lines.join('\n');
  } catch (e) {
    console.warn('[deep-calibration] 校准摘要生成失败（跳过注入）:', (e as Error)?.message);
    return '';
  }
}
