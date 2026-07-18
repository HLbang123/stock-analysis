"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/lib/constants";
import { AlertTriangle, Star, Search, Brain } from "lucide-react";

const navItems = [
  { href: ROUTES.home, label: "预警", icon: AlertTriangle },
  { href: ROUTES.watchlist, label: "自选", icon: Star },
  { href: ROUTES.ai, label: "AI分析", icon: Brain },
  { href: ROUTES.scanner, label: "全市场扫描", icon: Search },
];

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-56 border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950 md:flex md:flex-col">
      <div className="flex h-16 items-center border-b border-gray-200 px-6 dark:border-gray-800">
        <Link href={ROUTES.home} className="flex items-center">
          <span className="text-lg font-bold text-gray-900 dark:text-white">
            预警小工具
          </span>
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
