import { cn } from "@/lib/cn";
import { ALERT_COLORS } from "@/lib/constants";
import type { AlertLevel } from "@/types";

interface BadgeProps {
  children: React.ReactNode;
  variant?: AlertLevel | "default" | "opportunity";
  className?: string;
}

const variants = {
  CRITICAL: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  WARNING: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-800",
  INFO: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
  opportunity: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
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

export function AlertLevelBadge({ level }: { level: AlertLevel }) {
  const labels = { CRITICAL: "严重", WARNING: "警告", INFO: "提示" };
  const emojis = { CRITICAL: "🔴", WARNING: "🟡", INFO: "🔵" };
  return (
    <Badge variant={level}>
      {emojis[level]} {labels[level]}
    </Badge>
  );
}
