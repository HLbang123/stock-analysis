'use client';

/**
 * 表单控件原语 — 统一 input/select 的暗色模式样式。
 * 替换项目中 20+ 处重复的 border/rounded/bg 字符串。
 */

import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const baseCls =
  'border border-[var(--border)] rounded-[var(--radius-md)] bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] placeholder:text-gray-400';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 占满宽度，默认 true */
  block?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ block = true, className, ...props }, ref) {
  return <input ref={ref} className={cn(baseCls, 'px-3 py-2', block && 'w-full', className)} {...props} />;
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  block?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ block = true, className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(baseCls, 'px-3 py-2', block && 'w-full', className)} {...props}>
      {children}
    </select>
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  block?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ block = true, className, ...props }, ref) {
  return <textarea ref={ref} className={cn(baseCls, 'px-3 py-2', block && 'w-full', className)} {...props} />;
});
