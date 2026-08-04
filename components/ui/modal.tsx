'use client';

/**
 * 通用弹窗骨架 — 统一全项目 modal 外壳。
 * variant:
 *  - 'sheet'   : 移动端底部抽屉，桌面端居中（原 AlertRulesModal/GroupManageModal/UpdateLog 风格）
 *  - 'center'  : 始终居中（原 ProfileFormModal/ProfileSettingsModal 风格）
 * 点击遮罩关闭；内部点击 stopPropagation。
 */

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalProps {
  title: string;
  onClose: () => void;
  variant?: 'sheet' | 'center';
  /** 桌面端最大宽度，默认 max-w-lg */
  maxWidth?: string;
  children: ReactNode;
}

export function Modal({ title, onClose, variant = 'sheet', maxWidth = 'sm:max-w-lg', children }: ModalProps) {
  const overlayCls =
    variant === 'sheet'
      // z-[60]：必须高于底部导航(z-50)，否则移动端底部抽屉会被导航盖住
      ? 'fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40'
      : 'fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40';

  const panelCls =
    variant === 'sheet'
      ? cn('bg-white dark:bg-gray-900 w-full max-h-[80vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col', maxWidth)
      : cn('bg-white dark:bg-gray-900 w-full max-h-[85vh] rounded-2xl overflow-hidden flex flex-col shadow-xl', maxWidth);

  return (
    <div className={overlayCls} onClick={onClose}>
      <div className={panelCls} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
