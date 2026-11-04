import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MarkColor, TextMark } from "./types";

type MdComponents = ComponentProps<typeof Markdown>["components"];

const MARK_COLORS: MarkColor[] = ["y", "g", "b", "p"];
const COLOR_LABEL: Record<MarkColor, string> = { y: "黄", g: "绿", b: "蓝", p: "粉" };

// ---- CSS Custom Highlight API 的兼容包装（低版本浏览器自动降级为不可标注） ----
interface HighlightRegistryLike {
  set(name: string, h: object): void;
  delete(name: string): void;
}
function hlRegistry(): HighlightRegistryLike | undefined {
  return (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS?.highlights;
}
function makeHighlight(ranges: Range[]): object | null {
  const H = (globalThis as { Highlight?: new (...r: Range[]) => object }).Highlight;
  return H ? new H(...ranges) : null;
}
function marksSupported(): boolean {
  return !!hlRegistry() && !!(globalThis as { Highlight?: unknown }).Highlight;
}

// 所有实例的 Range 按颜色汇总后统一注册（::highlight 的样式名是全页的，只有 4 个）
const rangeStore = new Map<string, Map<MarkColor, Range[]>>();
function rebuildHighlights() {
  const reg = hlRegistry();
  if (!reg) return;
  for (const c of MARK_COLORS) {
    const name = `cs-mark-${c}`;
    const ranges: Range[] = [];
    for (const g of rangeStore.values()) ranges.push(...(g.get(c) ?? []));
    const h = ranges.length ? makeHighlight(ranges) : null;
    if (h) reg.set(name, h);
    else reg.delete(name);
  }
}

// ---- 渲染后文本偏移量 <-> DOM Range ----
function textNodes(root: Node): Text[] {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let n;
  while ((n = w.nextNode())) out.push(n as Text);
  return out;
}

/** DOM 点（node+offset）对应 root.textContent 里的字符偏移。 */
function pointOffset(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  try {
    r.setEnd(node, offset);
  } catch {
    return 0;
  }
  return r.toString().length;
}

function setPointAt(nodes: Text[], off: number): { node: Text; offset: number } {
  let acc = 0;
  for (const t of nodes) {
    if (off <= acc + t.data.length) return { node: t, offset: off - acc };
    acc += t.data.length;
  }
  const last = nodes[nodes.length - 1];
  return { node: last, offset: last.data.length };
}

/** textContent 偏移区间 -> Range，越界自动收敛到 root 内。 */
function rangeFor(root: HTMLElement, start: number, end: number): Range | null {
  const nodes = textNodes(root);
  if (!nodes.length || end <= start) return null;
  const total = nodes.reduce((a, t) => a + t.data.length, 0);
  const s = Math.max(0, Math.min(start, total));
  const e = Math.max(0, Math.min(end, total));
  if (e <= s) return null;
  const r = document.createRange();
  const ps = setPointAt(nodes, s);
  const pe = setPointAt(nodes, e);
  r.setStart(ps.node, ps.offset);
  r.setEnd(pe.node, pe.offset);
  return r;
}

function overlaps(m: TextMark, start: number, end: number): boolean {
  return m.start < end && m.end > start;
}

interface PalState {
  x: number;
  y: number;
  below: boolean;
  /** 有选区：对 [start,end) 新增/擦除 */
  range?: { start: number; end: number };
  /** 点中已有标注：改色/删除 */
  markIdx?: number;
}

/**
 * 可标注的 Markdown：选中文字弹出调色板，标注以 textContent 偏移量持久化，
 * 用 CSS Custom Highlight API 渲染（不改动 DOM，与 React 渲染无冲突）。
 */
export default function MarkableMarkdown({
  text,
  marks,
  onMarksChange,
  components,
}: {
  text: string;
  marks?: TextMark[];
  onMarksChange?: (marks: TextMark[] | undefined) => void;
  components?: MdComponents;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const palRef = useRef<HTMLDivElement>(null);
  const instId = useId();
  const markable = !!onMarksChange && marksSupported();
  const [pal, setPal] = useState<PalState | null>(null);
  const marksRef = useRef(marks);
  marksRef.current = marks;

  // 把持久化的偏移量还原成 Range 并注册到全局 highlight
  useLayoutEffect(() => {
    const root = boxRef.current;
    if (!root || !markable) return;
    const groups = new Map<MarkColor, Range[]>();
    for (const m of marks ?? []) {
      const r = rangeFor(root, m.start, m.end);
      if (r) {
        const arr = groups.get(m.color) ?? [];
        arr.push(r);
        groups.set(m.color, arr);
      }
    }
    rangeStore.set(instId, groups);
    rebuildHighlights();
    return () => {
      rangeStore.delete(instId);
      rebuildHighlights();
    };
  }, [text, marks, markable, instId]);

  // 消息内容变化（如换 slice）时关掉浮板
  useEffect(() => setPal(null), [text]);

  // 点外部 / 滚动 / Esc 关闭浮板
  useEffect(() => {
    if (!pal) return;
    const close = () => setPal(null);
    const onDown = (e: MouseEvent) => {
      if (palRef.current && !palRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pal]);

  function onMouseUp(e: ReactMouseEvent<HTMLDivElement>) {
    if (!markable || e.button !== 0) return;
    const root = boxRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;

    const posFor = (r: Range | null): Pick<PalState, "x" | "y" | "below"> | null => {
      const rc = r?.getBoundingClientRect();
      if (!rc || (rc.width === 0 && rc.height === 0)) return null;
      return {
        x: Math.min(Math.max(rc.left + rc.width / 2, 80), window.innerWidth - 80),
        y: rc.top < 56 ? rc.bottom + 8 : rc.top - 8,
        below: rc.top < 56,
      };
    };

    if (sel.isCollapsed) {
      // 单击落在已有标注内 -> 打开该标注的编辑浮板（右缘归前一段，见 overlaps）
      const off = pointOffset(root, sel.anchorNode!, sel.anchorOffset);
      const idx = (marksRef.current ?? []).findIndex((m) => off > m.start && off <= m.end);
      if (idx < 0) return;
      const m = marksRef.current![idx];
      const pos = posFor(rangeFor(root, m.start, m.end));
      if (pos) setPal({ ...pos, markIdx: idx });
      return;
    }
    const a = pointOffset(root, sel.anchorNode!, sel.anchorOffset);
    const b = pointOffset(root, sel.focusNode!, sel.focusOffset);
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start < 1) return;
    const pos = posFor(sel.getRangeAt(0));
    if (pos) setPal({ ...pos, range: { start, end } });
  }

  function emit(next: TextMark[]) {
    onMarksChange?.(next.length ? next : undefined);
    setPal(null);
    window.getSelection()?.removeAllRanges();
  }

  function applyColor(color: MarkColor) {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx != null) {
      emit(cur.map((m, i) => (i === pal.markIdx ? { ...m, color } : m)));
    } else if (pal?.range) {
      const { start, end } = pal.range;
      // 与新区间相交的旧标注被新色覆盖
      const next = cur.filter((m) => !overlaps(m, start, end));
      next.push({ start, end, color });
      next.sort((a, b) => a.start - b.start);
      emit(next);
    }
  }

  function erase() {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx != null) {
      emit(cur.filter((_, i) => i !== pal.markIdx));
    } else if (pal?.range) {
      const { start, end } = pal.range;
      emit(cur.filter((m) => !overlaps(m, start, end)));
    }
  }

  return (
    <div className="md-mark" ref={boxRef} onMouseUp={onMouseUp}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
      {pal &&
        createPortal(
          <div
            ref={palRef}
            className={`mark-pal${pal.below ? " below" : ""}`}
            style={{ left: pal.x, top: pal.y }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {MARK_COLORS.map((c) => (
              <button
                key={c}
                className={`mark-dot ${c}`}
                title={`${COLOR_LABEL[c]}色标注`}
                onClick={() => applyColor(c)}
              />
            ))}
            <button className="mark-erase" title="清除选区内/该条标注" onClick={erase}>
              清除
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
