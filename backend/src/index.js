const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const config = require('./config');
const { defaultLimiter, searchLimiter } = require('./middleware/rateLimiter');

// Load env
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/search', searchLimiter, require('./routes/search'));
app.use('/api/quote', defaultLimiter, require('./routes/quote'));
app.use('/api/kline', defaultLimiter, require('./routes/kline'));
app.use('/api/index', defaultLimiter, require('./routes/index'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}:`, err.message);
  res.status(err.response?.status || 500).json({
    error: err.message || '服务器内部错误',
  });
});

// Start server
const PORT = config.PORT;
app.listen(PORT, () => {
  console.log(`📊 Stock Analysis Backend running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
