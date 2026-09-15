/**
 * 分层筛选 —— 选股核心
 *
 * 规则（与 docs/funnel-alpha.md 验证过的版本一致）：
 *   L0 可交易性：当日有成交、开盘非涨停(<=9.5%)、上市满 90 自然日、非 ST/退
 *   L3 活跃度  ：按当日换手率分 5 档，取中间两档（q2/q3）—— 剔除最拥挤的一档
 *   L3 排序    ：按「买入前一日收盘 / 21 个交易日前收盘 − 1」升序，取前 5
 *   L2 风险排除：可选，命中风险事件则剔除并顺位补足（默认开启；表不存在时自动跳过）
 *
 * 依赖：funnel_bars（辅助表，由 scripts/funnel-setup.ts 构建）+ daily_bars + stocks
 *
 * ⚠️ 为什么要走 funnel_bars 而不是现场算窗口：
 *   规则里的 past20 是「该标的自己的第 2 根 / 第 22 根K线」之比，与阶段 3 的回测口径一致，
 *   不受停牌影响。若用「最近 N 自然日」现场算，长期停牌的标的会凑不齐 22 根而被剔除，
 *   而股票池一变、ntile 的分档边界就跟着移动，导致逐日实现与历史回填选出**不同的票**
 *   （2026-09-13 口径校验实测到：20180903 的 600515.SH）。
 *   走辅助表后两条实现共用同一份 rn，且逐日查询从「扫 200 天」变成主键点查。
 */
import { prisma } from '@/lib/db';
import { latestSnapshotAsOf } from '@/services/thesis/detect';


/**
 * 双创 = 创业板(300/301) + 科创板(688)。
 * 多数散户开不了权限（科创板需 50 万 + 2 年，创业板需 10 万 + 2 年），
 * 所以单期入选里双创要限量 —— 否则会出现「5 只全都买不了」的名单。
 */
export const isShuangChuang = (tsCode: string): boolean =>
  tsCode.startsWith("30") || tsCode.startsWith("688");

/** 单期双创上限 */
export const MAX_SHUANGCHUANG = 2;

/**
 * 最终入选：按 rk 顺序取 n 只 —— 双创（创业板/科创板）**最多 maxCyb 只**，其余顺位补主板。
 * 双创不够就用主板补；绝不为了凑满而硬塞双创。
 *
 * 🔴 回填（scripts/funnel-backfill.ts）与日更（pickForDate）**必须调用同一个函数**：
 *    两条实现一旦分叉，历史与当天会选出不同的票 —— funnel_bars 这张表就是为治这个病生的，
 *    校验用 scripts/funnel-backfill.ts --parity=N。
 */
export function takeFinal<T extends { ts_code: string }>(
  list: T[],
  n = 5,
  maxCyb = MAX_SHUANGCHUANG
): T[] {
  const out: T[] = [];
  let cyb = 0;
  for (const r of list) {
    if (out.length >= n) break;
    if (isShuangChuang(r.ts_code)) {
      if (cyb >= maxCyb) continue; // 双创已满，顺位让给非双创
      cyb++;
    }
    out.push(r);
  }
  return out;
}


export interface FunnelPick {
  tsCode: string;
  rankNo: number;
  name: string;
  reason: string;
  turnoverRate: number | null;
  turnoverQ: number;
  past20: number | null;
  vetoHit: boolean;
  vetoTypes: string[];
}

/** 风险事件类型（阶段 1 中性化检验后保留的 8 类） */
export const VETO_TYPES = ['停牌', '风险警示', '立案', '问询', '收购重组', '终止', '中标', '诉讼'];

/** 取候选的宽度：必须在风险排除**之前**取这么多，否则被排除后无法顺位补足到 5 只 */
const CANDIDATE_POOL = 40;

let vetoProbe: boolean | null = null;
/** event_signal 表是否存在（不存在则自动降级，不报错） */
export async function vetoTableAvailable(): Promise<boolean> {
  if (vetoProbe !== null) return vetoProbe;
  try {
    // ⚠️ 必须 ::text：to_regclass 返回 regclass，Prisma 无法反序列化（P2010 UnsupportedNativeDataType）
    const r: any[] = await prisma.$queryRawUnsafe(`SELECT to_regclass('public.event_signal')::text AS t`);
    vetoProbe = !!r[0]?.t;
  } catch {
    vetoProbe = false;
  }
  return vetoProbe;
}

/** 生成给用户看的理由（中性表述，不出现「股」字与算法术语） */
function buildReason(past20: number | null, vetoTypes: string[]): string {
  const parts: string[] = [];
  if (past20 != null) {
    const p = Math.abs(past20);
    if (past20 <= -15) parts.push(`近一个月回落 ${p.toFixed(1)}%`);
    else if (past20 <= -5) parts.push(`近一个月回调 ${p.toFixed(1)}%`);
    else if (past20 < 5) parts.push('近一个月横盘');
    else parts.push(`近一个月上涨 ${p.toFixed(1)}%`);
  }
  parts.push('成交活跃度处于中位区间');
  if (vetoTypes.length) parts.push(`已排除近期风险提示（${vetoTypes.join('、')}）`);
  return parts.join('，');
}

/**
 * 取某一买入日的入选。
 *
 * @param pickDate 买入日 YYYYMMDD（该日开盘买入）
 * @param opts.boards  只在这些板块（同花顺板块代码）的成分里选 —— 「论点板块内选票」。
 *                     不传 = 全市场（旧的分层筛选口径，仅回测/对照用）。
 * @param opts.snapshot 成分快照 as_of；不传则取 <= pickDate 的最近一份（带回退）。
 */
export async function pickForDate(
  pickDate: string,
  opts: { veto?: boolean; boards?: string[]; snapshot?: string } = {}
): Promise<FunnelPick[]> {
  const useVeto = opts.veto !== false && (await vetoTableAvailable());

  const sql = `
    WITH c AS (
      SELECT * FROM funnel_bars
      WHERE trade_date = $1 AND open > 0 AND close > 0 AND turnover_rate IS NOT NULL
    ),
    base AS (
      SELECT c.ts_code, s.name, c.turnover_rate,
             (c.open  / NULLIF(c.pre_close, 0) - 1) * 100 AS gap,
             (p1.close / NULLIF(p21.close, 0) - 1) * 100   AS past20
      FROM c
      JOIN funnel_bars p1  ON p1.ts_code  = c.ts_code AND p1.rn  = c.rn - 1
      JOIN funnel_bars p21 ON p21.ts_code = c.ts_code AND p21.rn = c.rn - 21
      JOIN stocks s ON s.ts_code = c.ts_code
      -- ⚠️ 涨幅过滤必须与 scripts/funnel-backfill.ts 的 PICK_SQL 表达式完全一致。
      --    写成 open/pre_close <= 1.095（比值）与写成 (open/pre_close-1)*100 <= 9.5（百分比）
      --    数学等价但浮点不等价；边界上差 1 只票 → 股票池差 1 行 → ntile 桶边界整体位移
      --    → 第 4~5 名换人。2026-09-13 口径校验抓到过 4 例。
      WHERE (c.open / NULLIF(c.pre_close, 0) - 1) * 100 <= 9.5
        -- 纯主板：沪市 600/601/603/605 + 深市 000/001/002/003。
        -- 排除创业板(30x)/科创板(688)/北交所(BJ) —— 权限门槛高，多数人买不了。
        -- ⚠️ 必须在候选池这一层排掉：ntile(5) 换手分档是在本池上算的，池子少一行桶边界就整体位移。
        AND (c.ts_code LIKE '60%' OR c.ts_code LIKE '00%')
        AND s.list_date IS NOT NULL
        AND s.list_date::date <= $1::date - 90
        AND s.name !~ '(ST|退)'
    ),
    ranked AS (
      -- ⚠️ 必须带 ts_code 破并列：换手率/涨幅在边界处常有并列值，
      --    不加破并列键时 ntile/row_number 的结果依赖物理行序，
      --    两条实现（逐日点查 vs 全表扫）会给出不同的分档 → 选出不同的票。
      --    2026-09-13 口径校验抓到过（20230914 / 20161116）。
      SELECT *, ntile(5) OVER (ORDER BY turnover_rate, ts_code) AS tq FROM base
    )
    SELECT ts_code, name, turnover_rate, tq, past20
    FROM ranked
    WHERE tq IN (2, 3) AND past20 IS NOT NULL
    ORDER BY past20 ASC, ts_code
    LIMIT ${CANDIDATE_POOL}
  `;

  const rows: any[] = await prisma.$queryRawUnsafe(sql, pickDate);

  // 风险事件（命中则从候选中剔除，并顺位补足到 5 只）
  // ⚠️ event_signal 的粒度是 (sec_code, ann_date)，**不是** (tsCode, entry_date)：
  //    entry_date 是「公告日之后第一个交易日」，即本函数的 pickDate；
  //    所以正确匹配方式是 ann_date = pickDate 的前一交易日。
  const vetoMap = new Map<string, string[]>(); // sec_code -> types
  if (useVeto) {
    const pv: any[] = await prisma.$queryRawUnsafe(
      `SELECT MAX("tradeDate") AS d FROM daily_bars WHERE "tradeDate" < $1`, pickDate
    );
    const prevTd: string | null = pv[0]?.d ?? null;
    if (prevTd) {
      const vr: any[] = await prisma.$queryRawUnsafe(
        `SELECT sec_code, string_agg(DISTINCT event_type, '、') AS types
         FROM event_signal
         WHERE ann_date = $1 AND event_type = ANY($2::varchar[])
         GROUP BY sec_code`,
        prevTd, VETO_TYPES
      );
      for (const v of vr) vetoMap.set(v.sec_code, String(v.types || '').split('、').filter(Boolean));
    }
  }
  const secOf = (tsCode: string) => tsCode.split('.')[0];

  const picked = takeFinal(rows.filter((r) => !vetoMap.has(secOf(r.ts_code))));
  const vetoTypesOf = (tsCode: string) => vetoMap.get(secOf(tsCode)) ?? [];

  return picked.map((r, i) => ({
    tsCode: r.ts_code,
    rankNo: i + 1,
    name: r.name ?? '',
    reason: buildReason(r.past20 == null ? null : Number(r.past20), vetoTypesOf(r.ts_code)),
    turnoverRate: r.turnover_rate == null ? null : Number(r.turnover_rate),
    turnoverQ: Number(r.tq),
    past20: r.past20 == null ? null : Number(r.past20),
    vetoHit: vetoTypesOf(r.ts_code).length > 0,
    vetoTypes: vetoTypesOf(r.ts_code),
  }));
}

/** 当前可用的最新交易日（数据截止日） */
export async function latestBarDate(): Promise<string | null> {
  const r: any[] = await prisma.$queryRawUnsafe(`SELECT MAX(trade_date) AS d FROM funnel_bars`);
  return r[0]?.d ?? null;
}
