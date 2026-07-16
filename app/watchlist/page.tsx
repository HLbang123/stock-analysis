'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, parseStockCode, searchStocks } from '@/services/stockApi';
import { RealtimeQuote } from '@/types';
import { formatPrice, formatChange, formatVolume, cn } from '@/lib/utils';
import { Plus, Search, Trash2, TrendingUp } from 'lucide-react';

export default function WatchlistPage() {
  const router = useRouter();
  const { watchlist, addToWatchlist, removeFromWatchlist, isInWatchlist } = useStockStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RealtimeQuote[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [stockQuotes, setStockQuotes] = useState<Map<string, RealtimeQuote>>(new Map());
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // 刷新自选股行情
  const refreshQuotes = async () => {
    const quotes = new Map<string, RealtimeQuote>();
    for (const stock of watchlist) {
      const quote = await getRealtimeQuote(stock.code);
      if (quote) {
        quotes.set(stock.code, quote);
      }
    }
    setStockQuotes(quotes);
  };

  useEffect(() => {
    refreshQuotes();
  }, [watchlist]);

  // 输入即搜（防抖300ms）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      const results = await searchStocks(searchQuery);
      setSearchResults(results);
      setIsSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // 添加到自选
  const handleAddStock = (quote: RealtimeQuote) => {
    const { market, pureCode } = parseStockCode(quote.code);
    addToWatchlist({
      code: quote.code,
      name: quote.name,
      market,
      pureCode,
    });
    setSearchQuery('');
    setSearchResults([]);
  };

  return (
    <div>
      {/* 搜索框 */}
      <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="输入股票代码搜索 (如: 600519, 000858)"
            className="w-full pl-10 pr-4 py-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {isSearching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">搜索中...</span>
          )}
        </div>

        {/* 搜索结果 */}
        {searchResults.length > 0 && (
          <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3 space-y-1">
            {searchResults.map((quote) => (
              <div key={quote.code} className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition">
                <div>
                  <span className="font-medium text-sm">{quote.name}</span>
                  <span className="text-xs text-gray-500 ml-2">{quote.code}</span>
                </div>
                {!isInWatchlist(quote.code) && (
                  <button
                    onClick={() => handleAddStock(quote)}
                    className="p-1.5 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200 transition"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 自选股列表 */}
      {watchlist.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Plus className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">暂无自选股</p>
          <p className="text-sm mt-2">在上方搜索框输入股票代码添加</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500">共 {watchlist.length} 只股票</span>
            <button
              onClick={refreshQuotes}
              className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
            >
              <TrendingUp className="w-4 h-4" />
              刷新行情
            </button>
          </div>

          <div className="space-y-3">
            {watchlist.map((stock) => {
              const quote = stockQuotes.get(stock.code);
              return (
                <div
                  key={stock.code}
                  onClick={() => router.push(`/stock/${stock.code}`)}
                  className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold">{stock.name}</h3>
                      <p className="text-sm text-gray-500">{stock.code}</p>
                    </div>
                    {quote ? (
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className={cn("font-semibold text-lg", quote.changePercent >= 0 ? "text-red-500" : "text-green-500")}>
                            {formatPrice(quote.price)}
                          </p>
                          <p className={cn("text-sm", quote.changePercent >= 0 ? "text-red-500" : "text-green-500")}>
                            {formatChange(quote.changePercent)}
                          </p>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); removeFromWatchlist(stock.code); }}
                          className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="text-gray-400 text-sm">加载中...</div>
                    )}
                  </div>

                  {quote && (
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-sm">
                      <span className="text-gray-500">成交量: {formatVolume(quote.volume)}</span>
                      <span className="text-blue-600">查看详情 →</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
