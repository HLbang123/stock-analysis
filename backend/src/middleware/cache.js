const NodeCache = require('node-cache');

/**
 * Simple in-memory cache middleware using node-cache.
 * Usage: app.get('/path', cache(ttlSeconds), handler);
 */
function cache(ttlSeconds) {
  const store = new NodeCache({ stdTTL: ttlSeconds, checkperiod: ttlSeconds * 2 });

  return (req, res, next) => {
    const key = req.originalUrl;

    const cached = store.get(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    // Wrap res.json to capture and cache the response
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Only cache successful responses
      if (res.statusCode === 200) {
        store.set(key, body);
      }
      res.setHeader('X-Cache', 'MISS');
      return originalJson(body);
    };

    next();
  };
}

module.exports = { cache };
