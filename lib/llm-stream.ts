/** 一个 LLM delta 片段。content 是正文，reasoning 是思考过程（DeepSeek-R1 / GLM-4.5+ 等 reasoning 模型）。 */
export interface LlmDelta {
  content?: string;
  reasoning?: string;
}

/**
 * 读取 OpenAI 兼容 SSE 流，逐个 delta 回调
 * 自动处理 buffer 切分、`data:` 前缀、`[DONE]` 标记和无法解析的行
 * 同时读取 content 与 reasoning_content / reasoning（不同 provider 字段名不同），
 * 让 DeepSeek-R1、GLM-4.5+ 等推理模型的思考过程不再被丢弃。
 * @param onFinish 可选：流结束时回调最后的 finish_reason（"stop" 正常结束 / "length" 达到 max_tokens 上限被截断）。
 *                 调用方据此区分"模型写完"与"被掐断"，避免截断输出被静默当成功。
 */
export async function readLlmDeltas(
  llmResponse: Response,
  onDelta: (delta: LlmDelta) => void,
  onFinish?: (reason: string) => void
): Promise<void> {
  return readLlmDeltasInternal(llmResponse, onDelta, undefined, onFinish);
}

/** 将一段文本以 SSE 事件形式写入控制器 */
export function encodeSSE(encoder: TextEncoder, controller: ReadableStreamDefaultController, payload: unknown): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

/** 写入 SSE 结束标记并关闭流 */
export function endSSE(encoder: TextEncoder, controller: ReadableStreamDefaultController): void {
  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
  controller.close();
}

/** 累积完成的工具调用（OpenAI 兼容格式，可直接回传 assistant 消息） */
export interface AccumulatedToolCall {
  id: string;
  type: string;
  'function': { name: string; arguments: string };
}

/**
 * 流式读取 + 工具调用分片累积（工具轮专用）。
 * OpenAI 流式 tool_calls 以 index 分片到达：首片带 id/type/function.name，后续片只带 arguments 字符串片段。
 * content/reasoning 照旧逐个回调（工具轮 content 通常为空，有则直播无害）；
 * 返回值是累积完成的 tool_calls，空数组 = 本轮纯文本回答（已直播完毕）。
 */
export async function readLlmDeltasWithTools(
  llmResponse: Response,
  onDelta: (delta: LlmDelta) => void
): Promise<AccumulatedToolCall[]> {
  const acc: AccumulatedToolCall[] = [];
  await readLlmDeltasInternal(llmResponse, onDelta, (toolCalls) => {
    for (const tc of toolCalls) {
      const idx = typeof tc?.index === 'number' ? tc.index : 0;
      if (!acc[idx]) acc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) acc[idx].id = tc.id;
      if (tc.type) acc[idx].type = tc.type;
      if (tc.function?.name) acc[idx].function.name += tc.function.name;
      if (tc.function?.arguments) acc[idx].function.arguments += tc.function.arguments;
    }
  });
  return acc.filter(Boolean);
}

/** 内部共享实现：readLlmDeltas 不带工具分片回调，readLlmDeltasWithTools 带 */
async function readLlmDeltasInternal(
  llmResponse: Response,
  onDelta: (delta: LlmDelta) => void,
  onToolCalls?: (toolCalls: any[]) => void,
  onFinish?: (reason: string) => void
): Promise<void> {
  const reader = llmResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // 记录最后一个非空 finish_reason（多数 provider 在末帧携带；中途帧为 null/空则跳过）
  let finishReason = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;

      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        const content = typeof delta.content === 'string' ? delta.content : undefined;
        // reasoning 字段名兜底：DeepSeek/部分 GLM 用 reasoning_content，部分 OpenAI 兼容包装用 reasoning
        const reasoning = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string' ? delta.reasoning : undefined;
        if (content || reasoning) onDelta({ content, reasoning });
        if (onToolCalls && Array.isArray(delta.tool_calls)) onToolCalls(delta.tool_calls);
      } catch {
        // 跳过无法解析的行
      }
    }
  }
  if (onFinish && finishReason) onFinish(finishReason);
}
