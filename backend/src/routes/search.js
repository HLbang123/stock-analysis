const express = require('express');
const axios = require('axios');
const { cache } = require('../middleware/cache');
const config = require('../config');

const router = express.Router();

/**
 * GET /api/search?keyword=茅台
 * Stock search via East Money suggest API.
 */
router.get('/', cache(config.CACHE_TTL.SEARCH), async (req, res, next) => {
  try {
    const { keyword } = req.query;
    if (!keyword || keyword.trim().length === 0) {
      return res.json({ results: [] });
    }

    const url = 'https://searchapi.eastmoney.com/api/suggest/get';
    const response = await axios.get(url, {
      params: {
        input: keyword.trim(),
        type: 14,
        token: 'D43BF722C8E33BDC906FB84D85E326E8',
        count: 20,
      },
      timeout: config.API_TIMEOUT,
    });

    const data = response.data;
    if (!data || !data.QuotationCodeTable || !data.QuotationCodeTable.Data) {
      return res.json({ results: [] });
    }

    const results = data.QuotationCodeTable.Data
      .filter(item => item.SecurityTypeName === 'A股' || item.Market === '科创板')
      .map(item => ({
        code: item.Code,
        market: item.Market === '上交所' ? 'sh' :
                item.Market === '深交所' ? 'sz' :
                item.Market === '北交所' ? 'bj' : 'sz',
        name: item.Name,
        type: item.SecurityTypeName || 'A股',
      }));

    res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
