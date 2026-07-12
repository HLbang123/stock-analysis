import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { getIndices } from '../../api/client';
import type { IndexData } from '../../types';
import { formatPrice, formatPercent } from '../../utils/format';
import { priceColor } from '../../utils/colors';

export default function MarketOverview() {
  const [indices, setIndices] = useState<IndexData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function fetch() {
      try {
        const data = await getIndices();
        if (mounted) setIndices(data);
      } catch {
        // silent
      } finally {
        if (mounted) setLoading(false);
      }
    }
    fetch();
    const timer = setInterval(fetch, 5000); // poll every 5s
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  if (loading) {
    return (
      <div className="flex gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-surface-card border border-surface-border rounded-lg p-3 w-44 animate-pulse">
            <div className="h-4 bg-gray-700 rounded w-16 mb-2" />
            <div className="h-6 bg-gray-700 rounded w-24 mb-1" />
            <div className="h-3 bg-gray-700 rounded w-16" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3 flex-wrap">
      {indices.map((idx) => {
        const isUp = idx.change > 0;
        const isDown = idx.change < 0;
        const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
        const colorClass = priceColor(idx.change);

        return (
          <div
            key={idx.code}
            className={`bg-surface-card border rounded-lg p-3 w-44 transition-colors ${
              isUp ? 'border-bull/20' : isDown ? 'border-bear/20' : 'border-surface-border'
            }`}
          >
            <div className="text-xs text-gray-400 mb-1 truncate">{idx.name}</div>
            <div className={`text-lg font-bold ${colorClass}`}>{formatPrice(idx.price)}</div>
            <div className={`flex items-center gap-1 text-xs ${colorClass} mt-0.5`}>
              <Icon className="w-3 h-3" />
              <span>{formatPercent(idx.changePercent)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
