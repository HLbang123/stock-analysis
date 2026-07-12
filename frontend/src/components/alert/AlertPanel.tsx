import { AlertTriangle, TrendingDown, TrendingUp, Info, XCircle } from 'lucide-react';
import type { Alert as AlertType } from '../../types';
import { ALERT_COLORS } from '../../utils/colors';

interface Props {
  alerts: AlertType[];
}

const levelIcons = {
  3: XCircle,
  2: AlertTriangle,
  1: TrendingUp,
  0: Info,
} as const;

export default function AlertPanel({ alerts }: Props) {
  if (alerts.length === 0) {
    return (
      <div className="bg-surface-card border border-surface-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">📋 预警信号</h3>
        <p className="text-xs text-gray-500 text-center py-8">
          当前未触发预警信号
        </p>
      </div>
    );
  }

  // Group by level
  const grouped: Record<number, AlertType[]> = {};
  for (const a of alerts) {
    if (!grouped[a.level]) grouped[a.level] = [];
    grouped[a.level].push(a);
  }

  return (
    <div className="bg-surface-card border border-surface-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">
        📋 预警信号
        <span className="ml-2 text-xs text-gray-500">({alerts.length}条)</span>
      </h3>

      <div className="space-y-3">
        {[3, 2, 1, 0].map((level) => {
          const items = grouped[level] || [];
          if (items.length === 0) return null;
          const colors = ALERT_COLORS[level as keyof typeof ALERT_COLORS];

          return (
            <div key={level} className="space-y-2">
              <div className={`text-xs font-semibold ${colors.text}`}>
                {colors.label} ({items.length})
              </div>
              {items.map((alert) => {
                const Icon = levelIcons[alert.level as keyof typeof levelIcons];
                return (
                  <div
                    key={alert.id}
                    className={`${colors.bg} border ${colors.border} rounded-lg p-3`}
                  >
                    <div className="flex items-start gap-2">
                      <Icon className="w-4 h-4 mt-0.5 shrink-0" style={{ color: colors.text.split(' ').pop()?.replace('text-', '#') }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium ${colors.text}`}>
                            {alert.rule}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-1">{alert.description}</p>
                        <p className="text-xs text-white mt-1.5 font-medium">
                          💡 {alert.action}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Disclaimer */}
      <div className="mt-4 pt-3 border-t border-surface-border">
        <p className="text-[10px] text-gray-600 leading-relaxed">
          ⚠️ 以上信号由算法根据K线数据自动计算生成，仅供学习参考，不构成任何投资建议。
          股市有风险，投资需谨慎。
        </p>
      </div>
    </div>
  );
}
