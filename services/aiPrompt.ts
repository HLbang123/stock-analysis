export function buildUserPrompt(
  stockCode: string,
  stockName: string,
  quoteJson: string,
  klineSummary: string,
  engineResults: string,
  indicatorBlock?: string,
  positionNote?: string
): string {
  const indicatorSection = indicatorBlock ? `${indicatorBlock}\n` : '';
  const positionSection = positionNote ? `${positionNote}\n` : '';
  return `分析股票：${stockName} (${stockCode})
${positionSection}
实时行情：
${quoteJson}

${indicatorSection}
近20日K线（日期 开 高 低 收 量）：
${klineSummary}

引擎初判（参考）：${engineResults}`;
}
