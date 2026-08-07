/**
 * 云同步数据清理 — 挂 run-daily 每日执行（fatal:false）：
 * 1. 删除已过期的配对行（10 分钟 TTL 的惰性清理兜底）
 * 2. 删除 90 天未更新的快照（弃用/丢失的同步身份不占坑）
 *
 * 用法:
 *   npx tsx scripts/cleanup-sync-snapshots.ts
 */

import { prisma } from '../lib/db';

async function main() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

  const expiredPairs = await prisma.syncPairing.deleteMany({ where: { expiresAt: { lt: now } } });
  const staleSnaps = await prisma.syncSnapshot.deleteMany({ where: { updatedAt: { lt: cutoff } } });

  console.log(`[cleanup-sync] 过期配对 ${expiredPairs.count} 行，90 天未更新快照 ${staleSnaps.count} 行`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[cleanup-sync] 失败:', e); process.exit(1); });
