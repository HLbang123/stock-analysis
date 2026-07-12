const rateLimit = require('express-rate-limit');
const config = require('../config');

const defaultLimiter = rateLimit({
  windowMs: config.RATE_LIMIT.windowMs,
  max: config.RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '请求过于频繁，请稍后再试',
    retryAfter: '60 seconds',
  },
});

// Stricter limit for search endpoint
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '搜索请求过于频繁，请稍后再试',
  },
});

module.exports = { defaultLimiter, searchLimiter };
