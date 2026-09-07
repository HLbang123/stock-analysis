'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';

/**
 * 意见反馈表单 — 文本 + 可选截图（点选/粘贴，最多 3 张、单张 ≤5MB）。
 * 提交成功后回调 onSubmitted，由父级刷新反馈列表。
 */

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface PickedImage {
  id: string;
  file: File;
  url: string;
}

export function FeedbackForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [images, setImages] = useState<PickedImage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setContent('');
    setContact('');
    setImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.url));
      return [];
    });
  };

  const addFiles = (list: FileList | File[]) => {
    const incoming = Array.from(list);
    const next = [...images];
    for (const file of incoming) {
      if (next.length >= MAX_IMAGES) {
        toast.error(`最多上传 ${MAX_IMAGES} 张图片`);
        break;
      }
      if (!file.type.startsWith('image/')) {
        toast.error('仅支持图片');
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error('单张图片不能超过 5MB');
        continue;
      }
      next.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        url: URL.createObjectURL(file),
      });
    }
    setImages(next);
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((i) => i.id !== id);
    });
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const submit = async () => {
    if (!content.trim()) {
      toast.error('请填写反馈内容');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('content', content.trim());
      if (contact.trim()) fd.append('contact', contact.trim());
      fd.append('path', window.location.pathname);
      for (const img of images) fd.append('images', img.file);

      const res = await fetch('/api/feedback', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('已收到，感谢反馈');
        reset();
        onSubmitted?.();
      } else {
        toast.error(data.error || '提交失败，请稍后重试');
      }
    } catch {
      toast.error('网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Textarea
          rows={5}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onPaste={onPaste}
          maxLength={2000}
          placeholder="请描述遇到的问题或建议（可直接粘贴截图）"
        />
        <div className="text-right text-xs text-gray-400 mt-1">{content.length}/2000</div>
      </div>

      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <ImagePlus className="w-4 h-4 text-gray-400" />
          <span className="text-xs text-gray-400">截图（选填，最多 {MAX_IMAGES} 张）</span>
        </div>

        {images.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mb-2">
            {images.map((img) => (
              <div
                key={img.id}
                className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt="截图" className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(img.id)}
                  className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white hover:bg-black/80 transition"
                  aria-label="移除图片"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {images.length < MAX_IMAGES && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
          >
            添加图片
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <div>
        <Input
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          maxLength={80}
          placeholder="联系方式（选填，方便回复）"
        />
      </div>

      <Button onClick={submit} loading={submitting} variant="accent" className="w-full">
        提交反馈
      </Button>
    </div>
  );
}
