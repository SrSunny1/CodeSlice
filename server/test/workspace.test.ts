import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { languageOf, listTree, resolveInside, toLocalPath } from "../src/workspace.js";

describe("toLocalPath", () => {
  it("Windows 盘符路径", () => {
    expect(toLocalPath("E:\\a\\b")).toBe("/mnt/e/a/b");
    expect(toLocalPath("E:/a/b")).toBe("/mnt/e/a/b");
    expect(toLocalPath("D:\\Code\\Proj")).toBe("/mnt/d/Code/Proj");
  });
  it("带引号和首尾空白", () => {
    expect(toLocalPath('  "E:\\a\\b"  ')).toBe("/mnt/e/a/b");
    expect(toLocalPath("'/mnt/e/x'")).toBe("/mnt/e/x");
  });
  it("WSL UNC 路径", () => {
    expect(toLocalPath("\\\\wsl.localhost\\Ubuntu\\home\\x\\proj")).toBe("/home/x/proj");
    expect(toLocalPath("\\\\wsl$\\Ubuntu\\home\\x")).toBe("/home/x");
  });
  it("POSIX 路径原样返回并去末尾斜杠", () => {
    expect(toLocalPath("/mnt/e/code/")).toBe("/mnt/e/code");
    expect(toLocalPath("/home/u/p")).toBe("/home/u/p");
  });
});

describe("languageOf", () => {
  it("常见扩展名", () => {
    expect(languageOf("a/b/c.py")).toBe("python");
    expect(languageOf("x.tsx")).toBe("typescript");
    expect(languageOf("main.go")).toBe("go");
    expect(languageOf("lib.rs")).toBe("rust");
    expect(languageOf("a.yaml")).toBe("yaml");
    expect(languageOf("a.yml")).toBe("yaml");
  });
  it("未知扩展名为 text", () => {
    expect(languageOf("a.xyz")).toBe("text");
    expect(languageOf("Makefile")).toBe("text");
  });
});

describe("listTree / resolveInside", () => {
  let root: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cs-ws-"));
    await fsp.mkdir(path.join(root, "src"));
    await fsp.mkdir(path.join(root, "node_modules"));
    await fsp.mkdir(path.join(root, ".git"));
    await fsp.writeFile(path.join(root, "src", "a.ts"), "a");
    await fsp.writeFile(path.join(root, "src", "b.ts"), "b");
    await fsp.writeFile(path.join(root, "z.md"), "z");
    await fsp.writeFile(path.join(root, "a.md"), "a");
    await fsp.writeFile(path.join(root, ".hidden"), "h");
    await fsp.writeFile(path.join(root, "node_modules", "x.js"), "x");
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("目录在前、按名称排序，忽略隐藏文件和 node_modules/.git", () => {
    const { tree } = listTree(root);
    expect(tree.map((n) => n.name)).toEqual(["src", "a.md", "z.md"]);
    const src = tree[0];
    expect(src.type).toBe("dir");
    expect(src.children?.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("resolveInside 正常解析", async () => {
    const p = await resolveInside(root, "src/a.ts");
    expect(p).toBe(await fsp.realpath(path.join(root, "src/a.ts")));
  });

  it("resolveInside 拒绝 ../ 越界", async () => {
    await expect(resolveInside(root, "../etc/passwd")).rejects.toThrow("路径越界");
    await expect(resolveInside(root, "src/../../x")).rejects.toThrow("路径越界");
  });

  it("resolveInside 拒绝指向 root 外部的符号链接", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "cs-out-"));
    await fsp.writeFile(path.join(outside, "secret.txt"), "s");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
      // listTree 不跟随符号链接
      expect(listTree(root).tree.map((n) => n.name)).not.toContain("link.txt");
      await expect(resolveInside(root, "link.txt")).rejects.toThrow("路径越界");
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});
