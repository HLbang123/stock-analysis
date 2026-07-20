/**
 * Tushare 数据获取与 AI Prompt 格式化
 * 从服务端 API 拉取数据，转换为 AI 可读的文本格式
 */

import { getCached, setCache } from '@/lib/cache';

interface DailyBasicItem {
  ts_code: string;
  trade_date: string;
  pe?: number;
  pe_ttm?: number;
  pb?: number;
  ps_ttm?: number;
  total_mv?: number;   // 总市值（万元）
  circ_mv?: number;     // 流通市值（万元）
  turnover_rate?: number;
  volume_ratio?: number;
}

interface FinaIndicatorItem {
  ts_code: string;
  ann_date?: string;
  end_date: string;
  roe?: number;
  roe_dt?: number;
  roa?: number;
  grossprofit_margin?: number;
  netprofit_margin?: number;
  debt_to_assets?: number;
  or_yoy?: number;
  tr_yoy?: number;
  profit_dedt?: number;
  basic_eps_yoy?: number;
  equity_yoy?: number;
  op_yoy?: number;
  current_ratio?: number;
  quick_ratio?: number;
  ocf_to_or?: number;
}

interface MoneyflowItem {
  ts_code: string;
  trade_date: string;
  net_mf_amount?: number;
  buy_elg_amount?: number;
  sell_elg_amount?: number;
  buy_lg_amount?: number;
  sell_lg_amount?: number;
  net_lg_amount?: number;
  buy_md_amount?: number;
  sell_md_amount?: number;
  net_md_amount?: number;
  buy_sm_amount?: number;
  sell_sm_amount?: number;
  net_sm_amount?: number;
}

export interface TushareData {
  dailyBasic?: DailyBasicItem[];
  finaIndicator?: FinaIndicatorItem[];
  moneyflow?: MoneyflowItem[];
  holderNumber?: HolderNumberItem[];
  margin?: MarginItem[];
  hkHold?: HkHoldItem[];
  forecast?: ForecastItem[];
  topList?: TopListItem[];
  indexData?: IndexDataItem[];
  errors?: string[];       // 服务端聚合接口的部分调用失败（来自 /api/tushare/stock-data）
  warnings?: string[];     // 客户端 sanitize 时丢弃的 section（数据异常）
}

// ===== 新增数据接口 =====

interface HolderNumberItem {
  ts_code: string;
  ann_date: string;
  end_date: string;
  holder_num?: number;
  holder_num_ratio?: number;  // 股东人数环比变化率(%)
}

interface MarginItem {
  ts_code: string;
  trade_date: string;
  rzye?: number;    // 融资余额（元）
  rqye?: number;    // 融券余额（元）
  rzmre?: number;   // 融资买入额（元）
  rzche?: number;   // 融资偿还额（元）
  rqyl?: number;    // 融券余量
  rqchl?: number;   // 融券偿还量
}

interface HkHoldItem {
  ts_code: string;
  trade_date: string;
  hold_vol?: number;   // 持股数量
  hold_ratio?: number; // 持股比例(%)
}

interface ForecastItem {
  ts_code: string;
  ann_date: string;
  end_date: string;
  type?: string;           // 预告类型: 预增/预减/扭亏/首亏/...
  p_change_min?: number;   // 净利润变动幅度下限(%)
  p_change_max?: number;   // 净利润变动幅度上限(%)
  net_profit_min?: number; // 预告净利润下限（万元）
  net_profit_max?: number; // 预告净利润上限（万元）
  last_parent_net?: number; // 上年同期归母净利润（万元）
  summary?: string;
  change_reason?: string;
}

interface TopListItem {
  trade_date: string;
  ts_code: string;
  name: string;
  close?: number;
  pct_change?: number;
  turnover_rate?: number;
  amount?: number;
  l_sell?: number;
  l_buy?: number;
  l_amount?: number;
  net_amount?: number;
  net_rate?: number;
  amount_rate?: number;
  reason?: string;
}

interface IndexDataItem {
  ts_code: string;
  trade_date: string;
  pe?: number;
  pe_ttm?: number;
  pb?: number;
  total_mv?: number;
  turnover_rate?: number;
  pct_chg?: number;      // 涨跌幅（来自 index_daily）
  close?: number;         // 收盘点位
}

/**
 * 按 section 校验 tushare 数据合理性，丢弃损坏的 section（保留正常的）。
 * token 错误/接口异常时，某些 section（典型如 margin）会返回市场总量级别的离谱大数
 * 或重复行，塞进 prompt 会触发中转站安全风控（400 安全拦截）。
 * 任一数值字段为 NaN/Infinity 或绝对值 > 1e11 → 该 section 整体丢弃。
 * （1e11 宽松上界：个股市值~1e8万元、北向持股~1e9股、工行净利润~4e7万元，均远低于此；
 *  而市场总量级垃圾值如 1.4e12 会被准确拦下。）
 */
function sanitizeTushareData(data: TushareData): TushareData {
  const MAX = 1e11;
  const warnings: string[] = [];
  const check = <T,>(recs: T[] | undefined, name: string): T[] | undefined => {
    if (!recs || recs.length === 0) return recs;
    for (const rec of recs) {
      for (const v of Object.values(rec as Record<string, unknown>)) {
        if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > MAX)) {
          const msg = `${name} 数据异常（含离谱大数 ${v}），已丢弃该 section`;
          console.warn(`[Tushare] ${msg}:`, rec);
          warnings.push(msg);
          return undefined;
        }
      }
    }
    return recs;
  };
  const sanitized: TushareData = {
    ...data,
    dailyBasic: check(data.dailyBasic, 'dailyBasic'),
    finaIndicator: check(data.finaIndicator, 'finaIndicator'),
    moneyflow: check(data.moneyflow, 'moneyflow'),
    holderNumber: check(data.holderNumber, 'holderNumber'),
    margin: check(data.margin, 'margin'),
    hkHold: check(data.hkHold, 'hkHold'),
    forecast: check(data.forecast, 'forecast'),
    topList: check(data.topList, 'topList'),
    indexData: check(data.indexData, 'indexData'),
  };
  if (warnings.length > 0) sanitized.warnings = warnings;
  return sanitized;
}

/**
 * 从服务端聚合接口获取 Tushare 数据
 */
export async function fetchTushareData(code: string): Promise<TushareData | null> {
  try {
    const res = await fetch(`/api/tushare/stock-data?code=${code}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.success) {
      console.warn('[Tushare] 部分数据获取失败:', json.errors);
    }
    const data = json.data as TushareData;
    if (!data) return null;
    return sanitizeTushareData(data);
  } catch (e) {
    console.warn('[Tushare] 数据获取失败:', e);
    return null;
  }
}

/**
 * 缓存版 fetchTushareData
 * 基本面数据 TTL=10min，maxAge=60min
 */
export async function fetchTushareDataCached(code: string): Promise<TushareData | null> {
  const key = { code };
  const cached = getCached<TushareData>('tushare_fundamental', key);
  if (cached && !cached.isStale) return cached.data;

  const fresh = await fetchTushareData(code);
  if (fresh) {
    setCache('tushare_fundamental', fresh, key);
    return fresh;
  }
  if (cached) return cached.data;
  return null;
}

/**
 * 格式化市值（万元 → 亿）
 */
function fmtMv(wan: number | undefined): string {
  if (wan == null) return '暂无';
  const yi = wan / 10000;
  return yi >= 1 ? `${yi.toFixed(1)}亿` : `${wan.toFixed(0)}万元`;
}

/**
 * 格式化主力资金（万元 → 亿）
 */
function fmtFlow(wan: number | undefined): string {
  if (!wan) return '0万';
  const abs = Math.abs(wan);
  if (abs >= 10000) {
    return `${(wan / 10000).toFixed(2)}亿`;
  }
  return `${wan.toFixed(0)}万元`;
}

/**
 * 格式化以「元」为单位的金额（元 → 亿/万自适应，避免小值变 0.00亿）
 */
function fmtYuan(yuan: number | undefined): string {
  if (!yuan) return '0';
  const abs = Math.abs(yuan);
  if (abs >= 1e8) return `${(yuan / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(yuan / 1e4).toFixed(0)}万`;
  return `${yuan.toFixed(0)}`;
}

/**
 * 将 Tushare 数据转换为 AI prompt 可读的文本
 * 这是关键函数 — 输出格式直接影响 AI 分析质量
 */
export function formatTushareForPrompt(data: TushareData | null): string {
  if (!data) return '';

  const sections: string[] = [];
  sections.push('---');
  sections.push('## 基本面数据（Tushare）');

  // ===== 1. 估值指标（最新一天） =====
  const latestBasic = data.dailyBasic?.[0];
  if (latestBasic) {
    const dateStr = latestBasic.trade_date
      ? `${latestBasic.trade_date.slice(0, 4)}-${latestBasic.trade_date.slice(4, 6)}-${latestBasic.trade_date.slice(6, 8)}`
      : '最近交易日';

    const valuationLines: string[] = [];
    valuationLines.push(`截止 ${dateStr}：`);

    if (latestBasic.pe_ttm != null) valuationLines.push(`- 市盈率(PE-TTM)：${latestBasic.pe_ttm.toFixed(2)}`);
    if (latestBasic.pb != null) valuationLines.push(`- 市净率(PB)：${latestBasic.pb.toFixed(2)}`);
    if (latestBasic.ps_ttm != null) valuationLines.push(`- 市销率(PS-TTM)：${latestBasic.ps_ttm.toFixed(2)}`);
    valuationLines.push(`- 总市值：${fmtMv(latestBasic.total_mv)}`);
    valuationLines.push(`- 流通市值：${fmtMv(latestBasic.circ_mv)}`);
    if (latestBasic.turnover_rate != null) valuationLines.push(`- 换手率：${latestBasic.turnover_rate.toFixed(2)}%`);
    if (latestBasic.volume_ratio != null) valuationLines.push(`- 量比：${latestBasic.volume_ratio.toFixed(2)}`);

    sections.push(`### 估值与市值\n${valuationLines.join('\n')}`);
  }

  // ===== 1.5. 大盘环境（六大指数最新指标） =====
  const idxData = data.indexData;
  if (idxData && idxData.length > 0) {
    const IDX_NAMES: Record<string, string> = {
      '000001.SH': '上证综指', '399001.SZ': '深证成指', '399006.SZ': '创业板指',
      '000016.SH': '上证50', '000905.SH': '中证500', '399005.SZ': '中小板指',
    };
    const idxLines: string[] = [];
    for (const idx of idxData) {
      const name = IDX_NAMES[idx.ts_code] || idx.ts_code;
      const parts: string[] = [name];
      if (idx.pct_chg != null) {
        parts.push(`${idx.pct_chg > 0 ? '+' : ''}${idx.pct_chg.toFixed(2)}%`);
      }
      if (idx.pe_ttm != null) parts.push(`PE ${idx.pe_ttm.toFixed(1)}`);
      if (idx.pb != null) parts.push(`PB ${idx.pb.toFixed(2)}`);
      if (idx.turnover_rate != null) parts.push(`换手 ${idx.turnover_rate.toFixed(2)}%`);
      idxLines.push(`- ${parts.join('，')}`);
    }
    sections.push(`### 大盘环境\n${idxLines.join('\n')}`);
  }

  // ===== 2. 财务指标（最近一季度 + 同比） =====
  const latestFin = data.finaIndicator?.[0];
  const prevFin = data.finaIndicator?.[1]; // 用于对比

  if (latestFin) {
    const finDate = latestFin.end_date
      ? `${latestFin.end_date.slice(0, 4)}-${latestFin.end_date.slice(4, 6)}-${latestFin.end_date.slice(6, 8)}`
      : '最新财报';

    const finLines: string[] = [];
    finLines.push(`报告期 ${finDate}：`);

    // 盈利能力
    const profitLines: string[] = [];
    if (latestFin.roe != null) profitLines.push(`ROE ${latestFin.roe.toFixed(2)}%`);
    if (latestFin.roa != null) profitLines.push(`ROA ${latestFin.roa.toFixed(2)}%`);
    if (latestFin.grossprofit_margin != null) profitLines.push(`毛利率 ${latestFin.grossprofit_margin.toFixed(2)}%`);
    if (latestFin.netprofit_margin != null) profitLines.push(`净利率 ${latestFin.netprofit_margin.toFixed(2)}%`);
    if (profitLines.length > 0) {
      finLines.push(`- 盈利能力：${profitLines.join('，')}`);
    }

    // 成长性
    const growthLines: string[] = [];
    if (latestFin.or_yoy != null) growthLines.push(`营收同比 ${latestFin.or_yoy > 0 ? '+' : ''}${latestFin.or_yoy.toFixed(2)}%`);
    if (latestFin.tr_yoy != null) growthLines.push(`净利润同比 ${latestFin.tr_yoy > 0 ? '+' : ''}${latestFin.tr_yoy.toFixed(2)}%`);
	    if (latestFin.basic_eps_yoy != null) growthLines.push(`EPS同比 ${latestFin.basic_eps_yoy > 0 ? '+' : ''}${latestFin.basic_eps_yoy.toFixed(2)}%`);
	    if (latestFin.op_yoy != null) growthLines.push(`营业利润同比 ${latestFin.op_yoy > 0 ? '+' : ''}${latestFin.op_yoy.toFixed(2)}%`);
    if (growthLines.length > 0) {
      finLines.push(`- 成长性：${growthLines.join('，')}`);
    }

    // 财务健康
    const healthLines: string[] = [];
    if (latestFin.debt_to_assets != null) healthLines.push(`资产负债率 ${latestFin.debt_to_assets.toFixed(2)}%`);
    if (latestFin.current_ratio != null) healthLines.push(`流动比率 ${latestFin.current_ratio.toFixed(2)}`);
    if (latestFin.quick_ratio != null) healthLines.push(`速动比率 ${latestFin.quick_ratio.toFixed(2)}`);
    if (healthLines.length > 0) {
      finLines.push(`- 财务健康：${healthLines.join('，')}`);
    }

    // 现金流质量
    if (latestFin.ocf_to_or != null) {
      finLines.push(`- 经营现金流/营收：${latestFin.ocf_to_or.toFixed(4)} (${latestFin.ocf_to_or < 0 ? '现金流为负⚠️' : latestFin.ocf_to_or < 0.05 ? '偏低' : '正常'})`);
    }

    // 对比上期
    if (prevFin) {
      const changes: string[] = [];
      const prevDate = prevFin.end_date
        ? `${prevFin.end_date.slice(0, 4)}-${prevFin.end_date.slice(4, 6)}-${prevFin.end_date.slice(6, 8)}`
        : '上期';
      changes.push(`\n与上期（${prevDate}）对比：`);
      if (latestFin.roe != null && prevFin.roe != null) {
        changes.push(`- ROE：${prevFin.roe.toFixed(2)}% → ${latestFin.roe.toFixed(2)}%（${latestFin.roe > prevFin.roe ? '↑' : '↓'}）`);
      }
      if (latestFin.or_yoy != null && prevFin.or_yoy != null) {
        changes.push(`- 营收增速：${prevFin.or_yoy > 0 ? '+' : ''}${prevFin.or_yoy.toFixed(2)}% → ${latestFin.or_yoy > 0 ? '+' : ''}${latestFin.or_yoy.toFixed(2)}%（${latestFin.or_yoy > prevFin.or_yoy ? '↑' : '↓'}）`);
      }
      if (changes.length > 1) finLines.push(changes.join('\n'));
    }

    sections.push(`### 财务指标\n${finLines.join('\n')}`);
  }

  // ===== 3. 资金流向（最近五天） =====
  const mfData = data.moneyflow;
  if (mfData && mfData.length > 0) {
    const flowLines: string[] = [];
    let totalNetMf = 0;

    for (const mf of mfData) {
      const dateStr = mf.trade_date
        ? `${mf.trade_date.slice(4, 6)}-${mf.trade_date.slice(6, 8)}`
        : '';
      const netMf = mf.net_mf_amount || 0;
      totalNetMf += netMf;
      const direction = netMf > 0 ? '净流入' : netMf < 0 ? '净流出' : '持平';

      // 计算大单净买入
      const lgNet = (mf.buy_lg_amount || 0) - (mf.sell_lg_amount || 0);
      const elgNet = (mf.buy_elg_amount || 0) - (mf.sell_elg_amount || 0);

      flowLines.push(`- ${dateStr}：主力${direction} ${fmtFlow(Math.abs(netMf))}（超大单${elgNet > 0 ? '+' : ''}${fmtFlow(elgNet)}，大单${lgNet > 0 ? '+' : ''}${fmtFlow(lgNet)}）`);
    }

    const totalDir = totalNetMf > 0 ? '累计净流入' : '累计净流出';
    flowLines.push(`\n近${mfData.length}日${totalDir}：${fmtFlow(Math.abs(totalNetMf))}`);
    flowLines.push(`（注：资金流向为盘后数据，最新仅至上述最近交易日，非当日实时）`);

    sections.push(`### 资金流向\n${flowLines.join('\n')}`);
  }

  // ===== 4. 股东人数 =====
  const hdData = data.holderNumber;
  if (hdData && hdData.length > 0) {
    const hdLines: string[] = [];
    let prevNum: number | undefined;
    for (const hd of hdData) {
      const dateStr = hd.end_date
        ? `${hd.end_date.slice(0, 4)}-${hd.end_date.slice(4, 6)}-${hd.end_date.slice(6, 8)}`
        : '';
      const dir = prevNum
        ? (hd.holder_num! < prevNum ? '↓ 集中' : hd.holder_num! > prevNum ? '↑ 分散' : '→ 持平')
        : '';
      const ratioStr = hd.holder_num_ratio != null ? ` (变动${hd.holder_num_ratio > 0 ? '+' : ''}${hd.holder_num_ratio.toFixed(2)}%)` : '';
      // 股东人数用「万户」中文单位，避免 toLocaleString 的千分位逗号与日期短横被风控剥掉后拼成 11 位手机号
      const holderNumStr = hd.holder_num != null
        ? (hd.holder_num >= 10000 ? `${(hd.holder_num / 10000).toFixed(2)}万` : `${hd.holder_num}`)
        : '--';
      hdLines.push(`- ${dateStr}：股东人数 ${holderNumStr} 户${dir}${ratioStr}`);
      prevNum = hd.holder_num;
    }
    // 趋势判断
    if (hdData.length >= 2) {
      const latest = hdData[0].holder_num || 0;
      const oldest = hdData[hdData.length - 1].holder_num || 0;
      const trend = latest < oldest ? '股东人数持续减少，筹码趋于集中，可能有主力吸筹' :
        latest > oldest ? '股东人数持续增加，筹码趋于分散，散户化特征' : '股东人数基本持平';
      hdLines.push(`\n趋势：${trend}`);
    }
    sections.push(`### 股东人数（筹码集中度）\n${hdLines.join('\n')}`);
  }

  // ===== 5. 融资融券 =====
  const mgData = data.margin;
  if (mgData && mgData.length > 0) {
    const mgLines: string[] = [];
    for (const mg of mgData) {
      const dateStr = mg.trade_date
        ? `${mg.trade_date.slice(4, 6)}-${mg.trade_date.slice(6, 8)}`
        : '';
      // margin 字段单位为「元」：rzye 用 fmtYuan 自适应（亿/万）；netBuy 先 /1e4 转万元 再交 fmtFlow
      const netBuy = ((mg.rzmre || 0) - (mg.rzche || 0)) / 1e4;
      const netStr = netBuy > 0 ? `净买入 ${fmtFlow(netBuy)}` : netBuy < 0 ? `净卖出 ${fmtFlow(Math.abs(netBuy))}` : '';
      mgLines.push(`- ${dateStr}：融资余额 ${fmtYuan(mg.rzye || 0)}${netStr ? '，' + netStr : ''}`);
    }
    // 趋势判断
    const latestRzye = mgData[0].rzye || 0;
    const oldestRzye = mgData[mgData.length - 1].rzye || 0;
    const rzTrend = latestRzye > oldestRzye * 1.05 ? '融资余额持续上升，杠杆资金看多情绪浓厚' :
      latestRzye < oldestRzye * 0.95 ? '融资余额持续下降，杠杆资金在撤退' : '融资余额基本稳定';
    mgLines.push(`\n趋势：${rzTrend}`);
    sections.push(`### 融资融券（杠杆资金）\n${mgLines.join('\n')}`);
  }

  // ===== 6. 北向资金 =====
  const hkData = data.hkHold;
  if (hkData && hkData.length > 0) {
    const hkLines: string[] = [];
    let prevRatio: number | undefined;
    for (const hk of hkData) {
      const dateStr = hk.trade_date
        ? `${hk.trade_date.slice(4, 6)}-${hk.trade_date.slice(6, 8)}`
        : '';
      const dir = prevRatio
        ? (hk.hold_ratio! > prevRatio ? '↑' : hk.hold_ratio! < prevRatio ? '↓' : '→')
        : '';
      hkLines.push(`- ${dateStr}：持股 ${hk.hold_ratio?.toFixed(2) || '--'}%${dir}`);
      prevRatio = hk.hold_ratio;
    }
    if (hkData.length >= 2) {
      const first = hkData[0].hold_ratio;
      const last = hkData[hkData.length - 1].hold_ratio;
      if (first && last) {
        const trend = first > last ? '北向资金持续增持，外资看好' :
          first < last ? '北向资金持续减持，外资态度谨慎' : '';
        if (trend) hkLines.push(`\n趋势：${trend}`);
      }
    }
    sections.push(`### 北向资金持股\n${hkLines.join('\n')}`);
  }

  // ===== 7. 龙虎榜 =====
  const tlData = data.topList;
  if (tlData && tlData.length > 0) {
    const tl = tlData[0];
    const netDir = (tl.net_amount || 0) > 0 ? '净买入' : '净卖出';
    const tlLines = [
      `- 上榜理由：${tl.reason || '--'}`,
      `- 龙虎榜成交额：${fmtFlow(tl.l_amount)}（占当日总成交 ${tl.amount_rate?.toFixed(1) || '--'}%）`,
      `- 龙虎榜${netDir}：${fmtFlow(Math.abs(tl.net_amount || 0))}（净占比 ${tl.net_rate?.toFixed(1) || '--'}%）`,
      `- 买入额：${fmtFlow(tl.l_buy)} | 卖出额：${fmtFlow(tl.l_sell)}`,
    ];
    sections.push(`### 龙虎榜\n${tlLines.join('\n')}`);
  }

  // ===== 8. 业绩预告 =====
  const fcData = data.forecast;
  if (fcData && fcData.length > 0) {
    const fc = fcData[0];
    const dateStr = fc.end_date
      ? `${fc.end_date.slice(0, 4)}-${fc.end_date.slice(4, 6)}-${fc.end_date.slice(6, 8)}`
      : '最近';
    const typeLabel: Record<string, string> = {
      '预增': '📈 预增', '预减': '📉 预减', '扭亏': '🔄 扭亏', '首亏': '⚠️ 首亏',
      '续亏': '❌ 续亏', '续盈': '✅ 续盈', '略增': '📈 略增', '略减': '📉 略减',
    };
    const label = typeLabel[fc.type || ''] || fc.type || '';
    const pChange = fc.p_change_min != null
      ? `净利润变动 ${fc.p_change_min > 0 ? '+' : ''}${fc.p_change_min.toFixed(1)}%${fc.p_change_max != null ? ` ~ ${fc.p_change_max > 0 ? '+' : ''}${fc.p_change_max.toFixed(1)}%` : ''}`
      : '';
    const npMin = fc.net_profit_min ?? 0;
    const npMax = fc.net_profit_max ?? 0;
    const profit = npMin > 0
      ? `预告净利润 ${fmtFlow(npMin)}${npMax > 0 ? ` ~ ${fmtFlow(npMax)}` : ''}`
      : '';
    const fcLines = [
      `- 报告期：${dateStr}`,
      `- 预告类型：${label}`,
    ];
    if (pChange) fcLines.push(`- ${pChange}`);
    if (profit) fcLines.push(`- ${profit}`);
    const lastNet = fc.last_parent_net ?? 0;
    if (lastNet > 0) fcLines.push(`- 去年同期净利润：${fmtFlow(lastNet)}`);
    if (fc.summary) fcLines.push(`- 摘要：${fc.summary.slice(0, 150)}`);
    if (fc.change_reason) fcLines.push(`- 变动原因：${fc.change_reason.slice(0, 150)}`);
    sections.push(`### 业绩预告\n${fcLines.join('\n')}`);
  }

  sections.push('---');
  return sections.join('\n');
}

/**
 * 龙虎榜对话速览（一行）
 */
export function formatTopListForChat(data: TushareData | null): string {
  if (!data?.topList?.length) return '';
  const tl = data.topList[0];
  const net = tl.net_amount || 0;
  const dir = net > 0 ? '净买入' : '净卖出';
  const parts = [`龙虎榜：${dir} ${fmtFlow(Math.abs(net))}`];
  if (tl.net_rate != null) parts.push(`占比 ${tl.net_rate.toFixed(1)}%`);
  if (tl.reason) parts.push(tl.reason);
  return parts.join(' | ');
}
