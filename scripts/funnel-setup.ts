/**
 * 分层筛选 —— 建表 + 辅助表维护（手动 DDL，不走 prisma db push）
 *
 * 在**任何**目标库都能跑：本地研究库（55432）或生产库。
 *
 * 用法：
 *   bash scripts/_scratch/run-local.sh scripts/funnel-setup.ts            # 建表 + 首次构建辅助表
 *   bash scripts/_scratch/run-local.sh scripts/funnel-setup.ts --refresh  # 只追加新交易日的辅助表（日更用）
 *
 * ⚠️ 为什么需要 funnel_bars：
 *   规则里的 past20 = 「该标的自己的第 2 根 / 第 22 根K线」收盘之比（与 docs/funnel-alpha.md 口径一致，
 *   不受停牌影响）。逐日实现若用「最近 200 自然日窗口」现场算 rn，长期停牌的标的会凑不齐 22 根而被剔除，
 *   而股票池一变，ntile 的分档边界就跟着移动 —— 导致**逐日实现与历史回填选出不同的票**。
 *   2026-09-13 口径校验实测到过（20180903：600515.SH 窗口内只有 16 根K线 → 被误剔）。
 *   因此把 rn 固化成一张表，两条实现共用同一个定义。
 */
import { prisma } from '../lib/db';

const args = process.argv.slice(2);
const has = (k: string) => args.includes(`--${k}`);
const argOf = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];

const DDL = `
CREATE TABLE IF NOT EXISTS funnel_bars (
  ts_code       varchar(12) NOT NULL,
  trade_date    varchar(8)  NOT NULL,
  rn            integer     NOT NULL,     -- 该标的自己的第几根K线（1 起）
  open          double precision,
  close         double precision,
  pre_close     double precision,
  turnover_rate double precision,
  CONSTRAINT funnel_bars_pkey PRIMARY KEY (ts_code, rn)
);
CREATE INDEX IF NOT EXISTS funnel_bars_dt_idx ON funnel_bars (trade_date);

CREATE TABLE IF NOT EXISTS funnel_picks (
  pick_date      varchar(8)  NOT NULL,          -- 买入日（该日开盘买入）
  ts_code        varchar(12) NOT NULL,
  rank_no        smallint    NOT NULL,          -- 1..5
  name           varchar(40),
  reason         varchar(200),                  -- 给用户看的理由（中性表述，不含「股」字）
  turnover_rate  double precision,
  turnover_q     smallint,                      -- 当日成交活跃度分档 1..5
  past20         double precision,              -- 截至买入前一日的 20 个交易日累计涨跌 %
  veto_hit       boolean     NOT NULL DEFAULT false,
  veto_types     varchar(80),
  ret5           double precision,
  ret10          double precision,
  ret20          double precision,
  ex5            double precision,
  ex10           double precision,
  ex20           double precision,
  settled        boolean     NOT NULL DEFAULT false,
  -- 每日推荐：这只票来自哪个「论点板块」，以及那个板块的理由（2026-09-14 新增）
  board_code     varchar(16),
  board_name     varchar(40),
  board_reason   varchar(200),
  -- 模型写的推荐理由与反面证据（每天一次调用，整份列表一起给模型）2026-09-14
  llm_thesis     varchar(300),
  llm_counter    varchar(300),
  updated_at     timestamp   NOT NULL DEFAULT now(),
  CONSTRAINT funnel_picks_pkey PRIMARY KEY (pick_date, ts_code)
);
-- 老库补列（幂等）
ALTER TABLE funnel_picks ADD COLUMN IF NOT EXISTS board_code   varchar(16);
ALTER TABLE funnel_picks ADD COLUMN IF NOT EXISTS board_name   varchar(40);
ALTER TABLE funnel_picks ADD COLUMN IF NOT EXISTS board_reason varchar(200);
ALTER TABLE funnel_picks ADD COLUMN IF NOT EXISTS llm_thesis   varchar(300);
ALTER TABLE funnel_picks ADD COLUMN IF NOT EXISTS llm_counter  varchar(300);
CREATE INDEX IF NOT EXISTS funnel_picks_dt_idx ON funnel_picks (pick_date DESC);
CREATE INDEX IF NOT EXISTS funnel_picks_settled_idx ON funnel_picks (settled, pick_date);

CREATE TABLE IF NOT EXISTS funnel_runs (
  id          serial PRIMARY KEY,
  pick_date   varchar(8) NOT NULL,
  bar_date    varchar(8),
  veto_used   boolean NOT NULL DEFAULT false,
  pick_count  smallint,
  note        varchar(200),
  created_at  timestamp NOT NULL DEFAULT now(),
  CONSTRAINT funnel_runs_uq UNIQUE (pick_date)
);
`;

async function main() {
  if (has('analyze')) {
    // 大批量写入后必须手动 ANALYZE（项目军规：统计过期会致查询走并行全表扫）
    for (const t of ['funnel_bars', 'funnel_picks']) {
      await prisma.$executeRawUnsafe(`ANALYZE ${t}`);
    }
    console.log('[funnel-setup] ANALYZE 完成');
    await prisma.$disconnect();
    return;
  }

  for (const stmt of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(stmt);
  }

  const cnt: any[] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM funnel_bars`);
  const empty = cnt[0].n === 0;

  if (empty || has('refresh')) {
    const mx: any[] = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(MAX(trade_date), '') AS d FROM funnel_bars`
    );
    const after: string = mx[0].d;
    // --to=YYYYMMDD 可把构建切成日期段（服务器 2 核/3.8G 上分段跑，避免单条语句过重）
    const to: string = argOf('to') ?? '99999999';
    console.log(
      (empty ? '[funnel-setup] 构建 funnel_bars' : `[funnel-setup] 追加 ${after} 之后的K线`) +
      `（${after} < trade_date <= ${to}）…`
    );
    const t0 = Date.now();
    const n = await prisma.$executeRawUnsafe(
      `
      INSERT INTO funnel_bars (ts_code, trade_date, rn, open, close, pre_close, turnover_rate)
      SELECT d."tsCode", d."tradeDate",
             COALESCE(m.mx, 0) + row_number() OVER (PARTITION BY d."tsCode" ORDER BY d."tradeDate"),
             d.open, d.close, d.pre_close, d.turnover_rate
      FROM daily_bars d
      LEFT JOIN (SELECT ts_code, MAX(rn) AS mx FROM funnel_bars GROUP BY ts_code) m
             ON m.ts_code = d."tsCode"
      WHERE d."tradeDate" > $1 AND d."tradeDate" <= $2
      ON CONFLICT (ts_code, rn) DO NOTHING
      `,
      after, to
    );
    console.log(`[funnel-setup] funnel_bars 写入 ${n} 行，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.log('[funnel-setup] funnel_bars 已存在，跳过构建（要追加新数据用 --refresh）');
  }

  const t: any[] = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public.funnel_picks')::text AS picks,
            to_regclass('public.funnel_runs')::text  AS runs,
            to_regclass('public.funnel_bars')::text  AS bars,
            (SELECT count(*)::int FROM funnel_bars)  AS bar_rows`
  );
  console.log('[funnel-setup] 完成:', t[0]);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[funnel-setup] 失败:', e);
  await prisma.$disconnect();
  process.exit(1);
});
