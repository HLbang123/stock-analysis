import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface CardProps {
  className?: string;
  children: ReactNode;
  onClick?: () => void;
  bordered?: boolean;
}

export function Card({ className, children, onClick, bordered = false }: CardProps) {
  const Component = onClick ? "button" : "div";
  return (
    <Component
      className={cn(
        "rounded-xl bg-white p-4 shadow-sm dark:bg-gray-900",
        bordered && "border border-gray-200 dark:border-gray-800",
        onClick && "cursor-pointer text-left transition-shadow hover:shadow-md",
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
