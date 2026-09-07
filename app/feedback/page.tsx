'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, ImagePlus } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Modal } from '@/components/ui/modal';
import { Tabs } from '@/components/ui/tabs';
import { FeedbackForm } from '@/components/FeedbackForm';
import { cn, formatTime } from '@/lib/utils';

/**
 * 意见反馈页 — 提交反馈 / 浏览大家的反馈与处理进度，两个标签页切换。
 * 列表接口只回截图数量，点「查看 N 张截图」再按 id 拉完整图片，避免一次性加载大图。
 */

interface FeedbackItem {
  id: string;
  content: string;
  contact: string | null;
  path: string | null;
  imageCount: number;
  status: string;
  createdAt: string;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  new: { label: '待处理', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  processing: { label: '处理中', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
  resolved: { label: '已解决', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
};

export default function FeedbackPage() {
  const [tab, setTab] = useState<'submit' | 'list'>('submit');
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{ id: string; images: string[] } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/feedback?limit=100');
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setItems(data.items || []);
      } else {
        toast.error(data.error || '加载失败');
      }
    } catch {
      toast.error('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  const openImages = async (id: string) => {
    setViewerLoading(true);
    try {
      const res = await fetch(`/api/feedback/${id}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.item?.images)) {
        setViewer({ id, images: data.item.images });
      } else {
        toast.error(data.error || '截图加载失败');
      }
    } catch {
      toast.error('网络错误');
    } finally {
      setViewerLoading(false);
    }
  };

  const updateStatus = async (id: string, status: string) => {
    const prev = items;
    setItems((cur) => cur.map((i) => (i.id === id ? { ...i, status } : i)));
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || '更新失败');
        setItems(prev);
      }
    } catch {
      toast.error('网络错误');
      setItems(prev);
    }
  };

  return (
    <div>
      <PageHeader
        title="意见反馈"
        subtitle="提反馈，也可以看大家的反馈和处理进度"
      />

      <Tabs
        items={[
          { value: 'submit', label: '提交反馈' },
          { value: 'list', label: '反馈记录' },
        ]}
        value={tab}
        onChange={setTab}
        variant="segment"
        size="md"
        fullWidth
        className="w-full mb-4"
      />

      {tab === 'submit' ? (
        <section className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">我要反馈</h2>
          <p className="text-xs text-gray-400 mt-1 mb-3">描述问题或建议，可附截图</p>
          <FeedbackForm onSubmitted={load} />
        </section>
      ) : (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
              反馈记录
            </h2>
            <button
              onClick={load}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              刷新
            </button>
          </div>

          {loading ? (
            <div className="text-center py-16 text-sm text-gray-400">加载中...</div>
          ) : items.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <ImagePlus className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">还没有反馈</p>
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const st = STATUS[item.status] ?? STATUS.new;
                return (
                  <div
                    key={item.id}
                    className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-3.5"
                  >
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className={cn('text-xs px-2 py-0.5 rounded-full shrink-0', st.cls)}>
                        {st.label}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0">
                        {formatTime(new Date(item.createdAt).getTime())}
                      </span>
                    </div>

                    <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
                      {item.content}
                    </p>

                    {item.contact && (
                      <p className="text-xs text-gray-400 mt-1.5">联系方式：{item.contact}</p>
                    )}
                    {item.path && item.path !== '/' && (
                      <p className="text-xs text-gray-400 mt-0.5">来自：{item.path}</p>
                    )}

                    <div className="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-gray-50 dark:border-gray-800">
                      {item.imageCount > 0 ? (
                        <button
                          onClick={() => openImages(item.id)}
                          disabled={viewerLoading}
                          className="text-xs text-[var(--color-accent)] hover:underline disabled:opacity-50"
                        >
                          查看 {item.imageCount} 张截图
                        </button>
                      ) : (
                        <span />
                      )}
                      <select
                        value={item.status}
                        onChange={(e) => updateStatus(item.id, e.target.value)}
                        className="text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 focus:outline-none"
                      >
                        <option value="new">待处理</option>
                        <option value="processing">处理中</option>
                        <option value="resolved">已解决</option>
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* 截图查看 */}
      {viewer && (
        <Modal title="反馈截图" onClose={() => setViewer(null)} variant="center" maxWidth="sm:max-w-lg">
          <div className="p-4 space-y-3">
            {viewer.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${viewer.id}-${i}`}
                src={src}
                alt={`截图${i + 1}`}
                className="w-full h-auto rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950"
              />
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
