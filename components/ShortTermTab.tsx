'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUiStore } from '@/store/ui-store';
import { useStockStore } from '@/store';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { ChevronDown, ChevronUp, Info, AlertTriangle, Loader2, Plus, Minus, Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

/**
 * 超短线主 tab — 三套短线形态策略（涨停+三连阴 / 龙首阴 / 双龙战法）的候选列表。
 * 数据来自 GET /api/short-term-strategies（后端两阶段扫描落库快照）。
 * 只读展示：形态符合 + 强度分级，不输出操作指引。
 */

export type ShortTermStrategyId = 'limit-up-three-yin' | 'dragon-first-yin' | 'double-dragon' | 'dragon-four-yin' | 'xian-ren-zhi-lu' | 'limit-up-board';

interface ShortTermStrategyMeta {
  id: ShortTermStrategyId;
  name: string;
  description: string;
  rulesText: string;
}

const STRATEGIES: ShortTermStrategyMeta[] = [
  {
    id: 'limit-up-three-yin',
    name: '板三阴',
    description: '涨停后连续三根小阴线',
    rulesText: '涨停日非一字板；随后三日小阴线（第一根可假阴）、收盘逐日走低，尾盘不急速拉升时形态符合。',
  },
  {
    id: 'dragon-first-yin',
    name: '龙首阴',
    description: '连板后首根阴线，换手充分',
    rulesText: '连续涨停后首根阴线；换手充分、量能承接、实体不超 7%；高位板需假阴真阳。',
  },
  {
    id: 'double-dragon',
    name: '双龙',
    description: '首板非一字实体板，二板连续涨停',
    rulesText: '首板为非一字实体板；二板连续涨停且只认恰好二板；二板一字板不作为硬性剔除。',
  },
  {
    id: 'dragon-four-yin',
    name: '龙四阴',
    description: '涨停首板放量近新高后四连阴',
    rulesText: '涨停需首板、非一字、放量1.5倍、接近20日新高；随后四连阴，第四阴尾盘关注。',
  },
  {
    id: 'xian-ren-zhi-lu',
    name: '仙人指路',
    description: '试盘长上影后确认日反包',
    rulesText: '试盘日长上影（≥实体1.2倍、上影≥1.5%）、小实体、收红、量比≥1.2、不破昨收；次日反包上影≥40%且收高位、不高开，确认日尾盘关注。',
  },
  {
    id: 'limit-up-board',
    name: '封板',
    description: '当日封于涨停且换手充分',
    rulesText: '当日封于涨停价（盘中现价触及即成立）；换手率不低于可买性下限（默认 10%）——换手越低历史期望越高，但过低说明封死、基本买不进。',
  },
];

interface MarketContext {
  mode: 'attack' | 'neutral' | 'defense';
  tradable: boolean;
  limitUpCount: number;
  limitDownCount: number;
  brokenCount: number | null;
  highestBoard: number | null;
  warnings: string[];
}

interface ShortTermCandidate {
  strategy: ShortTermStrategyId;
  tsCode: string;
  name: string;
  signalType: string;
  matchedDate: string;
  priority: 'high' | 'medium' | 'low';
  score: number;
  reason: string;
  summary: string | null;
  metrics: Record<string, unknown>;
}

interface ShortTermResponse {
  strategies: { id: string; name: string; description: string }[];
  phase: 'closing';
  tradeDate: string; // YYYYMMDD
  generated: boolean;
  generatedAt: string | null;
  market: MarketContext | null;
  candidates: Record<string, ShortTermCandidate[]>;
}

const REGIME_LABEL: Record<'attack' | 'neutral' | 'defense', string> = {
  attack: '活跃',
  neutral: '震荡',
  defense: '收缩',
};

const PRIORITY_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: '强',
  medium: '中',
  low: '弱',
};

const QUALITY_LABEL: Record<string, string> = {
  turnover: '换手板',
  mixed: '混合板',
  oneWord: '一字板',
};

/**
 * 标签口径：给人扫一眼用的，克制数字。
 * 能转成档位词就转词，原始数值放 hint（悬停可见）；门槛型指标达标时不占位，异常才出现。
 */
type ChipTone = 'red' | 'gray';

interface Chip {
  label: string;
  tone?: ChipTone;
  hint?: string;
  /** 合并出来的明细条，渲染时压暗一档 */
  detail?: boolean;
}

const CONF_STRONG = 70; // 反包上影 ≥70% 记「强」
const CONF_OVER = 100; // 反包上影 ≥100% 表示收上试盘日最高
const SHADOW_LONG = 3; // 试盘日上影 ≥3% 记「长」
const BODY_TIGHT = 5.5; // 阴线实体 ≤5.5% 属正常，越界才提示

/** 反包档位：确认日反包试盘日上影的比例 */
function confChip(pct: number): Chip {
  const hint = `反包试盘日上影 ${pct.toFixed(0)}%`;
  if (pct >= CONF_OVER) return { label: '反包过顶', tone: 'red', hint: `${hint}，收上试盘日最高` };
  if (pct >= CONF_STRONG) return { label: '强反包', tone: 'red', hint };
  return { label: '弱反包', hint };
}

/** 试盘日上影 */
function shadowChip(pct: number): Chip {
  return pct >= SHADOW_LONG
    ? { label: `长上影 ${pct.toFixed(1)}%`, hint: '试盘日上影' }
    : { label: '试盘影', hint: `试盘日上影 ${pct.toFixed(1)}%` };
}

/** 量能档位 */
function volumeChip(ratio: number): Chip {
  const hint = `量比 ${ratio.toFixed(1)}`;
  if (ratio >= 3) return { label: '巨量', hint };
  if (ratio >= 2) return { label: '显著放量', hint };
  if (ratio >= 1.2) return { label: '温和放量', hint };
  return { label: '缩量', hint };
}

/** 60 日位置（描述性，不上色） */
function positionChip(gain60: number): Chip {
  const hint = `60日 ${gain60 >= 0 ? '+' : ''}${gain60.toFixed(1)}%`;
  if (gain60 <= 5) return { label: '低位', hint };
  if (gain60 <= 30) return { label: '中位', hint };
  return { label: '高位', hint };
}

/**
 * 封板票的换手率：这是「可买性」和「期望」的取舍——
 * 换手越低历史期望越高，但越低越可能是封死板、根本排不进去。
 * 所以这里只描述事实，不下"好/坏"判断（判断交给打分，口径见 services/.../score.ts）。
 */
function turnoverChip(pct: number): Chip {
  const hint = `当日换手 ${pct.toFixed(1)}%`;
  if (pct < 7) return { label: '换手适中', tone: 'red', hint: `${hint}，历史期望最高的一档` };
  if (pct < 10) return { label: '换手充分', hint };
  if (pct < 15) return { label: '换手偏高', hint: `${hint}，越容易成交、历史期望越低` };
  return { label: '换手过高', hint: `${hint}，容易成交但历史期望已明显走低` };
}

/**
 * 封板日量比：本策略**权重最大**的排序因子，方向是「缩量优先」。
 * 依据是排序口径实测（Top5 日度等权）：缩量组显著优于放量组，五年/十年一致，
 * 且控制换手率后每个换手档内仍单调有效（与换手率相关系数仅 +0.087，是独立信息）。
 */
function sealVolChip(ratio: number): Chip {
  const hint = `封板日量比 ${ratio.toFixed(2)}（当日量 / 前5日均量）`;
  if (ratio < 1) return { label: '缩量封板', tone: 'red', hint: `${hint}，历史最优档` };
  if (ratio < 2) return { label: '温和封板', hint };
  if (ratio < 3) return { label: '放量封板', hint: `${hint}，历史期望偏低` };
  return { label: '巨量封板', hint: `${hint}，历史期望最差档` };
}

/** 把零散指标压成一条灰色明细，原始数值仍留在悬停里 */
function detailChip(parts: (Chip | null)[]): Chip | null {
  const kept = parts.filter((p): p is Chip => p != null);
  if (kept.length === 0) return null;
  return {
    label: kept.map((p) => p.label).join(' · '),
    hint: kept.map((p) => p.hint ?? p.label).join('；'),
    detail: true,
  };
}

/**
 * 板块热度：仙人指路打分里权重最大的一项。
 * 口径是该标的所属概念板块里，有几个板块指数自己也走出了「T-1 长上影 → T 反包上影」
 * ——即板块当天确实在往上收，不只是形态相似，所以按「热度」表达。
 */
function sectorChip(m: Record<string, unknown>): Chip | null {
  const hitCount = numMetric(m, 'hitCount');
  if (hitCount == null || hitCount < 1) return null;
  const maxShadow = numMetric(m, 'maxShadow');
  const hint =
    `同形态概念板块 ${hitCount} 个` +
    (maxShadow != null ? `，最强板块上影 ${maxShadow.toFixed(1)}%` : '');
  if (hitCount >= 4) return { label: '板块爆发', tone: 'red', hint };
  if (hitCount >= 2) return { label: '板块发酵', tone: 'red', hint };
  return { label: '板块异动', hint };
}

function numMetric(m: Record<string, unknown>, k: string): number | null {
  const v = m[k];
  return typeof v === 'number' ? v : null;
}

function strMetric(m: Record<string, unknown>, k: string): string | null {
  const v = m[k];
  return typeof v === 'string' ? v : null;
}

function arrMetric(m: Record<string, unknown>, k: string): number[] | null {
  const v = m[k];
  return Array.isArray(v) ? (v as number[]) : null;
}

function signalLabel(signalType: string): string | null {
  if (signalType === 'firstYinToday') return '首阴当日';
  if (signalType === 'firstYinYesterday') return '首阴次日';
  if (signalType === 'double_dragon_board') return '二板封板';
  if (signalType === 'dragon_four_yin') return '第四阴';
  if (signalType === 'xian_ren_zhi_lu') return '确认日';
  if (signalType === 'limit_up_board') return '封板当日';
  return null;
}

function hitLine(strategy: ShortTermStrategyId): string {
  if (strategy === 'limit-up-three-yin') return '板三阴形态符合';
  if (strategy === 'dragon-first-yin') return '龙首阴形态符合';
  if (strategy === 'double-dragon') return '二板封板形态符合';
  if (strategy === 'dragon-four-yin') return '龙四阴形态符合';
  if (strategy === 'xian-ren-zhi-lu') return '仙人指路形态符合';
  if (strategy === 'limit-up-board') return '封板形态符合';
  return '形态符合';
}

function formatDate(ymd: string): string {
  if (/^\d{8}$/.test(ymd)) return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  return ymd;
}

// 手动扫描结果本地缓存：手动扫描 persist=false 不落库，刷新/重进会回退到最近落库日（可能是上个交易日）。
// 这里按「当天」缓存一份手动扫描结果，挂载时兜底展示，避免数据日跳变。
const SCAN_CACHE_KEY = 'short-term-scan-cache-v1';

function beijingDate(ts: number): string {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}
function beijingToday(): string {
  return beijingDate(Date.now());
}

function readScanCache(): { tradeDate: string; savedAt: number; data: ShortTermResponse } | null {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.tradeDate === 'string' && typeof parsed.savedAt === 'number' && parsed.data?.candidates) return parsed;
  } catch {
    /* 忽略隐私模式等 localStorage 不可用场景 */
  }
  return null;
}

function writeScanCache(tradeDate: string, data: ShortTermResponse): void {
  try {
    localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify({ tradeDate, savedAt: Date.now(), data }));
  } catch {
    /* 忽略 */
  }
}

function toStock(tsCodeFull: string, name: string) {
  const tsCode = tsCodeFull.replace(/\.(SH|SZ|BJ)$/, '');
  const isSH = tsCode.startsWith('6') || tsCode.startsWith('68');
  const isBJ = tsCode.startsWith('4') || tsCode.startsWith('8') || tsCode.startsWith('9');
  const market = isSH ? 'sh' : isBJ ? 'bj' : 'sz';
  const pureCode = tsCode.replace(/^(sh|sz|bj)/i, '');
  return { code: `${market}${pureCode}`, name, market, pureCode };
}

function toAppCode(tsCode: string) {
  const m = tsCode.match(/^(\d+)\.(SH|SZ|BJ)$/);
  return m ? m[2].toLowerCase() + m[1] : tsCode;
}

export function ShortTermTab() {
  const router = useRouter();
  const selected = useUiStore((s) => s.shortTermStrategy);
  const setSelected = useUiStore((s) => s.setShortTermStrategy);
  const addToWatchlist = useStockStore((s) => s.addToWatchlist);
  const removeFromWatchlist = useStockStore((s) => s.removeFromWatchlist);
  const isInWatchlist = useStockStore((s) => s.isInWatchlist);

  const [resp, setResp] = useState<ShortTermResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [scanning, setScanning] = useState(false);

  const meta = STRATEGIES.find((s) => s.id === selected) ?? STRATEGIES[0];

  // 一次拉取三套策略的快照结果，子 tab 切换只做本地过滤（无需重复请求）
  useEffect(() => {
    let cancelled = false;
    const today = beijingToday();
    const cached = readScanCache();
    fetch('/api/short-term-strategies')
      .then((r) => r.json())
      .then((d: ShortTermResponse) => {
        if (cancelled) return;
        // 今天已正式落库 → 用落库结果；今天还没落库 → 用当天手动扫描缓存兜底；否则回退最近落库日
        if (d && d.candidates && d.generated && d.tradeDate === today) {
          setResp(d);
        } else if (cached && beijingDate(cached.savedAt) === today) {
          setResp(cached.data);
        } else if (d && d.candidates) {
          setResp(d);
        } else {
          setResp(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (cached && beijingDate(cached.savedAt) === today) setResp(cached.data);
        else setResp(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addWatch = (tsCode: string, name: string) => {
    addToWatchlist(toStock(tsCode, name));
    toast.success(`已添加 ${name}`);
  };
  const removeWatch = (tsCode: string, name: string) => {
    removeFromWatchlist(toAppCode(tsCode));
    toast.success(`已移除 ${name}`);
  };

  // 手动触发：一次扫描全部六套策略，仅本地展示，不落库（当天正式结果以尾盘自动任务为准）
  const runScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const r = await fetch('/api/short-term-strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persist: false }),
        signal: AbortSignal.timeout(120000),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d?.error ?? '扫描失败');
        return;
      }
      if (d && d.candidates) {
        const finalResp = { ...d, generated: true } as ShortTermResponse;
        setResp(finalResp);
        writeScanCache(d.tradeDate, finalResp);
        toast.success('六套策略扫描完成');
      } else {
        toast.error('扫描结果为空');
      }
    } catch (e) {
      const name = (e as any)?.name;
      toast.error(name === 'TimeoutError' || name === 'AbortError' ? '扫描超时，请稍后重试' : '扫描失败，请稍后重试');
    } finally {
      setScanning(false);
    }
  };

  const market = resp?.market ?? null;
  const candidates = resp?.candidates?.[selected] ?? [];

  const copyCurrentCandidates = async () => {
    if (!candidates.length) return;
    const lines = candidates.map((c) => `${c.name} ${c.tsCode.replace(/\.(SH|SZ|BJ)$/, '')}`);
    const text = lines.join('\n');
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) toast.success(`已复制 ${candidates.length} 只候选到剪贴板`);
    else toast.error('复制失败，请手动复制');
  };

  const coreChips = (c: ShortTermCandidate): Chip[] => {
    const m = c.metrics;
    switch (c.strategy) {
      case 'limit-up-three-yin': {
        const chips: Chip[] = [];
        const yinBodies = arrMetric(m, 'yinBodies');
        if (yinBodies && yinBodies.length === 3) {
          const falling = yinBodies.every((b, i) => i === 0 || (yinBodies[i - 1] ?? 0) > b);
          chips.push({
            label: falling ? '三阴递降' : '三阴形态',
            hint: `三日实体 ${yinBodies.map((b) => b.toFixed(1)).join(' / ')}%`,
          });
        } else {
          chips.push({ label: '三阴形态' });
        }
        return chips;
      }
      case 'dragon-first-yin': {
        const chips: Chip[] = [];
        const boardCount = numMetric(m, 'boardCount');
        const yinType = strMetric(m, 'yinType');
        const quality = strMetric(m, 'quality');
        const volumeRatio = numMetric(m, 'volumeRatio');
        const turnoverRate = numMetric(m, 'turnoverRate');
        const bodyPct = numMetric(m, 'bodyPct');
        if (boardCount != null) chips.push({ label: `${boardCount}连板` });
        if (yinType) chips.push({ label: yinType });
        const d = detailChip([
          quality && QUALITY_LABEL[quality] ? { label: QUALITY_LABEL[quality] } : null,
          volumeRatio != null ? volumeChip(volumeRatio) : null,
          turnoverRate != null ? { label: `换手 ${turnoverRate.toFixed(1)}%` } : null,
          bodyPct != null && bodyPct > BODY_TIGHT
            ? { label: '实体偏大', hint: `实体 ${bodyPct.toFixed(1)}%（形态上限 7%）` }
            : null,
        ]);
        if (d) chips.push(d);
        return chips;
      }
      case 'double-dragon': {
        const chips: Chip[] = [];
        if (m['secondOneWord'] === true) {
          chips.push({ label: '二板一字', tone: 'red', hint: '二板为一字板' });
        }
        const board2VolRatio = numMetric(m, 'board2VolRatio');
        if (board2VolRatio != null && board2VolRatio <= 0.7) {
          chips.push({ label: '二板缩量', tone: 'red', hint: `二板量比 ${board2VolRatio.toFixed(2)}` });
        } else if (board2VolRatio != null && board2VolRatio <= 1) {
          chips.push({ label: '二板温和', hint: `二板量比 ${board2VolRatio.toFixed(2)}` });
        }
        return chips;
      }
      case 'dragon-four-yin': {
        const chips: Chip[] = [];
        const yinBodies = arrMetric(m, 'yinBodies');
        const volRatio = numMetric(m, 'volRatio');
        const nearHighPct = numMetric(m, 'nearHighPct');
        if (yinBodies && yinBodies.length === 4) {
          chips.push({
            label: '四连阴',
            hint: `四阴实体 ${yinBodies.map((b) => b.toFixed(1)).join(' / ')}%`,
          });
        }
        if (nearHighPct != null) {
          chips.push(
            nearHighPct >= 100
              ? { label: '创20日新高', tone: 'red', hint: `涨停日高点达 20 日高点的 ${nearHighPct.toFixed(1)}%` }
              : { label: '逼近新高', hint: `涨停日高点达 20 日高点的 ${nearHighPct.toFixed(1)}%` },
          );
        }
        const d = detailChip([volRatio != null ? volumeChip(volRatio) : null]);
        if (d) chips.push(d);
        return chips;
      }
      case 'xian-ren-zhi-lu': {
        const chips: Chip[] = [];
        const upperShadowPct = numMetric(m, 'upperShadowPct');
        const volRatio = numMetric(m, 'volRatio');
        const gain60 = numMetric(m, 'gain60');
        const confPct = numMetric(m, 'confPct');
        if (confPct != null) chips.push(confChip(confPct));
        const sec = sectorChip(m);
        if (sec) chips.push(sec);
        const d = detailChip([
          upperShadowPct != null ? shadowChip(upperShadowPct) : null,
          gain60 != null ? positionChip(gain60) : null,
          volRatio != null ? volumeChip(volRatio) : null,
        ]);
        if (d) chips.push(d);
        return chips;
      }
      case 'limit-up-board': {
        const chips: Chip[] = [];
        const boardCount = numMetric(m, 'boardCount');
        const turnoverRate = numMetric(m, 'turnoverRate');
        const sealVol = numMetric(m, 'confVolRatio');
        const gap = numMetric(m, 'confOpenGap');
        const openBoard = m['openBoard'] === true;
        if (boardCount != null && boardCount >= 2) {
          chips.push({ label: `${boardCount}连板`, tone: 'red', hint: `含当日连续 ${boardCount} 个封板` });
        } else {
          chips.push({ label: '首板', hint: '当日为第 1 个封板' });
        }
        // 量比是权重最大的排序因子，放在最前
        if (sealVol != null) chips.push(sealVolChip(sealVol));
        chips.push(
          openBoard
            ? { label: '板上开合', hint: '当日曾跌破涨停价，盘中有买入窗口' }
            : { label: '未开板', hint: '当日未跌破涨停价，需排队' },
        );
        const d = detailChip([
          turnoverRate != null ? turnoverChip(turnoverRate) : null,
          gap != null && gap >= 0 ? { label: '高开', hint: `封板日开盘跳空 +${gap.toFixed(1)}%` } : null,
        ]);
        if (d) chips.push(d);
        return chips;
      }
    }
    return [];
  };

  return (
    <div>
      {/* 手动扫描 + 子 tab */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={runScan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed transition"
            title="扫描六套策略，仅本地展示（不落库）"
          >
            {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {scanning ? '扫描中…' : '立即扫描'}
          </button>
        </div>
        <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg w-fit flex-wrap">
          {STRATEGIES.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm transition',
                selected === s.id
                  ? 'bg-white dark:bg-gray-900 shadow-sm font-medium text-gray-900 dark:text-white'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-200',
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {/* 策略说明（默认折叠） */}
      <div className="mb-4">
        <button onClick={() => setShowRules(!showRules)} className="flex items-center gap-1 text-xs text-purple-600">
          <Info className="w-3.5 h-3.5" /> 策略说明
          {showRules ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showRules && (
          <div className="mt-2 rounded-xl bg-purple-50/60 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900 p-3 text-xs text-gray-600 dark:text-gray-400 space-y-2">
            <p className="whitespace-pre-line leading-relaxed">{meta.description}</p>
            <p className="whitespace-pre-line leading-relaxed opacity-90">{meta.rulesText}</p>
          </div>
        )}
      </div>

      {/* 运行概况 */}
      {resp && (
        <Card className="p-3 mb-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>数据日 {formatDate(resp.tradeDate)}</span>
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{resp.phase === 'closing' ? '尾盘' : '早盘'}</span>
            {market && (
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded',
                  market.mode === 'attack'
                    ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                    : market.mode === 'defense'
                      ? 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400'
                      : 'bg-gray-100 text-gray-600',
                )}
              >
                {REGIME_LABEL[market.mode]}
              </span>
            )}
          </div>
          {(market?.tradable === false || market?.mode === 'defense' || (market?.warnings?.length ?? 0) > 0) && (
            <div className="text-xs text-amber-600 flex items-start gap-1 mt-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                {market?.tradable === false || market?.mode === 'defense'
                  ? '退潮期，形态参考即可'
                  : (market?.warnings ?? []).slice(0, 2).join('；')}
              </span>
            </div>
          )}
        </Card>
      )}

      {/* 候选列表 */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">
          <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin" />
          <p className="text-sm">读取中…</p>
        </div>
      ) : candidates.length > 0 ? (
        <div>
          {candidates.map((c) => {
            const sig = signalLabel(c.signalType);
            const chips = coreChips(c);
            const appCode = toAppCode(c.tsCode);
            return (
              <Card key={c.tsCode} className="p-3 mb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button
                      onClick={() => router.push(`/stock/${appCode}`)}
                      className="font-medium text-blue-600 hover:underline text-left"
                    >
                      {c.name}
                    </button>
                    <div className="text-gray-400 text-xs mt-0.5">
                      {c.tsCode.replace(/\.(SH|SZ|BJ)$/, '')} · 形态触发 {c.matchedDate}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.strategy === 'xian-ren-zhi-lu' ? (
                      <span
                        className={cn(
                          'px-1.5 py-0.5 rounded text-xs font-medium',
                          // 阈值随 2026-09-10 口径切换同步重标定：新分 = 原始分/180 线性归一到 0-100
                          // （180 ≈ 历史 p96）。70 ≈ 前 12%、50 ≈ 中位——按此设置后「红/琥珀/灰」
                          // 占比 ≈12/40/48%，与旧刻度（13.0/40.5/46.5%）一致。改动锚点须同步改这两个数。
                          c.score >= 70
                            ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                            : c.score >= 50
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                              : 'bg-gray-100 text-gray-600',
                        )}
                      >
                        {c.score}
                      </span>
                    ) : c.strategy === 'double-dragon' || c.strategy === 'dragon-first-yin' ? (
                      <span
                        className={cn(
                          'px-1.5 py-0.5 rounded text-xs',
                          c.priority === 'high'
                            ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                            : c.priority === 'medium'
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                              : 'bg-gray-100 text-gray-600',
                        )}
                      >
                        {PRIORITY_LABEL[c.priority]}
                      </span>
                    ) : null}
                    {isInWatchlist(appCode) ? (
                      <button
                        onClick={() => removeWatch(c.tsCode, c.name)}
                        className="inline-flex p-1.5 text-gray-400 hover:text-red-500 rounded-[var(--radius-md)] transition"
                        title="移除自选"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => addWatch(c.tsCode, c.name)}
                        className="inline-flex p-1.5 bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 rounded-[var(--radius-md)] hover:opacity-80 transition"
                        title="加自选"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 text-sm text-gray-700 dark:text-gray-300">{hitLine(c.strategy)}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {sig && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-300">
                      {sig}
                    </span>
                  )}
                  {chips.map((ch, i) => (
                    <span
                      key={`${ch.label}-${i}`}
                      title={ch.hint}
                      className={cn(
                        'px-1.5 py-0.5 rounded text-xs',
                        ch.detail
                          ? 'bg-gray-50 text-gray-400 dark:bg-gray-900 dark:text-gray-500'
                          : ch.tone === 'red'
                            ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
                      )}
                    >
                      {ch.label}
                    </span>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      ) : resp && resp.generated ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">今日无标的命中</p>
          <p className="text-sm mt-2">形态未触发</p>
        </div>
      ) : (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">筛选尚未生成</p>
          <p className="text-sm mt-2">尾盘自动生成（约 14:55），稍后查看</p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="mt-4 flex flex-col items-end gap-1">
          <button
            onClick={copyCurrentCandidates}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition"
          >
            <Copy className="w-4 h-4" />
            一键复制本组候选 ({candidates.length})
          </button>
          <span className="text-xs text-gray-400">复制内容为「名称 代码」，可粘贴到自选文本识别</span>
        </div>
      )}
    </div>
  );
}
