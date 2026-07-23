// 股票基础类型
export interface Stock {
  code: string;      // 股票代码，如 sh600519
  name: string;      // 股票名称
  market: string;    // 市场: sh/sz/bj
  pureCode: string;  // 纯数字代码: 600519
  positionPercent?: number; // 可选: 持仓占比 0-100
}

// 实时行情
export interface RealtimeQuote {
  code: string;
  name: string;
  price: number;         // 当前价
  preClose: number;      // 昨收
  change: number;        // 涨跌额
  changePercent: number; // 涨跌幅(%)
  high: number;          // 最高
  low: number;           // 最低
  open: number;          // 开盘
  volume: number;        // 成交量
  amount: number;        // 成交额
  updateTime: string;
}

// K线数据
export interface KLineData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount?: number;
}

// K线序列：显式分离"已完成日K"与"盘中合成 bar"
// 由 splitKLines 产生。RSI / 量能基线 / 箱体等"已完成视角"指标读 completedBars；
// MA / MACD / 布林 等"盘中实时"指标读 combinedBars()。
// 把"吃不吃合成 bar"的决策集中到数据边界一处，避免各指标各自 slice(0,-1) 防御。
export interface KLineSeries {
  completedBars: KLineData[];    // 已完成日K（不含盘中合成 bar）
  intradayBar: KLineData | null; // 盘中合成 bar（非交易日 / 无合成时为 null）
}

// 预警级别
export enum AlertLevel {
  INFO = 'INFO',         // 关注/机会
  WARNING = 'WARNING',   // 注意
  CRITICAL = 'CRITICAL'  // 严重/清仓
}

// 预警类别
export enum AlertCategory {
  VOLUME = 'VOLUME',           // 成交量相关
  PRICE = 'PRICE',             // 价格/涨幅相关
  PATTERN = 'PATTERN',         // 形态相关
  MOVING_AVG = 'MOVING_AVG',   // 均线相关
  SENTIMENT = 'SENTIMENT',     // 情绪指标
  OPPORTUNITY = 'OPPORTUNITY', // 机会信号
  RSI = 'RSI',                 // RSI指标相关
  FUNDAMENTAL = 'FUNDAMENTAL'  // 基本面/选股
}

// 预警规则
export interface AlertRule {
  id: string;
  name: string;
  description: string;
  category: AlertCategory;
  level: AlertLevel;
  suggestion: string;
  isEnabled: boolean;
  thresholdValue?: number;
}

// 预警记录
export interface AlertRecord {
  id: string;
  stockCode: string;
  stockName: string;
  ruleId: string;
  ruleName: string;
  alertLevel: AlertLevel;
  alertMessage: string;
  suggestion: string;
  triggeredAt: number;
  isRead: boolean;
  extraData?: string;
  isExpired?: boolean;
}

// 规则检查结果
export interface RuleCheckResult {
  triggered: boolean;
  ruleId?: string;
  message?: string;
  extraData?: string;
  barIndex?: number;
}

// 技术指标结果 (lib/indicators.ts)
export interface IndicatorResult {
  ma5: number;
  ma10: number;
  ma20: number;
  ma55: number;
  ma60: number;
  macd: { dif: number; dea: number; histogram: number };
  rsi6: number;
  rsi12: number;
  rsi14: number;
  rsi24: number;
  bias6: number;
  bias12: number;
  bias24: number;
  bollinger: { upper: number; mid: number; lower: number; position: number };
  volMa5: number;
  volMa20: number;
  lastClose: number;
  lastVolume: number;
}