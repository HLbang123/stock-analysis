import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 按钮 — 统一全项目按钮样式与语义。
 * variant:
 *  - primary   : 主行动（品牌紫，用于 AI/筛选等核心操作）
 *  - accent    : 次主行动（蓝，用于常规确认/提交）
 *  - secondary : 次要（灰底）
 *  - outline   : 描边
 *  - ghost     : 幽灵（无底色，hover 显底）
 *  - danger    : 危险操作（红）
 *  - up/down   : 涨/跌语义（A股红绿）
 */

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "accent" | "secondary" | "outline" | "ghost" | "danger" | "up" | "down";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const base = "inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:pointer-events-none disabled:opacity-50";

  const variants = {
    primary: "bg-[var(--color-brand)] text-white hover:opacity-90",
    accent: "bg-[var(--color-accent)] text-white hover:opacity-90",
    secondary: "bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700",
    outline: "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800",
    ghost: "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800",
    danger: "bg-[var(--color-danger)] text-white hover:opacity-90",
    up: "bg-[var(--color-up)] text-white hover:opacity-90",
    down: "bg-[var(--color-down)] text-white hover:opacity-90",
  };

  const sizes = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-base",
  };

  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}
