const express = require('express');
const { cache } = require('../middleware/cache');
const { getQuotes } = require('../services/sina');
const config = require('../config');

const router = express.Router();

/**
 * GET /api/index
 * Returns the three major A-share indices.
 */
router.get('/', cache(config.CACHE_TTL.INDEX), async (req, res, next) => {
  try {
    const indexCodes = ['s_sh000001', 's_sz399001', 's_sz399006'];
    const quotes = await getQuotes(indexCodes);

    const indices = quotes.map(q => ({
      code: q.fullCode,
      name: q.name,
      price: q.price,
      change: q.change,
      changePercent: q.changePercent,
      open: q.open,
      high: q.high,
      low: q.low,
      prevClose: q.prevClose,
    }));

    res.json({ indices });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
