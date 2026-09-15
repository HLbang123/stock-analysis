-- ============================================================================
-- 回填数据层 DDL —— 全部手动 DDL，不跑 prisma db push
-- 命名：无前缀、snake_case（与 daily_bars / ths_index 保持一致）
-- 幂等：全部 IF NOT EXISTS；主键用业务自然键，支持 ON CONFLICT 重入
-- 用法：bash scripts/_scratch/run-local.sh scripts/backfill/00-ddl.ts
-- ============================================================================

-- ---------- 统一进度表（断点续传的唯一事实源） ----------
CREATE TABLE IF NOT EXISTS ingest_progress (
  task        varchar(40) NOT NULL,
  part_key    varchar(64) NOT NULL,          -- 64：容纳 "20260910|12:00:00|17:59:59" 这类窗口级断点键
  status      varchar(12) NOT NULL,          -- done / empty / failed
  rows        integer     NOT NULL DEFAULT 0,
  note        varchar(200),
  updated_at  timestamp   NOT NULL DEFAULT now(),
  CONSTRAINT ingest_progress_pkey PRIMARY KEY (task, part_key)
);
CREATE INDEX IF NOT EXISTS ingest_progress_task_idx ON ingest_progress (task, status);

-- ---------- A1 涨停板明细（limit_list_d，2020+） ----------
CREATE TABLE IF NOT EXISTS limit_list (
  ts_code         varchar(12) NOT NULL,
  trade_date      varchar(8)  NOT NULL,
  name            varchar(40),
  industry        varchar(40),
  close           double precision,
  pct_chg         double precision,
  amount          double precision,
  limit_amount    double precision,
  float_mv        double precision,
  total_mv        double precision,
  turnover_ratio  double precision,
  fd_amount       double precision,   -- 封单金额（能不能买到的核心）
  first_time      varchar(8),         -- 首次涨停时间
  last_time       varchar(8),         -- 最后涨停时间
  open_times      integer,            -- 开板次数（可买性）
  up_stat         varchar(16),        -- 涨停统计 如 3/5
  limit_times     integer,            -- 连板数
  limit_type      varchar(2),         -- U涨停 D跌停 Z炸板
  CONSTRAINT limit_list_pkey PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS limit_list_date_idx ON limit_list (trade_date, limit_type);

-- ---------- A2 开盘啦题材榜（kpl_list，2018+） ----------
CREATE TABLE IF NOT EXISTS kpl_list (
  ts_code          varchar(12) NOT NULL,
  trade_date       varchar(8)  NOT NULL,
  name             varchar(40),
  lu_time          varchar(12),
  ld_time          varchar(12),
  open_time        varchar(12),
  last_time        varchar(12),
  lu_desc          varchar(200),   -- 涨停原因（题材归因，人写的）
  tag              varchar(40),    -- 涨停/炸板/跌停
  theme            varchar(200),   -- 题材标签
  status           varchar(20),    -- 首板/2连板...
  net_change       double precision,
  bid_amount       double precision,
  bid_change       double precision,
  bid_turnover     double precision,
  lu_bid_vol       double precision,
  pct_chg          double precision,
  bid_pct_chg      double precision,
  rt_pct_chg       double precision,
  limit_order      double precision,
  amount           double precision,
  turnover_rate    double precision,
  free_float       double precision,
  lu_limit_order   double precision,
  CONSTRAINT kpl_list_pkey PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS kpl_list_date_idx ON kpl_list (trade_date);

-- ---------- A3 龙虎榜（top_list，2014+） ----------
CREATE TABLE IF NOT EXISTS top_list (
  ts_code        varchar(12) NOT NULL,
  trade_date     varchar(8)  NOT NULL,
  name           varchar(40),
  close          double precision,
  pct_change     double precision,
  turnover_rate  double precision,
  amount         double precision,
  l_sell         double precision,
  l_buy          double precision,
  l_amount       double precision,
  net_amount     double precision,
  net_rate       double precision,
  amount_rate    double precision,
  float_values   double precision,
  reason         varchar(200),
  CONSTRAINT top_list_pkey PRIMARY KEY (ts_code, trade_date, reason)
);
CREATE INDEX IF NOT EXISTS top_list_date_idx ON top_list (trade_date);

-- ---------- A4 龙虎榜席位（top_inst，2016+） ----------
CREATE TABLE IF NOT EXISTS top_inst (
  trade_date  varchar(8)  NOT NULL,
  ts_code     varchar(12) NOT NULL,
  exalter     varchar(240) NOT NULL,   -- 营业部名称（配 hm_list.orgs 识别游资）
  side        varchar(4),
  buy         double precision,
  buy_rate    double precision,
  sell        double precision,
  sell_rate   double precision,
  net_buy     double precision,
  reason      varchar(200) NOT NULL DEFAULT '',
  CONSTRAINT top_inst_pkey PRIMARY KEY (trade_date, ts_code, exalter, side, reason)
);
CREATE INDEX IF NOT EXISTS top_inst_code_idx ON top_inst (ts_code, trade_date);
CREATE INDEX IF NOT EXISTS top_inst_exalter_idx ON top_inst (exalter);

-- ---------- A5 新闻标题（major_news，2016+） ----------
CREATE TABLE IF NOT EXISTS news_title (
  pub_time  timestamp   NOT NULL,
  title     varchar(400) NOT NULL,
  src       varchar(40),
  url       varchar(300),
  CONSTRAINT news_title_pkey PRIMARY KEY (pub_time, title)
);
CREATE INDEX IF NOT EXISTS news_title_time_idx ON news_title (pub_time DESC);

-- ---------- A6 游资名录（hm_list，静态） ----------
CREATE TABLE IF NOT EXISTS hm_list (
  name  varchar(40) NOT NULL,
  descr varchar(500),
  orgs  jsonb,
  CONSTRAINT hm_list_pkey PRIMARY KEY (name)
);

-- ---------- A7 公告标题（cninfo，2016+） ----------
CREATE TABLE IF NOT EXISTS announcements (
  announcement_id  varchar(24) NOT NULL,
  sec_code         varchar(8)  NOT NULL,
  sec_name         varchar(40),
  org_id           varchar(20),
  title            varchar(400) NOT NULL,
  short_title      varchar(400),
  announce_time    timestamp   NOT NULL,
  adjunct_url      varchar(200),
  adjunct_size     integer,
  adjunct_type     varchar(8),
  announcement_type varchar(40),
  important        varchar(4),
  column_id        varchar(20),
  page_column      varchar(20),
  batch_num        varchar(20),
  event_class      varchar(12),          -- 我们自己的分类，可重跑
  event_keywords   varchar(160),
  fetched_at       timestamp NOT NULL DEFAULT now(),
  CONSTRAINT announcements_pkey PRIMARY KEY (announcement_id)
);
CREATE INDEX IF NOT EXISTS announcements_code_idx  ON announcements (sec_code, announce_time DESC);
CREATE INDEX IF NOT EXISTS announcements_time_idx  ON announcements (announce_time DESC);
CREATE INDEX IF NOT EXISTS announcements_class_idx ON announcements (event_class, announce_time DESC);

-- ---------- B 组 事件 / 否决层 ----------
CREATE TABLE IF NOT EXISTS forecast (
  ts_code       varchar(12) NOT NULL,
  ann_date      varchar(8)  NOT NULL,
  end_date      varchar(8)  NOT NULL,
  type          varchar(20),
  p_change_min  double precision,
  p_change_max  double precision,
  net_profit_min double precision,
  net_profit_max double precision,
  summary       varchar(300),
  CONSTRAINT forecast_pkey PRIMARY KEY (ts_code, ann_date, end_date)
);
CREATE INDEX IF NOT EXISTS forecast_ann_idx ON forecast (ann_date);

CREATE TABLE IF NOT EXISTS express (
  ts_code   varchar(12) NOT NULL,
  ann_date  varchar(8)  NOT NULL,
  end_date  varchar(8)  NOT NULL,
  revenue   double precision,
  n_income  double precision,
  total_assets double precision,
  CONSTRAINT express_pkey PRIMARY KEY (ts_code, ann_date, end_date)
);

CREATE TABLE IF NOT EXISTS holder_trade (
  ts_code       varchar(12) NOT NULL,
  ann_date      varchar(8)  NOT NULL,
  holder_name   varchar(120) NOT NULL,
  holder_type   varchar(4),
  in_de         varchar(4),      -- IN 增持 / DE 减持
  change_vol    double precision,
  change_ratio  double precision,
  after_share   double precision,
  CONSTRAINT holder_trade_pkey PRIMARY KEY (ts_code, ann_date, holder_name, in_de)
);
CREATE INDEX IF NOT EXISTS holder_trade_ann_idx ON holder_trade (ann_date);

CREATE TABLE IF NOT EXISTS share_float (
  ts_code      varchar(12) NOT NULL,
  ann_date     varchar(8),
  float_date   varchar(8)  NOT NULL,
  float_share  double precision,
  float_ratio  double precision,
  holder_name  varchar(240),
  CONSTRAINT share_float_pkey PRIMARY KEY (ts_code, float_date, holder_name)
);
CREATE INDEX IF NOT EXISTS share_float_date_idx ON share_float (float_date);

CREATE TABLE IF NOT EXISTS repurchase (
  ts_code   varchar(12) NOT NULL,
  ann_date  varchar(8)  NOT NULL,
  proc      varchar(40) NOT NULL,
  vol       double precision,
  amount    double precision,
  high_limit double precision,
  low_limit double precision,
  CONSTRAINT repurchase_pkey PRIMARY KEY (ts_code, ann_date, proc)
);

CREATE TABLE IF NOT EXISTS suspend (
  ts_code        varchar(12) NOT NULL,
  trade_date     varchar(8)  NOT NULL,
  suspend_timing varchar(60),
  suspend_type   varchar(4),
  CONSTRAINT suspend_pkey PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS suspend_date_idx ON suspend (trade_date);

CREATE TABLE IF NOT EXISTS stk_alert (
  ts_code    varchar(12) NOT NULL,
  start_date varchar(8)  NOT NULL,
  end_date   varchar(8)  NOT NULL,
  name       varchar(60),
  type       varchar(60),
  CONSTRAINT stk_alert_pkey PRIMARY KEY (ts_code, start_date, type)
);

CREATE TABLE IF NOT EXISTS block_trade (
  ts_code    varchar(12) NOT NULL,
  trade_date varchar(8)  NOT NULL,
  price      double precision,
  vol        double precision,
  amount     double precision,
  buyer      varchar(240),
  seller     varchar(240),
  CONSTRAINT block_trade_pkey PRIMARY KEY (ts_code, trade_date, buyer, seller)
);
CREATE INDEX IF NOT EXISTS block_trade_date_idx ON block_trade (trade_date);

CREATE TABLE IF NOT EXISTS dividend (
  ts_code       varchar(12) NOT NULL,
  ann_date      varchar(8)  NOT NULL,
  end_date      varchar(8)  NOT NULL,
  div_proc      varchar(20) NOT NULL,
  stk_div       double precision,
  cash_div_tax  double precision,
  record_date   varchar(8),
  ex_date       varchar(8),
  CONSTRAINT dividend_pkey PRIMARY KEY (ts_code, ann_date, end_date, div_proc)
);

-- ---------- C 东财板块资金流（industry_moneyflow_ths 是 THS 口径，dc 单独存） ----------
CREATE TABLE IF NOT EXISTS industry_moneyflow_dc (
  ts_code    varchar(16) NOT NULL,
  trade_date varchar(8)  NOT NULL,
  name       varchar(60),
  pct_change double precision,
  net_amount double precision,
  CONSTRAINT industry_moneyflow_dc_pkey PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS industry_moneyflow_dc_date_idx ON industry_moneyflow_dc (trade_date);

-- ---------- 存量表扩列（复用，不新建） ----------
ALTER TABLE stock_moneyflow ADD COLUMN IF NOT EXISTS buy_md_amount double precision;
ALTER TABLE stock_moneyflow ADD COLUMN IF NOT EXISTS buy_sm_amount double precision;
ALTER TABLE stock_moneyflow ADD COLUMN IF NOT EXISTS sell_lg_amount double precision;
ALTER TABLE stock_moneyflow ADD COLUMN IF NOT EXISTS sell_elg_amount double precision;
ALTER TABLE stock_moneyflow ADD COLUMN IF NOT EXISTS net_mf_vol     double precision;
ALTER TABLE stock_moneyflow ADD COLUMN IF NOT EXISTS net_mf_amount double precision;
