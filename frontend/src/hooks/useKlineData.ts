import { useState, useEffect, useCallback } from 'react';
import { getKline } from '../api/client';
import type { KlineData, ChartPeriod } from '../types';

export function useKlineData(code: string | undefined, period: ChartPeriod) {
  const [data, setData] = useState<KlineData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getKline(code, period, 300);
      setData(result);
    } catch (err: any) {
      setError(err.message || '获取K线数据失败');
    } finally {
      setLoading(false);
    }
  }, [code, period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
