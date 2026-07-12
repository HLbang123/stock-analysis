import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { searchStocks } from '../../api/client';
import type { StockInfo } from '../../types';

export default function StockSearch() {
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<StockInfo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Debounced search
  useEffect(() => {
    if (keyword.trim().length < 1) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchStocks(keyword.trim());
        setResults(data);
        setIsOpen(data.length > 0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [keyword]);

  function handleSelect(stock: StockInfo) {
    setKeyword(`${stock.name} (${stock.code})`);
    setIsOpen(false);
    navigate(`/stock/${stock.market}${stock.code}`);
  }

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          placeholder="搜索股票代码或名称..."
          className="w-full bg-surface border border-surface-border rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-bull/50 transition-colors"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {isOpen && results.length > 0 && (
        <div className="absolute top-full mt-1 w-full bg-surface-card border border-surface-border rounded-lg shadow-xl z-50 max-h-80 overflow-y-auto">
          {results.map((stock) => (
            <button
              key={stock.code}
              onClick={() => handleSelect(stock)}
              className="w-full text-left px-4 py-3 hover:bg-white/5 transition-colors border-b border-surface-border last:border-0"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm text-white">{stock.name}</span>
                  <span className="text-xs text-gray-500 ml-2">{stock.code}</span>
                </div>
                <span className="text-xs text-gray-400">
                  {stock.market === 'sh' ? '沪' : stock.market === 'sz' ? '深' : '京'}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
