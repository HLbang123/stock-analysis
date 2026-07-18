/**
 * 读取 OpenAI 兼容 SSE 流，逐个 delta 回调
 * 自动处理 buffer 切分、`data:` 前缀、`[DONE]` 标记和无法解析的行
 */
export async function readLlmDeltas(
  llmResponse: Response,
  onDelta: (delta: string) => void
): Promise<void> {
  const reader = llmResponse.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {
        // 跳过无法解析的行
      }
    }
  }
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
