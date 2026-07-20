'use client';

import { useState, useEffect, useRef } from 'react';
import { Menu, X } from 'lucide-react';

/**
 * 更新日志 + 鸣谢 — 首页标题左侧的汉堡按钮。
 * 两级交互：点按钮 → 下方展开小菜单（更新日志 / 鸣谢）→ 再点进入抽屉。
 * 更新日志：往 CHANGELOG 数组头部追加一条 { date, items } 即可。
 */
interface ChangeEntry {
  date: string;      // YYYY-MM-DD
  version?: string;  // 可选版本号
  items: string[];
}

const CHANGELOG: ChangeEntry[] = [
  {
    date: '2026-07-20',
    items: [
      '修复 RPS 全市场排名永远滞后一天',
      '修复多项 Tushare 数据 bug',
      '新增 MA55 均线指标（R029 规则用，避免与 MA60 混淆）',
      '修复行情 change 字段浮点误差',
      '新增「三重滤网简化版」三条规则：R027 5/13死叉（只有卖点）、R028 5/13金叉（放量+站上55日线才有效）、R029 跌破55日线（非多头区域）',
      '扫描页状态持久化：切走再切回保留上次选中的板块与查询结果',
      'AI 对话新增「附带分析结论」开关，可自由控制是否把快速/深度分析结论带入对话上下文',
    ],
  },
];

const THANKS = `这个小工具能跑起来，离不开群里大家的支持。

感谢群里大家赞助服务器费用，让这套预警系统能 7×24 小时稳定在线；

感谢群里大家赞助 Tushare 接口积分，让 AI 分析能拿到资金流向、融资融券、龙虎榜等专业数据；

也感谢每一位反馈 bug、提需求、分享实战经验的朋友——是你们让它越来越好用。

工具免费，数据有价，这份心意都记在心里。祝大家账户长红。`;

export function UpdateLog() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<'log' | 'thanks' | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外部关闭小菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const openPanel = (p: 'log' | 'thanks') => {
    setPanel(p);
    setMenuOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="p-1.5 -ml-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-300 transition"
        title="更新日志与鸣谢"
        aria-label="更新日志与鸣谢"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* 第一级：按钮下方的小菜单 */}
      {menuOpen && (
        <div className="absolute top-full left-0 mt-1 z-50 w-32 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-100 dark:border-gray-800 overflow-hidden">
          <button
            onClick={() => openPanel('log')}
            className="w-full px-3 py-2 text-sm text-left text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
          >
            更新日志
          </button>
          <button
            onClick={() => openPanel('thanks')}
            className="w-full px-3 py-2 text-sm text-left text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition border-t border-gray-100 dark:border-gray-800"
          >
            鸣谢
          </button>
        </div>
      )}

      {/* 第二级：抽屉/弹窗 */}
      {panel && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40"
          onClick={() => setPanel(null)}
        >
          <div
            className="bg-white dark:bg-gray-900 w-full sm:max-w-lg max-h-[80vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                {panel === 'log' ? '更新日志' : '鸣谢'}
              </h3>
              <button
                onClick={() => setPanel(null)}
                className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {panel === 'log' ? (
                <div className="space-y-4">
                  {CHANGELOG.map((entry) => (
                    <div key={entry.date}>
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {entry.date}{entry.version ? ` · ${entry.version}` : ''}
                      </p>
                      <ul className="space-y-1.5">
                        {entry.items.map((item, i) => (
                          <li key={i} className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed flex gap-2">
                            <span className="text-gray-300 dark:text-gray-600 shrink-0">·</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">
                  {THANKS}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
