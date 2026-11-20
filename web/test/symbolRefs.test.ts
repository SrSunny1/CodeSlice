import { describe, it, expect } from "vitest";
import {
  classifySpans,
  enclosingScope,
  findSymbolRefs,
  identifierAt,
  type Span,
} from "../src/symbolRefs";

describe("identifierAt", () => {
  it("返回 caret 处的标识符及词尾命中", () => {
    expect(identifierAt("foo(bar)", 1)).toEqual({ name: "foo", start: 0, end: 3 });
    expect(identifierAt("foo(bar)", 3)).toEqual({ name: "foo", start: 0, end: 3 });
    expect(identifierAt("foo(bar)", 4)).toEqual({ name: "bar", start: 4, end: 7 });
  });
  it("非标识符位置与空行返回 null", () => {
    expect(identifierAt("a + 1", 4)).toBeNull();
    expect(identifierAt("   ", 1)).toBeNull();
  });
  it("支持 Unicode 标识符", () => {
    expect(identifierAt("变量 = 1", 0)).toEqual({ name: "变量", start: 0, end: 2 });
  });
});

describe("classifySpans", () => {
  it("把 token 类型摊成行内 inert/skip 区间（empty 长度按 0）", () => {
    const { inert, skip } = classifySpans([
      [
        { types: ["keyword"], content: "def" },
        { types: ["plain"], content: " f" },
      ],
      [{ types: ["plain"], content: "\n", empty: true }],
      [
        { types: ["plain"], content: "x " },
        { types: ["comment"], content: "# f" },
      ],
    ]);
    expect(skip[0]).toContainEqual([0, 3]);
    expect(inert[1]).toEqual([]);
    expect(inert[2]).toContainEqual([2, 5]);
  });
});

describe("findSymbolRefs", () => {
  const py = [
    "import helper", // 1
    "def helper(x):", // 2
    "    return x", // 3
    "class A:", // 4
    "    def run(self):", // 5
    "        y = helper(1)", // 6
    "        helper = 2", // 7
    "        # helper note", // 8
    "print(helper)", // 9
    "helper_2 = 1", // 10
  ];
  it("Python：按行序分类，inert 区间内标 text，整词匹配", () => {
    const inert: Span[][] = Array.from({ length: py.length }, () => []);
    inert[7] = [[0, 21]]; // 注释整行
    const refs = findSymbolRefs(py, "helper", inert);
    expect(refs.map((r) => r.line)).toEqual([1, 2, 6, 7, 8, 9]);
    expect(refs.map((r) => r.kind)).toEqual([
      "import",
      "def",
      "call",
      "assign",
      "text",
      "ref",
    ]);
    expect(refs[2].scope).toBe("run");
    expect(refs[3].scope).toBe("run");
    expect(refs[1].scope).toBeUndefined();
    expect(refs[5].scope).toBeUndefined();
  });

  it("JS/TS/Go/Java 形态：定义/赋值/调用/引用", () => {
    const kinds = (code: string, name: string) =>
      findSymbolRefs(code.split("\n"), name).map((r) => r.kind);
    expect(kinds("const add = (a, b) => a + b;", "add")).toEqual(["def"]);
    expect(kinds("  const r = add(1, 2);", "add")).toEqual(["call"]);
    expect(kinds("  obj.add = add;", "add")).toEqual(["assign", "ref"]);
    expect(kinds("  return add(1);", "add")).toEqual(["call"]);
    expect(kinds("foo(name=1)", "name")).toEqual(["ref"]);
    expect(kinds("  public static int add(int a) {", "add")).toEqual(["def"]);
    expect(kinds("func (s *S) Run() {", "Run")).toEqual(["def"]);
    expect(kinds("  run() {", "run")).toEqual(["def"]);
  });

  it("运算符/箭头/控制词上下文不误判为定义或赋值", () => {
    const kinds = (code: string, name: string) =>
      findSymbolRefs(code.split("\n"), name).map((r) => r.kind);
    expect(kinds("  const ok = a && add(1);", "add")).toEqual(["call"]);
    expect(kinds("  total = a * add(2)", "add")).toEqual(["call"]);
    expect(kinds("items.map((x) => add(x));", "add")).toEqual(["call"]);
    expect(kinds("    assert helper(1)", "helper")).toEqual(["call"]);
    expect(kinds("with open(p) as f:", "open")).toEqual(["call"]);
    expect(kinds("const inc = x => x + 1;", "x")).toEqual(["ref", "ref"]);
    expect(kinds("int add(int a) {", "add")).toEqual(["def"]);
    expect(kinds("x == 1", "x")).toEqual(["ref"]);
    expect(kinds("x = 1", "x")).toEqual(["assign"]);
  });
});

describe("enclosingScope", () => {
  it("缩进向上找最近的函数/类名", () => {
    expect(
      enclosingScope(
        ["function main() {", "  if (x) {", "    add(1);", "  }", "}"],
        2
      )
    ).toBe("main");
    expect(
      enclosingScope(["const go = async () => {", "  add(1);", "};"], 1)
    ).toBe("go");
    expect(enclosingScope(["add(1);"], 0)).toBeUndefined();
  });
});
