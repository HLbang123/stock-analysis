import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 格式化价格
 */
export function formatPrice(price: number): string {
  return price.toFixed(2);
}

/**
 * 格式化涨跌幅
 */
export function formatChange(change: number): string {
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

/**
 * 格式化成交量
 */
export function formatVolume(volume: number): string {
  if (volume >= 100000000) {
    return `${(volume / 100000000).toFixed(2)}亿`;
  }
  if (volume >= 10000) {
    return `${(volume / 10000).toFixed(2)}万`;
  }
  return volume.toString();
}

/**
 * 格式化金额
 */
export function formatAmount(amount: number): string {
  if (amount >= 100000000) {
    return `${(amount / 100000000).toFixed(2)}亿`;
  }
  if (amount >= 10000) {
    return `${(amount / 10000).toFixed(2)}万`;
  }
  return amount.toFixed(2);
}

/**
 * 获取涨跌颜色类名
 */
export function getChangeColorClass(change: number, isBg: boolean = false): string {
  const prefix = isBg ? 'bg' : 'text';
  if (change > 0) return `${prefix}-red-500`;
  if (change < 0) return `${prefix}-green-500`;
  return `${prefix}-gray-500`;
}

/**
 * 格式化时间
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;

  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hour = date.getHours().toString().padStart(2, '0');
  const min = date.getMinutes().toString().padStart(2, '0');
  return `${month}-${day} ${hour}:${min}`;
}

/**
 * 预警级别颜色
 */
export function getAlertLevelColor(level: string): string {
  switch (level) {
    case 'CRITICAL':
      return 'bg-red-100 border-red-300 text-red-700';
    case 'WARNING':
      return 'bg-yellow-100 border-yellow-300 text-yellow-700';
    case 'INFO':
    default:
      return 'bg-green-100 border-green-300 text-green-700';
  }
}