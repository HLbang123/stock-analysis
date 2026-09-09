#!/bin/bash
# 部署后预热：把 Next.js 冷启动成本（路由模块加载 + Prisma 连接池首连）从
# 「用户第一次点击」转移到「部署完成时」。冷启动只在 pm2 restart 后发生一次。
# 用法（部署命令末尾接，约 12~16s）：
#   cd /home/stock-analysis && git pull && npm run build && pm2 restart stock-analysis && bash scripts/warmup.sh
BASE="http://localhost:3000"

# 等 next start 起来（最多 60s，每 2s 探一次 login）
for _ in $(seq 1 30); do
  curl -s -o /dev/null "$BASE/login" 2>/dev/null && break
  sleep 2
done

echo "[warmup] 预热关键路由..."
for path in "/market" "/watchlist" "/stock/sh600519" "/api/kline/db?code=sh600519&days=120" "/api/rps/batch?codes=sh600519,sz000001"; do
  curl -s -o /dev/null "$BASE$path" && echo "  ok  $path"
done

# 预热超短线扫描：首次 POST 要加载 Prisma 连接池 + DB 缓存 + 板块共振数据，
# 不预热的话用户第一次点「扫描」会明显偏慢（实测冷 ~18s vs 热 ~7s）。
ADV=$(grep -E "^ACCESS_ADVANCED_PASSWORD=" .env.local 2>/dev/null | cut -d= -f2- | tr -d '\r')
if [ -n "$ADV" ]; then
  CJ=$(mktemp)
  if curl -s -c "$CJ" -X POST "$BASE/api/auth" -H 'Content-Type: application/json' \
      -d "{\"password\":\"$ADV\"}" -o /dev/null 2>/dev/null; then
    curl -s -b "$CJ" -o /dev/null -w "  ok  /api/short-term-strategies (预热扫描 %{http_code} %{time_total}s)\n" \
      --max-time 120 -X POST "$BASE/api/short-term-strategies" \
      -H 'Content-Type: application/json' -d '{"persist":false}'
  fi
  rm -f "$CJ"
fi

echo "[warmup] 完成"
