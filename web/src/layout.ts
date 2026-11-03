const KEY = "codeslice:layout";

export interface LayoutPct {
  codePct: number;
  listPct: number;
  sidebarPx: number;
  sidebarCollapsed: boolean;
  listCollapsed: boolean;
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
    };
  } catch {
    return {
      codePct: 45,
      listPct: 30,
      sidebarPx: 280,
      sidebarCollapsed: false,
      listCollapsed: true,
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
