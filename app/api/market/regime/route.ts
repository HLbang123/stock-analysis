/**
 * GET /api/market/regime — 当前市场环境三态（attack/neutral/defense）
 * 判定逻辑：services/ai-screen/regime.ts（MA55上方占比 + 全市场20日收益中位数）
 * 消费方：扫描页防守期趋势条件警告、AI 筛选徽章（run 落库的同口径）
 */
import { detectMarketRegime } from '@/services/ai-screen/regime';

export async function GET() {
  const info = await detectMarketRegime();
  return Response.json(info);
}
