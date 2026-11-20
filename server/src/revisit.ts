/**
 * 解析「以后再看」AI 建议的输出：{"related":[序号...]}（序号是 candidates 的
 * number，从 1 开始）。取最后一个有效序号转成 0-based 候选下标；
 * 空数组 = 没有找到相关段落返回 null；格式不符抛错由路由降级为手动选择。
 */
export function lastRelatedIndex(output: string, candidateCount: number): number | null {
  const text = output.trim().replace(/^```(?:json)?\s*\n?(.*?)\n?```$/is, "$1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI 返回的相关段落格式不正确。");
  }
  const related = (parsed as { related?: unknown } | null)?.related;
  if (
    !Array.isArray(related) ||
    related.some((n) => !Number.isInteger(n) || n < 1 || n > candidateCount)
  ) {
    throw new Error("AI 返回的相关段落格式不正确。");
  }
  return related.length === 0 ? null : Math.max(...related) - 1;
}
