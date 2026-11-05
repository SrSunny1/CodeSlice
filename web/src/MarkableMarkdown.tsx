import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMsg, MarkColor, TextMark } from "./types";

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

// ---- 全局标注注册表：每个实例的 Range 按颜色（有无备注）汇总注册；
//      MarkRail 也从这里取点位信息 ----
interface MarkEntry {
  range: Range;
  mark: TextMark;
}
interface InstMarks {
  root: HTMLElement;
  entries: MarkEntry[];
}
const rangeStore = new Map<string, InstMarks>();
const markListeners = new Set<() => void>();
let notifyQueued = false;
function notifyMarks() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    markListeners.forEach((f) => f());
  });
}
export function subscribeMarks(fn: () => void): () => void {
  markListeners.add(fn);
  return () => {
    markListeners.delete(fn);
  };
}

function setReg(reg: HighlightRegistryLike, name: string, ranges: Range[]) {
  const h = ranges.length ? makeHighlight(ranges) : null;
  if (h) reg.set(name, h);
  else reg.delete(name);
}
function rebuildHighlights() {
  const reg = hlRegistry();
  if (!reg) return;
  const buckets = new Map<MarkColor, { plain: Range[]; noted: Range[] }>();
  for (const inst of rangeStore.values()) {
    for (const e of inst.entries) {
      const b = buckets.get(e.mark.color) ?? { plain: [], noted: [] };
      (e.mark.note ? b.noted : b.plain).push(e.range);
      buckets.set(e.mark.color, b);
    }
  }
  for (const c of MARK_COLORS) {
    const b = buckets.get(c) ?? { plain: [], noted: [] };
    setReg(reg, `cs-mark-${c}`, b.plain);
    setReg(reg, `cs-mark-${c}n`, b.noted);
  }
  notifyMarks();
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
export function rangeForText(root: HTMLElement, start: number, end: number): Range | null {
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

// ---------------- 调色板浮板 ----------------
interface PalState {
  x: number;
  y: number;
  below: boolean;
  /** 有选区：对 [start,end) 新增/擦除 */
  range?: { start: number; end: number };
  /** 点中已有标注：改色/删除/备注 */
  markIdx?: number;
  editingNote: boolean;
  noteDraft: string;
}

/**
 * 可标注的 Markdown：选中文字弹出调色板，可填色也可写文字备注；
 * 标注以 textContent 偏移量持久化，用 CSS Custom Highlight API 渲染。
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
    const entries: MarkEntry[] = [];
    for (const m of marks ?? []) {
      const r = rangeForText(root, m.start, m.end);
      if (r) entries.push({ range: r, mark: m });
    }
    rangeStore.set(instId, { root, entries });
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
      // 单击落在已有标注内 -> 打开该标注的编辑浮板（右缘归前一段）
      const off = pointOffset(root, sel.anchorNode!, sel.anchorOffset);
      const idx = (marksRef.current ?? []).findIndex((m) => off > m.start && off <= m.end);
      if (idx < 0) return;
      const m = marksRef.current![idx];
      const pos = posFor(rangeForText(root, m.start, m.end));
      if (pos)
        setPal({
          ...pos,
          markIdx: idx,
          editingNote: !!m.note,
          noteDraft: m.note ?? "",
        });
      return;
    }
    const a = pointOffset(root, sel.anchorNode!, sel.anchorOffset);
    const b = pointOffset(root, sel.focusNode!, sel.focusOffset);
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start < 1) return;
    const pos = posFor(sel.getRangeAt(0));
    if (pos) setPal({ ...pos, range: { start, end }, editingNote: false, noteDraft: "" });
  }

  function emit(next: TextMark[]) {
    onMarksChange?.(next.length ? next : undefined);
    setPal(null);
    window.getSelection()?.removeAllRanges();
  }

  function applyColor(color: MarkColor) {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx != null) {
      const next = cur.map((m, i) => (i === pal.markIdx ? { ...m, color } : m));
      if (pal.editingNote) {
        // 编辑备注时保持浮板不关
        onMarksChange?.(next.length ? next : undefined);
        setPal({ ...pal });
      } else {
        emit(next);
      }
    } else if (pal?.range) {
      const { start, end } = pal.range;
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

  function startNote() {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx != null) {
      const m = cur[pal.markIdx];
      setPal({ ...pal, editingNote: true, noteDraft: m?.note ?? "" });
      return;
    }
    if (!pal?.range) return;
    // 选区写备注：先落成黄色底标（备注颜色可再改），再就地编辑
    const { start, end } = pal.range;
    const next = cur.filter((m) => !overlaps(m, start, end));
    next.push({ start, end, color: "y" });
    next.sort((a, b) => a.start - b.start);
    const idx = next.findIndex((m) => m.start === start && m.end === end);
    onMarksChange?.(next);
    setPal({ ...pal, markIdx: idx, range: undefined, editingNote: true, noteDraft: "" });
  }

  function saveNote() {
    const cur = marksRef.current ?? [];
    if (pal?.markIdx == null) return;
    const note = pal.noteDraft.trim();
    emit(
      cur.map((m, i) =>
        i === pal.markIdx ? { ...m, note: note || undefined } : m
      )
    );
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
            className={`mark-pal${pal.below ? " below" : ""}${pal.editingNote ? " editing" : ""}`}
            style={{ left: pal.x, top: pal.y }}
            onMouseDown={(e) => {
              // 输入框要能聚焦，其余区域阻止默认行为以保留文字选区
              if ((e.target as HTMLElement).tagName !== "TEXTAREA") e.preventDefault();
            }}
            onMouseUp={(e) => e.stopPropagation()}
          >
            <div className="mark-pal-row">
              {MARK_COLORS.map((c) => (
                <button
                  key={c}
                  className={`mark-dot ${c}`}
                  title={`${COLOR_LABEL[c]}色标注`}
                  onClick={() => applyColor(c)}
                />
              ))}
              <button className="mark-note" title="写文字标注" onClick={startNote}>
                ✎
              </button>
              <button className="mark-erase" title="清除标注" onClick={erase}>
                清除
              </button>
            </div>
            {pal.editingNote && (
              <div className="mark-note-editor">
                <textarea
                  autoFocus
                  rows={3}
                  placeholder="写点标注…（Ctrl+Enter 保存）"
                  value={pal.noteDraft}
                  onChange={(e) => setPal({ ...pal, noteDraft: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveNote();
                  }}
                />
                <button className="link" onClick={saveNote}>
                  保存
                </button>
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

/** 把 Range 滚到滚动容器中央并临时选中，给「跳到标注」用。 */
export function revealRange(scroller: HTMLElement, range: Range) {
  const rc = range.getClientRects()[0];
  if (!rc) return;
  const cRect = scroller.getBoundingClientRect();
  const top = rc.top - cRect.top + scroller.scrollTop;
  scroller.scrollTo({ top: top + rc.height / 2 - scroller.clientHeight / 2, behavior: "smooth" });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range.cloneRange());
}

// ---------------- 标注导航栏（显示点） ----------------
interface RailDot {
  top: number;
  color: MarkColor;
  hasNote: boolean;
  excerpt: string;
  note?: string;
  range: Range;
}

function sameDots(a: RailDot[], b: RailDot[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x.top === b[i].top &&
        x.color === b[i].color &&
        x.hasNote === b[i].hasNote &&
        x.excerpt === b[i].excerpt &&
        x.note === b[i].note
    )
  );
}

/** 放进滚动容器内部：每个标注一个点，点击跳转并高亮选中。 */
export function MarkRail({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const [dots, setDots] = useState<RailDot[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => subscribeMarks(bump), []);

  // 每次渲染后重算点位（父组件更新/标注变化/自身 bump 都会走到这里）
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const cRect = c.getBoundingClientRect();
    const found: RailDot[] = [];
    for (const inst of rangeStore.values()) {
      if (!c.contains(inst.root)) continue;
      for (const e of inst.entries) {
        const rc = e.range.getClientRects()[0];
        if (!rc) continue;
        found.push({
          top: rc.top - cRect.top + c.scrollTop,
          color: e.mark.color,
          hasNote: !!e.mark.note,
          excerpt: e.range.toString().replace(/\s+/g, " ").trim().slice(0, 50),
          note: e.mark.note,
          range: e.range,
        });
      }
    }
    found.sort((a, b) => a.top - b.top);
    setDots((prev) => (sameDots(prev, found) ? prev : found));
  });

  // 容器尺寸变化（拖分栏/窗口缩放）时重算
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(bump);
    ro.observe(c);
    return () => ro.disconnect();
  }, [containerRef]);

  function jump(d: RailDot) {
    const c = containerRef.current;
    if (c) revealRange(c, d.range);
  }

  return (
    <>
      {dots.map((d, i) => (
        <button
          key={i}
          className={`mark-rail-dot m-${d.color}${d.hasNote ? " note" : ""}`}
          style={{ top: d.top }}
          title={`${d.hasNote ? "📝 " + (d.note ?? "") : ""}${d.excerpt}`}
          onClick={() => jump(d)}
        />
      ))}
    </>
  );
}

// ---------------- 问答 + 标注索引条（聊天区左缘） ----------------
interface IndexEntry {
  kind: "q" | "mark";
  msgIdx: number;
  mi?: number; // mark 在消息 marks 数组里的下标
  mark?: TextMark;
  text: string;
}

/**
 * 放在聊天滚动容器左侧的窄索引条：每个用户问题一个「问」图标、
 * 每条标注一个色点，点击跳到对应位置；顶部显示问/注数量。
 */
export function ChatIndex({
  containerRef,
  messages,
}: {
  containerRef: RefObject<HTMLElement | null>;
  messages: ChatMsg[];
}) {
  const entries = useMemo<IndexEntry[]>(() => {
    const out: IndexEntry[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user")
        out.push({
          kind: "q",
          msgIdx: i,
          text: m.content.replace(/\s+/g, " ").trim().slice(0, 60),
        });
      (m.marks ?? []).forEach((mk, mi) =>
        out.push({ kind: "mark", msgIdx: i, mi, mark: mk, text: mk.note ?? "" })
      );
    });
    return out;
  }, [messages]);

  // 标注点的文字摘要（tooltip 用），messages 变化时重建
  const [excerpts, setExcerpts] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const msgEls = c.querySelectorAll(".msg");
    const next: Record<string, string> = {};
    messages.forEach((m, i) => {
      if (m.role !== "assistant" || !m.marks?.length) return;
      const root = msgEls[i]?.querySelector(".md-mark");
      if (!(root instanceof HTMLElement)) return;
      m.marks.forEach((mk, mi) => {
        const r = rangeForText(root, mk.start, mk.end);
        if (r) next[`${i}:${mi}`] = r.toString().replace(/\s+/g, " ").trim().slice(0, 50);
      });
    });
    setExcerpts((prev) => {
      const keys = Object.keys(next);
      const same =
        keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]);
      return same ? prev : next;
    });
  }, [messages, containerRef]);

  function jump(e: IndexEntry) {
    const c = containerRef.current;
    if (!c) return;
    const el = c.querySelectorAll(".msg")[e.msgIdx];
    if (!el) return;
    if (e.kind === "q") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const root = el.querySelector(".md-mark");
    const mk = e.mark;
    if (!mk || !(root instanceof HTMLElement)) return;
    const r = rangeForText(root, mk.start, mk.end);
    if (r) revealRange(c, r);
  }

  if (!entries.length) return null;
  const qCount = entries.filter((e) => e.kind === "q").length;
  const mCount = entries.length - qCount;

  return (
    <div className="chat-index">
      <div className="ci-counts">
        <div>问 {qCount}</div>
        <div>注 {mCount}</div>
      </div>
      <div className="ci-list">
        {entries.map((e, i) => {
          const tip =
            e.kind === "q"
              ? e.text
              : e.text
                ? `📝 ${e.text}`
                : excerpts[`${e.msgIdx}:${e.mi}`] ?? "";
          return (
            <button key={i} className="ci-row" title={tip} onClick={() => jump(e)}>
              {e.kind === "q" ? (
                <span className="ci-q">问</span>
              ) : (
                <span
                  className={`ci-m m-${e.mark!.color}${e.mark!.note ? " note" : ""}`}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
