/**
 * 论点驱动选股 —— 建表
 *
 * 用法：MSYS_NO_PATHCONV=1 podman exec -i stock_pg_local psql -U quant_user -d stock_analysis -v ON_ERROR_STOP=1 -f - < scripts/thesis-setup.sql
 *
 * 🔴 幂等且**绝不 DROP**：本脚本同时被 scripts/thesis-setup.ts 在日任务里调用，
 *    里面一旦有 DROP TABLE，每天都会清空论点卡与案例库（案例库是长期资产，丢了无法重建）。
 *    需要重建时手动 DROP，不要写回这里。
 * 设计：docs/thesis-driven-selection.md
 */

-- ============ 1) 概念黑名单 ============
-- 只排「结构性非题材」；宽基问题由富集检验自动解决（实测融资融券原始家数第 1，富集倍数仅 1.15）
CREATE TABLE IF NOT EXISTS thesis_concept_blocklist (
  concept_name varchar(60) PRIMARY KEY,
  category     varchar(20) NOT NULL,
  reason       text        NOT NULL
);

INSERT INTO thesis_concept_blocklist (concept_name, category, reason) VALUES
('新股与次新股','status','状态标签：成分随上市时间滚动，非产业'),
('注册制次新股','status','状态标签'),
('科创次新股','status','状态标签'),
('ST板块','status','状态标签'),
('摘帽','status','状态标签'),
('高股息精选','status','风格因子标签'),
('超级品牌','status','风格标签'),
('中字头股票','status','属性标签（所有权），跨行业'),
('2026一季报预增','derived','🔴 派生标签：用 forecast 检测预增时必然命中，零信息'),
('2026中报预增','derived','🔴 派生标签：实测富集 2.16，完全是循环论证'),
('融资融券','mechanism','机制标签：全部两融标的，恒定接近市场平均（实测富集 1.15）'),
('沪股通','mechanism','机制标签'),
('深股通','mechanism','机制标签'),
('证金持股','mechanism','持股结构标签'),
('国家大基金持股','mechanism','持股结构标签'),
('举牌','mechanism','持股变动事件，非产业'),
('参股保险','mechanism','持股结构标签'),
('参股券商','mechanism','持股结构标签'),
('参股银行','mechanism','持股结构标签'),
('股权转让(并购重组)','mechanism','公司行为标签，跨行业'),
('同花顺中特估100','index_member','指数成分标签'),
('同花顺出海50','index_member','指数成分标签'),
('同花顺新质50','index_member','指数成分标签'),
('同花顺果指数','index_member','指数成分标签'),
('同花顺漂亮100','index_member','指数成分标签'),
('中国AI50','index_member','指数成分标签'),
('专精特新','policy_region','政策分类，跨全部行业（富集 1.79 但无产业含义）'),
('独角兽概念','policy_region','政策分类'),
('共同富裕示范区','policy_region','区域政策（富集 3.89 但非产业）'),
('新型城镇化','policy_region','政策主题'),
('乡村振兴','policy_region','政策主题'),
('西部大开发','policy_region','区域政策'),
('新疆振兴','policy_region','区域政策'),
('雄安新区','policy_region','区域政策'),
('粤港澳大湾区','policy_region','区域政策'),
('长三角一体化','policy_region','区域政策'),
('京津冀一体化','policy_region','区域政策'),
('一带一路','policy_region','政策主题'),
('统一大市场','policy_region','政策主题'),
('国企改革','policy_region','政策主题'),
('央企国企改革','policy_region','政策主题'),
('上海国企改革','policy_region','区域政策'),
('深圳国企改革','policy_region','区域政策'),
('上海自贸区','policy_region','区域政策'),
('天津自贸区','policy_region','区域政策'),
('广东自贸区','policy_region','区域政策'),
('福建自贸区','policy_region','区域政策'),
('海南自贸区','policy_region','区域政策'),
('黑龙江自贸区','policy_region','区域政策'),
('自由贸易港','policy_region','区域政策'),
('横琴新区','policy_region','区域政策'),
('土地流转','policy_region','政策主题'),
('供销社','policy_region','政策主题'),
('数字乡村','policy_region','政策主题'),
('智慧政务','policy_region','政策主题'),
('财税数字化','policy_region','政策主题'),
('新型工业化','policy_region','政策主题'),
('中俄贸易概念','policy_region','地缘政策'),
('中韩自贸区','policy_region','区域政策'),
('海峡两岸','policy_region','地缘政策'),
('俄乌冲突概念','policy_region','地缘事件')
ON CONFLICT (concept_name) DO NOTHING;

-- 派生标签关键词（防新报告期变体漏网）：代码侧同时应用 name ~ '(预增|预盈|预减|年报|中报|季报)'

-- ============ 2) 起点（种子的来源可以是系统检测，也可以是人的一个想法）============
CREATE TABLE IF NOT EXISTS thesis_seeds (
  seed_id      serial PRIMARY KEY,
  seed_date    varchar(8)  NOT NULL,
  kind         varchar(16) NOT NULL,   -- d1_boom / d2_theme / d3_flow / idea
  subject      varchar(80) NOT NULL,   -- 概念名 / 题材名 / 用户输入原文
  subject_code varchar(16),            -- 概念代码（可映射时）
  metric       jsonb,                  -- 触发它的客观指标
  source       varchar(8)  NOT NULL,   -- auto / user
  created_at   timestamptz DEFAULT now(),
  UNIQUE (seed_date, kind, subject)
);

-- ============ 3) 论点卡（一次完整调查的产物）============
CREATE TABLE IF NOT EXISTS thesis_cards (
  card_id      serial PRIMARY KEY,
  seed_id      int REFERENCES thesis_seeds(seed_id) ON DELETE CASCADE,
  card_date    varchar(8)  NOT NULL,
  subject      varchar(80) NOT NULL,

  -- 展开：确定性证据（SQL 采集，无 LLM 也能出）
  evidence     jsonb NOT NULL,          -- {concept, members, movers, fundamentals, flow, history}
  candidates   jsonb NOT NULL,          -- [{ts_code, name, ...}]

  -- 叙述：LLM 读证据后写（无 key 时降级为模板）
  thesis       text,                    -- 论点一句话
  mispricing   text,                    -- 错价假设：市场为什么还没反应
  counter      text,                    -- 🔴 反面证据：什么情况下这论点是错的
  triggers     jsonb,                   -- 后续需要盯什么
  llm_used     boolean DEFAULT false,

  -- 人的裁决（写死，事后不改）
  verdict      varchar(16),             -- buy / watch / skip
  verdict_note text,
  verdict_at   timestamptz,

  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS thesis_cards_date ON thesis_cards (card_date);

COMMENT ON TABLE thesis_seeds IS '论点起点。source=auto 为系统检测，source=user 为人给的想法。';
COMMENT ON TABLE thesis_cards IS '论点卡。counter（反面证据）为空视为无效卡，不得呈现。';
COMMENT ON TABLE thesis_concept_blocklist IS '概念黑名单。冻结后不得按结果增删。';

\pset border 2
\echo '=== 建表完成 ==='
SELECT category, count(*) n FROM thesis_concept_blocklist GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) AS 黑名单总数 FROM thesis_concept_blocklist;

-- ============ 4) 用户提交的想法（线索墙的数据源）============
-- 用户洞察是本系统最有价值的输入：定时任务只能从「已有数据」里找论点，
-- 而人能提供「数据还没体现」的信息（听说涨价、拿到订单、政策要变）。
-- 全部强制公开（用户 2026-09-14 定），算一次、所有人看 —— 与每日扫描同一模式。
CREATE TABLE IF NOT EXISTS thesis_proposals (
  proposal_id  serial PRIMARY KEY,
  idea         text        NOT NULL,   -- 用户原话，原样保留（用于展示与去重判断）
  subject      varchar(80) NOT NULL,   -- 归一到的板块
  subject_code varchar(16),
  as_of        varchar(8)  NOT NULL,
  anon_id      varchar(64),            -- 浏览器匿名 id（localStorage），无登录体系
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS thesis_proposals_subj ON thesis_proposals (subject, created_at DESC);
-- 同一匿名 id 对同一板块只计一次：防止刷「提出人数」触发服务器兜底跑模型
CREATE UNIQUE INDEX IF NOT EXISTS thesis_proposals_uniq
  ON thesis_proposals (subject, anon_id) WHERE anon_id IS NOT NULL;

COMMENT ON TABLE thesis_proposals IS
  '用户提交的调查线索。强制公开。anan_id 仅用于「几人独立提出」计数，不是身份。';
