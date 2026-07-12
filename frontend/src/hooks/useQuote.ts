import { useState, useEffect, useCallback } from 'react';
import { getQuotes } from '../api/client';
import type { Quote } from '../types';

export function useQuote(code: string | undefined) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchQuote = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    try {
      const quotes = await getQuotes([code]);
      if (quotes.length > 0) {
        setQuote(quotes[0]);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    fetchQuote();
    const timer = setInterval(fetchQuote, 5000); // poll every 5s
    return () => clearInterval(timer);
  }, [fetchQuote]);

  return { quote, loading, refetch: fetchQuote };
}
