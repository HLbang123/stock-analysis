/**
 * AI 筛选 — 服务器侧 LLM 配置（环境变量）
 *
 * 服务器 key 就位后，筛选完全在服务端跑：每日 run-daily 自动调度，全员共享同一份结果，
 * 不再依赖用户浏览器/个人 key。API 路由与每日脚本共用本模块。
 *
 * 环境变量：
 *   AI_SCREEN_API_KEY  - 必填；缺失时返回 null（路由回退客户端配置，每日任务跳过）
 *   AI_SCREEN_BASE_URL - 可选，默认 DeepSeek 官方
 *   AI_SCREEN_MODEL    - 可选，默认 deepseek-v4-flash
 */

import type { LlmConfig } from './types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';

export function getServerScreenCfg(): LlmConfig | null {
  const apiKey = process.env.AI_SCREEN_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: process.env.AI_SCREEN_BASE_URL || DEFAULT_BASE_URL,
    apiKey,
    model: process.env.AI_SCREEN_MODEL || DEFAULT_MODEL,
  };
}
