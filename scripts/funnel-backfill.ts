/**
 * 分层筛选 —— 历史回填 + 收益回填 + 口径一致性校验
 *
 * 用法（本地）：
 *   bash scripts/_scratch/run-local.sh scripts/funnel-backfill.ts                 # 全量：选票 + 收益回填
 *   bash scripts/_scratch/run-local.sh scripts/funnel-backfill.ts --parity=30     # 只做口径校验
 *   bash scripts/_scratch/run-local.sh scripts/funnel-backfill.ts --settle-only   # 只补收益
 *   bash scripts/_scratch/run-local.sh scripts/funnel-backfill.ts --daily         # 只算最新一日（日更用）
 *
 * ★ 口径一致性校验（--parity）：
 *   历史回填用的是「单遍 SQL」（快），日更用的是 services/funnel/select.ts（逐日、200 天窗口）。
 *   两条实现必须给出**同样的 5 只**，否则历史战绩与实盘就会脱节。
 *   这里随机抽 N 个交易日逐日比对，不一致必须当成 bug 处理。
 */
import { prisma } from '../lib/db';
import { pickForDate, latestBarDate, vetoTableAvailable, takeFinal } from '../services/funnel/select';

const args = process.argv.slice(2);
const argOf = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const has = (k: string) => args.includes(`--${k}`);

function shiftDate(yyyymmdd: string, days: number): string {
  const d = new Date(`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ---------------------------------------------------------------- 单遍 SQL 选票
const PICK_SQL = `
  WITH j AS (
    SELECT c.trade_date AS pick_date, c.ts_code, c.turnover_rate,
           (c.open  / NULLIF(c.pre_close, 0) - 1) * 100 AS gap,
           (p1.close / NULLIF(p21.close, 0) - 1) * 100  AS past20
    FROM funnel_bars c
    JOIN funnel_bars p1  ON p1.ts_code  = c.ts_code AND p1.rn  = c.rn - 1
    JOIN funnel_bars p21 ON p21.ts_code = c.ts_code AND p21.rn = c.rn - 21
    WHERE c.open > 0 AND c.close > 0 AND c.turnover_rate IS NOT NULL
      AND c.trade_date BETWEEN $1 AND $2
  ),
  l0 AS (
    SELECT j.* FROM j JOIN stocks s ON s.ts_code = j.ts_code
    WHERE j.gap <= 9.5
      -- 排除北交所（与 services/funnel/select.ts 完全一致；必须在候选池层排除以保持 ntile 桶一致）
      AND j.ts_code NOT LIKE '%.BJ'
      AND s.list_date IS NOT NULL
      AND s.list_date::date <= j.pick_date::date - 90
      AND s.name !~ '(ST|退)'
  ),
  t AS (SELECT *, ntile(5) OVER (PARTITION BY pick_date ORDER BY turnover_rate, ts_code) AS tq FROM l0),
  r AS (SELECT *, row_number() OVER (PARTITION BY pick_date ORDER BY past20, ts_code) AS rk
        FROM t WHERE tq IN (2, 3) AND past20 IS NOT NULL)
  -- ⚠️ 破并列键 ts_code 必须与 services/funnel/select.ts 完全一致，否则边界并列行的分档会不同。
  --    2026-09-13 口径校验抓到过（20230914 / 20161116）。
  -- ⚠️ 必须取到 40 而不是 5：风险排除发生在 JS 侧，若先截断到 5，
  --    一旦有票被排除就只剩 4 只、无法从第 6 名补位（与 select.ts 的候选宽度对齐）。
  --    2026-09-13 口径校验抓到过：20240327 单遍出 4 只、逐日出 5 只。
  SELECT pick_date, ts_code, rk::int AS rank_no, turnover_rate, tq::int AS tq, past20
  FROM r WHERE rk <= 40
  ORDER BY pick_date, rank_no
`;

function reasonOf(past20: number | null): string {
  const parts: string[] = [];
  if (past20 != null) {
    const p = Math.abs(past20);
    if (past20 <= -15) parts.push(`近一个月回落 ${p.toFixed(1)}%`);
    else if (past20 <= -5) parts.push(`近一个月回调 ${p.toFixed(1)}%`);
    else if (past20 < 5) parts.push('近一个月横盘');
    else parts.push(`近一个月上涨 ${p.toFixed(1)}%`);
  }
  parts.push('成交活跃度处于中位区间');
  return parts.join('，');
}

async function backfillPicks() {
  // 可按日期分段（服务器 2 核/3.8G 上分段跑，避免单条语句过重）
  const r0: any[] = await prisma.$queryRawUnsafe(
    `SELECT MIN(trade_date) AS d0, MAX(trade_date) AS d1 FROM funnel_bars`
  );
  const from: string = argOf('from') ?? r0[0]?.d0 ?? '00000000';
  const to: string = argOf('to') ?? r0[0]?.d1 ?? '99999999';
  console.log(`[funnel] 单遍 SQL 选票中…（${from} ~ ${to}）`);
  // 🔴 先清掉区间内的旧选票，再写入。
  //    下面用的是 ON CONFLICT (pick_date, ts_code) DO UPDATE —— 只更新不删除，
  //    所以**改了规则之后，不再入选的旧票会作为「孤儿行」留在表里**：
  //    rank_no 出现重复、历史战绩被新旧两套规则混着污染。
  //    2026-09-14 给双创加上限时踩到过（20250613 出现两个 rank 3、两个 rank 4）。
  //    这与 MEMORY.md 记的「2026-09-11 孤儿行教训」是同一类问题：改规则必须同步清理历史行。
  await prisma.$executeRawUnsafe(
    `DELETE FROM funnel_picks WHERE pick_date BETWEEN $1 AND $2`, from, to
  );
  const rows: any[] = await prisma.$queryRawUnsafe(PICK_SQL, from, to);
  console.log(`[funnel] 选出 ${rows.length} 条（${new Set(rows.map((r) => r.pick_date)).size} 个交易日）`);

  // 名称按码查一次做成 Map（军规：不要 join 变长字符串）
  const codes = [...new Set(rows.map((r) => r.ts_code))];
  const nameRows: any[] = await prisma.$queryRawUnsafe(
    `SELECT ts_code, name FROM stocks WHERE ts_code = ANY($1::varchar[])`, codes
  );
  const nameOf = new Map<string, string>(nameRows.map((r) => [r.ts_code, r.name]));

  // 风险事件（有表才用）。口径与 services/funnel/select.ts 一致：
  //   event_signal 的粒度是 (sec_code, ann_date)，买入日 = 公告日的次一交易日。
  const VETO = ['停牌', '风险警示', '立案', '问询', '收购重组', '终止', '中标', '诉讼'];
  const vetoMap = new Map<string, string>(); // `${pick_date}|${sec_code}` -> types
  if (await vetoTableAvailable()) {
    const vr: any[] = await prisma.$queryRawUnsafe(
      `WITH cal AS (
         SELECT d, lag(d) OVER (ORDER BY d) AS prev_d
         FROM (SELECT DISTINCT "tradeDate" AS d FROM daily_bars) t
       )
       -- ⚠️ pick_date 必须是 c.d（公告日的**次一交易日**），不是 c.prev_d。
       --    c.prev_d 就是 s.ann_date 本身（join 条件），把它当买入日会把风险事件
       --    错误地否决在公告当天，而不是公告后的买入日。
       --    2026-09-13 口径校验抓到过：300492 在 20200106 的公告被误否决在 20200106，
       --    正确应否决 20200107。
       SELECT DISTINCT c.d AS pick_date, s.sec_code, s.event_type
       FROM event_signal s JOIN cal c ON c.prev_d = s.ann_date
       WHERE s.event_type = ANY($1::varchar[])`,
      VETO
    );
    const acc = new Map<string, Set<string>>();
    for (const v of vr) {
      const k = `${v.pick_date}|${v.sec_code}`;
      if (!acc.has(k)) acc.set(k, new Set());
      acc.get(k)!.add(v.event_type);
    }
    for (const [k, s] of acc) vetoMap.set(k, [...s].join('、'));
    console.log(`[funnel] 风险事件命中 ${vetoMap.size} 个（日×标的）`);
  }
  const secOf = (tsCode: string) => tsCode.split('.')[0];

  // 命中风险事件的从候选中剔除后顺位补足（与 select.ts 同逻辑）
  const byDay = new Map<string, any[]>();
  for (const r of rows) {
    if (!byDay.has(r.pick_date)) byDay.set(r.pick_date, []);
    byDay.get(r.pick_date)!.push(r);
  }
  const finalRows: any[] = [];
  for (const [d, list] of byDay) {
    // 与日更共用 takeFinal，保证两条实现选出同一批票（含双创限 2 只）
    const kept = takeFinal(list.filter((r) => !vetoMap.has(`${d}|${secOf(r.ts_code)}`)));
    kept.forEach((r, i) => finalRows.push({ ...r, rank_no: i + 1 }));
  }

  const CHUNK = 2000;
  let done = 0;
  for (let i = 0; i < finalRows.length; i += CHUNK) {
    const chunk = finalRows.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: any[] = [];
    chunk.forEach((r, idx) => {
      const b = idx * 8;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
      const vt = vetoMap.get(`${r.pick_date}|${secOf(r.ts_code)}`) ?? null;
      params.push(
        r.pick_date, r.ts_code, r.rank_no,
        nameOf.get(r.ts_code) ?? null,
        reasonOf(r.past20 == null ? null : Number(r.past20)) + (vt ? `，已排除近期风险提示（${vt}）` : ''),
        r.turnover_rate, r.tq, r.past20
      );
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO funnel_picks
         (pick_date, ts_code, rank_no, name, reason, turnover_rate, turnover_q, past20)
       VALUES ${values.join(',')}
       ON CONFLICT (pick_date, ts_code) DO UPDATE SET
         rank_no = EXCLUDED.rank_no, name = EXCLUDED.name, reason = EXCLUDED.reason,
         turnover_rate = EXCLUDED.turnover_rate, turnover_q = EXCLUDED.turnover_q,
         past20 = EXCLUDED.past20, updated_at = now()`,
      ...params
    );
    done += chunk.length;
  }
  console.log(`[funnel] 写入 ${done} 条`);

  // 每次跑批元信息
  const days = [...byDay.keys()].sort();
  if (days.length) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO funnel_runs (pick_date, bar_date, veto_used, pick_count, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pick_date) DO UPDATE SET bar_date = EXCLUDED.bar_date,
         veto_used = EXCLUDED.veto_used, pick_count = EXCLUDED.pick_count, note = EXCLUDED.note`,
      days[days.length - 1], days[days.length - 1], vetoMap.size > 0, finalRows.length, 'backfill'
    );
  }
}

// ---------------------------------------------------------------- 收益回填
async function settle() {
  const r: any[] = await prisma.$queryRawUnsafe(
    `SELECT MIN(pick_date) AS d0, MAX(pick_date) AS d1 FROM funnel_picks`
  );
  const d0 = r[0]?.d0, d1 = r[0]?.d1;
  if (!d0) { console.log('[funnel] 无选票，跳过收益回填'); return; }
  const toExt = shiftDate(d1, 45);
  console.log(`[funnel] 收益回填 ${d0} ~ ${d1}（数据窗口延到 ${toExt}）`);

  await prisma.$executeRawUnsafe(
    `
    WITH b AS (
      SELECT "tsCode", "tradeDate", open, close,
             row_number() OVER (PARTITION BY "tsCode" ORDER BY "tradeDate") AS rn
      FROM daily_bars WHERE "tradeDate" BETWEEN $1 AND $2
    ),
    mkt AS (
      SELECT b."tradeDate" AS d, count(*) AS n,
             avg((b5.close  / NULLIF(b.open,0) - 1) * 100) AS m5,
             avg((b10.close / NULLIF(b.open,0) - 1) * 100) AS m10,
             avg((b20.close / NULLIF(b.open,0) - 1) * 100) AS m20
      FROM b
      LEFT JOIN b b5  ON b5."tsCode" = b."tsCode" AND b5.rn  = b.rn + 5
      LEFT JOIN b b10 ON b10."tsCode" = b."tsCode" AND b10.rn = b.rn + 10
      LEFT JOIN b b20 ON b20."tsCode" = b."tsCode" AND b20.rn = b.rn + 20
      WHERE b.open > 0 AND b."tradeDate" BETWEEN $1 AND $3
      GROUP BY 1
    ),
    e AS (
      SELECT p.pick_date, p.ts_code,
             (b5.close  / NULLIF(b.open,0) - 1) * 100 AS r5,
             (b10.close / NULLIF(b.open,0) - 1) * 100 AS r10,
             (b20.close / NULLIF(b.open,0) - 1) * 100 AS r20
      FROM funnel_picks p
      JOIN b ON b."tsCode" = p.ts_code AND b."tradeDate" = p.pick_date
      LEFT JOIN b b5  ON b5."tsCode"  = b."tsCode" AND b5.rn  = b.rn + 5
      LEFT JOIN b b10 ON b10."tsCode" = b."tsCode" AND b10.rn = b.rn + 10
      LEFT JOIN b b20 ON b20."tsCode" = b."tsCode" AND b20.rn = b.rn + 20
      WHERE b.open > 0
    )
    UPDATE funnel_picks f SET
      ret5 = e.r5, ret10 = e.r10, ret20 = e.r20,
      ex5  = e.r5  - m.m5, ex10 = e.r10 - m.m10, ex20 = e.r20 - m.m20,
      settled = (e.r20 IS NOT NULL),
      updated_at = now()
    FROM e JOIN mkt m ON m.d = e.pick_date
    WHERE f.pick_date = e.pick_date AND f.ts_code = e.ts_code
    `,
    d0, toExt, d1
  );

  const c: any[] = await prisma.$queryRawUnsafe(
    `SELECT count(*) AS total, count(*) FILTER (WHERE settled) AS settled FROM funnel_picks`
  );
  console.log(`[funnel] 收益回填完成：${c[0].settled}/${c[0].total} 已定型`);
}

// ---------------------------------------------------------------- 口径一致性校验
async function parity(n: number) {
  console.log(`[funnel] 口径校验：随机 ${n} 个交易日，单遍SQL vs select.ts`);
  const days: any[] = await prisma.$queryRawUnsafe(
    // 确定性抽样：用 md5(pick_date) 排序，保证每次跑的是同一批日期，结果可比较。
    // （用 ORDER BY random() 会导致两次运行的样本不同，无法判断是否真的改好了。）
    `SELECT pick_date FROM (SELECT DISTINCT pick_date FROM funnel_picks) t
     ORDER BY md5(pick_date) LIMIT $1`, n
  );
  let same = 0, diff = 0;
  for (const { pick_date } of days) {
    const a: any[] = await prisma.$queryRawUnsafe(
      `SELECT ts_code FROM funnel_picks WHERE pick_date = $1 ORDER BY rank_no`, pick_date
    );
    const b = await pickForDate(pick_date);
    const A = a.map((x) => x.ts_code).join(',');
    const B = b.map((x) => x.tsCode).join(',');
    if (A === B) same++;
    else { diff++; console.log(`  ✗ ${pick_date}\n     单遍: ${A}\n     逐日: ${B}`); }
  }
  console.log(`[funnel] 口径校验：一致 ${same} / 不一致 ${diff}`);
  if (diff > 0) { console.error('[funnel] ⚠️ 两条实现不一致，历史战绩不可信，需修到 0 差异'); process.exitCode = 2; }
}

// ---------------------------------------------------------------- 日更（只算最新一日）
async function daily() {
  const barDate = await latestBarDate();
  if (!barDate) throw new Error('daily_bars 为空');
  const picks = await pickForDate(barDate);
  if (!picks.length) { console.log(`[funnel] ${barDate} 无候选`); return; }
  for (const p of picks) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO funnel_picks
         (pick_date, ts_code, rank_no, name, reason, turnover_rate, turnover_q, past20, veto_hit, veto_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (pick_date, ts_code) DO UPDATE SET
         rank_no = EXCLUDED.rank_no, name = EXCLUDED.name, reason = EXCLUDED.reason,
         turnover_rate = EXCLUDED.turnover_rate, turnover_q = EXCLUDED.turnover_q,
         past20 = EXCLUDED.past20, veto_hit = EXCLUDED.veto_hit,
         veto_types = EXCLUDED.veto_types, updated_at = now()`,
      barDate, p.tsCode, p.rankNo, p.name, p.reason,
      p.turnoverRate, p.turnoverQ, p.past20, p.vetoHit, p.vetoTypes.join('、') || null
    );
  }
  const used = await vetoTableAvailable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO funnel_runs (pick_date, bar_date, veto_used, pick_count, note)
     VALUES ($1,$2,$3,$4,'daily') ON CONFLICT (pick_date) DO UPDATE SET
       bar_date = EXCLUDED.bar_date, veto_used = EXCLUDED.veto_used,
       pick_count = EXCLUDED.pick_count, note = EXCLUDED.note`,
    barDate, barDate, used, picks.length
  );
  console.log(`[funnel] ${barDate} 落库 ${picks.length} 只（风险排除 ${used ? '启用' : '未启用'}）`);
  for (const p of picks) console.log(`  ${p.rankNo}. ${p.name} ${p.tsCode}  ${p.reason}`);
}

async function main() {
  const parityN = argOf('parity');
  if (parityN) { await parity(parseInt(parityN, 10)); await prisma.$disconnect(); return; }
  if (has('settle-only')) { await settle(); await prisma.$disconnect(); return; }
  if (has('daily')) { await daily(); await settle(); await prisma.$disconnect(); return; }
  await backfillPicks();
  await settle();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[funnel-backfill] 失败:', e);
  await prisma.$disconnect();
  process.exit(1);
});
