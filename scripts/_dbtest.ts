import { prisma } from "../lib/db";
async function main() {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    console.log("DB OK");
    const c = await prisma.fundDaily.count({ where: { tradeDate: { gte: "20250801" } } });
    console.log("fund_daily_bars rows since 20250801:", c);
  } catch (e: any) {
    console.log("DB ERR:", String(e.message || e).slice(0, 500));
  } finally {
    await prisma.$disconnect();
  }
}
main();
