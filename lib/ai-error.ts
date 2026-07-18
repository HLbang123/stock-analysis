/**
 * AI API 错误翻译工具
 * 将 LLM API 返回的原始错误信息翻译为用户可读的中文提示
 */

interface AiErrorBody {
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
  code?: string | number;
  message?: string;
}

/**
 * 根据 HTTP 状态码和响应体，返回用户友好的错误信息
 * 同时将原始错误打印到服务端日志用于排查
 */
export function formatAiError(status: number, responseBody: string): string {
  // 尝试解析 JSON 错误体
  let parsed: AiErrorBody | null = null;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    // 不是 JSON，忽略
  }

  const providerMsg = parsed?.error?.message || parsed?.message || '';

  // ===== 按状态码映射 =====
  switch (status) {
    case 400:
      // 透出厂商原始错误（如 context length exceeded / invalid parameter），便于定位
      return providerMsg
        ? `请求参数有误 (400)：${providerMsg.slice(0, 150)}`
        : '请求参数有误，请检查模型名称或 Base URL 是否正确';

    case 401: {
      // 最常见：API Key 问题
      if (providerMsg.includes('过期') || providerMsg.includes('expired')) {
        return 'API Key 已过期，请前往平台重新生成密钥';
      }
      if (providerMsg.includes('invalid') || providerMsg.includes('验证') || providerMsg.includes('auth')) {
        return 'API Key 无效，请检查密钥是否正确，或前往平台重新生成';
      }
      return 'API Key 无效或已过期，请检查密钥是否正确';
    }

    case 403:
      if (providerMsg.includes('balance') || providerMsg.includes('余额') || providerMsg.includes('quota') || providerMsg.includes('额度')) {
        return 'API 账户余额不足，请前往平台充值';
      }
      if (providerMsg.includes('disabled') || providerMsg.includes('banned') || providerMsg.includes('禁用')) {
        return 'API Key 已被禁用，请前往平台查看账户状态';
      }
      return 'API 访问被拒绝，请检查账户权限或余额是否充足';

    case 404:
      return '模型不存在，请检查模型名称是否正确。注意：deepseek-chat 和 deepseek-reasoner 已于 2026年7月24日 起废弃，请改为 deepseek-v4-flash';

    case 429:
      return 'API 调用频率超限，请稍后重试或降低调用频率';

    case 500:
    case 502:
    case 503:
    case 504:
      return `AI 服务端异常 (${status})，请稍后重试。如持续出现请联系 AI 平台`;

    default:
      if (status >= 500) {
        return `AI 服务端错误 (${status})，请稍后重试`;
      }
      if (status >= 400) {
        return `请求失败 (${status})，${providerMsg ? `原因：${providerMsg.slice(0, 100)}` : '请检查配置'}`;
      }
      return `未知错误 (${status})`;
  }
}

/**
 * 格式化 fetch 阶段网络错误（无法连接、DNS 失败、超时等）
 * Node 的 fetch 失败时 message 通常是 "fetch failed"，真实原因在 error.cause
 * （cause.code 如 ENOTFOUND/ECONNREFUSED/ECONNRESET，cause.message 含细节）
 */
export function formatNetworkError(error: Error): string {
  const cause: any = (error as any).cause;
  const msg = cause?.message || error.message || '';
  const code: string = cause?.code || '';

  if (error.name === 'AbortError' || cause?.name === 'AbortError' || code === 'ABORT_ERR' || msg.includes('abort') || msg.includes('timeout')) {
    return '连接超时，请检查网络或 API 地址是否可访问';
  }

  // DNS / 无法解析
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND') || msg.includes('getaddrinfo') || msg.includes('DNS')) {
    return `无法解析域名${cause?.hostname ? `（${cause.hostname}）` : ''}，请检查 Base URL 是否正确`;
  }

  // 连接被拒
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED') || msg.includes('refused')) {
    return '连接被拒绝，请检查 Base URL 和端口是否正确';
  }

  // 连接被重置（中转站不稳定 / 限流常见）
  if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
    return '连接被对端重置（ECONNRESET），可能是服务端不稳定或限流，请稍后重试';
  }

  // SSL / 证书错误
  if (msg.includes('certificate') || msg.includes('SSL') || msg.includes('TLS') || msg.includes('CERT') || code.includes('CERT')) {
    return 'SSL 证书验证失败，请检查 Base URL 的 HTTPS 证书是否有效';
  }

  // 网络不可达
  if (code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || msg.includes('ETIMEDOUT') || msg.includes('ENETUNREACH') || msg.includes('EHOSTUNREACH')) {
    return '网络不可达，请检查 Base URL 是否正确、网络是否连通';
  }

  // 通用兜底：尽量带上 cause 细节
  if (msg && msg !== 'fetch failed') {
    return `网络连接失败: ${msg.slice(0, 120)}，请检查 Base URL 和网络`;
  }
  return `网络请求失败${code ? `（${code}）` : ''}，请检查 Base URL 是否正确、网络是否连通`;
}
