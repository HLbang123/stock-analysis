/** GET /api/industries — 同花顺概念板块清单（含活跃成分数）
 *  板块口径已切换为同花顺 cn_concept（lib/concepts.ts），扁平清单、无 L1/L2 层级。
 *  前端扫描页平铺展示；返回结构保留 l2 字段（恒空）以兼容旧前端。
 */
export async function GET() {
  try {
    const { listConcepts } = await import("@/lib/concepts");
    const concepts = await listConcepts();
    return Response.json({
      industries: concepts.map((c) => ({ name: c.name, count: c.count, l2: [] })),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
