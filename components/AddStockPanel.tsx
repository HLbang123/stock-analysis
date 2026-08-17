'use client';

/**
 * 添加自选面板 — 搜索 + 持仓截图识别 + 文本粘贴提取。
 * 从自选页顶部搜索卡整块抽取复用：页顶搜索卡 / 分组底部「添加到本组」弹窗两处使用。
 * targetGroupId 有值时添加即归入该组（OCR「全部加入」直接入组，不再弹分组选择）；
 * undefined（「全部」视角）时添加不归组，「全部加入」弹分组选择。
 */

import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Plus, ScanLine, Search, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useStockStore } from '@/store';
import { getRealtimeQuote, parseStockCode, searchStocks } from '@/services/stockApi';
import { validateStockCode, extractStockCodes, detectMarket } from '@/lib/identify';
import { RealtimeQuote } from '@/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

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

interface Props {
  /** 添加时归入的分组；undefined = 不归组 */
  targetGroupId?: string;
  /** bare = 不带 Card 外壳（嵌在弹窗里用） */
  variant?: 'card' | 'bare';
}

export function AddStockPanel({ targetGroupId, variant = 'card' }: Props) {
  const { groups, addToWatchlist, isInWatchlist, addGroup } = useStockStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RealtimeQuote[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const ocrFileRef = useRef<HTMLInputElement>(null);

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
    addToWatchlist({ code, name, market: parsed.market, pureCode: parsed.pureCode }, targetGroupId);
    setOcrResults(prev => prev.map(r => r.code === code ? { ...r, added: true } : r));
    toast.success(`已添加 ${name}`);
  };

  // 一键加自选：识别结果中未添加的全部加入指定分组（targetGroupId 为空时弹层选择，可临时新建）
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
    }, targetGroupId);
    setSearchQuery('');
    setSearchResults([]);
    setHasSearched(false);
  };

  const content = (
    <>
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
                      // 目标组已确定（组内添加弹窗/组视角页顶）→ 直接入组；否则弹分组选择
                      if (targetGroupId) { handleOcrAddAll(targetGroupId); return; }
                      const r = e.currentTarget.getBoundingClientRect();
                      // 弹层最高 50vh+头尾≈110px，y 钳制在视口内防底部分组够不着
                      const maxY = Math.max(8, window.innerHeight - Math.round(window.innerHeight * 0.5) - 110);
                      setOcrAddMenu(m => (m ? null : { x: r.right, y: Math.min(r.bottom, maxY) }));
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

          {/* 全部加入自选：分组选择弹层（fixed 定位，锚在按钮下方；z 高于 Modal 的 z-[60]，嵌弹窗内也可用） */}
          {ocrAddMenu && (
            <>
              <div className="fixed inset-0 z-[65]" onClick={() => setOcrAddMenu(null)} />
              <div
                className="fixed z-[70] w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-1.5 text-sm"
                style={{ left: Math.max(8, ocrAddMenu.x - 192), top: ocrAddMenu.y + 4 }}
              >
                <div className="px-2 py-1 text-xs text-gray-400">全部添加到分组</div>
                <div className="max-h-[50vh] overflow-y-auto">
                  <button onClick={() => handleOcrAddAll(undefined)} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition">
                    未分组
                  </button>
                  {groups.map(g => (
                    <button key={g.id} onClick={() => handleOcrAddAll(g.id)} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition">
                      {g.name}
                    </button>
                  ))}
                </div>
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
    </>
  );

  if (variant === 'bare') return content;
  return <Card className="mb-6">{content}</Card>;
}
