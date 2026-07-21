'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, Loader2 } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace('/');
        router.refresh();
      } else {
        const d = await res.json().catch(() => ({}));
        setError(d.error || '口令错误');
      }
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
      <form onSubmit={submit} className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg p-6 w-full max-w-xs">
        <div className="flex flex-col items-center mb-4">
          <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-950 flex items-center justify-center mb-2">
            <Lock className="w-6 h-6 text-blue-600" />
          </div>
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">预警小工具</h1>
          <p className="text-xs text-gray-400">请输入访问口令</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="口令"
          className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
        />
        {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />} 进入
        </button>
      </form>
    </div>
  );
}
