import { describe, it, expect } from "vitest";
import { mergeSlices, splitSlice } from "../src/sliceOps";
import type { SessionSlice } from "../src/types";

function mk(id: string, start: number, end: number, extra?: Partial<SessionSlice>): SessionSlice {
  return { id, startLine: start, endLine: end, title: `t-${id}`, status: "reading", messages: [], ...extra };
}

describe("mergeSlices", () => {
  it("合并行范围并拼接消息", () => {
    const a = mk("a", 1, 5, { messages: [{ role: "user", content: "q1" }] });
    const b = mk("b", 6, 10, { messages: [{ role: "assistant", content: "r1" }] });
    const c = mk("c", 11, 15);
    const out = mergeSlices([a, b, c], 0);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ startLine: 1, endLine: 10, title: "t-a" });
    expect(out[0].messages).toHaveLength(2);
    expect(out[1].id).toBe("c");
  });

  it("最后一段不能合并", () => {
    const out = mergeSlices([mk("a", 1, 5), mk("b", 6, 10)], 1);
    expect(out).toHaveLength(2);
  });
});

describe("splitSlice", () => {
  it("从指定行拆成两段，新段标题带（下）且消息为空", () => {
    const a = mk("a", 1, 10, { messages: [{ role: "user", content: "q" }] });
    const b = mk("b", 11, 20);
    const out = splitSlice([a, b], 0, 6);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ startLine: 1, endLine: 5, messages: [{ role: "user", content: "q" }] });
    expect(out[1]).toMatchObject({ startLine: 6, endLine: 10, title: "t-a（下）", messages: [] });
    expect(out[2].id).toBe("b");
  });

  it("首行不能拆分", () => {
    const arr = [mk("a", 1, 10)];
    const out = splitSlice(arr, 0, 1);
    expect(out).toBe(arr);
    expect(out[0].endLine).toBe(10);
  });

  it("段外的行不拆分", () => {
    const a = mk("a", 1, 10);
    const out = splitSlice([a], 0, 11);
    expect(out).toHaveLength(1);
  });
});
