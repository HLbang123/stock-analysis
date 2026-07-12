import { useParams, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { ArrowLeft, Star } from 'lucide-react';
import KlineChart from '../components/chart/KlineChart';
import ChartToolbar from '../components/chart/ChartToolbar';
import QuoteCard from '../components/stock/QuoteCard';
import AlertPanel from '../components/alert/AlertPanel';
import { useStockStore } from '../store/useStockStore';
import { useAlertStore } from '../store/useAlertStore';
import { useKlineData } from '../hooks/useKlineData';
import { useAlerts } from '../hooks/useAlerts';
import { searchStocks, getQuotes } from '../api/client';
import { calcMAs } from '../engine/indicators/ma';

export default function StockPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const {
    selectedStock, quote, isQuoteLoading,
    period, showMA5, showMA10, showMA20, showVolume,
    selectStock, setQuote, setQuoteLoading,
    setPeriod, toggleMA5, toggleMA10, toggleMA20, toggleVolume,
    addToWatchlist, removeFromWatchlist, isInWatchlist,
  } = useStockStore();

  const { setAlerts } = useAlertStore();

  // Fetch stock info on code change
  useEffect(() => {
    if (!code) return;
    // Short search to get stock name
    setQuoteLoading(true);
    searchStocks(code).then((results) => {
      const found = results.find((s) => `${s.market}${s.code}` === code);
      if (found) {
        selectStock(found);
      } else {
        // Create basic stock info from code
        const market = code.startsWith('sh') ? 'sh' : code.startsWith('sz') ? 'sz' : 'bj';
        const codeNum = code.replace(/^(sh|sz|bj)/, '');
        selectStock({ code: codeNum, market, name: code, type: 'A股' });
      }
    }).catch(() => {
      const market = code.startsWith('sh') ? 'sh' : code.startsWith('sz') ? 'sz' : 'bj';
      const codeNum = code.replace(/^(sh|sz|bj)/, '');
      selectStock({ code: codeNum, market, name: code, type: 'A股' });
    });

    // Fetch quote
    getQuotes([code]).then((quotes) => {
      if (quotes.length > 0) setQuote(quotes[0]);
      setQuoteLoading(false);
    }).catch(() => setQuoteLoading(false));
  }, [code]);

  // Fetch K-line data
  const { data: klineData, loading: klineLoading, error: klineError } = useKlineData(code, period);

  // Calculate MAs
  const klines = klineData?.klines || [];
  const closes = klines.map((k) => k.close);
  const mas = calcMAs(closes, [5, 10, 20]);
  const ma5Values = mas.get(5) || [];
  const ma10Values = mas.get(10) || [];
  const ma20Values = mas.get(20) || [];

  // Run rule engine
  const alerts = useAlerts(klines, quote);

  // Update alert store
  useEffect(() => {
    setAlerts(alerts);
  }, [alerts]);

  const inWatchlist = code ? isInWatchlist(code) : false;

  function handleWatchlistToggle() {
    if (!selectedStock) return;
    if (inWatchlist) {
      removeFromWatchlist(selectedStock.code);
    } else {
      addToWatchlist(selectedStock);
    }
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-surface-card border-b border-surface-border shrink-0">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 rounded hover:bg-white/10 transition-colors text-gray-400 hover:text-white"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {selectedStock && (
          <>
            <h1 className="text-white font-semibold">{selectedStock.name}</h1>
            <span className="text-xs text-gray-500">{selectedStock.market}{selectedStock.code}</span>
          </>
        )}

        <button
          onClick={handleWatchlistToggle}
          className={`p-1.5 rounded transition-colors ml-auto ${
            inWatchlist
              ? 'text-yellow-400 hover:text-yellow-300'
              : 'text-gray-500 hover:text-yellow-400'
          }`}
          title={inWatchlist ? '取消自选' : '添加自选'}
        >
          <Star className={`w-5 h-5 ${inWatchlist ? 'fill-yellow-400' : ''}`} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left: Chart area */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* Quote card (compact on mobile) */}
          {quote && (
            <div className="px-4 pt-3 shrink-0">
              <QuoteCard quote={quote} />
            </div>
          )}

          {/* Chart toolbar */}
          <div className="px-4 shrink-0">
            <ChartToolbar
              period={period}
              showMA5={showMA5}
              showMA10={showMA10}
              showMA20={showMA20}
              showVolume={showVolume}
              onPeriodChange={setPeriod}
              onToggleMA5={toggleMA5}
              onToggleMA10={toggleMA10}
              onToggleMA20={toggleMA20}
              onToggleVolume={toggleVolume}
            />
          </div>

          {/* Chart */}
          <div className="flex-1 px-4 pb-4 min-h-0">
            {klineLoading && (
              <div className="w-full h-full flex items-center justify-center">
                <div className="text-gray-500">加载K线数据...</div>
              </div>
            )}
            {klineError && (
              <div className="w-full h-full flex items-center justify-center">
                <div className="text-red-400">数据加载失败: {klineError}</div>
              </div>
            )}
            {!klineLoading && !klineError && klines.length > 0 && (
              <KlineChart
                klines={klines}
                ma5Values={ma5Values}
                ma10Values={ma10Values}
                ma20Values={ma20Values}
                showMA5={showMA5}
                showMA10={showMA10}
                showMA20={showMA20}
                showVolume={showVolume}
              />
            )}
            {!klineLoading && !klineError && klines.length === 0 && (
              <div className="w-full h-full flex items-center justify-center">
                <div className="text-gray-500">暂无K线数据</div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Alert panel */}
        <div className="w-full lg:w-80 xl:w-96 shrink-0 border-t lg:border-t-0 lg:border-l border-surface-border overflow-y-auto p-4">
          {alerts.length > 0 && (
            <div className="mb-4">
              <AlertPanel alerts={alerts} />
            </div>
          )}

          {/* Volume stats */}
          {klines.length > 0 && (
            <div className="bg-surface-card border border-surface-border rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">📊 成交量分析</h3>
              <VolumeStats klines={klines} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VolumeStats({ klines }: { klines: import('../types').Kline[] }) {
  if (klines.length < 5) return null;

  const recent5 = klines.slice(-5);
  const avgVol5 = recent5.reduce((sum, k) => sum + k.volume, 0) / 5;
  const lastVol = klines[klines.length - 1].volume;
  const ratio = avgVol5 > 0 ? lastVol / avgVol5 : 0;
  const maxVolAll = Math.max(...klines.map(k => k.volume));

  return (
    <div className="space-y-2 text-xs">
      <div className="flex justify-between">
        <span className="text-gray-400">前5日均量</span>
        <span className="text-white">{avgVol5 >= 1e8 ? `${(avgVol5/1e8).toFixed(2)}亿` : `${(avgVol5/1e4).toFixed(0)}万`}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-400">当前量</span>
        <span className={`font-medium ${ratio > 1.2 ? 'text-orange-400' : 'text-white'}`}>
          {lastVol >= 1e8 ? `${(lastVol/1e8).toFixed(2)}亿` : `${(lastVol/1e4).toFixed(0)}万`}
          {ratio > 1.2 && <span className="ml-1">⚡{ratio.toFixed(1)}x</span>}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-400">年内最大量</span>
        <span className="text-white">{maxVolAll >= 1e8 ? `${(maxVolAll/1e8).toFixed(2)}亿` : `${(maxVolAll/1e4).toFixed(0)}万`}</span>
      </div>
      {ratio > 1.2 && (
        <div className="mt-2 px-2 py-1.5 bg-orange-500/10 border border-orange-500/30 rounded text-xs text-orange-400">
          ⚠️ 放巨量 — 比前5日均量高 {((ratio-1)*100).toFixed(0)}%
        </div>
      )}
    </div>
  );
}
