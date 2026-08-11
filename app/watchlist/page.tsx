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
  const { watchlist, groups, addToWatchlist, removeFromWatchlist, isInWatchlist, addGroup } = useStockStore();
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

  // OCR 状态
  const [showOcr, setShowOcr] = useState(false);
  const [ocrImage, setOcrImage] = useState<string | null>(null);
  const [ocrImageFile, setOcrImageFile] = useState<File | null>(null);
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [ocrResults, setOcrResults] = useState<{ code: string; name: string; added: boolean }[]>([]);

  // OCR 识别
  const handleOcrScan = async () => {
    if (!ocrImageFile) { toast.error('请先选择图片'); return; }
    setIsOcrProcessing(true);
    setOcrStatus('正在准备识别引擎...');
    setOcrResults([]);

    try {
      const Tesseract = (await import('tesseract.js')).default;
      setOcrStatus('正在识别文字...');
      // 只识别 6 位数字代码，用 eng 引擎（语言包 ~4MB，chi_sim ~30MB）——加载更快、数字更准；
      // 名称不靠 OCR，后续用行情接口按代码查名
      const worker = await Tesseract.createWorker('eng');
      const { data } = await worker.recognize(ocrImageFile);
      await worker.terminate();

      // OCR 常把同一代码拆进空格/换行（如 "60 0000"）：原始文本与"数字间空白合并"文本各匹配一遍取并集。
      // 合并可能造出假 6 位串，交给 validateStockCode（前辍校验）+ 行情查名过滤
      const codeRegex = /(?<!\d)(\d{6})(?!\d)/g;
      const rawMatches = data.text.match(codeRegex) || [];
      const mergedMatches = data.text.replace(/(\d)\s+(?=\d)/g, '$1').match(codeRegex) || [];
      const extractedCodes = [...new Set([...rawMatches, ...mergedMatches])];

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

  // 分组派生：切换组只过滤展示，不重拉行情
  const activeGroupName = selectedGroupId === ALL_GROUP_ID
    ? '全部'
    : groups.find(g => g.id === selectedGroupId)?.name ?? '全部';
  const visibleWatchlist = selectedGroupId === ALL_GROUP_ID
    ? watchlist
    : watchlist.filter(s => s.groupId === selectedGroupId);

  // 选中组被删除时自动回退「全部」
  useEffect(() => {
    if (selectedGroupId !== ALL_GROUP_ID && !groups.some(g => g.id === selectedGroupId)) {
      setSelectedGroupId(ALL_GROUP_ID);
    }
  }, [groups, selectedGroupId]);

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
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setOcrImageFile(file);
                const reader = new FileReader();
                reader.onload = () => setOcrImage(reader.result as string);
                reader.readAsDataURL(file);
                setOcrResults([]);
                setOcrStatus(null);
              }}
              className="hidden"
            />

            {ocrImage ? (
              <div>
                <div className="relative mb-3">
                  <img src={ocrImage} alt="截图" className="w-full h-48 object-contain bg-gray-100 dark:bg-gray-800 rounded-lg" />
                  <button
                    onClick={() => { setOcrImage(null); setOcrImageFile(null); setOcrResults([]); setOcrStatus(null); }}
                    className="absolute top-2 right-2 p-1 bg-white/80 rounded-full hover:bg-white transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => ocrFileRef.current?.click()} className="flex-1 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm">
                    重新选择
                  </button>
                    <Button
                      onClick={handleOcrScan}
                      loading={isOcrProcessing}
                      className="flex-1"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      {isOcrProcessing ? '识别中...' : '开始识别'}
                    </Button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => ocrFileRef.current?.click()}
                className="w-full h-32 flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-[var(--radius-lg)] hover:border-[var(--color-accent)] transition mt-2"
              >
                <Camera className="w-8 h-8 text-gray-300 mb-1" />
                <p className="text-sm text-gray-500">点击上传持仓截图</p>
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
                    <Button
                      onClick={() => handleOcrAdd(r.code, r.name)}
                      variant={r.added ? "secondary" : "primary"}
                      size="sm"
                      disabled={r.added}
                    >
                      {r.added ? '已添加' : '加入自选'}
                    </Button>
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
            <button
              onClick={refreshQuotes}
              className="text-sm text-[var(--color-accent)] hover:opacity-80 flex items-center gap-1"
            >
              <TrendingUp className="w-4 h-4" />
              刷新行情
            </button>
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
                  onClick={() => router.push(`/stock/${stock.code}`)}
                >
                  <div className="flex items-center justify-between">
                    <div>
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
                        <div className="relative">
                          <button
                            onClick={(e) => { e.stopPropagation(); setMoveMenuFor(moveMenuFor === stock.code ? null : stock.code); }}
                            className="p-2 text-gray-400 hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] rounded-[var(--radius-md)] transition"
                            title="移动到分组"
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
                      </div>
                    ) : (
                      <div className="text-gray-400 text-sm">加载中...</div>
                    )}
                  </div>

                  {quote && (
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

      {showGroupManage && <GroupManageModal onClose={() => setShowGroupManage(false)} />}
    </div>
  );
}
