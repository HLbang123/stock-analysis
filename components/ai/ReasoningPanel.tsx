'use client';

import { useState } from 'react';
import { ChevronRight, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  reasoning: string;
  isStreaming?: boolean;
  title?: string;
  /** 嵌入深色卡片时用 'light'，嵌入浅色气泡时用 'plain' */
  variant?: 'plain' | 'light';
}

/**
 * 可折叠的"思考过程"面板。
 * 展示 DeepSeek-R1 / GLM-4.5+ 等 reasoning 模型的 reasoning_content。
 * 默认折叠，避免喧宾夺主；流式时标题加脉冲点提示正在思考。
 */
export function ReasoningPanel({ reasoning, isStreaming, title = '思考过程', variant = 'plain' }: Props) {
  const [open, setOpen] = useState(false);
  if (!reasoning) return null;

  return (
    <div
      className={cn(
        "mt-2 rounded-lg border text-xs",
        variant === 'light'
          ? "border-gray-200/70 dark:border-gray-700/70 bg-gray-50/70 dark:bg-gray-800/40"
          : "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40"
      )}
    >
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition"
      >
        <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
        <Brain className="w-3 h-3" />
        <span className="font-medium">{title}</span>
        {isStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
        )}
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 pt-0.5 text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-words leading-relaxed border-t border-gray-200/60 dark:border-gray-700/60">
          {reasoning}
          {isStreaming && <span className="inline-block w-0.5 h-3 bg-blue-400 ml-0.5 animate-pulse align-middle" />}
        </div>
      )}
    </div>
  );
}
