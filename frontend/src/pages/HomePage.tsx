import MarketOverview from '../components/stock/MarketOverview';
import StockSearch from '../components/stock/StockSearch';

const POPULAR_STOCKS = [
  { code: '600519', market: 'sh', name: '贵州茅台' },
  { code: '000858', market: 'sz', name: '五粮液' },
  { code: '300750', market: 'sz', name: '宁德时代' },
  { code: '002594', market: 'sz', name: '比亚迪' },
  { code: '601318', market: 'sh', name: '中国平安' },
  { code: '000333', market: 'sz', name: '美的集团' },
  { code: '600036', market: 'sh', name: '招商银行' },
  { code: '601138', market: 'sh', name: '工业富联' },
  { code: '002230', market: 'sz', name: '科大讯飞' },
  { code: '300124', market: 'sz', name: '汇川技术' },
  { code: '688981', market: 'sh', name: '中芯国际' },
  { code: '002371', market: 'sz', name: '北方华创' },
];

export default function HomePage() {
  return (
    <div className="flex-1 flex flex-col items-center px-4 py-8 max-w-4xl mx-auto w-full">
      {/* Market overview */}
      <div className="w-full mb-8">
        <MarketOverview />
      </div>

      {/* Search */}
      <div className="w-full max-w-md mb-8">
        <StockSearch />
      </div>

      {/* Popular stocks */}
      <div className="w-full">
        <h3 className="text-sm text-gray-400 mb-3">热门关注</h3>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
          {POPULAR_STOCKS.map((stock) => (
            <a
              key={stock.code}
              href={`/stock/${stock.market}${stock.code}`}
              className="bg-surface-card border border-surface-border rounded-lg px-3 py-2.5 text-center hover:border-bull/30 hover:bg-white/5 transition-colors group"
            >
              <div className="text-xs text-white group-hover:text-bull transition-colors truncate">
                {stock.name}
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5">{stock.code}</div>
            </a>
          ))}
        </div>
      </div>

      {/* Footer info */}
      <div className="mt-12 text-center">
        <p className="text-xs text-gray-600">
          数据来源：新浪财经 / 东方财富 ｜ 算法信号仅供参考，不构成投资建议
        </p>
        <p className="text-xs text-gray-600 mt-1">
          基于"心姐知识整理"交易规则构建
        </p>
      </div>
    </div>
  );
}
