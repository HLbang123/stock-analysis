/**
 * 每日推荐 —— 把「论点的选股思想」和「分层筛选的筛选逻辑」合成一个东西。
 *
 * 论点的贡献：**从哪里找** —— 先跑 D1 景气聚类 / D2 题材聚集 / D3 资金流跃升，
 *             得到「今天有理由的板块」；没有论点的日子就不推荐（宁缺勿滥）。
 * 分层筛选的贡献：**在这些板块里挑哪只** —— 纯主板 · 开盘非涨停 · 上市满 90 天 ·
 *                 非 ST/退 · 换手率不在最热的一档（不拥挤）· 近 20 日跌幅升序。
 *
 * ⚠️ 换手分档（ntile）在**全市场**池子上算，板块过滤发生在分档之后 ——
 *    这样「不拥挤」才是相对全市场而言；若先按板块过滤再分档，小板块内部自己分档、语义就变了。
 *
 * ⚠️ 只有**一个实现**（单日查询）。历史靠日更累积，不做批量回填 ——
 *    因为论点检测依赖的 forecast/kpl_list 在服务器上没有历史（分别只有 45 天 / 5 天），
 *    回填不出来。这也顺带消掉了「两条实现必须一致」的口径校验负担。
 */
import { prisma } from '@/lib/db';
import { detectD1, detectD2, detectD3, latestSnapshotAsOf, type Seed } from '@/services/thesis/detect';

/** 每天最多推荐几只 */
export const DAILY_N = 5;

/**
 * 只在「近 20 日跌幅榜前 RANK_WIDTH 名」里施加超跌条件。
 * 10 是回测里两段都最好的取值（前 40 名内筛 → +0.841/t=7.29；前 10 名内筛 → +1.291/t=7.95）。
 * ⚠️ 这是在全样本上挑的，属于**选择自由度**；两段独立复现方向一致，但仍需随日更继续观察。
 */
const RANK_WIDTH = 10;

export interface HotBoard {
  code: string;
  name: string;
  kind: string;
  /** 用户可读的一句话理由 */
  reason: string;
}

export interface DailyPick {
  rankNo: number;
  tsCode: string;
  name: string;
  boardCode: string | null;
  boardName: string | null;
  boardReason: string | null;
  past20: number | null;
  turnoverRate: number | null;
  turnoverQ: number | null;
}

// ---------------------------------------------------------------- 论点板块

function reasonOf(seed: Seed): string {
  const m = (seed.metric ?? {}) as any;
  if (seed.kind === 'd1_boom') {
    const n = Array.isArray(m.hits) ? m.hits.length : (m.x ?? 0);
    const e = m.enrich != null ? `，富集 ${Number(m.enrich).toFixed(1)} 倍` : '';
    return `近期 ${n} 家成分公司发布正面业绩预告${e}`;
  }
  if (seed.kind === 'd2_theme') {
    return `今日 ${m.count ?? 0} 家涨停，题材集中`;
  }
  if (seed.kind === 'd3_flow') {
    // ⚠️ industry_moneyflow_ths.net_amount 的单位**就是亿元**（实测 银行=36 / 证券=25），不要再除 1e8
    const yi = m.net_amount != null ? `${Number(m.net_amount).toFixed(1)} 亿` : '';
    const jump = m.jump != null ? `，净流入排名前进 ${m.jump} 位` : '';
    return `单日资金净流入${yi ? ` ${yi}` : ''}${jump}`;
  }
  return '出现异动';
}

/** 强度序：有基本面支撑的景气聚类最硬，其次资金，最后纯题材 */
const KIND_ORDER: Record<string, number> = { d1_boom: 0, d3_flow: 1, d2_theme: 2 };

/** 今天有论点的板块（按强度去重）。一个都没有 → 今天不推荐。 */
export async function hotBoards(asOf: string): Promise<HotBoard[]> {
  const safe = async (p: Promise<Seed[]>, tag: string): Promise<Seed[]> => {
    try { return await p; } catch (e: any) {
      console.warn(`[picks] ${tag} 检测失败：${String(e?.message).slice(0, 120)}`);
      return [];
    }
  };
  const [d1, d2, d3] = await Promise.all([
    safe(detectD1(asOf), 'D1'),
    safe(detectD2(asOf), 'D2'),
    safe(detectD3(asOf), 'D3'),
  ]);

  const seen = new Map<string, HotBoard>();
  for (const s of [...d1, ...d3, ...d2]) {
    const code = s.subjectCode;
    if (!code || seen.has(code)) continue;
    seen.set(code, { code, name: s.subject, kind: s.kind, reason: reasonOf(s) });
  }
  return [...seen.values()].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
  );
}

// ---------------------------------------------------------------- 候选池

interface Cand {
  ts_code: string;
  name: string | null;
  turnover_rate: number | null;
  tq: number;
  past20: number | null;
  boards: string[];
}

/**
 * 全市场可交易池 → 换手中间两档 → 按近 20 日跌幅排名 → 前 N 名内施加超跌条件。
 * 纯主板：沪市 60x + 深市 00x（排除创业板 30x / 科创板 688 / 北交所 BJ）。
 * 板块**不参与筛选**，只在 pickDaily 里做标注。
 */
const CAND_SQL = `
  WITH cal AS (
    -- 市场交易日序号。funnel_bars.rn 是**每股可用K线序号**，停牌会让 rn-21 跨月。
    -- 判定「近 20 日」必须用市场日历，不能用自然日（春节/国庆会误杀）。
    SELECT trade_date, row_number() OVER (ORDER BY trade_date) AS cd
    FROM (SELECT DISTINCT trade_date FROM funnel_bars) d
  ),
  c AS (
    SELECT * FROM funnel_bars
    WHERE trade_date = $1 AND open > 0 AND close > 0 AND turnover_rate IS NOT NULL
  ),
  base AS (
    SELECT c.ts_code, c.trade_date, s.name, c.turnover_rate,
           (c.open / NULLIF(c.pre_close, 0) - 1) * 100 AS gap,
           (p1.close / NULLIF(p21.close, 0) - 1) * 100  AS past20,
           (p1.close / NULLIF(p6.close, 0) - 1) * 100   AS ret5,
           (turn.t5 / NULLIF(turn.t20, 0))               AS turn_ratio
    FROM c
    JOIN funnel_bars p1  ON p1.ts_code  = c.ts_code AND p1.rn  = c.rn - 1
    JOIN funnel_bars p6  ON p6.ts_code  = c.ts_code AND p6.rn  = c.rn - 6
    JOIN funnel_bars p21 ON p21.ts_code = c.ts_code AND p21.rn = c.rn - 21
    JOIN cal ca  ON ca.trade_date  = c.trade_date
    JOIN cal c21 ON c21.trade_date = p21.trade_date
    JOIN stocks s ON s.ts_code = c.ts_code
    JOIN LATERAL (
      SELECT avg(t.turnover_rate) FILTER (WHERE t.rn >= c.rn - 6)  AS t5,
             avg(t.turnover_rate) FILTER (WHERE t.rn >= c.rn - 21) AS t20
      FROM funnel_bars t WHERE t.ts_code = c.ts_code AND t.rn BETWEEN c.rn - 21 AND c.rn - 1
    ) turn ON true
    WHERE (c.open / NULLIF(c.pre_close, 0) - 1) * 100 <= 9.5
      AND (c.ts_code LIKE '60%' OR c.ts_code LIKE '00%')
      AND s.list_date IS NOT NULL
      AND s.list_date::date <= $1::date - 90
      AND s.name !~ '(ST|退)'
      -- 🔴 停牌对齐（2026-09-15 修）：正常情况 p21 与当日相距 **21** 个市场交易日（20 个区间）。
      --    允许 1 天缺口（单日停牌不影响「近 20 日」的语义），再多就是停牌。
      --    停牌时 past20 其实是「上次交易至今」的涨跌幅 —— 实测 002683 在 20160104 算出 −66.5%
      --    （rn 698=20150508 → rn 699=20151228，停了 7 个半月），会被排到跌幅榜第 1 名直接成首推。
      --    这是**尾巴风险**不是均值问题：单日只剔 8/3185 条，但踩中就是当日首推。
      --    回测影响：全样本 +0.645→+0.762，样本外 +1.230→+1.260（两端都改善）。
      AND ca.cd - c21.cd <= 22
  ),
  ranked AS (
    -- 破并列键 ts_code 必须有：换手率边界常并列，否则分档依赖物理行序
    SELECT *, ntile(5) OVER (ORDER BY turnover_rate, ts_code) AS tq FROM base
  ),
  ord AS (
    -- 本查询只查 $1 单日，无需 PARTITION BY。先按「近20日跌幅」排名。
    SELECT *, row_number() OVER (ORDER BY past20, ts_code) AS rk
    FROM ranked WHERE tq IN (2, 3) AND past20 IS NOT NULL
  )
  SELECT ts_code, name, turnover_rate, tq, past20, rk
  FROM ord
  WHERE rk <= $2
    --    🔴「超跌」与「下跌中继」的分界
    --    近5日跌幅 <= -5%：最近**确实在急跌**（不是横盘阴跌）
    --    换手比   >= 0.8 ：**不是极度缩量**（有人恐慌抛、也有人接）
    --
    --    🔴 顺序至关重要：必须在**排名之后**施加。
    --       写成「先筛 F 再按 past20 排序」会把「跌得不多但近5日急跌」的票选进来
    --       （实测选出过近20日 +12% 的高位回落票），那不是超跌。
    --
    --    ⚠️ 2026-09-15 全口径复核（103,920 候选 / 2,598 天 / 2016-2026）：
    --       此前这里写的 +1.291%(t=7.95) **是错的**。旧回测用 stocks.name（今天的名字）
    --       剔 ST，等于从历史里删掉「后来才被 ST」的那批下跌股 —— 前视偏差，把 alpha 夸大约 1 倍。
    --       改用 stock_names 的**当时名字**（PIT）后：
    --         全样本 +0.762%(t=4.56) / 样本内 2016-2021 +0.327%(t=1.48) / 样本外 2022-2026 +1.260%(t=4.98)
    --       **2016-2021 统计上不显著**，真正有效的是 2022 年之后。详见 docs/picks-superdrop-alpha.md。
    --    ⚠️ 单独用 ret5 门槛（不加换手比）两段方向不一致，不要那样改。
    --    反例：张江高科 600895（20260914）近5日 -1.5%、换手比约 0.5 → 两条都不满足，正是要挡掉的阴跌。
    AND ret5 <= -5
    AND turn_ratio >= 0.8
  ORDER BY rk
  LIMIT 40
`;

async function candidates(asOf: string): Promise<Cand[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(CAND_SQL, asOf, RANK_WIDTH);
  return rows.map((r) => ({
    ts_code: r.ts_code,
    name: r.name,
    turnover_rate: r.turnover_rate == null ? null : Number(r.turnover_rate),
    tq: Number(r.tq),
    past20: r.past20 == null ? null : Number(r.past20),
    boards: [],
  }));
}

/** 当日异动板块 -> 成分股映射（**只用于标注，不参与筛选**） */
async function boardMembership(boardCodes: string[], snap: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!boardCodes.length) return out;
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ts_code, thscode FROM ths_index_member_snapshots
     WHERE as_of = $1 AND thscode = ANY($2::text[])`,
    snap, boardCodes
  );
  for (const r of rows) {
    if (!out.has(r.ts_code)) out.set(r.ts_code, []);
    out.get(r.ts_code)!.push(r.thscode);
  }
  return out;
}

// ---------------------------------------------------------------- 选股

export interface DailyResult {
  asOf: string;
  boards: HotBoard[];
  picks: DailyPick[];
}

/**
 * 取候选池前 DAILY_N 只。
 * ⚠️ 出票数**不保证是 5**：候选池被「跌幅榜前 RANK_WIDTH 名 + 超跌条件」双重收窄，
 *    够格几只就推几只（宁缺勿滥）。历史上平均每天约 2.7 只。
 */
export async function pickDaily(asOf: string): Promise<DailyResult> {
  // 选股：**全市场**口径，不依赖板块（板块层无法回测 —— 本地 PIT 成分快照只有 1 份）
  const cands = await candidates(asOf);

  // 板块：只做**标注**，告诉用户这只票是不是来自今天有异动的板块；不参与筛选
  const boards = await hotBoards(asOf);
  let member = new Map<string, string[]>();
  if (boards.length) {
    const snapRes = await latestSnapshotAsOf(asOf);
    if (snapRes.d) member = await boardMembership(boards.map((b) => b.code), snapRes.d);
  }
  const byCode = new Map(boards.map((b) => [b.code, b]));

  const picks: DailyPick[] = cands.slice(0, DAILY_N).map((c, i) => {
    const hit = (member.get(c.ts_code) ?? []).find((code) => byCode.has(code));
    const b = hit ? byCode.get(hit)! : null;
    return {
      rankNo: i + 1,
      tsCode: c.ts_code,
      name: c.name ?? '',
      // 无板块归属时存 null（不是空串）—— 界面据此决定是否显示板块行
      boardCode: b?.code ?? null,
      boardName: b?.name ?? null,
      boardReason: b?.reason ?? null,
      past20: c.past20,
      turnoverRate: c.turnover_rate,
      turnoverQ: c.tq,
    };
  });

  return { asOf, boards, picks };
}
