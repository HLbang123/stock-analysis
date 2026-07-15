'use client';

import React, { useState, useRef, useCallback } from 'react';
import { useStockStore } from '@/store';
import { parseStockCode, getRealtimeQuote } from '@/services/stockApi';
import { cn } from '@/lib/utils';
import { Camera, Upload, Loader2, Plus, Check, X } from 'lucide-react';
import { toast } from 'sonner';

interface OcrStockResult {
  code: string;   // full code like sh600519
  name: string;
  added: boolean;
}

// A股代码范围验证
const A_SHARE_RANGES: { min: number; max: number; market: string }[] = [
  { min: 600000, max: 605999, market: 'sh' },  // 上海主板
  { min: 688000, max: 689999, market: 'sh' },  // 科创板
  { min: 0, max: 3999, market: 'sz' },          // 深圳主板(000001-003999)
  { min: 300000, max: 301999, market: 'sz' },  // 创业板
  { min: 800000, max: 839999, market: 'bj' },  // 北交所
];

function isValidAStock(code: number): { market: string; pureCode: string } | null {
  for (const range of A_SHARE_RANGES) {
    if (code >= range.min && code <= range.max) {
      return { market: range.market, pureCode: String(code).padStart(6, '0') };
    }
  }
  return null;
}

export default function OcrPage() {
  const { addToWatchlist, isInWatchlist } = useStockStore();
  const [image, setImage] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<OcrStockResult[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 选择图片
  const handleSelectImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件');
      return;
    }

    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      setImage(reader.result as string);
    };
    reader.readAsDataURL(file);
    setResults([]);
    setStatus(null);
  };

  // OCR识别 — 客户端 tesseract.js
  const handleScan = async () => {
    if (!imageFile) {
      toast.error('请先选择图片');
      return;
    }

    setIsProcessing(true);
    setStatus('正在下载中文语言包（首次约30MB）...');
    setResults([]);

    try {
      let extractedCodes: string[] = [];

      try {
        // 动态导入 tesseract.js（避免 SSR 问题）
        const Tesseract = (await import('tesseract.js')).default;

        setStatus('正在识别文字...');
        const worker = await Tesseract.createWorker('chi_sim');

        const { data } = await worker.recognize(imageFile);
        const text = data.text;
        await worker.terminate();

        console.log('[OCR] 识别文本:', text.slice(0, 300));

        // 提取6位数字代码
        const codeRegex = /(?<!\d)(\d{6})(?!\d)/g;
        const matches = text.match(codeRegex) || [];
        extractedCodes = [...new Set(matches)];

        console.log('[OCR] 提取代码:', extractedCodes);
      } catch (ocrError: any) {
        console.error('[OCR] tesseract失败:', ocrError.message);
        // 回退：让用户手动输入
        setStatus('OCR引擎加载失败，请尝试直接粘贴持仓文本');
        setIsProcessing(false);
        return;
      }

      if (extractedCodes.length === 0) {
        setStatus('未识别到有效股票代码，请确认截图清晰且包含6位数字代码');
        setIsProcessing(false);
        return;
      }

      // 验证每个代码
      const validResults: OcrStockResult[] = [];

      for (const codeStr of extractedCodes) {
        const codeNum = parseInt(codeStr);
        const valid = isValidAStock(codeNum);
        if (!valid) continue;

        const fullCode = `${valid.market}${valid.pureCode}`;

        // 通过行情API验证股票是否存在
        try {
          const quote = await getRealtimeQuote(fullCode);
          if (quote && quote.name) {
            validResults.push({
              code: fullCode,
              name: quote.name,
              added: isInWatchlist(fullCode),
            });
          }
        } catch {
          // 无法验证的代码也添加（可能非交易时段）
          validResults.push({
            code: fullCode,
            name: fullCode,
            added: isInWatchlist(fullCode),
          });
        }
      }

      if (validResults.length > 0) {
        setResults(validResults);
        setStatus(`识别到 ${validResults.length} 只股票`);
      } else {
        setStatus('未识别到有效股票代码，请确认截图包含持仓列表');
      }
    } catch (error: any) {
      console.error('OCR失败:', error);
      setStatus(`识别失败: ${error.message || '未知错误'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // 添加单只股票
  const handleAddStock = (result: OcrStockResult) => {
    const parsed = parseStockCode(result.code);
    addToWatchlist({
      code: result.code,
      name: result.name,
      market: parsed.market,
      pureCode: parsed.pureCode,
    });
    setResults(prev =>
      prev.map(r => r.code === result.code ? { ...r, added: true } : r)
    );
    toast.success(`已添加 ${result.name}`);
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
        <Camera className="w-6 h-6" />
        持仓识别
      </h1>

      <p className="text-sm text-gray-500 mb-6">
        上传持仓截图，自动识别股票代码并添加到自选列表
      </p>

      {/* 图片上传区 */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm mb-6">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />

        {image ? (
          <div>
            <div className="relative">
              <img
                src={image}
                alt="持仓截图"
                className="w-full h-64 object-contain bg-gray-100 dark:bg-gray-800 rounded-t-xl"
              />
              <button
                onClick={() => { setImage(null); setImageFile(null); setResults([]); setStatus(null); }}
                className="absolute top-2 right-2 p-1.5 bg-white/80 rounded-full hover:bg-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex gap-3">
              <button
                onClick={handleSelectImage}
                className="flex-1 py-2.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition"
              >
                重新选择
              </button>
              <button
                onClick={handleScan}
                disabled={isProcessing}
                className={cn(
                  "flex-1 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition",
                  isProcessing
                    ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                )}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    识别中...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    开始识别
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={handleSelectImage}
            className="w-full h-64 flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/50 transition group"
          >
            <Camera className="w-12 h-12 text-gray-300 group-hover:text-blue-400 transition mb-3" />
            <p className="text-gray-500 group-hover:text-blue-600 transition">点击上传持仓截图</p>
            <p className="text-xs text-gray-400 mt-1">支持 JPG、PNG 格式</p>
          </button>
        )}
      </div>

      {/* 状态 */}
      {status && (
        <div className={cn(
          "p-3 rounded-lg text-sm mb-4",
          status.includes('失败') || status.includes('不可用')
            ? "bg-red-50 text-red-600"
            : status.includes('识别到')
            ? "bg-green-50 text-green-600"
            : "bg-blue-50 text-blue-600"
        )}>
          {status}
        </div>
      )}

      {/* 识别结果 */}
      {results.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-gray-900 dark:text-white">
            识别结果 ({results.length} 只)
          </h3>
          {results.map(result => (
            <div
              key={result.code}
              className="bg-white dark:bg-gray-900 rounded-xl p-4 shadow-sm flex items-center justify-between"
            >
              <div>
                <p className="font-medium">{result.name}</p>
                <p className="text-sm text-gray-500">{result.code}</p>
              </div>
              <button
                onClick={() => handleAddStock(result)}
                disabled={result.added}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition",
                  result.added
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                )}
              >
                {result.added ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    已添加
                  </>
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    加入自选
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
