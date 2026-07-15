"use client";

import type { ReactNode } from "react";
import { BottomNav } from "@/components/layout/bottom-nav";
import { SidebarNav } from "@/components/layout/sidebar-nav";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <SidebarNav />
      <main className="pb-20 md:ml-56 md:pb-8">
        <div className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
          {children}
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
