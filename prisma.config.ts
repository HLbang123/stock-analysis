import { defineConfig } from "prisma/config";

// Prisma 7 won't auto-load .env.local (Next.js convention)
// Load dotenv manually with path
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const dbUrl = process.env.DATABASE_URL ?? "postgresql://quant_user:stock_quant_2024@localhost:5432/stock_analysis";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: dbUrl,
  },
});
