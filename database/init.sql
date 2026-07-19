-- stock_analysis 初始化建表
-- Docker 首次启动时自动执行

-- 股票基础信息（含申万行业分类）
CREATE TABLE IF NOT EXISTS stocks (
    ts_code    VARCHAR(12) PRIMARY KEY,   -- 000001.SZ
    name       VARCHAR(40) NOT NULL,
    market     VARCHAR(2)  NOT NULL,      -- SH / SZ / BJ
    industry   VARCHAR(40),               -- 申万行业
    list_date  VARCHAR(8),                -- 上市日期
    is_active  BOOLEAN DEFAULT TRUE
);

-- 日线行情（增量同步）
CREATE TABLE IF NOT EXISTS daily_bars (
    ts_code    VARCHAR(12) NOT NULL,
    trade_date VARCHAR(8)  NOT NULL,      -- YYYYMMDD
    open       DOUBLE PRECISION,
    high       DOUBLE PRECISION,
    low        DOUBLE PRECISION,
    close      DOUBLE PRECISION,          -- 前复权收盘价
    pre_close  DOUBLE PRECISION,
    change_pct DOUBLE PRECISION,          -- 涨跌幅(%)
    vol        DOUBLE PRECISION,          -- 成交量（手）
    amount     DOUBLE PRECISION,          -- 成交额（千元）
    PRIMARY KEY (ts_code, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_bars_date ON daily_bars("tradeDate");

-- RPS 分数（每日计算）
CREATE TABLE IF NOT EXISTS rps_scores (
    "tsCode"    VARCHAR(12) NOT NULL,
    "calcDate"  VARCHAR(8)  NOT NULL,      -- 计算日期
    rps_20     DOUBLE PRECISION,          -- 20日 RPS
    rps_60     DOUBLE PRECISION,          -- 60日 RPS
    rps_120    DOUBLE PRECISION,          -- 120日 RPS
    rps_250    DOUBLE PRECISION,          -- 250日 RPS
    ret_20     DOUBLE PRECISION,          -- 20日涨幅(%)
    ret_60     DOUBLE PRECISION,
    ret_120    DOUBLE PRECISION,
    ret_250    DOUBLE PRECISION,
    PRIMARY KEY ("tsCode", "calcDate")
);

CREATE INDEX IF NOT EXISTS idx_rps_calc_date ON rps_scores("calcDate");
CREATE INDEX IF NOT EXISTS idx_rps_250 ON rps_scores("calcDate", rps_250 DESC);
