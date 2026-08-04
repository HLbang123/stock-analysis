import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 卡片 — 统一全项目面板容器。
 * variant:
 *  - 'default'  : 白底 + 轻阴影（常规卡片）
 *  - 'bordered' : 白底 + 边框（需要明确边界的卡片，如表单）
 *  - 'accent'   : 左侧品牌色边条（需要强调的结论卡，如 AI 综合说明）
 *  - 'up'       : 涨/买入语义（红调，A股）
 *  - 'down'     : 跌/卖出语义（绿调，A股）
 *  - 'warning'  : 警告语义（琥珀调）
 */

type CardVariant = 'default' | 'bordered' | 'accent' | 'up' | 'down' | 'warning';

interface CardProps {
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  variant?: CardVariant;
}

const variantCls: Record<CardVariant, string> = {
  default: 'bg-white dark:bg-gray-900 shadow-[var(--shadow-card)]',
  bordered: 'bg-white dark:bg-gray-900 border border-[var(--border)]',
  accent: 'bg-white dark:bg-gray-900 shadow-[var(--shadow-card)] border-l-4 border-[var(--color-brand)]',
  up: 'bg-[var(--color-up-soft)] border border-[var(--color-up-border)]',
  down: 'bg-[var(--color-down-soft)] border border-[var(--color-down-border)]',
  warning: 'bg-[var(--color-warning-soft)] border border-[var(--color-warning)]/30',
};

export function Card({ className, children, onClick, variant = 'default' }: CardProps) {
  const Component = onClick ? "button" : "div";
  return (
    <Component
      className={cn(
        "rounded-[var(--radius-lg)] p-[var(--space-card)]",
        variantCls[variant],
        onClick && "cursor-pointer text-left transition-shadow hover:shadow-[var(--shadow-hover)]",
        className
      )}
      onClick={onClick}
      type={onClick ? "button" : undefined}
    >
      {children}
    </Component>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("mb-3 flex items-center justify-between", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h3 className={cn("text-base font-semibold text-gray-900 dark:text-white", className)}>
      {children}
    </h3>
  );
}

export function CardContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("space-y-2", className)}>{children}</div>;
}
