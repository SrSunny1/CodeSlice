import { useEffect, useRef, useState, type RefObject } from "react";
import { loadLayout, saveLayout, type LayoutPct } from "./layout";

export type ZoomKey = "zCode" | "zSlices" | "zChat" | "zOverview" | "zSidebar";

const ZMIN = 0.7;
const ZMAX = 2;
const ZSTEP = 1.12;

/**
 * 单栏 Ctrl+滚轮缩放：在 ref 元素上监听 wheel（原生非 passive 监听，
 * preventDefault 阻止浏览器整页缩放），把系数写到元素的 --z CSS 变量，
 * 样式表里相关 font-size 用 calc(Npx * var(--z, 1)) 跟随。
 * 系数持久化在 codeslice:layout；元素晚挂载（如折叠列表）也能生效。
 */
export function usePaneZoom<T extends HTMLElement>(
  ref: RefObject<T | null>,
  key: ZoomKey
): number {
  const [z, setZ] = useState(() => loadLayout()[key]);
  const zRef = useRef(z);
  zRef.current = z;

  // 每次渲染都同步 --z：元素可能在渲染后才出现（条件渲染）
  useEffect(() => {
    ref.current?.style.setProperty("--z", String(z));
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = zRef.current;
      const next = Math.min(
        ZMAX,
        Math.max(ZMIN, +(cur * (e.deltaY < 0 ? ZSTEP : 1 / ZSTEP)).toFixed(3))
      );
      if (next === cur) return;
      zRef.current = next;
      setZ(next);
      saveLayout({ [key]: next } as Partial<LayoutPct>);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  return z;
}
