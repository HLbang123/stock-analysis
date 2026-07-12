import axios from 'axios';
import type { KlineData, Quote, StockInfo, IndexData } from '../types';

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

export async function searchStocks(keyword: string): Promise<StockInfo[]> {
  const res = await api.get('/search', { params: { keyword } });
  return res.data.results || [];
}

export async function getQuotes(codes: string[]): Promise<Quote[]> {
  const res = await api.get('/quote', { params: { codes: codes.join(',') } });
  return res.data.quotes || [];
}

export async function getKline(
  code: string,
  period: string = 'daily',
  limit: number = 300
): Promise<KlineData> {
  const res = await api.get('/kline', { params: { code, period, limit } });
  return res.data;
}

export async function getIndices(): Promise<IndexData[]> {
  const res = await api.get('/index');
  return res.data.indices || [];
}
