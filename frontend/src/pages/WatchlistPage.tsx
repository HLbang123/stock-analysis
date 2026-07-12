import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { useStockStore } from '../store/useStockStore';
import { getQuotes } from '../api/client';
import type { Quote } from '../types';
import { formatPrice, formatPercent } from '../utils/format';
import { priceColor } from '../utils/colors';

export default function WatchlistPage() {
  const { watchlist, removeFromWatchlist } = useStockStore();
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (watchlist.length === 0) {
      setLoading(false);
      return;
    }

    let mounted = true;
    const codes = watchlist.map((s) => `${s.market}${s.code}`);

    async function fetch() {
      try {
        const data = await getQuotes(codes);
        if (mounted) {
          const map: Record<string, Quote> = {};
          for (const q of data) {
            map[q.fullCode] = q;
          }
          setQuotes(map);
        }
      } catch {
        // silent
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetch();
    const timer = setInterval(fetch, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, [watchlist]);

  if (watchlist.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 p-8">
        <div className="text-4xl mb-4">⭐</div>
        <p className="text-sm">还没有添加自选股</p>
        <p className="text-xs mt-2">在股票分析页点击星标即可添加</p>
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 max-w-3xl mx-auto w-full">
      <h2 className="text-lg font-semibold text-white mb-4">
        自选股
        <span className="text-sm text-gray-500 ml-2">({watchlist.length})</span>
      </h2>

      {loading && (
        <div className="text-center text-gray-500 py-8">加载行情...</div>
      )}

      <div className="space-y-2">
        {watchlist.map((stock) => {
          const fullCode = `${stock.market}${stock.code}`;
          const quote = quotes[fullCode];
          const isUp = quote && quote.change > 0;
          const isDown = quote && quote.change < 0;
          const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
          const colorClass = quote ? priceColor(quote.change) : 'text-gray-500';

          return (
            <div
              key={fullCode}
              className="bg-surface-card border border-surface-border rounded-lg hover:border-bull/20 transition-colors"
            >
              <div className="flex items-center p-4">
                {/* Stock info */}
                <Link
                  to={`/stock/${fullCode}`}
                  className="flex-1 flex items-center gap-4 min-w-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate">
                      {stock.name}
                    </div>
                    <div className="text-xs text-gray-500">{stock.code}</div>
                  </div>

                  {quote ? (
                    <div className="text-right ml-auto">
                      <div className={`text-base font-bold ${colorClass}`}>
                        {formatPrice(quote.price)}
                      </div>
                      <div className={`flex items-center gap-1 text-xs ${colorClass} justify-end`}>
                        <Icon className="w-3 h-3" />
                        <span>{formatPercent(quote.changePercent)}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500 ml-auto">加载中...</div>
                  )}
                </Link>

                {/* Remove button */}
                <button
                  onClick={() => removeFromWatchlist(stock.code)}
                  className="p-2 ml-3 text-gray-600 hover:text-red-400 transition-colors rounded"
                  title="移除自选"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
