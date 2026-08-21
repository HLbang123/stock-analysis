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
echo "[warmup] 完成"
