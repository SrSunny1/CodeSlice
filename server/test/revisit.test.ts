import { describe, it, expect } from "vitest";
import { lastRelatedIndex } from "../src/revisit.js";

describe("lastRelatedIndex", () => {
  it("取最大有效序号并转成 0-based 候选下标", () => {
    expect(lastRelatedIndex('{"related":[4,1,4,2]}', 5)).toBe(3);
    expect(lastRelatedIndex('{"related":[1]}', 5)).toBe(0);
    expect(lastRelatedIndex('{"related":[5]}', 5)).toBe(4);
  });

  it("空 related 返回 null（合法的无结果）", () => {
    expect(lastRelatedIndex('{"related":[]}', 5)).toBeNull();
  });

  it("容忍 markdown 代码围栏与前后空白", () => {
    expect(lastRelatedIndex('```json\n{"related":[2]}\n```', 5)).toBe(1);
    expect(lastRelatedIndex('  {"related":[3]}  ', 5)).toBe(2);
  });

  it("非法 JSON / 缺少 related / 越界或非整数一律抛错", () => {
    expect(() => lastRelatedIndex("这不是 JSON", 5)).toThrow();
    expect(() => lastRelatedIndex('{"foo":[1]}', 5)).toThrow();
    expect(() => lastRelatedIndex('{"related":"3"}', 5)).toThrow();
    expect(() => lastRelatedIndex('{"related":[6]}', 5)).toThrow();
    expect(() => lastRelatedIndex('{"related":[0]}', 5)).toThrow();
    expect(() => lastRelatedIndex('{"related":[1.5]}', 5)).toThrow();
    expect(() => lastRelatedIndex('{"related":["2"]}', 5)).toThrow();
  });
});
