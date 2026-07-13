'use client';

import React, { useEffect, useState } from 'react';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina, parseStockCode, searchStocks } from '@/services/stockApi';
import { Stock, RealtimeQuote } from '@/types';
import { formatPrice, formatChange, formatVolume, cn } from '@/lib/utils';
import { Plus, Search, Trash2, TrendingUp, ArrowRight } from 'lucide-react';
import { KLineChart } from '@/components/KLineChart';

export default function WatchlistPage() {
  const { watchlist, addToWatchlist, removeFromWatchlist, isInWatchlist } = useStockStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RealtimeQuote[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [stockQuotes, setStockQuotes] = useState<Map<string, RealtimeQuote>>(new Map());
  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const [selectedKLines, setSelectedKLines] = useState<any[]>([]);

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

  // 搜索股票
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await searchStocks(searchQuery);
      setSearchResults(results);
    } catch (error) {
      console.error('搜索失败:', error);
    } finally {
      setIsSearching(false);
    }
  };

  // 添加到自选
  const handleAddStock = (quote: RealtimeQuote) => {
    const { market, pureCode } = parseStockCode(quote.code);
    addToWatchlist({
      code: quote.code,
      name: quote.name,
      market,
      pureCode
    });
    setSearchQuery('');
    setSearchResults([]);
  };

  // 查看详情
  const handleViewDetail = async (code: string) => {
    setSelectedStock(code);
    const kLines = await getKLineSina(code, 240, 120);
    setSelectedKLines(kLines);
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-gray-900">自选股</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* 搜索框 */}
        <div className="bg-white rounded-xl p-4 shadow-sm mb-6">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="输入股票代码或名称搜索 (如: 600519, 茅台)"
                className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={isSearching}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
            >
              {isSearching ? '搜索中...' : '搜索'}
            </button>
          </div>

          {/* 搜索结果 */}
          {searchResults.length > 0 && (
            <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
              {searchResults.map((quote) => (
                <div
                  key={quote.code}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                >
                  <div>
                    <p className="font-medium">{quote.name}</p>
                    <p className="text-sm text-gray-500">{quote.code}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className={cn("font-medium", quote.changePercent >= 0 ? "text-red-500" : "text-green-500")}>
                        {formatPrice(quote.price)}
                      </p>
                      <p className={cn("text-sm", quote.changePercent >= 0 ? "text-red-500" : "text-green-500")}>
                        {formatChange(quote.changePercent)}
                      </p>
                    </div>
                    {!isInWatchlist(quote.code) && (
                      <button
                        onClick={() => handleAddStock(quote)}
                        className="p-2 bg-blue-100 text-blue-600 rounded-lg hover:bg-blue-200 transition"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
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
                    className="bg-white rounded-xl p-4 shadow-sm"
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
                            onClick={() => removeFromWatchlist(stock.code)}
                            className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="text-gray-400 text-sm">加载中...</div>
                      )}
                    </div>

                    {/* 成交量 */}
                    {quote && (
                      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500">
                        <span>成交量: {formatVolume(quote.volume)}</span>
                        <button
                          onClick={() => handleViewDetail(stock.code)}
                          className="text-blue-600 hover:text-blue-700 flex items-center gap-1"
                        >
                          查看K线
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* K线详情弹窗 */}
        {selectedStock && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-auto">
              <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
                <h2 className="font-semibold">K线图</h2>
                <button
                  onClick={() => setSelectedStock(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <Trash2 className="w-6 h-6" />
                </button>
              </div>
              <div className="p-4">
                <KLineChart data={selectedKLines} height={400} />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 底部导航 */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200">
        <div className="max-w-4xl mx-auto flex">
          <a
            href="/"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-gray-400 hover:text-gray-600 transition"
          >
            <TrendingUp className="w-6 h-6" />
            <span className="text-xs">预警</span>
          </a>
          <a
            href="/watchlist"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-blue-600"
          >
            <Plus className="w-6 h-6" />
            <span className="text-xs">自选</span>
          </a>
          <a
            href="/scanner"
            className="flex-1 py-3 flex flex-col items-center gap-1 text-gray-400 hover:text-gray-600 transition"
          >
            <Search className="w-6 h-6" />
            <span className="text-xs">筛选</span>
          </a>
        </div>
      </nav>
    </div>
  );
}