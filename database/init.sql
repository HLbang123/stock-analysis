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

-- ===== 大盘页预计算表（snake_case 列名，raw SQL 裸用） =====

-- 市场宽度 + 占比（一行/交易日）
CREATE TABLE IF NOT EXISTS market_breadth (
    trade_date        VARCHAR(8) PRIMARY KEY,
    advance           INTEGER,
    decline           INTEGER,
    flat              INTEGER,
    limit_up          INTEGER,
    limit_down        INTEGER,
    new_high20        INTEGER,
    new_low20         INTEGER,
    above_ma55_count  INTEGER,
    above_ma55_ratio  DOUBLE PRECISION,
    strong_rps_count  INTEGER,
    strong_rps_ratio  DOUBLE PRECISION
);

-- 指数估值历史（6 大指数 × 多日）
CREATE TABLE IF NOT EXISTS index_valuation (
    ts_code       VARCHAR(12) NOT NULL,
    trade_date    VARCHAR(8)  NOT NULL,
    pe            DOUBLE PRECISION,
    pe_ttm        DOUBLE PRECISION,
    pb            DOUBLE PRECISION,
    turnover_rate DOUBLE PRECISION,
    PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_index_val_date ON index_valuation(trade_date);

-- 北向资金（一行/交易日）
CREATE TABLE IF NOT EXISTS northbound_flow (
    trade_date   VARCHAR(8) PRIMARY KEY,
    north_money  DOUBLE PRECISION,
    hgt          DOUBLE PRECISION,
    sgt          DOUBLE PRECISION,
    north_total  DOUBLE PRECISION
);

-- 融资融券市场总量（一行/交易所/日）
CREATE TABLE IF NOT EXISTS margin_total (
    trade_date VARCHAR(8)  NOT NULL,
    exchange   VARCHAR(5)  NOT NULL,
    rzye       DOUBLE PRECISION,
    rqye       DOUBLE PRECISION,
    rzmre      DOUBLE PRECISION,
    rzche      DOUBLE PRECISION,
    rzrqye     DOUBLE PRECISION,
    PRIMARY KEY (trade_date, exchange)
);
CREATE INDEX IF NOT EXISTS idx_margin_total_date ON margin_total(trade_date);

-- 个股基本面（ROE 等）
CREATE TABLE IF NOT EXISTS stock_fundamentals (
    ts_code            VARCHAR(12) PRIMARY KEY,
    roe                DOUBLE PRECISION,
    roa                DOUBLE PRECISION,
    grossprofit_margin DOUBLE PRECISION,
    or_yoy             DOUBLE PRECISION,
    tr_yoy             DOUBLE PRECISION,
    period             VARCHAR(8)
);

-- 个股资金流向（按 trade_date 同步，用于板块聚合）
CREATE TABLE IF NOT EXISTS stock_moneyflow (
    ts_code        VARCHAR(12) NOT NULL,
    trade_date     VARCHAR(8)  NOT NULL,
    net_mf_amount  DOUBLE PRECISION,
    buy_elg_amount DOUBLE PRECISION,
    buy_lg_amount  DOUBLE PRECISION,
    PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_moneyflow_date ON stock_moneyflow(trade_date);

-- 申万行业指数日线
CREATE TABLE IF NOT EXISTS sw_index_daily (
    ts_code VARCHAR(12) NOT NULL,
    trade_date VARCHAR(8) NOT NULL,
    close DOUBLE PRECISION,
    pct_chg DOUBLE PRECISION,
    vol DOUBLE PRECISION,
    amount DOUBLE PRECISION,
    PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_sw_daily_date ON sw_index_daily(trade_date);

-- 申万行业成分股
CREATE TABLE IF NOT EXISTS sw_index_member (
    ts_code VARCHAR(20) NOT NULL,
    name VARCHAR(40),
    code VARCHAR(20),
    member_code VARCHAR(12) NOT NULL,
    member_name VARCHAR(40),
    weight DOUBLE PRECISION,
    level VARCHAR(5),
    src VARCHAR(10),
    PRIMARY KEY (ts_code, member_code, level)
);
CREATE INDEX IF NOT EXISTS idx_sw_member_code ON sw_index_member(member_code);
