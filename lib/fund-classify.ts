/**
 * ETF 品种分类器 — 基金品种 profile 的派生逻辑单一事实源。
 *
 * 输入 tushare fund_basic 的原始字段（fundType/name/benchmark/tsCode），
 * 输出派生字段：assetClass（资产类别）、tPlus0（是否 T+0）、limitPct（涨跌幅限制 %）。
 *
 * 判定只依赖 2000 积分档数据（fund_basic）+ 名称关键词；若将来积分到 8000，
 * 可用 etf_basic.index_code/etf_type 提升跨境与跟踪指数精度（见 memory: etf-feature-notes）。
 */

export type FundAssetClass = 'equity' | 'cross-border' | 'bond' | 'commodity' | 'money';

export interface FundClassifyInput {
  tsCode: string;              // tushare 格式，如 511880.SH
  name: string;                // 基金简称
  fundType?: string | null;    // 股票型/债券型/混合型/货币型/另类投资型/QDII 等
  benchmark?: string | null;   // 业绩基准文本
}

export interface FundClassifyResult {
  assetClass: FundAssetClass;
  tPlus0: boolean;
  limitPct: number;
}

// 关键词表（命中即归类；顺序即优先级，先债券再商品再货币最后跨境）
// 防误伤：「证金债」不能裸写「证金」（"保证金ETF"含"证金"）；「黄金股/黄金产业」是矿业股票指数（equity）
const BOND_RE = /国债|债|转债|证金债|城投|信用|政金|利率债|国开|农发|口行/;
// 商品：贵金属/农产品/能源化工现货ETF + 商品期货ETF（豆粕/有色/能源化工期货，如"有色金属期货ETF"）
// ① 不裸匹配"有色"（"有色金属ETF"跟踪股票指数，属 equity）② "黄金股/黄金产业/白银股"是矿业股票指数，也属 equity
const COMMODITY_RE = /黄金(?![股产])|白银(?![股产])|豆粕|原油|能源化工|农产品|饲料|油脂|期货/;
const MONEY_RE = /货币|现金|添益|日利|日日|收益快线|保证金/;
// 跨境：QDII 及境外标的。注意"国际"容易误伤（如"MSCI中国A股国际通"是 A 股指数），故只匹配 全球/海外
const CROSS_BORDER_RE = /QDII|恒生|香港|H股|中概|纳斯达克|纳指|标普|道琼斯|日经|德国|法国|英国|东南亚|印度|越南|沙特|亚太|美债|港股通|中资美元债|海外|全球/;

// 涨跌幅 20%：科创板(588) / 创业板 / 双创 跟踪标的
const LIMIT20_RE = /创业板|科创|双创/;

export function classifyFund(input: FundClassifyInput): FundClassifyResult {
  const { name, tsCode } = input;
  const fundType = input.fundType ?? '';
  // 匹配文本 = 名称 + 业绩基准（基准里常含跟踪指数名，如"纳斯达克100指数收益率"）
  const text = name + ' ' + (input.benchmark ?? '');

  let assetClass: FundAssetClass;
  if (fundType.includes('债券') || BOND_RE.test(text)) {
    assetClass = 'bond';
  } else if (COMMODITY_RE.test(text)) {
    assetClass = 'commodity';
  } else if (fundType.includes('货币') || MONEY_RE.test(name)) {
    assetClass = 'money';
  } else if (fundType.toUpperCase().includes('QDII') || CROSS_BORDER_RE.test(text)) {
    assetClass = 'cross-border';
  } else {
    assetClass = 'equity';
  }

  // 跨境(QDII)/债券/商品/货币基金均支持 T+0
  const tPlus0 = assetClass !== 'equity';

  // 涨跌幅：仅股票型有 20% 档（588 科创板 ETF 或跟踪创业板/科创/双创指数）；
  // 债券/商品/跨境/货币恒 10%（防"科创债ETF"被名称里的"科创"误判成 20%）
  const pure = tsCode.replace(/\.(SH|SZ|BJ)$/i, '');
  const limitPct =
    assetClass === 'equity' && (/^588\d{3}$/.test(pure) || LIMIT20_RE.test(text)) ? 20 : 10;

  return { assetClass, tPlus0, limitPct };
}
