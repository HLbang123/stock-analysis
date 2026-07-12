import type { ChartPeriod } from '../../types';

interface Props {
  period: ChartPeriod;
  showMA5: boolean;
  showMA10: boolean;
  showMA20: boolean;
  showVolume: boolean;
  onPeriodChange: (p: ChartPeriod) => void;
  onToggleMA5: () => void;
  onToggleMA10: () => void;
  onToggleMA20: () => void;
  onToggleVolume: () => void;
}

const periods: { value: ChartPeriod; label: string }[] = [
  { value: '30min', label: '30分' },
  { value: 'daily', label: '日K' },
  { value: 'weekly', label: '周K' },
  { value: 'monthly', label: '月K' },
];

export default function ChartToolbar({
  period, showMA5, showMA10, showMA20, showVolume,
  onPeriodChange, onToggleMA5, onToggleMA10, onToggleMA20, onToggleVolume,
}: Props) {
  return (
    <div className="flex items-center gap-2 flex-wrap px-1 py-2">
      {/* Period selectors */}
      <div className="flex rounded-lg overflow-hidden border border-surface-border">
        {periods.map((p) => (
          <button
            key={p.value}
            onClick={() => onPeriodChange(p.value)}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              period === p.value
                ? 'bg-bull text-white'
                : 'bg-surface text-gray-400 hover:text-white'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="w-px h-6 bg-surface-border mx-1" />

      {/* Indicator toggles */}
      <ToggleBtn label="MA5" color="#f59e0b" active={showMA5} onClick={onToggleMA5} />
      <ToggleBtn label="MA10" color="#3b82f6" active={showMA10} onClick={onToggleMA10} />
      <ToggleBtn label="MA20" color="#a855f7" active={showMA20} onClick={onToggleMA20} />
      <ToggleBtn label="量" color="#94a3b8" active={showVolume} onClick={onToggleVolume} />
    </div>
  );
}

function ToggleBtn({
  label, color, active, onClick,
}: {
  label: string; color: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
        active
          ? 'bg-white/10 text-white'
          : 'bg-transparent text-gray-500 hover:text-gray-300'
      }`}
    >
      <span
        className="w-2.5 h-2.5 rounded-full"
        style={{ backgroundColor: active ? color : '#475569' }}
      />
      {label}
    </button>
  );
}
