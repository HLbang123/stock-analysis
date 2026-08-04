import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * 页面头部 — 统一各 Tab 页标题区（图标 + 标题 + 徽标 + 右侧操作 + 副标题）。
 * 各页面不要再手搓 <h1> + 操作区，间距统一为 mb-[var(--space-section)]。
 */
interface PageHeaderProps {
  title: ReactNode;
  /** 标题前图标/组件（如 UpdateLog、Brain 图标） */
  icon?: ReactNode;
  /** 标题后徽标（如未读数） */
  badge?: ReactNode;
  /** 右侧操作区（按钮组） */
  actions?: ReactNode;
  /** 标题下方一行说明文字 */
  subtitle?: ReactNode;
  className?: string;
}

export function PageHeader({ title, icon, badge, actions, subtitle, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-[var(--space-section)]', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <h1 className="text-xl font-bold text-gray-900 dark:text-white truncate">{title}</h1>
          {badge}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
    </div>
  );
}
