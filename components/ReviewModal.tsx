'use client';

/**
 * 复盘弹窗 — 预警首页「复盘」按钮入口，全站唯一的复盘数据聚合处。
 * 顶部 tab：周报 / 胜率复盘；胜率复盘内嵌子 tab：深度分析 / AI筛选 / 预警规则。
 * 原 AI 页两处「胜率复盘」入口（分析 tab、筛选 view）已收拢至此，AI 页只留分析与筛选。
 * tab 为条件渲染：切到才挂载拉数，切走卸载；再切回重新拉（回填可能已更新，正好刷新生效）。
 */

import { useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { CalendarDays, Brain, Sparkles, AlertTriangle, TrendingUp } from 'lucide-react';
import { WeeklyReview } from '@/components/ai/WeeklyReview';
import { DeepAnalysisStats } from '@/components/ai/DeepAnalysisStats';
import { AiScreenStats } from '@/components/ai/AiScreenStats';
import { AlertRuleHealth } from '@/components/ai/AlertRuleHealth';

type Tab = 'weekly' | 'stats';
type StatsTab = 'deep' | 'screen' | 'rule';

const TABS: { key: Tab; label: string; icon: typeof CalendarDays }[] = [
  { key: 'weekly', label: '周报', icon: CalendarDays },
  { key: 'stats', label: '胜率复盘', icon: TrendingUp },
];

const STATS_TABS: { key: StatsTab; label: string; icon: typeof Brain }[] = [
  { key: 'deep', label: '深度分析', icon: Brain },
  { key: 'screen', label: 'AI筛选', icon: Sparkles },
  { key: 'rule', label: '预警规则', icon: AlertTriangle },
];

export function ReviewModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('weekly');
  const [statsTab, setStatsTab] = useState<StatsTab>('deep');

  // 必须守卫 open（在 hooks 之后）：无此守卫时父组件一旦渲染本组件，弹窗永远显示、叉不掉
  if (!open) return null;

  return (
    <Modal title="复盘" onClose={onClose} variant="center" maxWidth="sm:max-w-4xl">
      {/* tab 条：sticky 吸附在滚动区顶部，长表格滚动时仍可切换 */}
      <div className="sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 px-3 py-2">
        <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800/50 rounded-lg w-fit max-w-full overflow-x-auto">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1 whitespace-nowrap transition',
                tab === key
                  ? 'bg-white dark:bg-gray-900 text-[var(--color-accent)] shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'weekly' && <WeeklyReview />}
      {tab === 'stats' && (
        <div className="p-4">
          {/* 胜率复盘子 tab：三个统计面板同属一类，收进二级切换 */}
          <div className="flex gap-1 p-0.5 mb-3 bg-gray-100 dark:bg-gray-800/50 rounded-lg w-fit">
            {STATS_TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setStatsTab(key)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs flex items-center gap-1 whitespace-nowrap transition',
                  statsTab === key
                    ? 'bg-white dark:bg-gray-900 text-[var(--color-accent)] shadow-sm font-medium'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                )}
              >
                <Icon className="w-3 h-3" /> {label}
              </button>
            ))}
          </div>
          {statsTab === 'deep' && <DeepAnalysisStats />}
          {statsTab === 'screen' && <AiScreenStats />}
          {statsTab === 'rule' && <AlertRuleHealth />}
        </div>
      )}
    </Modal>
  );
}
