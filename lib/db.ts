/**
 * Prisma 客户端单例（Prisma 7 + pg Pool adapter）
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const dbUrl = process.env.DATABASE_URL ?? "postgresql://quant_user:stock_quant_2024@localhost:5432/stock_analysis";
const pool = new pg.Pool({ connectionString: dbUrl, max: 10 });
const adapter = new PrismaPg(pool);

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter } as any);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
