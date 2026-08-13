import { cn } from "@/lib/utils";
import type { AlertLevel } from "@/types";

interface BadgeProps {
  children: React.ReactNode;
  variant?: AlertLevel | "default" | "opportunity";
  className?: string;
}

/** 语义色全部走设计 token（globals.css），散装 red/orange/blue 色值勿回潮 */
const variants = {
  CRITICAL: "bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[var(--color-danger)]/30",
  WARNING: "bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning)]/30",
  INFO: "bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-[var(--color-accent)]/30",
  opportunity: "bg-[var(--color-down-soft)] text-[var(--color-down)] border-[var(--color-down-border)]",
  default: "bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
} as const;

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
