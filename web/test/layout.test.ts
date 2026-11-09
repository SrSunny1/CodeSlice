import { describe, it, expect, beforeEach } from "vitest";
import { clampPct, loadLayout } from "../src/layout";

const store: Record<string, string> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
    removeItem: (k: string) => void delete store[k],
    clear: () => void Object.keys(store).forEach((k) => delete store[k]),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("clampPct", () => {
  it("正常值按比例换算", () => {
    expect(clampPct(500, 100, 800, 25, 75)).toBe(50);
  });
  it("低于下限返回 min", () => {
    expect(clampPct(0, 100, 800, 25, 75)).toBe(25);
  });
  it("高于上限返回 max", () => {
    expect(clampPct(9999, 100, 800, 25, 75)).toBe(75);
  });
  it("size 为 0 时返回 min", () => {
    expect(clampPct(500, 0, 0, 25, 75)).toBe(25);
  });
});

describe("loadLayout", () => {
  it("默认值", () => {
    const l = loadLayout();
    expect(l).toEqual({
      codePct: 45,
      listPct: 30,
      sidebarPx: 280,
      sidebarCollapsed: false,
      listCollapsed: true,
      indexOpen: false,
      indexPx: 220,
      zCode: 1,
      zSlices: 1,
      zChat: 1,
      zOverview: 1,
      zSidebar: 1,
    });
  });

  it("旧字段 treePx 迁移为 sidebarPx", () => {
    store["codeslice:layout"] = JSON.stringify({ treePx: 320 });
    expect(loadLayout().sidebarPx).toBe(320);
  });

  it("sidebarPx 优先于 treePx，并做范围校验", () => {
    store["codeslice:layout"] = JSON.stringify({ sidebarPx: 999, treePx: 320 });
    expect(loadLayout().sidebarPx).toBe(480);
    store["codeslice:layout"] = JSON.stringify({ sidebarPx: 10 });
    expect(loadLayout().sidebarPx).toBe(200);
  });

  it("布尔字段类型校验", () => {
    store["codeslice:layout"] = JSON.stringify({
      sidebarCollapsed: "yes",
      listCollapsed: 0,
    });
    const l = loadLayout();
    expect(l.sidebarCollapsed).toBe(false);
    expect(l.listCollapsed).toBe(true);
  });
});
