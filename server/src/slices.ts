export interface Slice {
  id: string;
  startLine: number;
  endLine: number;
  title: string;
  role?: string;
}

interface RawSlice {
  startLine: number;
  endLine: number;
  title: string;
  role?: string;
}

function fallbackSlices(totalLines: number): RawSlice[] {
  const size = 20;
  const out: RawSlice[] = [];
  for (let start = 1; start <= totalLines; start += size) {
    out.push({
      startLine: start,
      endLine: Math.min(start + size - 1, totalLines),
      title: `第 ${Math.ceil(start / size)} 段`,
    });
  }
  return out;
}

/**
 * 把模型的原始输出修正为首尾相接、完整覆盖 [1, totalLines] 的切片数组。
 * - 去掉 markdown 代码块包裹
 * - 解析失败时按约 20 行兜底切分
 * - 排序、裁剪到合法范围、消除重叠、把空隙并入前一段
 */
export function normalizeSlices(raw: string, totalLines: number): Slice[] {
  if (totalLines <= 0) return [];

  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  let parsed: RawSlice[] | null = null;
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) {
      parsed = v
        .filter(
          (s) =>
            s &&
            Number.isFinite(Number(s.startLine)) &&
            Number.isFinite(Number(s.endLine))
        )
        .map((s) => ({
          startLine: Math.round(Number(s.startLine)),
          endLine: Math.round(Number(s.endLine)),
          title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : "未命名片段",
          ...(typeof s.role === "string" && s.role.trim()
            ? { role: s.role.trim().slice(0, 200) }
            : {}),
        }));
    }
  } catch {
    parsed = null;
  }

  if (!parsed || parsed.length === 0) parsed = fallbackSlices(totalLines);

  const sorted = [...parsed]
    .map((s) => ({
      startLine: Math.max(1, Math.min(totalLines, s.startLine)),
      endLine: Math.max(1, Math.min(totalLines, s.endLine)),
      title: s.title,
      ...(s.role ? { role: s.role } : {}),
    }))
    .filter((s) => s.startLine <= s.endLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  if (sorted.length === 0) sorted.push(...fallbackSlices(totalLines));

  const merged: RawSlice[] = [];
  for (const s of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && s.startLine <= prev.endLine) {
      // 重叠或被包含：并入前一段
      prev.endLine = Math.max(prev.endLine, s.endLine);
    } else {
      merged.push({ ...s });
    }
  }

  // 消除段间空隙：把空隙行并入前一段
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].startLine > merged[i - 1].endLine + 1) {
      merged[i - 1].endLine = merged[i].startLine - 1;
    }
  }

  // 首尾补齐
  if (merged.length === 0) merged.push({ startLine: 1, endLine: totalLines, title: "全部代码" });
  if (merged[0].startLine > 1) merged[0].startLine = 1;
  merged[merged.length - 1].endLine = totalLines;

  return merged.map((s, i) => ({
    id: `slice-${i + 1}`,
    startLine: s.startLine,
    endLine: s.endLine,
    title: s.title,
    ...(s.role ? { role: s.role } : {}),
  }));
}
