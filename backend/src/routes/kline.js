const express = require('express');
const { cache } = require('../middleware/cache');
const { getKline } = require('../services/eastmoney');
const config = require('../config');

const router = express.Router();

/**
 * GET /api/kline?code=sh600519&period=daily&limit=300&adjusted=1
 *
 * Parameters:
 *   code     - stock code with market prefix (e.g. sh600519)
 *   period   - daily | weekly | monthly | 30min | 60min | 15min | 5min
 *   limit    - number of K-lines (default 300)
 *   adjusted - 1 = 前复权 (default), 0 = 不复权
 */
router.get('/', cache(config.CACHE_TTL.KLINE), async (req, res, next) => {
  try {
    const { code, period = 'daily', limit = '300', adjusted = '1' } = req.query;

    if (!code) {
      return res.status(400).json({ error: '缺少code参数' });
    }

    const validPeriods = ['daily', 'weekly', 'monthly', '30min', '60min', '15min', '5min'];
    const p = validPeriods.includes(period) ? period : 'daily';
    const lmt = Math.min(parseInt(limit) || 300, 500);
    const adj = adjusted === '0' ? 0 : 1;

    const data = await getKline(code, p, lmt, adj);

    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
