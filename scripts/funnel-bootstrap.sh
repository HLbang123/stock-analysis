#!/bin/bash
# 分层筛选 —— 服务器侧一次性引导（建表 → 构建辅助表 → 历史回填 → 收益回填 → 口径校验）
#
# ⚠️ 服务器只有 2 核 / 3.8GB，而全量是一次 1470 万行的窗口函数。
#    因此**按年分段**跑，避免单条语句把内存打满（生产曾因统计过期 + 并行全表扫出过 load 9 事故）。
#
# 幂等：可重复执行；已完成的年份会因 funnel_bars 的 (ts_code, rn) 主键与
#       funnel_picks 的 (pick_date, ts_code) 主键自动跳过/覆盖。
#
# 用法（服务器上）：
#   setsid bash scripts/funnel-bootstrap.sh > /tmp/funnel-bootstrap.log 2>&1 < /dev/null &
#   tail -f /tmp/funnel-bootstrap.log
set -e
cd "$(dirname "$0")/.." || exit 1

YEARS=$(seq 2009 2026)
TSX="npx tsx"

echo "===== [1/4] 建表 + 构建辅助表 funnel_bars（按年分段）====="
for y in $YEARS; do
  echo "--- $y ---"
  $TSX scripts/funnel-setup.ts --refresh --to=${y}1231
done

echo "===== [2/4] 历史回填选票（按年分段）====="
for y in $YEARS; do
  echo "--- $y ---"
  $TSX scripts/funnel-backfill.ts --from=${y}0101 --to=${y}1231
done

echo "===== [3/4] 收益回填 ====="
$TSX scripts/funnel-backfill.ts --settle-only

echo "===== [4/4] 口径校验（必须 0 差异）====="
$TSX scripts/funnel-backfill.ts --parity=50

echo "===== 大批量写入后必须 ANALYZE（项目军规）====="
$TSX scripts/funnel-setup.ts --analyze

echo "===== 完成 ====="
