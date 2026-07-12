module.exports = {
  PORT: process.env.PORT || 3001,
  CACHE_TTL: {
    QUOTE: 3,        // 3 seconds for real-time quotes
    KLINE: 300,      // 5 minutes for K-line data
    SEARCH: 7200,    // 2 hours for stock search
    INDEX: 3,        // 3 seconds for market indices
  },
  API_TIMEOUT: 8000, // 8 seconds timeout for upstream APIs
  RATE_LIMIT: {
    windowMs: 60 * 1000, // 1 minute
    max: 60,              // max requests per window per IP
  },
};
