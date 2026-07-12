import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import type { Quote } from '../../types';
import { formatPrice, formatChange, formatPercent, formatVolume } from '../../utils/format';
import { priceColor } from '../../utils/colors';

interface Props {
  quote: Quote;
}

export default function QuoteCard({ quote }: Props) {
  const isUp = quote.change > 0;
  const isDown = quote.change < 0;
  const colorClass = priceColor(quote.change);
  const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;

  return (
    <div className="bg-surface-card border border-surface-border rounded-lg p-4">
      {/* Name + Price */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-bold text-white">{quote.name}</h2>
          <span className="text-xs text-gray-500">{quote.fullCode}</span>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-bold ${colorClass}`}>
            {formatPrice(quote.price)}
          </div>
          <div className={`flex items-center justify-end gap-1 text-sm ${colorClass}`}>
            <Icon className="w-4 h-4" />
            <span>{formatChange(quote.change)}</span>
            <span>({formatPercent(quote.changePercent)})</span>
          </div>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-gray-500">开盘</span>
          <div className="text-white">{formatPrice(quote.open)}</div>
        </div>
        <div>
          <span className="text-gray-500">最高</span>
          <div className="text-bull">{formatPrice(quote.high)}</div>
        </div>
        <div>
          <span className="text-gray-500">最低</span>
          <div className="text-bear">{formatPrice(quote.low)}</div>
        </div>
        <div>
          <span className="text-gray-500">昨收</span>
          <div className="text-white">{formatPrice(quote.prevClose)}</div>
        </div>
        <div>
          <span className="text-gray-500">成交量</span>
          <div className="text-white">{formatVolume(quote.volume)}手</div>
        </div>
        <div>
          <span className="text-gray-500">成交额</span>
          <div className="text-white">{formatVolume(quote.amount)}</div>
        </div>
      </div>
    </div>
  );
}
