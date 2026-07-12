const express = require('express');
const { cache } = require('../middleware/cache');
const { getQuotes: getSinaQuotes } = require('../services/sina');
const { getQuotes: getTencentQuotes } = require('../services/tencent');
const config = require('../config');

const router = express.Router();

/**
 * GET /api/quote?codes=sh600519,sz000001
 * Real-time quotes with Sina primary + Tencent fallback.
 */
router.get('/', cache(config.CACHE_TTL.QUOTE), async (req, res, next) => {
  try {
    const { codes } = req.query;
    if (!codes) {
      return res.status(400).json({ error: '缺少codes参数' });
    }

    const codeList = codes.split(',').map(c => c.trim()).filter(Boolean);
    if (codeList.length === 0) {
      return res.status(400).json({ error: 'codes参数无效' });
    }

    let quotes;
    try {
      quotes = await getSinaQuotes(codeList);
    } catch (sinaErr) {
      console.warn('Sina quote failed, trying Tencent fallback:', sinaErr.message);
      try {
        quotes = await getTencentQuotes(codeList);
      } catch (tencentErr) {
        console.error('Tencent fallback also failed:', tencentErr.message);
        return res.status(502).json({ error: '行情数据获取失败，请稍后重试' });
      }
    }

    res.json({ quotes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
