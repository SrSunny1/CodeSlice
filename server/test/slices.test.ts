import { describe, it, expect } from "vitest";
import { normalizeSlices } from "../src/slices.js";

describe("normalizeSlices", () => {
  it("合法输入原样通过并补 id", () => {
    const out = normalizeSlices(
      '[{"startLine":1,"endLine":5,"title":"导入"},{"startLine":6,"endLine":10,"title":"主流程"}]',
      10
    );
    expect(out).toEqual([
      { id: "slice-1", startLine: 1, endLine: 5, title: "导入" },
      { id: "slice-2", startLine: 6, endLine: 10, title: "主流程" },
    ]);
  });

  it("重叠的段被合并且保持覆盖", () => {
    const out = normalizeSlices(
      '[{"startLine":1,"endLine":8,"title":"a"},{"startLine":5,"endLine":10,"title":"b"}]',
      10
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startLine: 1, endLine: 10 });
  });

  it("空隙行并入前一段", () => {
    const out = normalizeSlices(
      '[{"startLine":1,"endLine":3,"title":"a"},{"startLine":8,"endLine":10,"title":"b"}]',
      10
    );
    expect(out[0]).toMatchObject({ startLine: 1, endLine: 7 });
    expect(out[1]).toMatchObject({ startLine: 8, endLine: 10 });
  });

  it("越界行号被裁剪，末尾覆盖到 totalLines", () => {
    const out = normalizeSlices(
      '[{"startLine":-5,"endLine":4,"title":"a"},{"startLine":5,"endLine":99,"title":"b"}]',
      10
    );
    expect(out[0].startLine).toBe(1);
    expect(out[out.length - 1].endLine).toBe(10);
  });

  it("乱序输入会排序", () => {
    const out = normalizeSlices(
      '[{"startLine":6,"endLine":10,"title":"b"},{"startLine":1,"endLine":5,"title":"a"}]',
      10
    );
    expect(out[0].title).toBe("a");
    expect(out[1].title).toBe("b");
  });

  it("能解析 markdown 代码块包裹的 JSON", () => {
    const raw = '```json\n[{"startLine":1,"endLine":4,"title":"x"}]\n```';
    const out = normalizeSlices(raw, 4);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startLine: 1, endLine: 4, title: "x" });
  });

  it("非法 JSON 走约 20 行一段的兜底切分", () => {
    const out = normalizeSlices("这不是 JSON", 45);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ startLine: 1, endLine: 20 });
    expect(out[2]).toMatchObject({ startLine: 41, endLine: 45 });
  });

  it("空代码返回空数组", () => {
    expect(normalizeSlices("[]", 0)).toEqual([]);
  });

  it("任何情况下段与段首尾相接且覆盖全部行", () => {
    const raw =
      '[{"startLine":3,"endLine":7,"title":"a"},{"startLine":15,"endLine":12,"title":"bad"},{"startLine":20,"endLine":30,"title":"b"}]';
    const total = 25;
    const out = normalizeSlices(raw, total);
    expect(out[0].startLine).toBe(1);
    expect(out[out.length - 1].endLine).toBe(total);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startLine).toBe(out[i - 1].endLine + 1);
    }
  });
});
