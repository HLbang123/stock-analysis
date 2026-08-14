'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina, getMinuteData, getChipData } from '@/services/stockApi';
import { isETF, parseCode } from '@/lib/identify';
import { ALERT_RULES, checkAllRules } from '@/services/alertRules';
import { computeSupportResistance, type SupportResistance } from '@/services/deep-analysis/levels';
import { RealtimeQuote, KLineData, RuleCheckResult } from '@/types';
import { formatPrice, formatChange, formatVolume, cn, getAlertLevelColor } from '@/lib/utils';
import { buildUpdatedKLines } from '@/lib/stock-helpers';
import { getJSON, getJSONOr } from '@/services/api';
import type { StockRpsResp, FuyaoAnomalyResp, FuyaoFundResp, TushareStockDataResp } from '@/types/api';
import { ArrowLeft, RefreshCw, TrendingUp, Loader2, Plus, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { KLineChart } from '@/components/KLineChart';
import { MinuteChart } from '@/components/MinuteChart';
import { EChart } from '@/components/market/EChart';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

interface AnomalyItem {
  tag_name?: string;
  keyword_list?: string[];
  analysis_content?: string;
}

export default function StockDetailPage() {
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;

  const { watchlist, addToWatchlist, removeFromWatchlist, alerts } = useStockStore();

  const [quote, setQuote] = useState<RealtimeQuote | null>(null);
  const [kLines, setKLines] = useState<KLineData[]>([]);
  const [minuteData, setMinuteData] = useState<{ time: string; price: number; volume: number; avgPrice: number }[]>([]);
  const [ruleResults, setRuleResults] = useState<RuleCheckResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chartTab, setChartTab] = useState<'kline' | 'minute'>('minute');
  const [error, setError] = useState<string | null>(null);
  const [rpsData, setRpsData] = useState<StockRpsResp | null>(null);
  const [fundData, setFundData] = useState<any>(null);
  const [fundLoading, setFundLoading] = useState(false);
  const [anomaly, setAnomaly] = useState<AnomalyItem | null>(null);
  const [thsTags, setThsTags] = useState<{ industries: string[]; concepts: string[] } | null>(null);
  const [fundInfo, setFundInfo] = useState<FuyaoFundResp | null>(null);
  const [fundBars, setFundBars] = useState<{ tradeDate: string; close: number; changePct: number | null }[]>([]);
  const [srData, setSrData] = useState<SupportResistance | null>(null);

  const stock = watchlist.find(s => s.code === code);
  const stockName = quote?.name || stock?.name || code;

  // 该股票的历史预警
  const stockAlerts = useMemo(
    () => alerts.filter(a => a.stockCode === code).slice(-10).reverse(),
    [alerts, code]
  );

  // 加载数据
  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [quoteData, kLineData, minData] = await Promise.all([
        getRealtimeQuote(code),
        getKLineSina(code, 240, 120),
        getMinuteData(code),
      ]);

      if (!quoteData) {
        setError('获取行情失败，请检查标的代码');
        return;
      }

      setQuote(quoteData);
      setKLines(kLineData);
      setMinuteData(minData || []);

      // 构建实时K线并检查规则
      if (kLineData.length >= 5) {
        const updatedKLines = buildUpdatedKLines(quoteData, kLineData);
        const chip = await getChipData(code).catch(() => null);
        const results = checkAllRules(updatedKLines, quoteData, ALERT_RULES.filter(r => r.isEnabled), chip, undefined, isETF(code));
        setSrData(computeSupportResistance(updatedKLines, chip));

        setRuleResults(results);
      }
    } catch (err) {
      console.error('加载股票数据失败:', err);
      setError('加载失败，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (code) {
      loadData();
    }
  }, [code]);

  // 拉 RPS + 基本面 + 异动原因（主数据加载后异步）
  useEffect(() => {
    if (!code) return;
    getJSONOr<StockRpsResp | null>(`/api/stock/rps?code=${code}`, null).then(d => { if (d && !d.error) setRpsData(d); });
    setFundLoading(true);
    getJSONOr<TushareStockDataResp | null>(`/api/tushare/stock-data?code=${code}`, null)
      .then(d => { if (d?.success) setFundData(d.data); })
      .finally(() => setFundLoading(false));
    // 异动原因：code 格式 sz002463 → 002463.SZ
    const m = code.match(/^([a-z]+)(\d+)$/i);
    if (m) {
      const thscode = `${m[2]}.${m[1].toUpperCase()}`;
      getJSONOr<FuyaoAnomalyResp | null>(`/api/fuyao/anomaly?code=${thscode}`, null)
        .then(d => { if (d?.item && d.item.length > 0) setAnomaly(d.item[0] as AnomalyItem); });
      // 同花顺概念/行业标签（成分快照反查）
      getJSONOr<{ industries: string[]; concepts: string[] } | null>(`/api/ths/concepts?code=${thscode}`, null)
        .then(d => { if (d && (d.industries?.length || d.concepts?.length)) setThsTags({ industries: d.industries ?? [], concepts: d.concepts ?? [] }); });
      // ETF 时拉基金持仓 + 净值走势
      if (isETF(code)) {
        getJSONOr<FuyaoFundResp | null>(`/api/fuyao/fund?code=${thscode}`, null)
          .then(d => { if (d?.holdings && d.holdings.length > 0) setFundInfo(d); });
        getJSONOr<{ bars: { tradeDate: string; close: number; changePct: number | null }[] } | null>(`/api/fund/daily?code=${code}`, null)
          .then(d => { if (d?.bars?.length) setFundBars(d.bars); });
      }
    }
  }, [code]);

  // 趋势状态（MA5/13/55 从 K 线 + 当前价算）
  const trendStatus = useMemo(() => {
    if (kLines.length < 55 || !quote) return null;
    const closes = [...kLines.map(k => k.close), quote.price];
    const ma = (p: number) => closes.slice(-p).reduce((a: number, b: number) => a + b, 0) / p;
    const maSeries = (p: number) => {
      const out: number[] = [];
      let sum = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= p) sum -= closes[i - p];
        out.push(i >= p - 1 ? sum / p : NaN);
      }
      return out;
    };
    const ma5s = maSeries(5), ma13s = maSeries(13);
    const ma55 = ma(55);
    const n = closes.length - 1;
    const price = closes[n];
    // 最近 3 根内是否发生穿越(金叉/死叉事件);未穿越则只显示排列状态
    let cross: 'golden' | 'death' | null = null;
    for (let i = n; i > n - 3 && i >= 1; i--) {
      const prevBull = ma5s[i - 1] > ma13s[i - 1];
      const curBull = ma5s[i] > ma13s[i];
      if (!prevBull && curBull) { cross = 'golden'; break; }
      if (prevBull && !curBull) { cross = 'death'; break; }
    }
    const bullish = ma5s[n] > ma13s[n];
    return {
      aboveMa55: price > ma55,
      bullish,
      cross,
      ma55: ma55.toFixed(2),
    };
  }, [kLines, quote]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      {/* 顶部导航 */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => {
            // 有站内历史则返回上一页（扫描/自选/搜索等来源页），直接打开详情（无历史）回首页
            if (window.history.length > 1) router.back();
            else router.push('/');
          }}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          title="返回"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{stockName}</h1>
          <p className="text-sm text-gray-500">{code}</p>
        </div>
        <button
          onClick={loadData}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          title="刷新"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
        {stock ? (
          <button
            onClick={() => { removeFromWatchlist(code); toast.success(`已删除 ${stockName}`); }}
            className="p-2 text-gray-400 hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] rounded-lg transition"
            title="删除自选"
          >
            <Minus className="w-5 h-5" />
          </button>
        ) : (
          <button
            onClick={() => {
              if (quote) {
                const parsed = parseCode(code);
                addToWatchlist({
                  code,
                  name: quote.name,
                  market: parsed?.market || 'sh',
                  pureCode: parsed?.pureCode || code.replace(/^[a-z]+/, ''),
                });
                toast.success(`已添加 ${quote.name}`);
              }
            }}
            className="p-2 text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] rounded-lg transition"
            title="添加自选"
          >
            <Plus className="w-5 h-5" />
          </button>
        )}
      </div>

      {error ? (
        <Card variant="warning" className="p-6 text-center">
          <p className="text-[var(--color-warning)]">{error}</p>
          <button onClick={loadData} className="mt-3 text-sm text-[var(--color-accent)] hover:underline">重试</button>
        </Card>
      ) : (
        <>
          {/* 实时行情卡片 */}
          {quote && (() => {
            const up = quote.changePercent >= 0;
            const tone = up ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]';
            const amplitude = quote.preClose ? ((quote.high - quote.low) / quote.preClose) * 100 : null;
            return (
            <Card className="p-5 mb-4">
              {/* hero：大价格 + 涨跌 chip + 昨收 */}
              <div className="flex items-end justify-between mb-5">
                <div className="flex items-end gap-3 flex-wrap">
                  <p className={cn("text-4xl font-bold leading-none tracking-tight", tone)}>
                    {formatPrice(quote.price)}
                  </p>
                  <div className="flex items-center gap-1.5 pb-0.5">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-[var(--radius-sm)] text-sm font-semibold",
                      up ? "bg-[var(--color-up-soft)] text-[var(--color-up)]" : "bg-[var(--color-down-soft)] text-[var(--color-down)]"
                    )}>
                      {formatChange(quote.changePercent)}
                    </span>
                    <span className={cn("text-sm font-medium", tone)}>
                      {quote.change > 0 ? '+' : ''}{quote.change?.toFixed(2)}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-gray-400 pb-0.5">
                  昨收 <span className="text-gray-600 dark:text-gray-300 font-medium">{formatPrice(quote.preClose)}</span>
                </p>
              </div>

              {/* 次级指标网格：小标签 + 中数值 */}
              <div className="grid grid-cols-3 gap-x-3 gap-y-4 pt-4 border-t border-[var(--border)]">
                <QuoteStat label="开盘" value={formatPrice(quote.open)} tone={quote.open >= quote.preClose ? 'up' : 'down'} />
                <QuoteStat label="最高" value={formatPrice(quote.high)} tone="up" />
                <QuoteStat label="最低" value={formatPrice(quote.low)} tone="down" />
                <QuoteStat label="成交量" value={formatVolume(quote.volume)} />
                <QuoteStat label="成交额" value={quote.amount ? formatVolume(quote.amount) : '--'} />
                <QuoteStat label="振幅" value={amplitude != null ? `${amplitude.toFixed(2)}%` : '--'} />
              </div>
            </Card>
            );
          })()}

          {/* RPS + 趋势状态 */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {rpsData && (
              <>
                {[
                  { label: 'RPS20', val: rpsData.rps20, ret: (rpsData as any).ret20 },
                  { label: 'RPS60', val: rpsData.rps60, ret: (rpsData as any).ret60 },
                  { label: 'RPS120', val: rpsData.rps120, ret: (rpsData as any).ret120 },
                  { label: 'RPS250', val: rpsData.rps250, ret: (rpsData as any).ret250 },
                ].map(r => r.val != null && (
                  <span key={r.label} className={cn(
                    "px-2 py-1 rounded-[var(--radius-md)] text-xs font-mono font-semibold",
                    r.val >= 95 ? "bg-[var(--color-up-soft)] text-[var(--color-up)]" :
                    r.val >= 87 ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]" :
                    "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
                  )} title={`${r.label} 涨幅 ${r.ret?.toFixed(1)}%`}>
                    {r.label} {r.val.toFixed(1)}
                  </span>
                ))}
                <span className="text-xs text-gray-400">({rpsData.calcDate})</span>
              </>
            )}
            {trendStatus && (
              <>
                <span className={cn("px-2 py-1 rounded-[var(--radius-md)] text-xs font-medium", trendStatus.aboveMa55 ? "bg-[var(--color-up-soft)] text-[var(--color-up)]" : "bg-[var(--color-down-soft)] text-[var(--color-down)]")}>
                  {trendStatus.aboveMa55 ? 'MA55上方 ✓' : 'MA55下方 ⚠'} ({trendStatus.ma55})
                </span>
                <span className={cn("px-2 py-1 rounded-[var(--radius-md)] text-xs font-medium", trendStatus.bullish ? "bg-[var(--color-up-soft)] text-[var(--color-up)]" : "bg-[var(--color-down-soft)] text-[var(--color-down)]")}>
                  5/13{trendStatus.cross === 'golden' ? '金叉 ✓' : trendStatus.cross === 'death' ? '死叉 ⚠' : trendStatus.bullish ? '多头排列' : '空头排列'}
                </span>
              </>
            )}
          </div>

          {/* 同花顺行业/概念标签（成分快照，每日盘后刷新；行业含一级+二级） */}
          {thsTags && (
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
              {thsTags.industries.slice(0, 3).map(n => (
                <span key={`i-${n}`} className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-medium">{n}</span>
              ))}
              {thsTags.concepts.slice(0, 8).map(n => (
                <span key={`c-${n}`} className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{n}</span>
              ))}
              {thsTags.concepts.length > 8 && (
                <span className="text-xs text-gray-400 cursor-default" title={thsTags.concepts.slice(8).join('、')}>+{thsTags.concepts.length - 8}</span>
              )}
            </div>
          )}

          {/* 异动原因（当天有异动才显示） */}
          {anomaly && (
            <Card className="p-4 mb-4 border-l-4 border-[var(--color-warning)]">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold">🔥 今日异动</span>
                <span className={cn("text-xs px-1.5 py-0.5 rounded-[var(--radius-sm)] font-medium",
                  anomaly.tag_name === '涨停' ? "bg-[var(--color-up-soft)] text-[var(--color-up)]" :
                  anomaly.tag_name === '跌停' ? "bg-[var(--color-down-soft)] text-[var(--color-down)]" :
                  "bg-[var(--color-warning-soft)] text-[var(--color-warning)]")}>
                  {anomaly.tag_name}
                </span>
                {anomaly.keyword_list?.map((kw: string, i: number) => (
                  <span key={i} className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">{kw}</span>
                ))}
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                {anomaly.analysis_content}
              </p>
            </Card>
          )}

          {/* 图表切换 */}
          <Tabs
            className="mb-4"
            variant="pills"
            activeCls="bg-[var(--color-accent)] text-white"
            value={chartTab}
            onChange={setChartTab}
            items={[
              { value: 'minute', label: '分时图' },
              { value: 'kline', label: '日K线' },
            ]}
          />

          {/* 分时图 */}
          {chartTab === 'minute' && (
            <Card className="mb-4">
              {minuteData.length > 0 ? (
                <MinuteChart
                  data={minuteData}
                  prevClose={quote?.preClose || 0}
                  height={400}
                />
              ) : (
                <div className="flex items-center justify-center h-[400px] text-gray-400">
                  <div className="text-center">
                    <TrendingUp className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>暂无分时数据</p>
                    <p className="text-sm mt-1">非交易时段不提供实时分时数据</p>
                  </div>
                </div>
              )}
            </Card>
          )}

          {/* K线图 */}
          {chartTab === 'kline' && (
            <Card className="mb-4">
              <KLineChart
                data={kLines}
                height={400}
                levels={srData ? [
                  ...srData.supports.map(l => ({ price: l.price, color: '#16a34a', title: `支撑·${l.label}` })),
                  ...srData.resistances.map(l => ({ price: l.price, color: '#dc2626', title: `压力·${l.label}` })),
                ] : []}
              />
            </Card>
          )}

          {/* 基本面速览 + 资金流向 */}
          {fundLoading && (
            <Card className="p-4 mb-4 flex items-center gap-2 text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" /> 加载基本面数据...
            </Card>
          )}
          {!fundLoading && fundData && (fundData.dailyBasic?.length > 0 || fundData.finaIndicator?.length > 0) && (
            <Card className="p-4 mb-4">
              <h2 className="font-semibold text-sm mb-3">基本面速览</h2>
              {fundData.dailyBasic?.[0] && (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 text-xs mb-3">
                  {fundData.dailyBasic[0].pe_ttm != null && <Metric label="PE-TTM" value={fundData.dailyBasic[0].pe_ttm.toFixed(1)} />}
                  {fundData.dailyBasic[0].pb != null && <Metric label="PB" value={fundData.dailyBasic[0].pb.toFixed(2)} />}
                  {fundData.dailyBasic[0].total_mv != null && <Metric label="总市值" value={`${(fundData.dailyBasic[0].total_mv / 10000).toFixed(1)}亿`} />}
                  {fundData.dailyBasic[0].turnover_rate != null && <Metric label="换手率" value={`${fundData.dailyBasic[0].turnover_rate.toFixed(2)}%`} />}
                  {fundData.finaIndicator?.[0]?.roe != null && <Metric label="ROE" value={`${fundData.finaIndicator[0].roe.toFixed(2)}%`} />}
                  {fundData.finaIndicator?.[0]?.grossprofit_margin != null && <Metric label="毛利率" value={`${fundData.finaIndicator[0].grossprofit_margin.toFixed(1)}%`} />}
                  {fundData.finaIndicator?.[0]?.or_yoy != null && <Metric label="营收同比" value={`${fundData.finaIndicator[0].or_yoy > 0 ? '+' : ''}${fundData.finaIndicator[0].or_yoy.toFixed(1)}%`} />}
                  {fundData.finaIndicator?.[0]?.tr_yoy != null && <Metric label="净利同比" value={`${fundData.finaIndicator[0].tr_yoy > 0 ? '+' : ''}${fundData.finaIndicator[0].tr_yoy.toFixed(1)}%`} />}
                </div>
              )}
              {/* 资金流向 mini 图 */}
              {fundData.moneyflow?.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">主力资金近{fundData.moneyflow.length}日（亿元）</p>
                  <div className="h-32">
                    <EChart option={{
                      tooltip: { trigger: 'axis', valueFormatter: (v: any) => `${(Number(v) / 10000).toFixed(2)}亿` },
                      grid: { left: 35, right: 10, top: 5, bottom: 20 },
                      xAxis: { type: 'category', data: fundData.moneyflow.slice().reverse().map((m: any) => m.tradeDate?.slice(4, 6) + '-' + m.tradeDate?.slice(6, 8)), axisLabel: { fontSize: 9 } },
                      yAxis: { type: 'value', axisLabel: { fontSize: 9, formatter: (v: number) => (v / 10000).toFixed(0) } },
                      series: [{ type: 'bar', data: fundData.moneyflow.slice().reverse().map((m: any) => m.netAmount), itemStyle: { color: (p: any) => (p.value >= 0 ? '#ef4444' : '#22c55e') } }],
                    }} />
                  </div>
                  {/* 大中小单结构（最新一日占比） */}
                  {fundData.moneyflow[0] && (
                    <div className="flex items-center gap-2 text-xs mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                      <span className="text-gray-500 shrink-0">今日大中小单占比</span>
                      {[
                        { label: '大单', rate: fundData.moneyflow[0].buyLgRate, cls: 'text-[var(--color-up)]' },
                        { label: '中单', rate: fundData.moneyflow[0].buyMdRate, cls: 'text-gray-600 dark:text-gray-300' },
                        { label: '小单', rate: fundData.moneyflow[0].buySmRate, cls: 'text-[var(--color-down)]' },
                      ].map((b) => (
                        <span key={b.label} className={cn('flex items-center gap-1', b.cls)}>
                          {b.label} <b className="font-mono">{b.rate != null ? `${b.rate.toFixed(1)}%` : '--'}</b>
                        </span>
                      ))}
                      {fundData.moneyflow[0].netD5Amount != null && (
                        <span className="text-gray-500 ml-auto">5日主力 <b className={cn('font-mono', fundData.moneyflow[0].netD5Amount >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]')}>{(fundData.moneyflow[0].netD5Amount / 10000).toFixed(2)}亿</b></span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* 支撑压力位（结构位 + 黄金分割回撤） */}
          {srData && (srData.supports.length > 0 || srData.resistances.length > 0) && (
            <Card className="p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm">支撑压力位</h2>
                <span className="text-xs text-gray-400">现价 <span className="font-mono text-gray-600 dark:text-gray-300">{srData.current.toFixed(2)}</span></span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-[var(--color-down)] font-medium mb-1.5">支撑位（下方）</p>
                  <div className="space-y-1">
                    {srData.supports.map(l => (
                      <div key={`s-${l.label}-${l.price}`} className="flex items-center justify-between bg-[var(--color-down-soft)] rounded-[var(--radius-sm)] px-2 py-1">
                        <span className="text-gray-500">{l.label}</span>
                        <span className="font-mono font-medium text-[var(--color-down)]">{l.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[var(--color-up)] font-medium mb-1.5">压力位（上方）</p>
                  <div className="space-y-1">
                    {srData.resistances.map(l => (
                      <div key={`r-${l.label}-${l.price}`} className="flex items-center justify-between bg-[var(--color-up-soft)] rounded-[var(--radius-sm)] px-2 py-1">
                        <span className="text-gray-500">{l.label}</span>
                        <span className="font-mono font-medium text-[var(--color-up)]">{l.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* ETF 基金持仓（仅 ETF 显示） */}
          {fundInfo?.holdings && (
            <Card className="p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-sm">基金持仓（前{fundInfo.holdings.length}大重仓股）</h2>
                {fundInfo.profile?.fund_name && <span className="text-xs text-gray-400">{fundInfo.profile.fund_name}</span>}
              </div>
              {fundBars.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs text-gray-500 mb-1">净值走势（近{fundBars.length}日）</p>
                  <div className="h-24">
                    <EChart option={{
                      tooltip: { trigger: 'axis' },
                      grid: { left: 35, right: 10, top: 5, bottom: 20 },
                      xAxis: { type: 'category', data: fundBars.map(b => b.tradeDate.slice(4, 6) + '-' + b.tradeDate.slice(6, 8)), axisLabel: { fontSize: 9, interval: 9 } },
                      yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 9 } },
                      series: [{ type: 'line', data: fundBars.map(b => b.close), smooth: true, symbol: 'none', lineStyle: { color: '#2563eb', width: 1.5 }, areaStyle: { opacity: 0.08 } }],
                    }} />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {fundInfo.holdings.map((h: any, i: number) => (
                  <div key={h.thscode} className="p-2 rounded-lg bg-gray-50 dark:bg-gray-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-400">#{i + 1}</span>
                      <span className="text-xs font-medium text-[var(--color-accent)]">{h.hold_ratio.toFixed(2)}%</span>
                    </div>
                    <p className="text-sm font-medium mt-0.5 truncate">{h.stock_name}</p>
                    <p className="text-xs text-gray-400">{h.ticker}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 触发规则列表 */}
          {ruleResults.length > 0 && (
            <Card className="mb-4">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-3">
                触发规则 ({ruleResults.length})
              </h2>
              <div className="space-y-2">
                {ruleResults.map((result, i) => {
                  const rule = ALERT_RULES.find(r => r.id === result.ruleId);
                  return (
                    <div
                      key={i}
                      className={cn(
                        "p-3 rounded-lg border-l-4",
                        getAlertLevelColor(rule?.level || 'INFO')
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn(
                          "w-2 h-2 rounded-full shrink-0",
                          rule?.level === 'CRITICAL' ? "bg-[var(--color-danger)]" : rule?.level === 'WARNING' ? "bg-[var(--color-warning)]" : "bg-[var(--color-accent)]"
                        )} />
                        <span className="font-medium">{rule?.name || result.ruleId}</span>
                        {rule && (
                          <Badge variant={rule.level}>{rule.level}</Badge>
                        )}
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400 ml-4">
                        {result.message}
                      </p>
                      {rule?.suggestion && (
                        <p className="text-xs text-gray-500 mt-1 ml-4">
                          建议: {rule.suggestion}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* 历史预警 */}
          {stockAlerts.length > 0 && (
            <Card>
              <h2 className="font-semibold text-gray-900 dark:text-white mb-3">
                历史预警 ({stockAlerts.length})
              </h2>
              <div className="space-y-2">
                {stockAlerts.map(alert => (
                  <div
                    key={alert.id}
                    className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-gray-500">
                        {new Date(alert.triggeredAt).toLocaleString('zh-CN')}
                      </span>
                      <span className="text-sm font-medium">{alert.ruleName}</span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {alert.alertMessage}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 无触发规则 */}
          {ruleResults.length === 0 && (
            <Card className="p-8 text-center text-gray-400">
              <p>未触发任何预警规则</p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/** hero 下方的次级指标：小标签 + 中数值，数字全局 tabular-nums */
function QuoteStat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={cn(
        "text-sm font-semibold mt-0.5",
        tone === 'up' ? "text-[var(--color-up)]" : tone === 'down' ? "text-[var(--color-down)]" : "text-gray-800 dark:text-gray-100"
      )}>
        {value}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-gray-400">{label}</p>
      <p className="font-semibold text-gray-800 dark:text-gray-100">{value}</p>
    </div>
  );
}
