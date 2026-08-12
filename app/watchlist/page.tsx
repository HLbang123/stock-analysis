'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useStockStore } from '@/store';
import { getRealtimeQuote, getKLineSina, parseStockCode, searchStocks } from '@/services/stockApi';
import { isETF, validateStockCode } from '@/lib/identify';
import { computeMaCross, type MaCrossState } from '@/lib/stock-helpers';
import { RealtimeQuote } from '@/types';
import { formatPrice, formatChange, cn } from '@/lib/utils';
import { Plus, Search, Trash2, TrendingUp, ScanLine, Upload, Camera, X, Check, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { GroupBar, ALL_GROUP_ID } from '@/components/GroupBar';
import { GroupManageModal } from '@/components/GroupManageModal';
import { MoveToGroupMenu } from '@/components/MoveToGroupMenu';

export default function WatchlistPage() {
  const router = useRouter();
  const { watchlist, groups, addToWatchlist, removeFromWatchlist, isInWatchlist, addGroup, removeStocks } = useStockStore();
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

  // 分组状态
  const [selectedGroupId, setSelectedGroupId] = useState<string>(ALL_GROUP_ID);
  const [showGroupManage, setShowGroupManage] = useState(false);
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);

  // 多选删除状态
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());

  // OCR 状态（支持多张截图：持仓超一屏时连选，逐张识别结果合并）
  const [showOcr, setShowOcr] = useState(false);
  const [ocrImages, setOcrImages] = useState<string[]>([]);
  const [ocrImageFiles, setOcrImageFiles] = useState<File[]>([]);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrResults, setOcrResults] = useState<{ code: string; name: string; added: boolean }[]>([]);

  // 图像预处理（08-12）：canvas 缩放 + 深色模式反色。
  // tesseract 在字符高度 ~30px 以上才准（手机截图字太小要放大），且对白字黑底的深色截图识别率暴跌。
  const preprocessImage = async (file: File): Promise<Blob> => {
    const bitmap = await createImageBitmap(file);
    const scale = bitmap.width < 1200 ? 2 : Math.min(1, 2000 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // 抽样平均亮度，偏暗判定为深色模式 → 反色
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 400) { sum += d[i] + d[i + 1] + d[i + 2]; n++; }
    if (sum / n / 3 < 128) {
      for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
      ctx.putImageData(imgData, 0, 0);
    }
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图像预处理失败'))), 'image/png'));
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
      // 名称不靠 OCR，后续用行情接口按代码查名。
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
      // 表格截图按"整块文本"理解，减少名称列与代码列黏连
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });

      const texts: string[] = [];
      for (; currentIdx < total; currentIdx++) {
        const blob = await preprocessImage(ocrImageFiles[currentIdx]);
        const { data } = await worker.recognize(blob);
        texts.push(data.text);
      }
      await worker.terminate();
      console.log('[ocr] 原始识别文本:', texts.join('\n----\n')); // 识别漏代码时排查用

      // OCR 常把同一代码拆进空格/换行（如 "60 0000"）：原始文本与"数字间空白合并"文本各匹配一遍取并集。
      // eng 引擎还会把数字认成字母（0→O、1→l、5→S 等）或把中文认成字母黏在代码上：
      // 再做一份"混淆字母→数字、其余字母→空格"的归一化副本匹配（08-12 修"识别变少"）。
      // 归一化可能造出假 6 位串，交给 validateStockCode（前辍校验）+ 行情查名过滤
      const codeRegex = /(?<!\d)(\d{6})(?!\d)/g;
      const mergeSpaces = (t: string) => t.replace(/(\d)\s+(?=\d)/g, '$1');
      const CONFUSE: Record<string, string> = {
        o: '0', O: '0', Q: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', '!': '1',
        Z: '2', z: '2', A: '4', S: '5', s: '5', G: '6', b: '6', T: '7', B: '8', g: '9', q: '9',
      };
      const extractedCodes = [...new Set(texts.flatMap((t) => {
        const normalized = mergeSpaces(t.replace(/[A-Za-z|!]/g, (ch) => CONFUSE[ch] ?? ' '));
        return [t, mergeSpaces(t), normalized].flatMap((v) => v.match(codeRegex) || []);
      }))];

      if (extractedCodes.length === 0) {
        setOcrStatus('未识别到有效标的代码，请确认截图清晰');
        setIsOcrProcessing(false);
        return;
      }

      setOcrStatus(`识别到 ${extractedCodes.length} 个代码，正在验证...`);
      // 并行验证 + 查名（原串行循环，代码一多就很慢）
      const checked = await Promise.all(
        extractedCodes.slice(0, 50).map(async (codeStr) => {
          const valid = validateStockCode(codeStr);
          if (!valid) return null;
          const fullCode = `${valid.market}${valid.pureCode}`;
          try {
            const quote = await getRealtimeQuote(fullCode);
            if (quote?.name) return { code: fullCode, name: quote.name, added: isInWatchlist(fullCode) };
            return null;
          } catch {
            return { code: fullCode, name: fullCode, added: isInWatchlist(fullCode) };
          }
        })
      );
      const validResults = checked.filter((r): r is NonNullable<typeof r> => r !== null);

      if (validResults.length > 0) {
        setOcrResults(validResults);
        setOcrStatus(`识别到 ${validResults.length} 只标的`);
      } else {
        setOcrStatus('未识别到有效标的代码');
      }
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

  // 只在标的「增删」时重拉行情；position 占比、groupId 分组归属变化不触发
  // （原实现依赖 [watchlist] 引用，导致持仓占比每敲一个数字就重拉全部行情）
  const watchlistCodesKey = watchlist.map(s => s.code).join(',');
  useEffect(() => {
    refreshQuotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlistCodesKey]);

  // 分组派生：切换组只过滤展示，不重拉行情（多组映射：组内标的 = group.stockCodes）
  const activeGroupName = selectedGroupId === ALL_GROUP_ID
    ? '全部'
    : groups.find(g => g.id === selectedGroupId)?.name ?? '全部';
  const selectedGroupCodes = selectedGroupId === ALL_GROUP_ID
    ? null
    : groups.find(g => g.id === selectedGroupId)?.stockCodes;
  const visibleWatchlist = selectedGroupId === ALL_GROUP_ID
    ? watchlist
    : watchlist.filter(s => selectedGroupCodes?.includes(s.code));

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
  };
  const handleBatchDelete = () => {
    if (selectedCodes.size === 0) return;
    removeStocks([...selectedCodes]);
    toast.success(`已删除 ${selectedCodes.size} 只标的`);
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
                <button onClick={exitMultiSelect} className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                  完成
                </button>
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
            {visibleWatchlist.map((stock) => {
              const quote = stockQuotes.get(stock.code);
              const cross = crossMap.get(stock.code);
              const rps60 = rpsMap[stock.code]?.rps60 ?? null;
              return (
                <Card
                  key={stock.code}
                  clickable
                  onClick={() => (multiSelect ? toggleSelect(stock.code) : router.push(`/stock/${stock.code}`))}
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
                        {rps60 != null && (rps60 >= 87 || rps60 <= 20) && (
                          <span
                            title={`RPS60 相对强度 ${Math.round(rps60)}（全市场百分位，${rpsMap[stock.code]?.calcDate ?? ''} 计算）`}
                            className={cn(
                              'inline-block align-middle ml-1.5 px-1.5 py-0.5 text-[10px] font-medium rounded',
                              rps60 >= 87
                                ? 'bg-[var(--color-up-soft)] text-[var(--color-up)]'
                                : 'bg-[var(--color-down-soft)] text-[var(--color-down)]'
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

      {showGroupManage && <GroupManageModal onClose={() => setShowGroupManage(false)} />}
    </div>
  );
}
