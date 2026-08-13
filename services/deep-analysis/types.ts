/**
 * 深度分析 — 结果类型单一事实源。
 * 原本定义在 engine.ts，ai-store 引 DeepResult、engine 引 ai-store 的 AiAnalysisRecord，
 * 形成类型级循环依赖；抽到本文件后依赖单向化：engine / ai-store / 页面 → types。
 */

/** 结构化裁决结果（verdict 文本解析） */
export interface DeepStructured {
  action: string;
  oneLiner?: string;
  /** 综合评判（原 manager 职责并入裁决：对比辩论三人论点 + 5级情绪强度 + 是否改变初判） */
  consensus?: string;
  riskLevel: string;
  confidence: number;
  targetLow: number;
  targetHigh: number;
  stopLoss: number;
  position: number;
  reasoning: string;
  plan: string;
  riskNote: string;
  confidenceScore?: number;
  clamped?: string[];
  keyPoints?: string[];
}

export interface DeepLevels {
  current: number;
  supports: { price: number; label: string }[];
  resistances: { price: number; label: string }[];
}

export interface DeepResult {
  analyst: string;
  analystReasoning?: string;
  debate: string;
  debateReasoning?: string;
  debateError?: string;
  verdict: string;
  verdictReasoning?: string;
  verdictError?: string;
  levels?: DeepLevels | null;
  structured: DeepStructured | null;
  /** 并行编排后阶段指示不再单调，卡片游标/思考面板据此判断该区是否仍在流式写入 */
  analystDone?: boolean;
  debateDone?: boolean;
  /** 本次分析降级说明（上游角色失败被跳过 / 裁决降级 / 规则兜底）——UI 展示给用户知道分析不完整 */
  warnings?: string[];
}

export type DeepStage = 'idle' | 'analyst' | 'debate' | 'verdict';

export interface DeepProgress {
  stage: DeepStage;
  result: DeepResult;
}
