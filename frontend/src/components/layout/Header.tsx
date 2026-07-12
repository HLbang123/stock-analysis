import { Link, useLocation } from 'react-router-dom';
import { Star } from 'lucide-react';

export default function Header() {
  const location = useLocation();

  return (
    <header className="h-14 bg-surface-card border-b border-surface-border flex items-center px-4 gap-4 shrink-0">
      <Link to="/" className="text-lg font-bold text-white hover:text-bull transition-colors shrink-0">
        📈 A股形态预警
      </Link>

      <nav className="flex items-center gap-1 ml-4">
        <Link
          to="/"
          className={`px-3 py-1.5 rounded text-sm transition-colors ${
            location.pathname === '/'
              ? 'bg-white/10 text-white'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          首页
        </Link>
        <Link
          to="/watchlist"
          className={`px-3 py-1.5 rounded text-sm transition-colors flex items-center gap-1 ${
            location.pathname.startsWith('/watchlist')
              ? 'bg-white/10 text-white'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          <Star className="w-4 h-4" />
          自选
        </Link>
      </nav>

      <div className="text-xs text-gray-500 ml-auto">
        数据来源：新浪财经 / 东方财富 | 仅供参考，不构成投资建议
      </div>
    </header>
  );
}
