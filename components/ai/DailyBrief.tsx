'use client';

/**
 * 每日简报 — 复盘弹窗「日报」/「盘前提示」tab 共用组件。
 * 数据源 /api/daily-brief（盘前 9:10 / 盘后 18:30 cron 生成）。
 */

import { useEffect, useState } from 'react';
import { Calendar, TrendingUp, TrendingDown, Sparkles, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BriefPayload {
  briefDate: string;
  type: 'morning' | 'daily';
  generatedAt: string;
  market: {
    upCount: number;
    downCount: number;
    avgChange: number | null;
    limitUp: number;
    limitDown: number;
    newHigh20: number | null;
    northMoney: number | null;
  };
  dragonTiger: {
    orgNetBuy: { name: string; amount: number }[];
    hotMoneyNetBuy: { name: string; amount: number }[];
    hotRank: { name: string; rank: number }[];
  } | null;
  aiScreen: {
    strategy: string;
    picks: number;
    t1WinRate: number | null;
    best: { name: string; t1: number } | null;
    worst: { name: string; t1: number } | null;
  }[] | null;
  focus: {
    strongIndustries: string[];
    watchStocks: { name: string; reason: string }[];
  } | null;
  summary: string;
}

const pct = (v: number | null | undefined) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
const fmtDate = (d: string) => `${d.slice(4, 6)}-${d.slice(6, 8)}`;

export function DailyBrief({ type }: { type: 'morning' | 'daily' }) {
  const [brief, setBrief] = useState<BriefPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/daily-brief?type=${type}`)
      .then((r) => r.json())
      .then((d) => setBrief(d.brief?.payload ?? null))
      .catch(() => setBrief(null))
      .finally(() => setLoading(false));
  }, [type]);

  if (loading) {
    return <div className="p-8 text-center text-gray-400 text-sm">加载中…</div>;
  }
  if (!brief) {
    return (
      <div className="p-8 text-center text-gray-400">
        <Calendar className="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p className="text-sm">{type === 'morning' ? '今日盘前提示' : '今日日报'}尚未生成</p>
        <p className="text-xs mt-1">{type === 'morning' ? '每日 9:10 自动生成' : '每日 18:30 自动生成'}</p>
      </div>
    );
  }

  const m = brief.market;
  const isMorning = type === 'morning';

  return (
    <div className="p-4 space-y-4">
      {/* 头部：日期 + 类型 + 总结 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{fmtDate(brief.briefDate)}</span>
          <span className={cn('text-xs px-1.5 py-0.5 rounded', isMorning ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
            {isMorning ? '盘前提示' : '盘后日报'}
          </span>
        </div>
        <span className="text-xs text-gray-400">{brief.generatedAt.slice(11, 16)} 更新</span>
      </div>

      {/* 一句话总结 */}
      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 text-sm text-gray-700 dark:text-gray-300">
        {brief.summary}
      </div>

      {/* 市场概况 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 p-2.5">
          <div className="text-xs text-gray-400">涨/跌</div>
          <div className="text-lg font-semibold mt-0.5">
            <span className="text-red-600">{m.upCount}</span>
            <span className="text-gray-400 mx-1">/</span>
            <span className="text-green-600">{m.downCount}</span>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 p-2.5">
          <div className="text-xs text-gray-400">涨停/跌停</div>
          <div className="text-lg font-semibold mt-0.5">
            <span className="text-red-600">{m.limitUp}</span>
            <span className="text-gray-400 mx-1">/</span>
            <span className="text-green-600">{m.limitDown}</span>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 p-2.5">
          <div className="text-xs text-gray-400">平均涨跌</div>
          <div className={cn('text-lg font-semibold mt-0.5', (m.avgChange ?? 0) >= 0 ? 'text-red-600' : 'text-green-600')}>
            {pct(m.avgChange)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 p-2.5">
          <div className="text-xs text-gray-400">北向资金</div>
          <div className={cn('text-lg font-semibold mt-0.5', (m.northMoney ?? 0) >= 0 ? 'text-red-600' : 'text-green-600')}>
            {m.northMoney != null ? `${(m.northMoney / 10000).toFixed(1)}亿` : '--'}
          </div>
        </div>
      </div>

      {/* 龙虎榜 */}
      {brief.dragonTiger && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 p-3">
          <div className="text-xs font-medium text-gray-500 mb-2">龙虎榜亮点</div>
          <div className="space-y-2 text-xs">
            {brief.dragonTiger.orgNetBuy.length > 0 && (
              <div>
                <span className="text-gray-400">机构净买入：</span>
                {brief.dragonTiger.orgNetBuy.map((s, i) => (
                  <span key={s.name} className="text-gray-700 dark:text-gray-300">
                    {i > 0 && '、'}{s.name} <span className="text-red-600">{s.amount.toFixed(1)}亿</span>
                  </span>
                ))}
              </div>
            )}
            {brief.dragonTiger.hotMoneyNetBuy.length > 0 && (
              <div>
                <span className="text-gray-400">游资净买入：</span>
                {brief.dragonTiger.hotMoneyNetBuy.map((s, i) => (
                  <span key={s.name} className="text-gray-700 dark:text-gray-300">
                    {i > 0 && '、'}{s.name} <span className="text-red-600">{s.amount.toFixed(1)}亿</span>
                  </span>
                ))}
              </div>
            )}
            {brief.dragonTiger.hotRank.length > 0 && (
              <div>
                <span className="text-gray-400">人气 Top：</span>
                {brief.dragonTiger.hotRank.map((s, i) => (
                  <span key={s.name} className="text-gray-700 dark:text-gray-300">
                    {i > 0 && '、'}{s.name} <span className="text-gray-400">#{s.rank}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 筛选表现（仅 daily） */}
      {!isMorning && brief.aiScreen && brief.aiScreen.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 p-3">
          <div className="text-xs font-medium text-gray-500 mb-2">昨日筛选表现（T+1）</div>
          <div className="space-y-1.5 text-xs">
            {brief.aiScreen.map((s) => (
              <div key={s.strategy} className="flex items-center justify-between">
                <span className="text-gray-700 dark:text-gray-300">{s.strategy}（{s.picks} 只）</span>
                <span className={cn('font-medium', (s.t1WinRate ?? 0) >= 50 ? 'text-red-600' : 'text-green-600')}>
                  胜率 {s.t1WinRate != null ? `${s.t1WinRate}%` : '--'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 今日关注（仅 morning） */}
      {isMorning && brief.focus && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 p-3">
          <div className="text-xs font-medium text-gray-500 mb-2">今日关注</div>
          <div className="space-y-2 text-xs">
            {brief.focus.strongIndustries.length > 0 && (
              <div>
                <span className="text-gray-400">强势行业：</span>
                <span className="text-gray-700 dark:text-gray-300">{brief.focus.strongIndustries.join('、')}</span>
              </div>
            )}
            {brief.focus.watchStocks.length > 0 && (
              <div>
                <span className="text-gray-400">关注标的：</span>
                {brief.focus.watchStocks.map((s, i) => (
                  <span key={s.name} className="text-gray-700 dark:text-gray-300">
                    {i > 0 && '、'}{s.name} <span className="text-gray-400">({s.reason})</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
