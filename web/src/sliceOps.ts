import type { SessionSlice } from "./types";

/** 把 index 处的段与下一段合并：行范围合并、标题保留前段、消息拼接。 */
export function mergeSlices(slices: SessionSlice[], index: number): SessionSlice[] {
  if (index < 0 || index >= slices.length - 1) return slices;
  const a = slices[index];
  const b = slices[index + 1];
  const merged: SessionSlice = {
    ...a,
    endLine: b.endLine,
    status: a.status === "done" && b.status === "done" ? "done" : a.status === "unread" && b.status === "unread" ? "unread" : "reading",
    messages: [...a.messages, ...b.messages],
  };
  const out = [...slices];
  out.splice(index, 2, merged);
  return out;
}

/** 在 splitLine 处把 index 处的段拆成两段，新段标题为「原标题（下）」、消息为空。 */
export function splitSlice(
  slices: SessionSlice[],
  index: number,
  splitLine: number
): SessionSlice[] {
  const s = slices[index];
  if (!s || splitLine <= s.startLine || splitLine > s.endLine) return slices;
  const upper: SessionSlice = { ...s, endLine: splitLine - 1 };
  const lower: SessionSlice = {
    id: `${s.id}-b${Date.now()}`,
    startLine: splitLine,
    endLine: s.endLine,
    title: `${s.title}（下）`,
    status: s.status === "done" ? "done" : "unread",
    messages: [],
  };
  const out = [...slices];
  out.splice(index, 1, upper, lower);
  return out;
}
