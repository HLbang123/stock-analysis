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

// App routes
export const ROUTES = {
  home: "/",
  market: "/market",
  watchlist: "/watchlist",
  ai: "/ai",
  scanner: "/scanner",
  stockDetail: (code: string) => `/stock/${code}`,
} as const;
