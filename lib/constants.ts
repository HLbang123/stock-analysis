// A-share market color convention: RED = UP (涨), GREEN = DOWN (跌)
// This is the OPPOSITE of Western markets
export const MARKET_COLORS = {
  up: "#ef4444",       // red-500
  upLight: "#fca5a5",  // red-300
  upBg: "#fef2f2",     // red-50
  down: "#22c55e",     // green-500
  downLight: "#86efac", // green-300
  downBg: "#f0fdf4",   // green-50
} as const;

export const ALERT_COLORS = {
  CRITICAL: {
    text: "#dc2626",
    bg: "#fef2f2",
    border: "#fca5a5",
  },
  WARNING: {
    text: "#ea580c",
    bg: "#fff7ed",
    border: "#fdba74",
  },
  INFO: {
    text: "#2563eb",
    bg: "#eff6ff",
    border: "#93c5fd",
  },
} as const;

// Trading hours (Beijing time)
export const TRADING_HOURS = {
  morningStart: { hours: 9, minutes: 30 },
  morningEnd: { hours: 11, minutes: 30 },
  afternoonStart: { hours: 13, minutes: 0 },
  afternoonEnd: { hours: 15, minutes: 0 },
} as const;

// Polling interval for real-time quotes during trading hours
export const QUOTE_POLL_INTERVAL = 5000; // 5 seconds

// Scanner concurrency
export const SCANNER_CONCURRENCY = 5;

// App routes
export const ROUTES = {
  home: "/",
  market: "/market",
  watchlist: "/watchlist",
  ai: "/ai",
  scanner: "/scanner",
  ocr: "/ocr",
  stockDetail: (code: string) => `/stock/${code}`,
} as const;
