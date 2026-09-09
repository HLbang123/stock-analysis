import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Providers } from "./providers";
import { Shell } from "@/components/layout/shell";
import "./globals.css";

// 字体自托管（2026-09-10 由 next/font/google 改为 local）：
// 原来每次 next build 都要联网去 Google Fonts 拉 Geist，且 .next/cache 里没有字体缓存
// → 网络一抖构建就失败（当天已发生一次）。改为仓库内自带的 latin 变量字体后，构建彻底离线。
// 字体文件：app/fonts/*.woff2（Geist / Geist Mono 的 latin 子集，可变字重 100-900）。
const geistSans = localFont({
  src: "./fonts/Geist-latin.woff2",
  variable: "--font-geist-sans",
  display: "swap",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-latin.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "预警小工具",
  description: "大A技术形态预警与AI深度分析",
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.ico",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      </head>
      <body className="min-h-full bg-gray-50 dark:bg-gray-950">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
