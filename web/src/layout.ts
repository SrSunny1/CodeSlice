const KEY = "codeslice:layout";

export interface LayoutPct {
  codePct: number;
  listPct: number;
  sidebarPx: number;
  sidebarCollapsed: boolean;
  listCollapsed: boolean;
  indexOpen: boolean;
  /** 各栏 Ctrl+滚轮文字缩放系数 */
  zCode: number;
  zSlices: number;
  zChat: number;
  zOverview: number;
  zSidebar: number;
}

/** 把像素位置 pos 换算成相对 [start, start+size) 的百分比，并夹在 [min,max]。 */
export function clampPct(
  pos: number,
  start: number,
  size: number,
  min: number,
  max: number
): number {
  if (size <= 0) return min;
  const pct = ((pos - start) / size) * 100;
  return Math.min(max, Math.max(min, pct));
}

export function loadLayout(): LayoutPct {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      codePct: clampNum(v.codePct, 25, 75, 45),
      listPct: clampNum(v.listPct, 12, 60, 30),
      // 旧字段 treePx 迁移为 sidebarPx
      sidebarPx: clampNum(
        typeof v.sidebarPx === "number" ? v.sidebarPx : v.treePx,
        200,
        480,
        280
      ),
      sidebarCollapsed:
        typeof v.sidebarCollapsed === "boolean" ? v.sidebarCollapsed : false,
      listCollapsed: typeof v.listCollapsed === "boolean" ? v.listCollapsed : true,
      indexOpen: typeof v.indexOpen === "boolean" ? v.indexOpen : false,
      zCode: clampNum(v.zCode, 0.7, 2, 1),
      zSlices: clampNum(v.zSlices, 0.7, 2, 1),
      zChat: clampNum(v.zChat, 0.7, 2, 1),
      zOverview: clampNum(v.zOverview, 0.7, 2, 1),
      zSidebar: clampNum(v.zSidebar, 0.7, 2, 1),
    };
  } catch {
    return {
      codePct: 45,
      listPct: 30,
      sidebarPx: 280,
      sidebarCollapsed: false,
      listCollapsed: true,
      indexOpen: false,
      zCode: 1,
      zSlices: 1,
      zChat: 1,
      zOverview: 1,
      zSidebar: 1,
    };
  }
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : dflt;
}

export function saveLayout(patch: Partial<LayoutPct>): void {
  localStorage.setItem(KEY, JSON.stringify({ ...loadLayout(), ...patch }));
}
