import { RealtimeQuote } from '@/types';
import { decodeGBK, buildQuoteResponse } from '@/lib/api-helpers';

/**
 * 新浪实时行情。**单位归一**：新浪 volume 是「股」、amount 是「元」，
 * 而腾讯/东财是「手」/「万元」，库内 daily_bars（tushare）也是「手」。
 * 这里统一换算成 手 / 万元，避免回落新浪时量比类条件差 100 倍
 * （消费方：短线扫描量比、预警规则均量、分时指标、UI formatVolume、LLM 提示词）。
 */
export async function fetchSinaQuote(symbol: string, signal: AbortSignal): Promise<RealtimeQuote | null> {
  try {
    const res = await fetch(`https://hq.sinajs.cn/list=${symbol}`, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      signal,
    });
    if (!res.ok) return null;

    const text = decodeGBK(await res.arrayBuffer());
    const match = text.match(/="([^"]+)"/);
    if (!match) return null;

    const data = match[1].split(',');
    if (data.length < 32) return null;

    const price = parseFloat(data[3]);
    const preClose = parseFloat(data[2]);
    if (isNaN(price) || price === 0) return null;

    // 字段[30]/[31]为行情自带日期时间（2026-08-10 / 15:09:29），个股与指数同布局
    const updateTime = data[30] && data[31]
      ? `${data[30]} ${data[31].slice(0, 5)}`
      : undefined;

    return buildQuoteResponse({
      symbol,
      name: data[0],
      price,
      preClose,
      open: parseFloat(data[1]),
      high: parseFloat(data[4]),
      low: parseFloat(data[5]),
      volume: Math.round((parseInt(data[8]) || 0) / 100), // 股 → 手
      amount: (parseFloat(data[9]) || 0) / 10000,         // 元 → 万元
      updateTime,
    });
  } catch {
    return null;
  }
}
