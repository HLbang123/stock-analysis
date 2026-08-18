/**
 * 波动档缩放 — ETF 预警/打分阈值换算的单一事实源。
 *
 * 股票规则的价格幅度阈值（急跌 -7%、突破 3%…）按个股波动中枢（ATR14≈2%）标定；
 * ETF 波动率差异极大（债券 0.1% / 宽基 1% / 跨境商品 1.5-2%），同一阈值会失灵：
 * 债券 ETF 永不触发、低波宽基误报。故按 ATR 比率相对中枢换算 scale，阈值 × scale。
 *
 * 只缩放"价格幅度类"阈值；量比类阈值（量能对自身历史自适应）不缩放。
 * scale 夹在 [0.3, 2.0]：下限防债券 ETF 阈值缩到噪声级，下限 0.3×(-7%)≈-2.1% 对债基仍是一年一遇。
 *
 * 用法：预警 = alertRules.checkAllRules 内部 isETF 时自动算；T-score = computeTScore 的 scale 参数。
 */
import type { KLineData } from '@/types';

/** A 股个股 ATR14/收盘价 的中枢（经验值） */
const BASE_ATR_RATIO = 0.02;
const SCALE_MIN = 0.3;
const SCALE_MAX = 2.0;

/** ATR14 / 最新收盘价。数据不足返回 null（调用方按 scale=1 处理） */
export function getAtrRatio(kLines: KLineData[], period = 14): number | null {
  if (kLines.length < period + 1) return null;
  const close = kLines[kLines.length - 1].close;
  if (!close || close <= 0) return null;
  let sum = 0;
  for (let i = kLines.length - period; i < kLines.length; i++) {
    const k = kLines[i];
    const prev = kLines[i - 1];
    sum += Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
  }
  return sum / period / close;
}

/** 波动档缩放系数：ATR 比率 ÷ 个股中枢，clip 到 [0.3, 2.0]；数据不足恒 1（不缩放） */
export function getVolScale(kLines: KLineData[]): number {
  const r = getAtrRatio(kLines);
  if (r == null || r <= 0) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, r / BASE_ATR_RATIO));
}
