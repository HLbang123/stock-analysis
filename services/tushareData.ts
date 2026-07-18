/**
 * Tushare 数据获取与 AI Prompt 格式化
 * 从服务端 API 拉取数据，转换为 AI 可读的文本格式
 */

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
  end_date: string;
  roe?: number;
  roe_dt?: number;
  roa?: number;
  grossprofit_margin?: number;
  netprofit_margin?: number;
  debt_to_assets?: number;
  or_yoy?: number;         // 营收同比增速
  tr_yoy?: number;         // 归属净利润同比增速
  profit_dedt?: number;    // 扣非净利润同比
  op_yoy?: number;         // 营业利润同比
  current_ratio?: number;
  quick_ratio?: number;
  ocf_to_or?: number;      // 经营现金流/营业收入
}

interface MoneyflowItem {
  ts_code: string;
  trade_date: string;
  net_mf_amount?: number;   // 主力净流入（万元）
  buy_elg_amount?: number;  // 超大单买入
  sell_elg_amount?: number;
  buy_lg_amount?: number;   // 大单买入
  sell_lg_amount?: number;
  buy_md_amount?: number;   // 中单买入
  sell_md_amount?: number;
  buy_sm_amount?: number;   // 小单买入
  sell_sm_amount?: number;
}

export interface TushareData {
  dailyBasic: DailyBasicItem[];
  finaIndicator: FinaIndicatorItem[];
  moneyflow: MoneyflowItem[];
  errors?: string[];
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
    return json.data as TushareData;
  } catch (e) {
    console.warn('[Tushare] 数据获取失败:', e);
    return null;
  }
}

/**
 * 格式化市值（万元 → 亿）
 */
function fmtMv(wan: number | undefined): string {
  if (!wan) return '暂无';
  const yi = wan / 10000;
  return yi >= 1 ? `${yi.toFixed(1)}亿` : `${wan.toFixed(0)}万元`;
}

/**
 * 格式化百分比
 */
function pct(v: number | undefined): string {
  if (v === undefined || v === null) return '暂无';
  return `${v.toFixed(2)}%`;
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

    if (latestBasic.pe_ttm !== undefined) valuationLines.push(`- 市盈率(PE-TTM)：${latestBasic.pe_ttm.toFixed(2)}`);
    if (latestBasic.pb !== undefined) valuationLines.push(`- 市净率(PB)：${latestBasic.pb.toFixed(2)}`);
    if (latestBasic.ps_ttm !== undefined) valuationLines.push(`- 市销率(PS-TTM)：${latestBasic.ps_ttm.toFixed(2)}`);
    valuationLines.push(`- 总市值：${fmtMv(latestBasic.total_mv)}`);
    valuationLines.push(`- 流通市值：${fmtMv(latestBasic.circ_mv)}`);
    if (latestBasic.turnover_rate !== undefined) valuationLines.push(`- 换手率：${latestBasic.turnover_rate.toFixed(2)}%`);
    if (latestBasic.volume_ratio !== undefined) valuationLines.push(`- 量比：${latestBasic.volume_ratio.toFixed(2)}`);

    sections.push(`### 估值与市值\n${valuationLines.join('\n')}`);
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
    if (latestFin.roe !== undefined) profitLines.push(`ROE ${latestFin.roe.toFixed(2)}%`);
    if (latestFin.roa !== undefined) profitLines.push(`ROA ${latestFin.roa.toFixed(2)}%`);
    if (latestFin.grossprofit_margin !== undefined) profitLines.push(`毛利率 ${latestFin.grossprofit_margin.toFixed(2)}%`);
    if (latestFin.netprofit_margin !== undefined) profitLines.push(`净利率 ${latestFin.netprofit_margin.toFixed(2)}%`);
    if (profitLines.length > 0) {
      finLines.push(`- 盈利能力：${profitLines.join('，')}`);
    }

    // 成长性
    const growthLines: string[] = [];
    if (latestFin.or_yoy !== undefined) growthLines.push(`营收同比 ${latestFin.or_yoy > 0 ? '+' : ''}${latestFin.or_yoy.toFixed(2)}%`);
    if (latestFin.tr_yoy !== undefined) growthLines.push(`净利润同比 ${latestFin.tr_yoy > 0 ? '+' : ''}${latestFin.tr_yoy.toFixed(2)}%`);
    if (growthLines.length > 0) {
      finLines.push(`- 成长性：${growthLines.join('，')}`);
    }

    // 财务健康
    const healthLines: string[] = [];
    if (latestFin.debt_to_assets !== undefined) healthLines.push(`资产负债率 ${latestFin.debt_to_assets.toFixed(2)}%`);
    if (latestFin.current_ratio !== undefined) healthLines.push(`流动比率 ${latestFin.current_ratio.toFixed(2)}`);
    if (latestFin.quick_ratio !== undefined) healthLines.push(`速动比率 ${latestFin.quick_ratio.toFixed(2)}`);
    if (healthLines.length > 0) {
      finLines.push(`- 财务健康：${healthLines.join('，')}`);
    }

    // 现金流质量
    if (latestFin.ocf_to_or !== undefined) {
      finLines.push(`- 经营现金流/营收：${latestFin.ocf_to_or.toFixed(4)} (${latestFin.ocf_to_or < 0 ? '现金流为负⚠️' : latestFin.ocf_to_or < 0.05 ? '偏低' : '正常'})`);
    }

    // 对比上期
    if (prevFin) {
      const changes: string[] = [];
      const prevDate = prevFin.end_date
        ? `${prevFin.end_date.slice(0, 4)}-${prevFin.end_date.slice(4, 6)}-${prevFin.end_date.slice(6, 8)}`
        : '上期';
      changes.push(`\n与上期（${prevDate}）对比：`);
      if (latestFin.roe !== undefined && prevFin.roe !== undefined) {
        changes.push(`- ROE：${latestFin.roe.toFixed(2)}% → ${prevFin.roe.toFixed(2)}%（${latestFin.roe > prevFin.roe ? '↑' : '↓'}）`);
      }
      if (latestFin.or_yoy !== undefined && prevFin.or_yoy !== undefined) {
        changes.push(`- 营收增速：${latestFin.or_yoy > 0 ? '+' : ''}${latestFin.or_yoy.toFixed(2)}% → ${prevFin.or_yoy > 0 ? '+' : ''}${prevFin.or_yoy.toFixed(2)}%`);
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

    sections.push(`### 资金流向\n${flowLines.join('\n')}`);
  }

  // ===== 4. AI 分析提示 =====
  sections.push(`### 基本面分析提示
- PE/PB 需要结合行业均值和历史分位判断，不能只看绝对值
- ROE 持续高于 10% 视为盈利能力良好，低于 5% 需要警惕
- 营收增速连续两个季度下滑可能是基本面恶化的信号
- 主力资金连续净流出且股价上涨 → 量价背离，可能是诱多
- 资产负债率 > 80% 为高杠杆，需关注偿债风险
- 经营现金流/营收 < 0 → 利润可能只是账面数字`);

  sections.push('---');
  return sections.join('\n');
}
