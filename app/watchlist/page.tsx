'use client';

import { useEffect, useState, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { useUiStore } from '@/store/ui-store';
import { getRealtimeQuote, getKLineSina, parseStockCode, searchStocks } from '@/services/stockApi';
import { isETF, validateStockCode, extractStockCodes, detectMarket } from '@/lib/identify';
import { computeMaCross, type MaCrossState } from '@/lib/stock-helpers';
import { RealtimeQuote } from '@/types';
import { formatPrice, formatChange, cn } from '@/lib/utils';
import { Plus, Search, Trash2, TrendingUp, ScanLine, Upload, Camera, X, Check, FolderInput, Menu } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { GroupBar, ALL_GROUP_ID } from '@/components/GroupBar';
import { GroupManageModal } from '@/components/GroupManageModal';
import { MoveToGroupMenu } from '@/components/MoveToGroupMenu';

/** 全量股票名录缓存（名称识别用，与搜索共用 /stocks.json 静态名录） */
let stockDictCache: { name: string; code: string }[] | null = null;
const loadStockDict = async (): Promise<{ name: string; code: string }[]> => {
  if (stockDictCache) return stockDictCache;
  try {
    const res = await fetch('/stocks.json');
    if (res.ok) {
      const list: { c: string; n: string }[] = await res.json();
      stockDictCache = list.map((s) => ({ name: s.n, code: s.c }));
    }
  } catch { /* 名录加载失败 → 名称识别降级为空 */ }
  return stockDictCache ?? [];
};

/** 从自由文本提取股票名称：字典匹配，长名优先（避免短名吞掉长名，如"平安" vs "平安银行"） */
function extractStockNames(text: string, dict: { name: string; code: string }[]): { name: string; code: string }[] {
  let remaining = text;
  const out: { name: string; code: string }[] = [];
  for (const s of [...dict].sort((a, b) => b.name.length - a.name.length)) {
    if (remaining.includes(s.name)) {
      out.push({ name: s.name, code: s.code });
      remaining = remaining.split(s.name).join(' '); // 移除已命中，避免子串重复
    }
  }
  return out;
}

export default function WatchlistPage() {
  const router = useRouter();
  const { watchlist, groups, addToWatchlist, removeFromWatchlist, isInWatchlist, addGroup, removeStocks, moveStocksToGroup, reorderStocks } = useStockStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RealtimeQuote[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [stockQuotes, setStockQuotes] = useState<Map<string, RealtimeQuote>>(new Map());
  // MA5/13 交叉状态徽标（金叉/死叉/即将金叉），随行情刷新一起算
  const [crossMap, setCrossMap] = useState<Map<string, MaCrossState>>(new Map());
  // RPS60 徽标（DB rps_scores，随行情刷新一起批量拉）
  const [rpsMap, setRpsMap] = useState<Record<string, { rps60: number | null; calcDate: string }>>({});
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const ocrFileRef = useRef<HTMLInputElement>(null);

  // 分组状态（位置存 ui-store：钻详情返回后仍在原分组）
  const selectedGroupId = useUiStore(s => s.watchlistGroupId);
  const setSelectedGroupId = useUiStore(s => s.setWatchlistGroupId);
  const [showGroupManage, setShowGroupManage] = useState(false);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);

  // 多选删除状态
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  // 多选移动分组弹窗
  const [showBatchMove, setShowBatchMove] = useState(false);
  // 长按进入多选：fired 用于吞掉长按松手后的那次 click（防刚进入就被反选/跳转）
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const startLongPress = (code: string) => {
    if (multiSelect) return;
    cancelLongPress();
    longPressRef.current.timer = setTimeout(() => {
      longPressRef.current.fired = true;
      setMultiSelect(true);
      setSelectedCodes(new Set([code]));
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressRef.current.timer) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  };

  // 拖动排序（多选模式内，手柄触发）：拖动中只动本地 dragOrder，松手一次性提交 store。
  // 事件挂 window + rAF 每帧驱动：不依赖 pointer capture 的 React 事件重定向（iOS 上拖动中 DOM 重排
  // 会掐断 capture 事件流，曾表现为拖到一半卡死）；插入位按行中线判定，不用 elementFromPoint
  // （指针落进行间隙或覆盖层时它返回容器，丢目标）。
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [dragInfo, setDragInfo] = useState<{ code: string; offsetY: number } | null>(null);
  const dragRef = useRef<{ code: string; startY: number; startScroll: number; lastOffset: number } | null>(null);
  // dragOrder 的同步镜像：重排判定须以 ref 为准（state 可能还是上一帧的）
  const dragOrderRef = useRef<string[] | null>(null);
  const dragPosRef = useRef(0); // 最近一次指针 clientY，rAF 每帧读
  const dragCleanupRef = useRef<(() => void) | null>(null);

  /** 按指针位置重排 + 更新被拖卡片位移（pointermove 与 rAF 共用） */
  const applyDrag = (clientY: number) => {
    const d = dragRef.current;
    const order = dragOrderRef.current;
    if (!d || !order) return;
    const from = order.indexOf(d.code);
    // 插入位 = 首张「中线在指针下方」的卡片的槽位（换算成移除被拖卡后的下标；都没越线=排末尾）
    let to = order.length - 1;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === d.code) continue;
      const r = document.querySelector(`[data-stock-code="${order[i]}"]`)?.getBoundingClientRect();
      if (r && clientY < r.top + r.height / 2) { to = i > from ? i - 1 : i; break; }
    }
    if (from >= 0 && to !== from) {
      // 换位后被拖卡片的布局位置平移了，须同步平移 startY 抵消，否则 translateY 与布局位移叠加跳行。
      // 补偿量 = 被跨过卡片的真实高度之和（卡片高度不一：徽章换行/"加载中"单行等），
      // 用被拖卡片自身高度×行数会累积误差 → 视觉位置与指针错开 → 两格间来回换锁死。
      const GAP = 8; // space-y-2
      const step = to > from ? 1 : -1;
      let shift = 0;
      for (let i = from + step; step > 0 ? i <= to : i >= to; i += step) {
        shift += step * (GAP + (document.querySelector(`[data-stock-code="${order[i]}"]`)?.getBoundingClientRect().height ?? 0));
      }
      d.startY += shift;
      const next = [...order];
      next.splice(from, 1);
      next.splice(to, 0, d.code);
      dragOrderRef.current = next;
      setDragOrder(next);
    }
    // 页面滚动也要计入位移（边缘自动滚动时指针不动但内容在动）
    const offsetY = (clientY - d.startY) + (window.scrollY - d.startScroll);
    if (offsetY !== d.lastOffset) {
      d.lastOffset = offsetY;
      setDragInfo({ code: d.code, offsetY });
    }
  };

  const handleGripDown = (e: ReactPointerEvent<HTMLButtonElement>, code: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragCleanupRef.current?.(); // 上次未正常收尾（极端情况）先清掉
    // 保留 pointer capture：松手在窗口外也能收到 pointerup；move/up 走 window 监听双保险
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 指针已失效时忽略 */ }
    dragRef.current = { code, startY: e.clientY, startScroll: window.scrollY, lastOffset: 0 };
    dragPosRef.current = e.clientY;
    dragOrderRef.current = visibleWatchlist.map(s => s.code);
    setDragOrder(dragOrderRef.current);
    setDragInfo({ code, offsetY: 0 });

    let raf = 0;
    const tick = () => {
      if (!dragRef.current) return;
      // 指针贴近视口上下沿时自动滚动页面，长列表才能拖出屏幕外
      const y = dragPosRef.current;
      const EDGE = 72;
      if (y < EDGE) window.scrollBy(0, -(EDGE - y) / 6);
      else if (y > window.innerHeight - EDGE) window.scrollBy(0, (y - (window.innerHeight - EDGE)) / 6);
      applyDrag(y);
      raf = requestAnimationFrame(tick);
    };
    const onMove = (ev: PointerEvent) => { dragPosRef.current = ev.clientY; };
    const onUp = () => {
      cleanup();
      if (dragOrderRef.current) {
        reorderStocks(dragOrderRef.current, selectedGroupId === ALL_GROUP_ID ? undefined : selectedGroupId);
      }
      dragRef.current = null;
      dragOrderRef.current = null;
      setDragOrder(null);
      setDragInfo(null);
    };
    const cleanup = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    dragCleanupRef.current = cleanup;
    raf = requestAnimationFrame(tick);
  };

  // 卸载兜底：清掉 window 监听与 rAF
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // OCR 状态（支持多张截图：持仓超一屏时连选，逐张识别结果合并）
  const [showOcr, setShowOcr] = useState(false);
  const [ocrImages, setOcrImages] = useState<string[]>([]);
  const [ocrImageFiles, setOcrImageFiles] = useState<File[]>([]);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrResults, setOcrResults] = useState<{ code: string; name: string; added: boolean }[]>([]);
  // 文本提取（与截图识别同一管线）
  const [ocrText, setOcrText] = useState('');

  // 图像预处理（08-12）：canvas 缩放 + 深色模式反色。
  // tesseract 在字符高度 ~30px 以上才准（手机截图字太小要放大），且对白字黑底的深色截图识别率暴跌。
  const preprocessImage = async (file: File): Promise<Blob> => {
    const bitmap = await createImageBitmap(file);
    // 3x 放大窄图（手机截图代码列 ~11px → 33px，跨过 tesseract ~30px 精度线），宽图也补到 ≥2400px
    const scale = bitmap.width < 1200 ? 3 : Math.max(1, 2400 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // 深色模式反色：抽样平均亮度偏暗 → 全图反色
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 400) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
    if (sum / n / 3 < 128) {
      for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    }

    // 灰度 + OTSU 二值化：把浅灰小字（同花顺代码列常见 #999）拉黑、白底拉白，
    // 否则 tesseract 内部二值化会把浅灰代码当背景丢掉（08-14 实测代码列整列读不出）
    const gray = (i: number) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    const hist = new Uint32Array(256);
    const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) hist[gray(i) | 0]++;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t];
    let sumB = 0, wB = 0, thr = 128, maxVar = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const between = wB * wF * ((sumB / wB) - ((sumAll - sumB) / wF)) ** 2;
      if (between > maxVar) { maxVar = between; thr = t; }
    }
    for (let i = 0; i < d.length; i += 4) {
      const g = gray(i) < thr ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(imgData, 0, 0);

    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图像预处理失败'))), 'image/png'));
  };

  // 提取出的代码 → 本地名录批量校验查名（不打实时行情：外部源限流/抖动曾致整批误判"无有效标的"），
  // 名录未命中的（新上市/名录周更未覆盖）回落实时行情查名，仍失败才丢弃
  const resolveStockCodes = async (extractedCodes: string[]): Promise<{ code: string; name: string; added: boolean }[]> => {
    let validResults: { code: string; name: string; added: boolean }[] = [];
    try {
      const vr = await fetch('/api/stock/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: extractedCodes.slice(0, 50) }),
      });
      const vdata = vr.ok ? await vr.json() : { items: [] };
      validResults = (vdata.items ?? []).map((it: { code: string; name: string }) => ({
        ...it,
        added: isInWatchlist(it.code),
      }));
    } catch { /* 名录服务异常 → 走行情兜底 */ }

    const hitCodes = new Set(validResults.map((r) => r.code));
    const missCodes = [...new Set(
      extractedCodes.slice(0, 50)
        .map((c) => validateStockCode(c))
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .map((v) => `${v.market}${v.pureCode}`)
    )].filter((fc) => !hitCodes.has(fc));
    if (missCodes.length > 0) {
      const fallback = await Promise.all(
        missCodes.map(async (fc) => {
          const quote = await getRealtimeQuote(fc);
          return quote?.name ? { code: fc, name: quote.name, added: isInWatchlist(fc) } : null;
        })
      );
      validResults = [...validResults, ...fallback.filter((r): r is NonNullable<typeof r> => r !== null)];
    }
    return validResults;
  };

  // 提取 → 校验 → 写结果（截图 OCR 与文本粘贴共用）
  const finishExtract = async (extractedCodes: string[], emptyMsg: string) => {
    if (extractedCodes.length === 0) {
      setOcrStatus(emptyMsg);
      return;
    }
    setOcrStatus(`识别到 ${extractedCodes.length} 个代码，正在验证...`);
    const validResults = await resolveStockCodes(extractedCodes);
    if (validResults.length > 0) {
      setOcrResults(validResults);
      setOcrStatus(`识别到 ${validResults.length} 只标的`);
    } else {
      setOcrStatus(`识别到 ${extractedCodes.length} 个代码，但均不在标的名录中`);
    }
  };

  // 粘贴文本提取：代码 + 名称两条路合并（名称走本地名录字典，不依赖后端/行情）
  const handleTextExtract = async () => {
    const t = ocrText.trim();
    if (!t) { toast.error('请先粘贴文本'); return; }
    setIsOcrProcessing(true);
    setOcrResults([]);
    try {
      const codes = extractStockCodes(t);
      const nameHits = extractStockNames(t, await loadStockDict());

      const codeResults = codes.length > 0 ? await resolveStockCodes(codes) : [];
      const seen = new Set(codeResults.map((r) => r.code));
      const merged = [...codeResults];
      for (const { name, code } of nameHits) {
        const full = `${detectMarket(code) ?? 'sh'}${code}`;
        if (seen.has(full)) continue;
        seen.add(full);
        merged.push({ code: full, name, added: isInWatchlist(full) });
      }

      if (merged.length > 0) {
        setOcrResults(merged);
        setOcrStatus(`识别到 ${merged.length} 只标的`);
      } else {
        setOcrStatus('未从文本中提取到标的（代码或名称）');
      }
    } finally {
      setIsOcrProcessing(false);
    }
  };

  // OCR 识别（多张顺序跑，worker 复用）
  const handleOcrScan = async () => {
    if (ocrImageFiles.length === 0) { toast.error('请先选择图片'); return; }
    setIsOcrProcessing(true);
    setOcrStatus('正在准备识别引擎...');
    setOcrResults([]);

    try {
      const Tesseract = (await import('tesseract.js')).default;
      // 只识别 6 位数字代码，用 eng 引擎（语言包 ~3MB，chi_sim ~30MB）——加载更快、数字更准；
      // 名称不靠 OCR，后续用标的名录按代码查名。
      // 引擎/语言包全部自托管在 public/（08-12：默认走 jsdelivr CDN，国内时有不稳会卡死"正在识别"）
      const total = ocrImageFiles.length;
      let currentIdx = 0;
      const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        workerPath: '/tesseract/worker.min.js',
        corePath: '/tesseract',
        langPath: '/tessdata',
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') {
            setOcrStatus(`正在识别第 ${currentIdx + 1}/${total} 张… ${Math.round(m.progress * 100)}%`);
          }
        },
      });
      // 表格截图按"整块文本"理解，减少名称列与代码列黏连（AUTO 版面分析反而漏掉代码列，08-14 实测回退）
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });

      const texts: string[] = [];
      for (; currentIdx < total; currentIdx++) {
        const blob = await preprocessImage(ocrImageFiles[currentIdx]);
        const { data } = await worker.recognize(blob);
        texts.push(data.text);
      }
      await worker.terminate();
      console.log('[ocr] 原始识别文本:', texts.join('\n----\n')); // 识别漏代码时排查用

      await finishExtract(extractStockCodes(texts.join('\n')), '未识别到标的代码，请确认截图清晰');
    } catch (e: any) {
      setOcrStatus('OCR引擎加载失败，请重试');
    } finally {
      setIsOcrProcessing(false);
    }
  };

  const handleOcrAdd = (code: string, name: string) => {
    const parsed = parseStockCode(code);
    addToWatchlist({ code, name, market: parsed.market, pureCode: parsed.pureCode }, currentGroupId);
    setOcrResults(prev => prev.map(r => r.code === code ? { ...r, added: true } : r));
    toast.success(`已添加 ${name}`);
  };

  // 一键加自选：识别结果中未添加的全部加入指定分组（弹层选择，可临时新建）
  const [ocrAddMenu, setOcrAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [ocrNewGroup, setOcrNewGroup] = useState('');
  const handleOcrAddAll = (groupId?: string) => {
    const pending = ocrResults.filter(r => !r.added);
    for (const r of pending) {
      const parsed = parseStockCode(r.code);
      addToWatchlist({ code: r.code, name: r.name, market: parsed.market, pureCode: parsed.pureCode }, groupId);
    }
    setOcrResults(prev => prev.map(r => ({ ...r, added: true })));
    const gName = groupId ? groups.find(g => g.id === groupId)?.name ?? '' : '未分组';
    toast.success(`已添加 ${pending.length} 只到「${gName}」`);
    setOcrAddMenu(null);
  };
  // 临时新建分组并全部加入
  const createGroupAndAddAll = () => {
    const name = ocrNewGroup.trim();
    if (!name) return;
    if (!addGroup(name)) { toast.error('分组已存在'); return; }
    const g = useStockStore.getState().groups.find(g => g.name === name);
    setOcrNewGroup('');
    handleOcrAddAll(g?.id);
  };

  // 刷新自选股行情（并发拉取，替代原串行循环）；顺带算 MA5/13 交叉徽标（日K+实时价）
  const refreshQuotes = async () => {
    const results = await Promise.all(
      watchlist.map(async stock => {
        const quote = await getRealtimeQuote(stock.code);
        return quote ? ([stock.code, quote] as const) : null;
      })
    );
    const quotes = new Map<string, RealtimeQuote>();
    for (const r of results) if (r) quotes.set(r[0], r[1]);
    setStockQuotes(quotes);

    // 批量拉 RPS60（DB 数据，一次请求全自选）
    if (watchlist.length > 0) {
      try {
        const res = await fetch(`/api/rps/batch?codes=${encodeURIComponent(watchlist.map(s => s.code).join(','))}`);
        if (res.ok) {
          const data = await res.json();
          setRpsMap(data.rps ?? {});
        }
      } catch { /* RPS 失败不影响行情展示 */ }
    } else {
      setRpsMap({});
    }

    const crossResults = await Promise.all(
      watchlist.map(async stock => {
        const quote = quotes.get(stock.code);
        if (!quote) return null;
        try {
          const kLines = await getKLineSina(stock.code, 240, 20);
          const state = computeMaCross([...kLines.map(k => k.close), quote.price]);
          return state ? ([stock.code, state] as const) : null;
        } catch {
          return null;
        }
      })
    );
    const cm = new Map<string, MaCrossState>();
    for (const r of crossResults) if (r) cm.set(r[0], r[1]);
    setCrossMap(cm);
  };

  // 只在标的「增删」时重拉行情；position 占比、groupId 分组归属、排序变化不触发
  // （排序后与排序前代码集合相同，故 key 排序后拼接，与顺序解耦）
  const watchlistCodesKey = watchlist.map(s => s.code).sort().join(',');
  useEffect(() => {
    refreshQuotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlistCodesKey]);

  // 分组派生：切换组只过滤展示，不重拉行情（多组映射：组内标的 = group.stockCodes，顺序即组内排序）
  const activeGroupName = selectedGroupId === ALL_GROUP_ID
    ? '全部'
    : groups.find(g => g.id === selectedGroupId)?.name ?? '全部';
  const selectedGroupCodes = selectedGroupId === ALL_GROUP_ID
    ? null
    : groups.find(g => g.id === selectedGroupId)?.stockCodes;
  const visibleWatchlist = selectedGroupId === ALL_GROUP_ID
    ? watchlist
    : (selectedGroupCodes ?? [])
        .map(c => watchlist.find(s => s.code === c))
        .filter((s): s is NonNullable<typeof s> => !!s);

  // 选中组被删除时自动回退「全部」；切组时退出多选态
  useEffect(() => {
    if (selectedGroupId !== ALL_GROUP_ID && !groups.some(g => g.id === selectedGroupId)) {
      setSelectedGroupId(ALL_GROUP_ID);
    }
  }, [groups, selectedGroupId]);
  useEffect(() => {
    setSelectedCodes(new Set());
    setMultiSelect(false);
  }, [selectedGroupId]);

  // 多选删除
  const toggleSelect = (code: string) => {
    setSelectedCodes(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };
  const exitMultiSelect = () => {
    setMultiSelect(false);
    setSelectedCodes(new Set());
    dragCleanupRef.current?.();
    dragRef.current = null;
    dragOrderRef.current = null;
    setDragOrder(null);
    setDragInfo(null);
  };
  const handleBatchDelete = () => {
    if (selectedCodes.size === 0) return;
    removeStocks([...selectedCodes]);
    toast.success(`已删除 ${selectedCodes.size} 只标的`);
    exitMultiSelect();
  };

  // 全选/全不选（只作用于当前组可见列表）
  const allVisibleSelected = visibleWatchlist.length > 0 && visibleWatchlist.every(s => selectedCodes.has(s.code));
  const toggleSelectAll = () => {
    setSelectedCodes(allVisibleSelected ? new Set() : new Set(visibleWatchlist.map(s => s.code)));
  };

  // 多选移动分组：加入目标组，并从当前浏览组移出（「全部」下无移出来源，即纯加入）
  const handleBatchMove = (targetId: string | null) => {
    if (selectedCodes.size === 0) return;
    const fromId = selectedGroupId === ALL_GROUP_ID ? undefined : selectedGroupId;
    moveStocksToGroup([...selectedCodes], targetId, fromId);
    const targetName = targetId ? groups.find(g => g.id === targetId)?.name ?? '' : '未分组';
    toast.success(`已移动 ${selectedCodes.size} 只到「${targetName}」`);
    setShowBatchMove(false);
    exitMultiSelect();
  };

  // 页内添加(搜索/OCR)归当前选中组；「全部」时不归组（未分组）
  const currentGroupId = selectedGroupId === ALL_GROUP_ID ? undefined : selectedGroupId;

  // 输入即搜（防抖400ms + 竞态防护）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }

    setIsSearching(true);
    let cancelled = false;
    debounceRef.current = setTimeout(async () => {
      const results = await searchStocks(searchQuery);
      if (!cancelled) {
        setSearchResults(results);
        setIsSearching(false);
        setHasSearched(true);
      }
    }, 400);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  // 添加到自选
  const handleAddStock = (quote: RealtimeQuote) => {
    const { market, pureCode } = parseStockCode(quote.code);
    addToWatchlist({
      code: quote.code,
      name: quote.name,
      market,
      pureCode,
    }, currentGroupId);
    setSearchQuery('');
    setSearchResults([]);
    setHasSearched(false);
  };

  return (
    <div>
      {/* 搜索框 */}
      <Card className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="输入标的代码或名称搜索"
            className="pl-10 pr-12 py-3"
          />
          {isSearching ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">搜索中...</span>
          ) : (
            <button
              onClick={() => setShowOcr(!showOcr)}
              title="识别持仓截图"
              className={cn(
                'absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition',
                showOcr
                  ? 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'text-gray-400 hover:text-[var(--color-accent)] hover:bg-gray-100 dark:hover:bg-gray-800'
              )}
            >
              <ScanLine className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 持仓识别（搜索框内图标展开） */}
        {showOcr && (
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
            <input
              ref={ocrFileRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (files.length === 0) return;
                // 追加模式：持仓超一屏的截图可分次选入，一次性识别合并
                setOcrImageFiles(prev => [...prev, ...files]);
                for (const f of files) {
                  const reader = new FileReader();
                  reader.onload = () => setOcrImages(prev => [...prev, reader.result as string]);
                  reader.readAsDataURL(f);
                }
                setOcrResults([]);
                setOcrStatus(null);
                e.target.value = ''; // 允许重复选同一文件
              }}
              className="hidden"
            />

            {ocrImages.length > 0 ? (
              <div>
                <div className="flex gap-2 overflow-x-auto mb-3 pb-1">
                  {ocrImages.map((src, i) => (
                    <div key={i} className="relative shrink-0">
                      <img src={src} alt={`截图${i + 1}`} className="h-36 w-auto object-contain bg-gray-100 dark:bg-gray-800 rounded-lg" />
                      <button
                        onClick={() => { setOcrImages(prev => prev.filter((_, j) => j !== i)); setOcrImageFiles(prev => prev.filter((_, j) => j !== i)); }}
                        className="absolute top-1 right-1 p-0.5 bg-white/80 rounded-full hover:bg-white transition"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => ocrFileRef.current?.click()} className="flex-1 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
                    再加一张
                  </button>
                  <Button
                      onClick={handleOcrScan}
                      loading={isOcrProcessing}
                      className="flex-1"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {isOcrProcessing ? '识别中...' : `开始识别（${ocrImages.length} 张）`}
                    </Button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => ocrFileRef.current?.click()}
                className="w-full h-32 flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-[var(--radius-lg)] hover:border-[var(--color-accent)] transition mt-2"
              >
                <Camera className="w-8 h-8 text-gray-300 mb-1" />
                <p className="text-sm text-gray-500">点击上传持仓截图（可多选）</p>
              </button>
            )}

            {/* 文本提取（与截图识别同一管线，免引擎秒出） */}
            <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
              <textarea
                value={ocrText}
                onChange={(e) => setOcrText(e.target.value)}
                rows={3}
                placeholder="或直接粘贴持仓/关注列表文本，提取其中的代码或名称"
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-[var(--radius-md)] bg-white dark:bg-gray-900 resize-none focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />
              <Button
                onClick={handleTextExtract}
                loading={isOcrProcessing}
                disabled={!ocrText.trim()}
                className="w-full mt-2"
              >
                提取文本中的标的
              </Button>
            </div>

            {ocrStatus && (
              <div className={cn(
                'mt-3 p-2 rounded-[var(--radius-md)] text-sm',
                ocrStatus.includes('失败') || ocrStatus.includes('未识别')
                  ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
                  : ocrStatus.includes('识别到')
                    ? 'bg-[var(--color-down-soft)] text-[var(--color-down)]'
                    : 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              )}>
                {ocrStatus}
              </div>
            )}

            {ocrResults.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">已识别 {ocrResults.length} 只</span>
                  {ocrResults.some(r => !r.added) && (
                    <Button
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        setOcrAddMenu(m => (m ? null : { x: r.right, y: r.bottom }));
                      }}
                      size="sm"
                    >
                      全部加入自选
                    </Button>
                  )}
                </div>
                {ocrResults.map(r => (
                  <div key={r.code} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <div>
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs text-gray-500 ml-2">{r.code}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        onClick={() => handleOcrAdd(r.code, r.name)}
                        variant={r.added ? "secondary" : "primary"}
                        size="sm"
                        disabled={r.added}
                      >
                        {r.added ? '已添加' : '加入自选'}
                      </Button>
                      {/* 误识别行剔除（归一化副本可能造出查名能查到的幻影代码） */}
                      <button
                        onClick={() => setOcrResults(prev => prev.filter(x => x.code !== r.code))}
                        className="p-1.5 text-gray-400 hover:text-red-500 rounded transition"
                        title="移除"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 全部加入自选：分组选择弹层（fixed 定位，锚在按钮下方） */}
            {ocrAddMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setOcrAddMenu(null)} />
                <div
                  className="fixed z-50 w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-1.5 text-sm"
                  style={{ left: Math.max(8, ocrAddMenu.x - 192), top: ocrAddMenu.y + 4 }}
                >
                  <div className="px-2 py-1 text-xs text-gray-400">全部添加到分组</div>
                  <button onClick={() => handleOcrAddAll(undefined)} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition">
                    未分组
                  </button>
                  {groups.map(g => (
                    <button key={g.id} onClick={() => handleOcrAddAll(g.id)} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition">
                      {g.name}
                    </button>
                  ))}
                  <div className="mt-1 pt-1.5 border-t border-gray-100 dark:border-gray-800 flex gap-1">
                    <input
                      value={ocrNewGroup}
                      onChange={e => setOcrNewGroup(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && createGroupAndAddAll()}
                      placeholder="新建分组"
                      className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-200 dark:border-gray-700 rounded bg-transparent"
                    />
                    <button onClick={createGroupAndAddAll} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition">
                      确定
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* 搜索结果 */}
        {(searchResults.length > 0 || isSearching || hasSearched) && (
          <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3 space-y-1">
            {isSearching ? (
              <div className="p-3 text-center text-sm text-gray-400">正在搜索...</div>
            ) : hasSearched && searchResults.length === 0 ? (
              <div className="p-3 text-center text-sm text-gray-400">未找到相关标的</div>
            ) : (
              searchResults.map((quote) => (
                <div key={quote.code} className="flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition">
                  <div>
                    <span className="font-medium text-sm">{quote.name}</span>
                    <span className="text-xs text-gray-500 ml-2">{quote.code}</span>
                  </div>
                  {isInWatchlist(quote.code) ? (
                    <span className="p-1.5 text-[var(--color-down)]" title="已在自选中">
                      <Check className="w-4 h-4" />
                    </span>
                  ) : (
                    <button
                      onClick={() => handleAddStock(quote)}
                      className="p-1.5 bg-[var(--color-accent-soft)] text-[var(--color-accent)] rounded-[var(--radius-md)] hover:opacity-80 transition"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </Card>

      {/* 分组栏 */}
      <GroupBar
        selectedId={selectedGroupId}
        onSelect={setSelectedGroupId}
        onManage={() => setShowGroupManage(true)}
      />

      {/* 自选列表 */}
      {watchlist.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Plus className="w-16 h-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">暂无自选标的</p>
          <p className="text-sm mt-2">在上方搜索框输入标的代码添加</p>
        </div>
      ) : visibleWatchlist.length === 0 ? (
        <Card className="text-center py-16 text-gray-400">
          <FolderInput className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-base">「{activeGroupName}」暂无自选</p>
          <p className="text-sm mt-2">可搜索添加</p>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500">{activeGroupName} · {visibleWatchlist.length} 只</span>
            <div className="flex items-center gap-3">
              {multiSelect ? (
                <>
                  <button onClick={toggleSelectAll} className="text-sm text-[var(--color-accent)] hover:opacity-80">
                    {allVisibleSelected ? '全不选' : '全选'}
                  </button>
                  <button onClick={exitMultiSelect} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    完成
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={refreshQuotes}
                    className="text-sm text-[var(--color-accent)] hover:opacity-80 flex items-center gap-1"
                  >
                    <TrendingUp className="w-4 h-4" />
                    刷新行情
                  </button>
                  <button onClick={() => setMultiSelect(true)} className="text-sm text-[var(--color-accent)] hover:opacity-80">
                    多选
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {(dragOrder
              ? dragOrder.map(c => visibleWatchlist.find(s => s.code === c)).filter((s): s is NonNullable<typeof s> => !!s)
              : visibleWatchlist
            ).map((stock) => {
              const quote = stockQuotes.get(stock.code);
              const cross = crossMap.get(stock.code);
              const rps60 = rpsMap[stock.code]?.rps60 ?? null;
              const isDragging = dragInfo?.code === stock.code;
              return (
                <Card
                  key={stock.code}
                  clickable
                  data-stock-code={stock.code}
                  onClick={() => {
                    // 长按刚触发多选时，松手伴随的 click 吞掉（否则会立刻反选掉长按选中的那只）
                    if (longPressRef.current.fired) { longPressRef.current.fired = false; return; }
                    if (multiSelect) toggleSelect(stock.code); else router.push(`/stock/${stock.code}`);
                  }}
                  onTouchStart={() => startLongPress(stock.code)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn('select-none', isDragging && 'relative z-10 shadow-lg opacity-90')}
                  style={isDragging ? { transform: `translateY(${dragInfo.offsetY}px)`, pointerEvents: 'none' } : undefined}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {multiSelect && (
                        <span
                          className={cn(
                            'w-5 h-5 rounded border shrink-0 flex items-center justify-center transition',
                            selectedCodes.has(stock.code)
                              ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                              : 'border-gray-300 dark:border-gray-600'
                          )}
                        >
                          {selectedCodes.has(stock.code) && <Check className="w-3.5 h-3.5 text-white" />}
                        </span>
                      )}
                      <div className="min-w-0">
                      <h3 className="font-semibold">
                        {stock.name}
                        {rps60 != null && (
                          <span
                            title={`RPS60 相对强度 ${Math.round(rps60)}（全市场百分位，${rpsMap[stock.code]?.calcDate ?? ''} 计算）`}
                            className={cn(
                              'inline-block align-middle ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded',
                              rps60 >= 87
                                ? 'bg-[var(--color-up-soft)] text-[var(--color-up)]'
                                : rps60 <= 20
                                  ? 'bg-[var(--color-down-soft)] text-[var(--color-down)]'
                                  : 'bg-[var(--muted)] text-[var(--muted-foreground)]'
                            )}
                          >
                            RPS {Math.round(rps60)}
                          </span>
                        )}
                        {isETF(stock.code) && (
                          <span className="inline-block align-middle ml-1.5 px-1.5 py-0.5 text-[10px] font-bold bg-[var(--color-warning-soft)] text-[var(--color-warning)] rounded">ETF</span>
                        )}
                        {cross && (
                          <span
                            title={cross === 'golden' ? 'MA5 近3日内上穿 MA13' : cross === 'death' ? 'MA5 近3日内下穿 MA13' : 'MA5 逼近 MA13（差距<2%）且上行，可能即将金叉'}
                            className={cn(
                              'inline-block align-middle ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded',
                              cross === 'golden' && 'bg-[var(--color-up-soft)] text-[var(--color-up)]',
                              cross === 'death' && 'bg-[var(--color-down-soft)] text-[var(--color-down)]',
                              cross === 'pending' && 'bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
                            )}
                          >
                            {cross === 'golden' ? '金叉' : cross === 'death' ? '死叉' : '即将金叉'}
                          </span>
                        )}
                      </h3>
                      <p className="text-sm text-gray-500">{stock.code}</p>
                      </div>
                    </div>
                    {quote ? (
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className={cn("font-semibold text-lg", quote.changePercent >= 0 ? "text-[var(--color-up)]" : "text-[var(--color-down)]")}>
                            {formatPrice(quote.price)}
                          </p>
                          <p className={cn("text-sm", quote.changePercent >= 0 ? "text-[var(--color-up)]" : "text-[var(--color-down)]")}>
                            {formatChange(quote.changePercent)}
                          </p>
                        </div>
                        {!multiSelect && (
                          <>
                            <div className="relative">
                              <button
                                onClick={(e) => { e.stopPropagation(); setMoveMenuFor(moveMenuFor === stock.code ? null : stock.code); }}
                                className="p-2 text-gray-400 hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] rounded-[var(--radius-md)] transition"
                                title="分组"
                              >
                                <FolderInput className="w-4 h-4" />
                              </button>
                              {moveMenuFor === stock.code && (
                                <MoveToGroupMenu
                                  code={stock.code}
                                  onClose={() => setMoveMenuFor(null)}
                                  onCreateGroup={() => setShowGroupManage(true)}
                                />
                              )}
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); removeFromWatchlist(stock.code); }}
                              className="p-2 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] rounded-[var(--radius-md)] transition"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="text-gray-400 text-sm">加载中...</div>
                    )}
                    {multiSelect && (
                      <button
                        onPointerDown={(e) => handleGripDown(e, stock.code)}
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        title="按住拖动排序"
                        className="p-2 -mr-2 shrink-0 text-gray-300 dark:text-gray-600 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none"
                      >
                        <Menu className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {quote && !multiSelect && (
                    <div className="mt-2 flex items-center text-sm">
                      {/* 持仓占比输入 */}
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <span className="text-gray-400 text-xs">持仓占比</span>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          block={false}
                          value={stock.positionPercent ?? ''}
                          placeholder="--"
                          onChange={(e) => {
                            const val = e.target.value === '' ? undefined : Math.min(100, Math.max(0, Number(e.target.value)));
                            useStockStore.getState().updateStockPosition(stock.code, val);
                          }}
                          className="w-14 px-2 py-1 text-xs text-center"
                        />
                        <span className="text-gray-400 text-xs">%</span>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* 多选删除操作栏 */}
      {multiSelect && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 rounded-full bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-lg">
          <span className="text-sm whitespace-nowrap">已选 {selectedCodes.size} 只</span>
          {groups.length > 0 && (
            <button
              onClick={() => setShowBatchMove(true)}
              disabled={selectedCodes.size === 0}
              className="px-3.5 py-1 rounded-full bg-[var(--color-accent)] text-white text-sm font-medium disabled:opacity-40"
            >
              移动分组
            </button>
          )}
          <button
            onClick={handleBatchDelete}
            disabled={selectedCodes.size === 0}
            className="px-3.5 py-1 rounded-full bg-[var(--color-danger)] text-white text-sm font-medium disabled:opacity-40"
          >
            删除
          </button>
          <button onClick={exitMultiSelect} className="text-sm opacity-70">取消</button>
        </div>
      )}

      {/* 多选移动分组弹窗：在「全部」下为加入目标组；在具体分组下为移出当前组并加入目标组 */}
      {showBatchMove && (
        <Modal title={`移动 ${selectedCodes.size} 只到分组`} onClose={() => setShowBatchMove(false)} variant="center" maxWidth="sm:max-w-sm">
          <div className="p-4 space-y-1.5 max-h-[60vh] overflow-y-auto">
            {selectedGroupId !== ALL_GROUP_ID && (
              <button
                onClick={() => handleBatchMove(null)}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                未分组<span className="text-xs text-gray-400 ml-1.5">（移出「{activeGroupName}」）</span>
              </button>
            )}
            {groups.filter(g => g.id !== selectedGroupId).map(g => (
              <button
                key={g.id}
                onClick={() => handleBatchMove(g.id)}
                className="w-full text-left px-3 py-2.5 rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                {g.name}
                <span className="text-xs text-gray-400 ml-1.5">{g.stockCodes.length} 只</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {showGroupManage && <GroupManageModal onClose={() => setShowGroupManage(false)} />}
    </div>
  );
}
