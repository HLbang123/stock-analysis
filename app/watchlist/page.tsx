'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, parseStockCode, searchStocks } from '@/services/stockApi';
import { RealtimeQuote } from '@/types';
import { formatPrice, formatChange, formatVolume, cn } from '@/lib/utils';
import { Plus, Search, Trash2, TrendingUp, ScanLine, Upload, Camera, X, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function WatchlistPage() {
  const router = useRouter();
  const { watchlist, addToWatchlist, removeFromWatchlist, isInWatchlist } = useStockStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RealtimeQuote[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [stockQuotes, setStockQuotes] = useState<Map<string, RealtimeQuote>>(new Map());
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const ocrFileRef = useRef<HTMLInputElement>(null);

  // OCR 状态
  const [showOcr, setShowOcr] = useState(false);
  const [ocrImage, setOcrImage] = useState<string | null>(null);
  const [ocrImageFile, setOcrImageFile] = useState<File | null>(null);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrResults, setOcrResults] = useState<{ code: string; name: string; added: boolean }[]>([]);

  // A股代码范围验证
  const isValidAStock = (code: number) => {
    const ranges = [
      { min: 600000, max: 605999, market: 'sh' },
      { min: 688000, max: 689999, market: 'sh' },
      { min: 0, max: 3999, market: 'sz' },
      { min: 300000, max: 301999, market: 'sz' },
    ];
    for (const r of ranges) {
      if (code >= r.min && code <= r.max) {
        return { market: r.market, pureCode: String(code).padStart(6, '0') };
      }
    }
    return null;
  };

  // OCR 识别
  const handleOcrScan = async () => {
    if (!ocrImageFile) { toast.error('请先选择图片'); return; }
    setIsOcrProcessing(true);
    setOcrStatus('正在下载中文语言包（首次约30MB）...');
    setOcrResults([]);

    try {
      const Tesseract = (await import('tesseract.js')).default;
      setOcrStatus('正在识别文字...');
      const worker = await Tesseract.createWorker('chi_sim');
      const { data } = await worker.recognize(ocrImageFile);
      await worker.terminate();

      const codeRegex = /(?<!\d)(\d{6})(?!\d)/g;
      const matches = data.text.match(codeRegex) || [];
      const extractedCodes = [...new Set(matches)];

      if (extractedCodes.length === 0) {
        setOcrStatus('未识别到有效股票代码，请确认截图清晰');
        setIsOcrProcessing(false);
        return;
      }

      const validResults: { code: string; name: string; added: boolean }[] = [];
      for (const codeStr of extractedCodes.slice(0, 20)) {
        const codeNum = parseInt(codeStr);
        const valid = isValidAStock(codeNum);
        if (!valid) continue;
        const fullCode = `${valid.market}${valid.pureCode}`;
        try {
          const quote = await getRealtimeQuote(fullCode);
          if (quote?.name) {
            validResults.push({ code: fullCode, name: quote.name, added: isInWatchlist(fullCode) });
          }
        } catch {
          validResults.push({ code: fullCode, name: fullCode, added: isInWatchlist(fullCode) });
        }
      }

      if (validResults.length > 0) {
        setOcrResults(validResults);
        setOcrStatus(`识别到 ${validResults.length} 只股票`);
      } else {
        setOcrStatus('未识别到有效A股代码');
      }
    } catch (e: any) {
      setOcrStatus('OCR引擎加载失败，请重试');
    } finally {
      setIsOcrProcessing(false);
    }
  };

  const handleOcrAdd = (code: string, name: string) => {
    const parsed = parseStockCode(code);
    addToWatchlist({ code, name, market: parsed.market, pureCode: parsed.pureCode });
    setOcrResults(prev => prev.map(r => r.code === code ? { ...r, added: true } : r));
    toast.success(`已添加 ${name}`);
  };

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

  // 输入即搜（防抖400ms）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      const results = await searchStocks(searchQuery);
      setSearchResults(results);
      setIsSearching(false);
      setHasSearched(true);
    }, 400);

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
    setHasSearched(false);
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
            placeholder="输入股票代码或名称搜索"
            className="w-full pl-10 pr-4 py-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {isSearching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">搜索中...</span>
          )}
        </div>

        {/* 搜索结果 */}
        {(searchResults.length > 0 || isSearching || hasSearched) && (
          <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3 space-y-1">
            {isSearching ? (
              <div className="p-3 text-center text-sm text-gray-400">正在搜索...</div>
            ) : hasSearched && searchResults.length === 0 ? (
              <div className="p-3 text-center text-sm text-gray-400">未找到相关股票</div>
            ) : (
              searchResults.map((quote) => (
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
              ))
            )}
          </div>
        )}
      </div>

      {/* 持仓识别 */}
      <div className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm mb-6">
        <button
          onClick={() => setShowOcr(!showOcr)}
          className="w-full flex items-center justify-between"
        >
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-2">
            <ScanLine className="w-4 h-4" />
            识别持仓截图
          </span>
          <span className="text-xs text-gray-400">{showOcr ? '收起' : '展开'}</span>
        </button>

        {showOcr && (
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
            <input
              ref={ocrFileRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setOcrImageFile(file);
                const reader = new FileReader();
                reader.onload = () => setOcrImage(reader.result as string);
                reader.readAsDataURL(file);
                setOcrResults([]);
                setOcrStatus(null);
              }}
              className="hidden"
            />

            {ocrImage ? (
              <div>
                <div className="relative mb-3">
                  <img src={ocrImage} alt="截图" className="w-full h-48 object-contain bg-gray-100 dark:bg-gray-800 rounded-lg" />
                  <button
                    onClick={() => { setOcrImage(null); setOcrImageFile(null); setOcrResults([]); setOcrStatus(null); }}
                    className="absolute top-2 right-2 p-1 bg-white/80 rounded-full hover:bg-white transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => ocrFileRef.current?.click()} className="flex-1 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
                    重新选择
                  </button>
                  <button
                    onClick={handleOcrScan}
                    disabled={isOcrProcessing}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    {isOcrProcessing ? <><Loader2 className="w-4 h-4 animate-spin" />识别中...</> : <><Upload className="w-3.5 h-3.5" />开始识别</>}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => ocrFileRef.current?.click()}
                className="w-full h-32 flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg hover:border-blue-400 transition mt-2"
              >
                <Camera className="w-8 h-8 text-gray-300 mb-1" />
                <p className="text-sm text-gray-500">点击上传持仓截图</p>
              </button>
            )}

            {ocrStatus && (
              <div className={`mt-3 p-2 rounded text-sm ${ocrStatus.includes('失败') || ocrStatus.includes('未识别') ? 'bg-red-50 text-red-600' : ocrStatus.includes('识别到') ? 'bg-green-50 text-green-600' : 'bg-blue-50 text-blue-600'}`}>
                {ocrStatus}
              </div>
            )}

            {ocrResults.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {ocrResults.map(r => (
                  <div key={r.code} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div>
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs text-gray-500 ml-2">{r.code}</span>
                    </div>
                    <button
                      onClick={() => handleOcrAdd(r.code, r.name)}
                      disabled={r.added}
                      className={`px-3 py-1 rounded text-xs font-medium ${r.added ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                    >
                      {r.added ? '已添加' : '加入自选'}
                    </button>
                  </div>
                ))}
              </div>
            )}
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
                    <>
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between text-sm">
                      {/* 持仓占比输入 */}
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <span className="text-gray-400 text-xs">持仓占比</span>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={stock.positionPercent ?? ''}
                          placeholder="--"
                          onChange={(e) => {
                            const val = e.target.value === '' ? undefined : Math.min(100, Math.max(0, Number(e.target.value)));
                            useStockStore.getState().updateStockPosition(stock.code, val);
                          }}
                          className="w-14 px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-800 text-center"
                        />
                        <span className="text-gray-400 text-xs">%</span>
                      </div>
                      <span className="text-blue-600">查看详情 →</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500">成交量: {formatVolume(quote.volume)}</span>
                    </div>
                    </>
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
