"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/constants";
import { AlertTriangle, Star, Search, Brain, LineChart } from "lucide-react";

const tabs = [
  { href: ROUTES.home, label: "预警", icon: AlertTriangle },
  { href: ROUTES.market, label: "大盘", icon: LineChart },
  { href: ROUTES.watchlist, label: "自选", icon: Star },
  { href: ROUTES.ai, label: "AI分析", icon: Brain },
  { href: ROUTES.scanner, label: "全市场扫描", icon: Search },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950 md:hidden">
      <div className="grid h-16 grid-cols-5">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          // 与 sidebar 一致的激活判断：首页精确匹配，其余前缀匹配（子路径也高亮）
          const isActive = tab.href === "/"
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex flex-col items-center justify-center gap-1 px-2 py-2 text-xs font-medium transition-colors",
                isActive
                  ? "text-[var(--color-accent)]"
                  : "text-gray-500 dark:text-gray-400"
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
